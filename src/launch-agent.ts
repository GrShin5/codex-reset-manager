import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { CODEX_COMMAND_ENV } from "./codex-command.js";
import { fileExists, removeKnownPath, writeTextAtomic } from "./files.js";
import { assertSupportedPlatform } from "./platform.js";
import type { AppPaths } from "./types.js";

export const LAUNCH_AGENT_LABEL = "com.codex-reset-manager";

export function buildLaunchAgentPlist(nodePath: string, cliPath: string, paths: AppPaths, codexExecutable: string): string {
  const values = [nodePath, cliPath, "daemon"];
  const programArguments = values.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${CODEX_COMMAND_ENV}</key>
    <string>${xml(codexExecutable)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrLog)}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(
  paths: AppPaths,
  codexExecutable: string,
  cliPath = process.argv[1],
  // Injectable only so a test can exercise the bootstrap-failure path without
  // booting the real user domain out from under a running daemon.
  launchctl: (args: string[]) => Promise<void> = runLaunchctl,
): Promise<void> {
  assertSupportedPlatform();
  if (cliPath === undefined) {
    throw new Error("Cannot determine the CLI entry point for the LaunchAgent.");
  }
  await writeTextAtomic(paths.launchAgentFile, buildLaunchAgentPlist(process.execPath, resolve(cliPath), paths, codexExecutable));
  // Validate the file before asking launchd to load it.  A malformed plist
  // should fail closed without registering a partially working daemon.
  await validateLaunchAgentPlist(paths);
  const domain = launchDomain();
  await launchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
  try {
    await bootstrapLaunchAgentWithRetry(
      () => launchctl(["bootstrap", domain, paths.launchAgentFile]),
    );
  } catch (error: unknown) {
    // A plist that launchd never registered must not linger on disk: it
    // would make status's file-presence check lie about installation.
    await removeKnownPath(paths.launchAgentFile);
    throw error;
  }
}

export async function uninstallLaunchAgent(paths: AppPaths): Promise<void> {
  assertSupportedPlatform();
  await runLaunchctl(["bootout", `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
  await removeKnownPath(paths.launchAgentFile);
}

export async function launchAgentInstalled(paths: AppPaths): Promise<boolean> {
  return fileExists(paths.launchAgentFile);
}

export async function launchAgentRegistered(
  runner: (args: string[]) => Promise<void> = runLaunchctl,
): Promise<boolean> {
  try {
    await runner(["print", `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

export async function validateLaunchAgentPlist(paths: AppPaths): Promise<void> {
  assertSupportedPlatform();
  await runProcess("/usr/bin/plutil", ["-lint", paths.launchAgentFile]);
}

export async function bootstrapLaunchAgentWithRetry(
  bootstrap: () => Promise<void>,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await bootstrap();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (attempt < 2) {
        // launchd can still be tearing down a just-booted-out service.  Wait
        // briefly before retrying the same plist; do not alter its arguments
        // or fall back to a different registration path.
        await wait(250 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

async function runLaunchctl(args: string[]): Promise<void> {
  await runProcess("/bin/launchctl", args);
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with status ${code ?? "unknown"}.`));
      }
    });
  });
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
