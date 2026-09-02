import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAppDirectories, loadConfig, loadState } from "../src/files.js";
import { resolveAppPaths } from "../src/paths.js";
import { emptyState } from "../src/types.js";
import { normalizeRateLimits } from "../src/windows.js";
import { rateLimits } from "./helpers.js";

test("ignores legacy fixed-route config values without widening the anchor policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-config-test-"));
  const paths = resolveAppPaths(root);
  await writeFile(paths.configFile, JSON.stringify({ anchorModel: "gpt-5.6-sol", anchorEffort: "high", pollIntervalSeconds: 0 }), "utf8");
  const config = await loadConfig(paths);
  assert.equal("anchorModel" in config, false);
  assert.equal("anchorEffort" in config, false);
  assert.equal(config.version, 1);
  assert.equal(config.pollIntervalSeconds, 60);
});

test("persists the affected ready legacy rollover state as a no-catch-up recovery baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-state-migration-test-"));
  const paths = resolveAppPaths(root);
  const now = Date.now();
  const resetAt = Math.floor(now / 1_000) + 3_600;
  const window = normalizeRateLimits(rateLimits({ usedPercent: 2, duration: 300, resetsAt: resetAt }), now).windows[0]!;
  const state = emptyState();
  state.manualAnchor = {
    status: "ready",
    completedAt: now,
    detail: "fixture",
    baselineWindowIds: [window.id],
  };
  state.windows[window.id] = {
    ...window,
    observedAt: now,
    verifiedResetAt: resetAt,
    baselineEvidence: "verified_advance",
    lastAnchorGeneration: "manual",
  };
  await writeFile(paths.stateFile, JSON.stringify(state), "utf8");

  const loaded = await loadState(paths);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.windows[window.id]?.baselineEvidence, "recovered_rollover");
  assert.equal(loaded.windows[window.id]?.verifiedResetAt, resetAt);
  assert.deepEqual(loaded.anchors, {});

  const persisted = JSON.parse(await readFile(paths.stateFile, "utf8")) as typeof loaded;
  assert.equal(persisted.windows[window.id]?.baselineEvidence, "recovered_rollover");
});

test("creates the application directories owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-modes-fresh-test-"));
  const paths = resolveAppPaths(join(root, "app"));
  await ensureAppDirectories(paths);
  for (const directory of [paths.root, paths.logsDirectory, paths.anchorWorkspace]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }
});

/**
 * mkdir/appendFile modes only apply at creation, so an installation made
 * before this change would keep group- and world-readable permissions
 * forever. ensureAppDirectories tightens them once on the next run.
 */
test("tightens an existing installation created with looser permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-modes-legacy-test-"));
  const paths = resolveAppPaths(join(root, "app"));
  await mkdir(paths.logsDirectory, { recursive: true });
  await writeFile(join(paths.logsDirectory, "events.jsonl"), "{}\n", "utf8");
  await chmod(paths.root, 0o755);
  await chmod(paths.logsDirectory, 0o755);
  await chmod(join(paths.logsDirectory, "events.jsonl"), 0o644);

  await ensureAppDirectories(paths);

  assert.equal((await stat(paths.root)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.logsDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(paths.logsDirectory, "events.jsonl"))).mode & 0o777, 0o600);
});

/**
 * CODEX_ANCHOR_HOME is arbitrary user input, so the permission sweep must
 * never become a way to chmod files outside the app's own state. chmod
 * follows symlinks, so a link planted in the logs directory would otherwise
 * have its target tightened.
 */
test("never follows a symlink when tightening log permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-modes-symlink-test-"));
  const paths = resolveAppPaths(join(root, "app"));
  await mkdir(paths.logsDirectory, { recursive: true });

  const victim = join(root, "victim.txt");
  await writeFile(victim, "not ours\n", "utf8");
  await chmod(victim, 0o644);
  await symlink(victim, join(paths.logsDirectory, "events.planted.jsonl"));

  await ensureAppDirectories(paths);

  assert.equal((await stat(victim)).mode & 0o777, 0o644, "the symlink target must be untouched");
  assert.equal((await lstat(join(paths.logsDirectory, "events.planted.jsonl"))).isSymbolicLink(), true);
  // The app's own directories are still tightened.
  assert.equal((await stat(paths.logsDirectory)).mode & 0o777, 0o700);
});
