import { homedir } from "node:os";
import { join } from "node:path";

import type { AppPaths } from "./types.js";

export function resolveAppPaths(rootOverride = process.env.CODEX_ANCHOR_HOME): AppPaths {
  const root = rootOverride ?? join(homedir(), "Library", "Application Support", "Codex Reset Manager");
  return {
    root,
    logsDirectory: join(root, "logs"),
    anchorWorkspace: join(root, "anchor-workspace"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    lockDirectory: join(root, "daemon.lock"),
    anchorLockDirectory: join(root, "anchor.lock"),
    launchAgentFile: join(homedir(), "Library", "LaunchAgents", "com.codex-reset-manager.plist"),
    stdoutLog: join(root, "logs", "launchd.stdout.log"),
    stderrLog: join(root, "logs", "launchd.stderr.log"),
  };
}
