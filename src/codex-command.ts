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
