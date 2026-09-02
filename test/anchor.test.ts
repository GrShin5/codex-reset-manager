import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnchorExecutor, advancedTargetResetWindowIds, didAdvanceTargetReset } from "../src/anchor.js";
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "safety_abort");
  assert.equal(client.interruptCalls, 1);
});

test("refuses a non-ephemeral response without persistent fallback", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.thread = { id: "persistent", ephemeral: false, path: "/tmp/rollout", model: "gpt-5.6-luna", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.turnCalls, 0);
});

test("refuses a thread response that differs from the selected fallback route", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.models = [{ slug: "gpt-5.4-mini", supportedReasoningEfforts: ["none"] }];
  client.thread = { id: "rerouted", ephemeral: true, path: null, model: "gpt-5.5", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "verified");
  assert.equal(client.turnCalls, 1);
  assert.equal(client.interruptCalls, 0);
});

test("rejects a partial turn route echo even when its model matches", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.turn = { id: "turn_partial", status: "inProgress", model: "gpt-5.6-luna" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.turnCalls, 1);
  assert.equal(client.interruptCalls, 1);
});

test("interrupts and rejects a turn response that explicitly differs from the selected route", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.turn = { id: "turn_mismatch", status: "inProgress", model: "gpt-5.4-mini", reasoningEffort: "low" };
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
  const result = await executor.run();
  assert.equal(result.status, "rejected");
  assert.equal(client.threadCalls, 0);
  assert.equal(client.turnCalls, 0);
});

test("rejects a provider reroute instead of accepting a fallback model", async () => {
  const { paths, logger } = await testContext();
  const client = new FakeAppServer([rateLimits({ usedPercent: 0, duration: 300, resetsAt: 1_000 })]);
  client.emitModelRerouted = true;
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
  const executor = new AnchorExecutor(client, paths, { ...DEFAULT_CONFIG, verificationDelaySeconds: 0 }, logger);
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
