import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnchorExecutor, advancedTargetResetWindowIds, classifyVerificationSamples, didAdvanceTargetReset, minimumStabilitySpanMs } from "../src/anchor.js";
import { Logger } from "../src/logger.js";
import { resolveAppPaths } from "../src/paths.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { normalizeRateLimits } from "../src/windows.js";
import { FakeAppServer, rateLimits } from "./helpers.js";

async function testContext(): Promise<{ paths: ReturnType<typeof resolveAppPaths>; logger: Logger }> {
  const root = await mkdtemp(join(tmpdir(), "codex-anchor-test-"));
  const paths = resolveAppPaths(root);
  return { paths, logger: new Logger(paths, DEFAULT_CONFIG) };
}

test("verifies the lowest-cost advertised route from a timestamp advance", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const started: Array<{ threadId: string; turnId: string; targetWindowIds: string[]; route: { model: string; effort: string } }> = [];
  const result = await executor.run(undefined, async (event) => {
    started.push(event);
  });
  assert.equal(result.status, "verified");
  assert.equal(client.threadCalls, 1);
  assert.equal(client.turnCalls, 1);
  assert.deepEqual(result.route, { model: "gpt-5.6-luna", effort: "low" });
  assert.deepEqual(client.threadRoutes, [{ model: "gpt-5.6-luna", effort: "low" }]);
  assert.deepEqual(client.turnRoutes, [{ model: "gpt-5.6-luna", effort: "low" }]);
  assert.deepEqual(started, [{
    threadId: "thread_anchor",
    turnId: "turn_anchor",
    targetWindowIds: ["codex:primary:300"],
    route: { model: "gpt-5.6-luna", effort: "low" },
  }]);
});

test("does not treat an advanced but already past reset timestamp as verified", () => {
  const before = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 }), 100);
  const after = normalizeRateLimits(rateLimits({ usedPercent: 1, duration: 300, resetsAt: 2_000 }), 200);
  assert.equal(didAdvanceTargetReset(before, after, undefined, 3_000_000), false);
});

test("interrupts a tool-like anchor event and does not verify it", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.emitToolItem = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  let notificationCount = 0;
  const result = await executor.run(undefined, async () => {
    notificationCount += 1;
  });
  assert.equal(result.status, "safety_abort");
  assert.equal(client.interruptCalls, 1);
  assert.equal(notificationCount, 0);
});

test("interrupts an approval request and does not verify it", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.emitApprovalRequest = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "safety_abort");
  assert.equal(client.interruptCalls, 1);
});

test("refuses a non-ephemeral response without persistent fallback", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.thread = { id: "persistent", ephemeral: false, path: "/tmp/rollout", model: "gpt-5.6-luna", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.turnCalls, 0);
});

test("refuses a thread response that differs from the selected fallback route", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.models = [{ slug: "gpt-5.4-mini", supportedReasoningEfforts: ["none"] }];
  client.thread = { id: "rerouted", ephemeral: true, path: null, model: "gpt-5.5", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.route, { model: "gpt-5.4-mini", effort: "none" });
  assert.equal(client.turnCalls, 0);
});

test("uses the first known fallback and sends the same route to thread and turn", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  client.models = [
    { slug: "gpt-5.6-sol", supportedReasoningEfforts: ["low"] },
    { slug: "gpt-5.4-mini", supportedReasoningEfforts: ["ultra", "medium", "none"] },
    { slug: "unknown-experimental", supportedReasoningEfforts: ["none"] },
  ];
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "verified");
  assert.deepEqual(result.route, { model: "gpt-5.4-mini", effort: "none" });
  assert.deepEqual(client.threadRoutes, [{ model: "gpt-5.4-mini", effort: "none" }]);
  assert.deepEqual(client.turnRoutes, [{ model: "gpt-5.4-mini", effort: "none" }]);
});

test("refuses to start a thread or turn when no known safe route is advertised", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.models = [
    { slug: "unknown-experimental", supportedReasoningEfforts: ["none"] },
    { slug: "gpt-5.6-luna", supportedReasoningEfforts: ["ultra"] },
    { slug: "gpt-5.4-mini" },
  ];
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(result.route, null);
  assert.equal(client.threadCalls, 0);
  assert.equal(client.turnCalls, 0);
});

test("accepts a turn acknowledgement that omits the route after the exact thread confirmation", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  client.turn = { id: "turn_without_route", status: "inProgress" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "verified");
  assert.equal(client.turnCalls, 1);
  assert.equal(client.interruptCalls, 0);
});

test("rejects a partial turn route echo even when its model matches", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.turn = { id: "turn_partial", status: "inProgress", model: "gpt-5.6-luna" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.turnCalls, 1);
  assert.equal(client.interruptCalls, 1);
});

test("interrupts and rejects a turn response that explicitly differs from the selected route", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.turn = { id: "turn_mismatch", status: "inProgress", model: "gpt-5.4-mini", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.turnCalls, 1);
  assert.equal(client.interruptCalls, 1);
});

test("does not let a start-notification delivery failure change the anchor result", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run(undefined, async () => {
    throw new Error("macOS notification unavailable");
  });
  assert.equal(result.status, "verified");
  assert.equal(client.turnCalls, 1);
});

test("refuses an anchor when the dedicated workspace is not empty", async () => {
  const { paths, logger } = await testContext();
  await mkdir(paths.anchorWorkspace, { recursive: true });
  await writeFile(join(paths.anchorWorkspace, "unexpected.txt"), "do not inherit this workspace", "utf8");
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.threadCalls, 0);
  assert.equal(client.turnCalls, 0);
});

test("rejects a provider reroute instead of accepting a fallback model", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.emitModelRerouted = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.interruptCalls, 1);
});

/**
 * The safety signal arrives AFTER the turn is acknowledged,
 * which is the only ordering the real transport produces. The notification must
 * still never fire for a run that ends in safety_abort.
 */
test("does not notify when a tool-like item arrives after the turn is acknowledged", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  client.emitToolItem = true;
  client.emitSafetyAsync = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  let notificationCount = 0;
  const result = await executor.run(undefined, async () => {
    notificationCount += 1;
  });
  assert.equal(result.status, "safety_abort");
  assert.equal(notificationCount, 0);
});

test("does not notify when a provider reroute arrives after the turn is acknowledged", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  client.turn = { id: "turn_anchor", status: "inProgress" };
  client.emitModelRerouted = true;
  client.emitSafetyAsync = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  let notificationCount = 0;
  const result = await executor.run(undefined, async () => {
    notificationCount += 1;
  });
  assert.equal(result.status, "rejected");
  assert.equal(notificationCount, 0);
});

/** The turn completed but the reset never advanced: still silent. */
test("does not notify when the turn completes without a verified reset advance", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
  ]);
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  let notificationCount = 0;
  const result = await executor.run(undefined, async () => {
    notificationCount += 1;
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.turnCompletedSafely, true);
  assert.deepEqual(result.targetWindowIds, ["codex:primary:300"]);
  assert.equal(notificationCount, 0);
});

/** A notifier that never resolves must not deadlock the anchor. */
test("does not let a hanging notification handler block the anchor result", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 3_600 }),
    rateLimits({ usedPercent: 1, duration: 300, resetsAt: nowSeconds + 7_200 }),
  ]);
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationSampleIntervalSeconds: 0, verificationDelaySeconds: 0 }, logger);
  const startedAt = Date.now();
  const result = await executor.run(undefined, () => new Promise<void>(() => undefined));
  assert.equal(result.status, "verified");
  assert.ok(Date.now() - startedAt < 30_000, "the hanging handler must not hold the anchor for the full turn timeout");
});

/** Verification is per window, not one boolean for the batch. */
test("reports only the windows whose reset actually advanced", () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const before = normalizeRateLimits(rateLimits(
    { usedPercent: 80, duration: 300, resetsAt: nowSeconds + 100 },
    { usedPercent: 70, duration: 10_080, resetsAt: nowSeconds + 200 },
  ));
  const after = normalizeRateLimits(rateLimits(
    { usedPercent: 1, duration: 300, resetsAt: nowSeconds + 18_100 },
    { usedPercent: 70, duration: 10_080, resetsAt: nowSeconds + 200 },
  ));
  const advanced = advancedTargetResetWindowIds(before, after);
  assert.deepEqual(advanced, ["codex:primary:300"]);
  assert.equal(didAdvanceTargetReset(before, after), true);
});

/**
 * The sliding-timestamp problem, in one place. An uninitialized window can
 * report resetsAt as `now + duration`, recomputed on every read, so a single
 * "did it advance" comparison is satisfied by the clock alone. These pin the
 * discriminator: drift measured against elapsed wall-clock time.
 */
function snapshotAt(observedAtMs: number, resetsAt: number, usedPercent = 0) {
  return normalizeRateLimits(rateLimits({ usedPercent, duration: 300, resetsAt }), observedAtMs);
}

test("verifies a window whose advanced reset timestamp then holds steady", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  const anchored = nowSeconds + 18_000;
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [snapshotAt(nowMs + 5_000, anchored), snapshotAt(nowMs + 15_000, anchored), snapshotAt(nowMs + 25_000, anchored)],
    ["codex:primary:300"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "advanced_stable");
  assert.deepEqual(verifiedWindowIds, ["codex:primary:300"]);
});

test("refuses to verify a reset timestamp that slides with the clock", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  // Each read returns now + 7 days, so the value advances purely with time.
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [
      snapshotAt(nowMs + 5_000, nowSeconds + 5 + 604_800),
      snapshotAt(nowMs + 15_000, nowSeconds + 15 + 604_800),
      snapshotAt(nowMs + 25_000, nowSeconds + 25 + 604_800),
    ],
    ["codex:primary:300"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "sliding");
  assert.deepEqual(verifiedWindowIds, [], "a sliding window must never be verified");
});

test("treats a not-yet-settled reset timestamp as indeterminate", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  const anchored = nowSeconds + 18_000;
  // Moves once by 3s, then holds: neither steady nor tracking the clock.
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [snapshotAt(nowMs + 5_000, anchored), snapshotAt(nowMs + 15_000, anchored + 3), snapshotAt(nowMs + 25_000, anchored + 3)],
    ["codex:primary:300"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "indeterminate");
  assert.deepEqual(verifiedWindowIds, []);
});

test("cannot judge stability from a single sample", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [snapshotAt(nowMs + 5_000, nowSeconds + 18_000)],
    ["codex:primary:300"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "indeterminate");
  assert.deepEqual(verifiedWindowIds, []);
});

test("separates a steady timestamp that never advanced from one that did", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const unchanged = nowSeconds + 600;
  const before = snapshotAt(nowMs, unchanged);
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [snapshotAt(nowMs + 5_000, unchanged), snapshotAt(nowMs + 15_000, unchanged)],
    ["codex:primary:300"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "not_advanced");
  assert.deepEqual(verifiedWindowIds, []);
});

/** A coalesced batch gets one verdict per window, not one for the batch. */
test("verifies only the stable window when a coalesced batch mixes both", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const anchored = nowSeconds + 18_000;
  const snapshot = (offsetMs: number, weeklyResetsAt: number) => normalizeRateLimits(
    rateLimits(
      { usedPercent: 0, duration: 300, resetsAt: anchored },
      { usedPercent: 0, duration: 10_080, resetsAt: weeklyResetsAt },
    ),
    nowMs + offsetMs,
  );
  const before = normalizeRateLimits(
    rateLimits(
      { usedPercent: 0, duration: 300, resetsAt: nowSeconds + 600 },
      { usedPercent: 0, duration: 10_080, resetsAt: nowSeconds + 600 },
    ),
    nowMs,
  );
  const { verdicts, verifiedWindowIds } = classifyVerificationSamples(
    before,
    [
      snapshot(5_000, nowSeconds + 5 + 604_800),
      snapshot(15_000, nowSeconds + 15 + 604_800),
      snapshot(25_000, nowSeconds + 25 + 604_800),
    ],
    ["codex:primary:300", "codex:secondary:10080"],
    nowMs,
  );
  assert.equal(verdicts["codex:primary:300"], "advanced_stable");
  assert.equal(verdicts["codex:secondary:10080"], "sliding");
  assert.deepEqual(verifiedWindowIds, ["codex:primary:300"]);
});

/**
 * End-to-end through the executor: a backend that keeps recomputing resetsAt
 * as `now + 7 days` must not produce a verified anchor, a baseline write, or a
 * success notification -- which is exactly what the old single-sample check
 * would have done.
 */
test("does not report a verified anchor when the backend keeps recomputing the reset", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 10_080, resetsAt: nowSeconds + 60 }),
    rateLimits({ usedPercent: 0, duration: 10_080, resetsAt: nowSeconds + 604_800 }),
    rateLimits({ usedPercent: 0, duration: 10_080, resetsAt: nowSeconds + 604_830 }),
    rateLimits({ usedPercent: 0, duration: 10_080, resetsAt: nowSeconds + 604_860 }),
  ]);
  const executor = new AnchorExecutor(
    client,
    paths,
    { ...DEFAULT_CONFIG, verificationDelaySeconds: 0, verificationSampleIntervalSeconds: 0.02 },
    logger,
  );
  let notified = 0;
  const result = await executor.run(undefined, async () => {
    notified += 1;
  });

  assert.equal(result.status, "unverified");
  assert.deepEqual(result.verifiedWindowIds, []);
  assert.equal(result.verificationVerdicts?.["codex:primary:10080"], "sliding");
  assert.equal(notified, 0, "a sliding window must not announce success");
  assert.match(result.detail, /sliding with wall-clock time/);
  // One pre-turn read plus one per sample.
  assert.equal(client.readCalls, 1 + DEFAULT_CONFIG.verificationSampleCount);
  assert.equal(client.turnCalls, 1, "the turn still ran exactly once");
});

/**
 * Losing the App Server part-way through sampling must degrade to a
 * non-verified verdict, not throw: the turn already happened, and the
 * generation must still be recorded rather than retried.
 */
test("classifies from the samples it has when a later rate-limit read fails", async () => {
  const { paths, logger } = await testContext();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const client = new FakeAppServer([
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 60 }),
    rateLimits({ usedPercent: 0, duration: 300, resetsAt: nowSeconds + 18_000 }),
  ]);
  const executor = new AnchorExecutor(
    client,
    paths,
    { ...DEFAULT_CONFIG, verificationDelaySeconds: 0, verificationSampleIntervalSeconds: 0 },
    logger,
  );
  // Let the pre-turn read and the first sample through, then fail the rest.
  const readRateLimits = client.readRateLimits.bind(client);
  let reads = 0;
  client.readRateLimits = async () => {
    reads += 1;
    if (reads > 2) {
      throw new Error("fixture App Server disconnect");
    }
    return readRateLimits();
  };

  const result = await executor.run();

  assert.equal(result.turnCompletedSafely, true, "the turn itself completed; only verification was cut short");
  assert.equal(result.status, "unverified", "one surviving sample cannot establish stability");
  assert.deepEqual(result.verifiedWindowIds, []);
  assert.equal(result.verificationVerdicts?.["codex:primary:300"], "indeterminate");
  assert.notEqual(result.after, null, "the sample collected before the failure is still the result");
  assert.equal(reads, 3, "sampling stopped at the first failure rather than retrying");
});

/**
 * Boundary cases for the discriminator. The earlier sliding test clears the
 * threshold by three orders of magnitude, so it does not actually constrain
 * where the line sits; these do.
 */
test("holds the stability tolerance and the sliding threshold at their boundaries", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  const anchored = nowSeconds + 18_000;
  const id = "codex:primary:300";
  // 20s of real span, so a 12s minimum is satisfied for the stable cases.
  const classify = (values: number[]) => classifyVerificationSamples(
    before,
    values.map((resetsAt, index) => snapshotAt(nowMs + 5_000 + index * 10_000, resetsAt)),
    [id],
    nowMs,
    12_000,
  ).verdicts[id];

  // 1s of jitter is within tolerance -- the live backend really does this.
  assert.equal(classify([anchored, anchored + 1, anchored + 1]), "advanced_stable");
  // 2s over a 20s span: past tolerance, far short of tracking the clock.
  assert.equal(classify([anchored, anchored + 1, anchored + 2]), "indeterminate");
  // 10s over a 20s span is exactly the 0.5x threshold.
  assert.equal(classify([anchored, anchored + 5, anchored + 10]), "sliding");
  // Non-monotonic drift is never called sliding, however large.
  assert.equal(classify([anchored, anchored + 18, anchored + 12]), "indeterminate");
});

/**
 * Identical values prove nothing if they could all have come from one cached
 * read, so a series that was not actually spread across the intended span
 * must not verify.
 */
test("refuses to call a timestamp steady when the samples were taken too close together", () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const before = snapshotAt(nowMs, nowSeconds + 600);
  const anchored = nowSeconds + 18_000;
  const samples = [snapshotAt(nowMs + 100, anchored), snapshotAt(nowMs + 200, anchored)];

  assert.equal(
    classifyVerificationSamples(before, samples, ["codex:primary:300"], nowMs, 30_000).verdicts["codex:primary:300"],
    "indeterminate",
  );
  // The same series over a span that satisfies the minimum does verify.
  assert.equal(
    classifyVerificationSamples(before, samples, ["codex:primary:300"], nowMs, 0).verdicts["codex:primary:300"],
    "advanced_stable",
  );
});

test("derives the minimum proven span from the configured sampling", () => {
  assert.equal(minimumStabilitySpanMs({ verificationSampleCount: 4, verificationSampleIntervalSeconds: 15 }), 27_000);
  assert.equal(minimumStabilitySpanMs({ verificationSampleCount: 1, verificationSampleIntervalSeconds: 15 }), 0);
  assert.equal(minimumStabilitySpanMs({ verificationSampleCount: 4, verificationSampleIntervalSeconds: 0 }), 0);
});
