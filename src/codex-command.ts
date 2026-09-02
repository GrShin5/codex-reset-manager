import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

export const CODEX_COMMAND_ENV = "CODEX_RESET_MANAGER_CODEX";

export function appServerCommandFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CODEX_COMMAND_ENV]?.trim();
  return configured === undefined || configured.length === 0 ? "codex" : configured;
}

export interface ResolvedAppServerCommand {
  command: string;
  /** True when the configured absolute path was missing or not executable. */
  recovered: boolean;
  configured: string | null;
}

/**
 * Re-validate the configured Codex path at the moment the daemon actually
 * spawns it. A path recorded during install can go stale (Codex upgraded,
 * a version manager switched Node, npm relocated the bin) long after the
 * LaunchAgent was registered, so the daemon must not trust it forever.
 */
export async function resolveAppServerCommand(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedAppServerCommand> {
  const configured = env[CODEX_COMMAND_ENV]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { command: appServerCommandFromEnvironment(env), recovered: false, configured: null };
  }
  if (await isExecutableFile(configured)) {
    return { command: configured, recovered: false, configured };
  }
  const found = await resolveCodexExecutable(env);
  if (found !== null) {
    return { command: found, recovered: true, configured };
  }
  return { command: configured, recovered: true, configured };
}

/**
 * A global npm installation commonly exposes Codex through a script whose
 * shebang is /usr/bin/env node. launchd's default PATH does not include the
 * Node.js directory, even when this manager itself was started by Node.
 *
 * Keep the configured absolute Codex path authoritative, then add only the
 * current Node runtime and its containing CLI directory before the inherited
 * PATH. HOME is supplied from the operating-system account if launchd did not
 * provide it, so the CLI can read its normal authenticated user state.
 */
export function appServerSpawnEnvironment(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
  userHome = homedir(),
): NodeJS.ProcessEnv {
  const configuredDirectory = isAbsolute(command) ? dirname(command) : null;
  const inheritedEntries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const pathEntries = uniquePathEntries([
    dirname(nodeExecutable),
    configuredDirectory,
    ...inheritedEntries,
  ]);
  const configuredHome = env.HOME?.trim();
  return {
    ...env,
    PATH: pathEntries.join(delimiter),
    HOME: configuredHome === undefined || configuredHome.length === 0 ? userHome : configuredHome,
  };
}

/**
 * Resolve an executable absolute path while the user runs install or doctor
 * from an interactive shell. The LaunchAgent receives the result explicitly
 * because launchd does not inherit that shell PATH.
 */
export async function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env[CODEX_COMMAND_ENV]?.trim();
  if (configured !== undefined && configured.length > 0 && isAbsolute(configured) && await isExecutableFile(configured)) {
    return configured;
  }

  const searchPath = env.PATH;
  if (searchPath === undefined || searchPath.trim().length === 0) {
    return null;
  }
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = resolve(directory, "codex");
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniquePathEntries(entries: Array<string | null>): string[] {
  return [...new Set(entries.filter((entry): entry is string => entry !== null && entry.length > 0))];
}

/**
 * Codex CLI versions this manager's wire usage has actually been checked
 * against. An unlisted version is reported, never blocked: the App Server
 * protocol moves faster than this tool can be revalidated, and refusing to
 * anchor on an unrecognised version would break a working installation on
 * every Codex upgrade.
 */
export const TESTED_CODEX_CLI_VERSIONS = ["0.152.0"] as const;

/** Null when the executable could not be run or its output was unrecognised. */
export async function readCodexCliVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      // A wrapper script that ignores SIGTERM would otherwise be orphaned.
      const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
      escalation.unref();
      resolve(value);
    };
    let timer: NodeJS.Timeout;
    try {
      child = spawn(command, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: appServerSpawnEnvironment(command, env),
      });
    } catch {
      // The documented contract is null on failure, not a rejection: doctor
      // reads this inside a Promise.all and must not exit non-zero over it.
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // A runaway --version must not be allowed to balloon memory.
      if (output.length < 4_096) {
        output += chunk.toString("utf8");
      }
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(parseCodexCliVersion(output)));
  });
}

export function parseCodexCliVersion(output: string): string | null {
  return /codex-cli\s+(\S+)/.exec(output)?.[1] ?? null;
}

export function codexVersionDiagnostic(version: string | null): string {
  if (version === null) {
    return "unknown (could not run codex --version)";
  }
  if ((TESTED_CODEX_CLI_VERSIONS as readonly string[]).includes(version)) {
    return `${version} (in the tested set)`;
  }
  return `${version} (WARNING: not in the tested set [${TESTED_CODEX_CLI_VERSIONS.join(", ")}]; `
    + "automatic anchoring is NOT blocked. Run verify-protocol to check the wire contract.)";
}
