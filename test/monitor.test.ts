import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveState } from "../src/files.js";
import { Logger } from "../src/logger.js";
import { UsageMonitor } from "../src/monitor.js";
import { resolveAppPaths } from "../src/paths.js";
import type { ManagerState, RateLimitReadResult } from "../src/types.js";
import { DEFAULT_CONFIG, emptyState } from "../src/types.js";
import { normalizeRateLimits } from "../src/windows.js";
import { FakeAppServer, rateLimits } from "./helpers.js";

const silentNotifier = async (): Promise<void> => undefined;

function recordingNotifier(target: Array<{ title: string; message: string }>): (title: string, message: string) => Promise<void> {
  return async (title, message) => {
    target.push({ title, message });
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for monitor activity.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function automaticState(before: RateLimitReadResult, ready = false): ManagerState {
  const state = emptyState();
  const snapshot = normalizeRateLimits(before);
  const targetIds = snapshot.windows.filter((window) => window.kind !== "unknown").map((window) => window.id);
  state.autoAnchorEnabled = true;
  state.manualAnchor = ready
    ? { status: "ready", completedAt: Date.now(), detail: "fixture", baselineWindowIds: targetIds }
    : { status: "verified", completedAt: Date.now(), detail: "fixture" };
  for (const window of snapshot.windows) {
    state.windows[window.id] = {
      ...window,
      observedAt: Date.now(),
      verifiedResetAt: window.resetsAt,
      baselineEvidence: ready ? "manual_ready" : "verified_advance",
      lastAnchorGeneration: "manual",
    };
  }
  return state;
}

function fiveHourRollover(): {
  before: RateLimitReadResult;
  zero: RateLimitReadResult;
  positive: RateLimitReadResult;
  after: RateLimitReadResult;
} {
  const baseline = Math.floor(Date.now() / 1_000) - 10;
  return {
    before: rateLimits({ usedPercent: 60, duration: 300, resetsAt: baseline }),
    zero: rateLimits({ usedPercent: 0, duration: 300, resetsAt: baseline + 18_000 }),
    positive: rateLimits({ usedPercent: 1, duration: 300, resetsAt: baseline + 18_000 }),
    after: rateLimits({ usedPercent: 1, duration: 300, resetsAt: baseline + 36_000 }),
  };
}

test("coalesces simultaneous zero-use 5-hour and weekly rollovers into one selected-route turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-zero-rollover-"));
  const paths = resolveAppPaths(root);
  const baseline = Math.floor(Date.now() / 1_000) - 10;
  const before = rateLimits(
    { usedPercent: 60, duration: 300, resetsAt: baseline },
    { usedPercent: 60, duration: 10_080, resetsAt: baseline },
  );
  const zero = rateLimits(
    { usedPercent: 0, duration: 300, resetsAt: baseline + 18_000 },
    { usedPercent: 0, duration: 10_080, resetsAt: baseline + 604_800 },
  );
  const after = rateLimits(
    { usedPercent: 1, duration: 300, resetsAt: baseline + 36_000 },
    { usedPercent: 1, duration: 10_080, resetsAt: baseline + 1_209_600 },
  );
  const state = automaticState(before);
  await saveState(paths, state);
  const client = new FakeAppServer([zero, zero, zero, after]);
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const notifications: Array<{ title: string; message: string }> = [];
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), recordingNotifier(notifications));
  try {
    await monitor.start();
    await waitUntil(() => client.turnCalls === 1 && Object.values(monitor.getState().anchors).every((record) => record.status === "verified"));
    assert.equal(client.threadCalls, 1);
    assert.equal(client.turnCalls, 1);
    assert.equal(Object.values(monitor.getState().anchors).length, 2);
    assert.deepEqual(notifications, [{
      title: "Codex usage window anchor verified",
      message: "A guarded gpt-5.6-luna / low anchor turn verified the 5-hour and the weekly usage windows.",
    }]);
  } finally {
    await monitor.stop();
  }
});

test("a ready manual baseline also requires a zero-use post-reset snapshot before one turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-ready-zero-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before, true);
  await saveState(paths, state);
  const client = new FakeAppServer([fixtures.zero, fixtures.zero, fixtures.zero, fixtures.after]);
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => client.turnCalls === 1 && Object.values(monitor.getState().anchors)[0]?.status === "verified");
    assert.equal(client.threadCalls, 1);
    assert.equal(client.turnCalls, 1);
  } finally {
    await monitor.stop();
  }
});

test("positive new-window usage is recorded as skipped and never starts a thread or turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-positive-skip-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before);
  await saveState(paths, state);
  const client = new FakeAppServer([fixtures.positive]);
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    const records = Object.values(monitor.getState().anchors);
    assert.equal(client.threadCalls, 0);
    assert.equal(client.turnCalls, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "skipped");
    assert.match(records[0]?.detail ?? "", /above 0%/);
    assert.equal(monitor.getState().windows["codex:primary:300"]?.baselineEvidence, "external_usage");
  } finally {
    await monitor.stop();
  }
});

test("a preflight re-check cancels when external usage appears during coalescing", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-race-skip-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before);
  await saveState(paths, state);
  const client = new FakeAppServer([fixtures.zero, fixtures.positive]);
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0.05, verificationDelaySeconds: 0 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => Object.values(monitor.getState().anchors).some((record) => record.status === "skipped"));
    assert.equal(client.threadCalls, 0);
    assert.equal(client.turnCalls, 0);
  } finally {
    await monitor.stop();
  }
});

test("weekly-only zero-use rollover selects the lowest available fallback route", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-weekly-zero-"));
  const paths = resolveAppPaths(root);
  const baseline = Math.floor(Date.now() / 1_000) - 10;
  const before = rateLimits(null, { usedPercent: 60, duration: 10_080, resetsAt: baseline });
  const zero = rateLimits(null, { usedPercent: 0, duration: 10_080, resetsAt: baseline + 604_800 });
  const after = rateLimits(null, { usedPercent: 1, duration: 10_080, resetsAt: baseline + 1_209_600 });
  const state = automaticState(before);
  await saveState(paths, state);
  const client = new FakeAppServer([zero, zero, zero, after]);
  client.models = [{ slug: "gpt-5.4-mini", supportedReasoningEfforts: ["none", "medium"] }];
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => client.turnCalls === 1 && Object.values(monitor.getState().anchors)[0]?.status === "verified");
    assert.deepEqual(client.threadRoutes, [{ model: "gpt-5.4-mini", effort: "none" }]);
    assert.deepEqual(client.turnRoutes, [{ model: "gpt-5.4-mini", effort: "none" }]);
    assert.equal(Object.values(monitor.getState().windows).filter((window) => window.kind === "five_hour").length, 0);
  } finally {
    await monitor.stop();
  }
});

test("preserves existing tool and route safety guards after a zero-use candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-safety-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before);
  await saveState(paths, state);
  const client = new FakeAppServer([fixtures.zero, fixtures.zero, fixtures.zero]);
  client.emitToolItem = true;
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const notifications: Array<{ title: string; message: string }> = [];
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), recordingNotifier(notifications));
  try {
    await monitor.start();
    await waitUntil(() => client.turnCalls === 1 && Object.values(monitor.getState().anchors)[0]?.status === "safety_abort");
    assert.equal(notifications.length, 0);
  } finally {
    await monitor.stop();
  }
});

test("no advertised route still rejects before thread/start or turn/start", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-route-gate-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before);
  await saveState(paths, state);
  const client = new FakeAppServer([fixtures.zero, fixtures.zero, fixtures.zero]);
  client.models = [];
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => Object.values(monitor.getState().anchors)[0]?.status === "rejected");
    assert.equal(client.threadCalls, 0);
    assert.equal(client.turnCalls, 0);
  } finally {
    await monitor.stop();
  }
});

test("a persisted verified result prevents a second turn after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-restart-"));
  const paths = resolveAppPaths(root);
  const fixtures = fiveHourRollover();
  const state = automaticState(fixtures.before);
  await saveState(paths, state);
  const config = { ...DEFAULT_CONFIG, resetGraceSeconds: 0, coalesceSeconds: 0, verificationDelaySeconds: 0 };
  const first = new FakeAppServer([fixtures.zero, fixtures.zero, fixtures.zero, fixtures.after]);
  const monitor = new UsageMonitor(first, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => first.turnCalls === 1 && Object.values(monitor.getState().anchors)[0]?.status === "verified");
  } finally {
    await monitor.stop();
  }

  const restartedState = automaticState(fixtures.before);
  const second = new FakeAppServer([fixtures.after]);
  const restarted = new UsageMonitor(second, paths, config, restartedState, new Logger(paths, config), silentNotifier);
  try {
    await restarted.start();
    assert.equal(second.threadCalls, 0);
    assert.equal(second.turnCalls, 0);
  } finally {
    await restarted.stop();
  }
});

test("sparse notifications and transient read failures remain passive and recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-passive-"));
  const paths = resolveAppPaths(root);
  const state = emptyState();
  await saveState(paths, state);
  const first = rateLimits({ usedPercent: 4, duration: 300, resetsAt: 1_000 });
  const second = rateLimits({ usedPercent: 5, duration: 300, resetsAt: 1_000 });
  const client = new FakeAppServer([first, second]);
  client.readFailuresRemaining = 1;
  const config = { ...DEFAULT_CONFIG, pollIntervalSeconds: 0.01 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  try {
    await monitor.start();
    await waitUntil(() => client.readCalls >= 2 && client.started);
    client.emit("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 99 } } });
    await waitUntil(() => client.readCalls >= 3);
    assert.equal(Object.values(monitor.getState().windows)[0]?.usedPercent, 5);
    assert.equal(client.turnCalls, 0);
  } finally {
    await monitor.stop();
  }
});

test("a corrupt state file does not create an unhandled rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-corrupt-"));
  const paths = resolveAppPaths(root);
  await writeFile(paths.stateFile, "{", "utf8");
  const state = emptyState();
  const client = new FakeAppServer([rateLimits({ usedPercent: 4, duration: 300, resetsAt: 1_000 })]);
  const config = { ...DEFAULT_CONFIG, pollIntervalSeconds: 60 };
  const monitor = new UsageMonitor(client, paths, config, state, new Logger(paths, config), silentNotifier);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    await monitor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rejections, []);
    assert.ok(client.readCalls >= 1);
  } finally {
    process.off("unhandledRejection", onRejection);
    await monitor.stop();
  }
});
