import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, loadState } from "../src/files.js";
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
