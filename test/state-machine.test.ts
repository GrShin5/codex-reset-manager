import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAnchorResult,
  claimCandidates,
  manualAnchorAllowsAutoAnchoring,
  manualAnchorAllowsEnable,
  migrateLegacyRolloverState,
  nextScheduledWakeAt,
  observeSnapshot,
  recordManualAnchor,
} from "../src/state-machine.js";
import type { AnchorRunResult, ManagerState, NormalizedSnapshot } from "../src/types.js";
import { DEFAULT_CONFIG, emptyState } from "../src/types.js";
import { normalizeRateLimits } from "../src/windows.js";
import { rateLimits } from "./helpers.js";

const FIVE_HOUR_CYCLE_SECONDS = 18_000;
const BASELINE_SECONDS = 1_000;
const BEFORE_BOUNDARY_MS = 1_004_000;
const AFTER_BOUNDARY_MS = 1_006_000;

function seededFiveHourState(): { state: ManagerState; windowId: string } {
  const state = emptyState();
  const snapshot = normalizeRateLimits(
    rateLimits({ usedPercent: 60, duration: 300, resetsAt: BASELINE_SECONDS }),
    BEFORE_BOUNDARY_MS,
  );
  const window = snapshot.windows[0];
  if (window === undefined) {
    throw new Error("fixture did not expose a five-hour window");
  }
  state.windows[window.id] = {
    ...window,
    observedAt: BEFORE_BOUNDARY_MS,
    verifiedResetAt: BASELINE_SECONDS,
    baselineEvidence: "manual_ready",
    lastAnchorGeneration: "manual",
  };
  return { state, windowId: window.id };
}

function postResetFiveHour(usedPercent: number | null, resetsAt = BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS): NormalizedSnapshot {
  return normalizeRateLimits(
    rateLimits({ usedPercent, duration: 300, resetsAt }),
    AFTER_BOUNDARY_MS,
  );
}

function completedResult(
  before: NormalizedSnapshot,
  after: NormalizedSnapshot | null,
  status: AnchorRunResult["status"] = "verified",
): AnchorRunResult {
  return {
    status,
    detail: status === "verified" ? "verified" : "not verified",
    before,
    after,
    threadId: "thread_anchor",
    route: { model: "gpt-5.6-luna", effort: "low" },
    targetWindowIds: before.windows.filter((window) => window.kind !== "unknown").map((window) => window.id),
    turnCompletedSafely: status === "verified" || status === "unverified",
    verifiedWindowIds: status === "verified" ? before.windows.filter((window) => window.kind !== "unknown").map((window) => window.id) : [],
    // Production always sets verdicts alongside turnCompletedSafely, so a
    // fixture that omits them would not describe any reachable state.
    verificationVerdicts: Object.fromEntries(
      before.windows
        .filter((window) => window.kind !== "unknown")
        .map((window) => [window.id, status === "verified" ? "advanced_stable" : "not_advanced"] as const),
    ),
  };
}

test("a fresh natural rollover with 0% usage preserves the old boundary and creates one candidate", () => {
  const { state, windowId } = seededFiveHourState();

  const candidates = observeSnapshot(state, postResetFiveHour(0), DEFAULT_CONFIG);

  assert.deepEqual(candidates, [{
    generation: `scheduled:${windowId}:${BASELINE_SECONDS}`,
    windowId,
    baselineResetAt: BASELINE_SECONDS,
    reason: "scheduled",
  }]);
  assert.equal(state.windows[windowId]?.verifiedResetAt, BASELINE_SECONDS);
  assert.equal(state.anchors[candidates[0]!.generation], undefined);

  claimCandidates(state, candidates);
  assert.equal(observeSnapshot(state, postResetFiveHour(0), DEFAULT_CONFIG).length, 0);
});

test("a fresh newer reset timestamp need not equal an exact fixed-duration delta", () => {
  const { state } = seededFiveHourState();
  const candidates = observeSnapshot(state, postResetFiveHour(0, BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS + 2_500), DEFAULT_CONFIG);
  assert.equal(candidates.length, 1);
});

test("positive usage in the new reset window is durably skipped without a candidate", () => {
  const { state, windowId } = seededFiveHourState();

  assert.deepEqual(observeSnapshot(state, postResetFiveHour(1), DEFAULT_CONFIG), []);
  const record = Object.values(state.anchors)[0];
  assert.equal(record?.status, "skipped");
  assert.match(record?.detail ?? "", /above 0%/);
  assert.equal(state.windows[windowId]?.verifiedResetAt, BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS);
  assert.equal(state.windows[windowId]?.baselineEvidence, "external_usage");
});

test("unknown, delayed, and multi-cycle observations fail closed without a model candidate", () => {
  const missing = seededFiveHourState().state;
  assert.deepEqual(observeSnapshot(missing, postResetFiveHour(null), DEFAULT_CONFIG), []);
  assert.equal(Object.values(missing.anchors)[0]?.status, "skipped");

  const delayed = seededFiveHourState().state;
  delayed.windows["codex:primary:300"]!.observedAt = 500_000;
  assert.deepEqual(observeSnapshot(delayed, postResetFiveHour(0), DEFAULT_CONFIG), []);
  assert.match(Object.values(delayed.anchors)[0]?.detail ?? "", /too late/);

  const multiCycle = seededFiveHourState().state;
  multiCycle.windows["codex:primary:300"]!.observedAt = 500_000;
  assert.deepEqual(observeSnapshot(multiCycle, postResetFiveHour(0, BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS * 2), DEFAULT_CONFIG), []);
  assert.equal(multiCycle.windows["codex:primary:300"]?.baselineEvidence, "recovered_rollover");
});

test("a timestamp that has not rolled over never becomes a scheduled candidate", () => {
  const { state } = seededFiveHourState();
  assert.deepEqual(observeSnapshot(state, postResetFiveHour(0, BASELINE_SECONDS), DEFAULT_CONFIG), []);
  assert.equal(Object.values(state.anchors)[0]?.status, "skipped");
});

test("simultaneous 5-hour and weekly zero-use rollovers create one candidate per window", () => {
  const state = emptyState();
  const previous = normalizeRateLimits(rateLimits(
    { usedPercent: 60, duration: 300, resetsAt: BASELINE_SECONDS },
    { usedPercent: 60, duration: 10_080, resetsAt: BASELINE_SECONDS },
  ), BEFORE_BOUNDARY_MS);
  for (const window of previous.windows) {
    state.windows[window.id] = {
      ...window,
      observedAt: BEFORE_BOUNDARY_MS,
      verifiedResetAt: BASELINE_SECONDS,
      baselineEvidence: "manual_ready",
      lastAnchorGeneration: "manual",
    };
  }
  const candidates = observeSnapshot(state, normalizeRateLimits(rateLimits(
    { usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS + 18_000 },
    { usedPercent: 0, duration: 10_080, resetsAt: BASELINE_SECONDS + 604_800 },
  ), AFTER_BOUNDARY_MS), DEFAULT_CONFIG);

  assert.equal(candidates.length, 2);
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.windowId)), new Set(["codex:primary:300", "codex:secondary:10080"]));
});

test("a completed guarded turn alone is not enough: applyAnchorResult advances only strict verified targets", () => {
  const { state, windowId } = seededFiveHourState();
  const before = postResetFiveHour(0);
  const candidates = observeSnapshot(state, before, DEFAULT_CONFIG);
  claimCandidates(state, candidates);

  const after = postResetFiveHour(1, BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS * 2);
  applyAnchorResult(state, candidates, completedResult(before, after));

  assert.equal(state.anchors[candidates[0]!.generation]?.status, "verified");
  assert.equal(state.windows[windowId]?.verifiedResetAt, BASELINE_SECONDS + FIVE_HOUR_CYCLE_SECONDS * 2);
  assert.equal(state.windows[windowId]?.baselineEvidence, "verified_advance");
});

function safeCompletedStableResult(before: NormalizedSnapshot, after: NormalizedSnapshot): AnchorRunResult {
  return {
    ...completedResult(before, after, "unverified"),
    turnCompletedSafely: true,
  };
}

test("a stable future manual baseline becomes ready, but needs a fresh 0% rollover before scheduling", () => {
  const state = emptyState();
  const before = normalizeRateLimits(rateLimits({ usedPercent: 58, duration: 300, resetsAt: BASELINE_SECONDS }), 100);
  const after = normalizeRateLimits(rateLimits({ usedPercent: 59, duration: 300, resetsAt: BASELINE_SECONDS }), 200);
  const manual = recordManualAnchor(state, safeCompletedStableResult(before, after));
  const window = after.windows[0]!;

  assert.equal(manual.status, "ready");
  assert.equal(manualAnchorAllowsAutoAnchoring(state), true);
  assert.equal(manualAnchorAllowsEnable(state, 200), true);
  assert.equal(nextScheduledWakeAt(state, DEFAULT_CONFIG, 200), 1_005_000);
  state.windows[window.id]!.observedAt = BEFORE_BOUNDARY_MS;

  assert.equal(observeSnapshot(state, postResetFiveHour(0), DEFAULT_CONFIG).length, 1);
  assert.equal(manualAnchorAllowsEnable(state, 1_000_000), false);
});

test("partial manual adoption remains allowed while unsafe or legacy unverified results remain blocked", () => {
  const state = emptyState();
  const before = normalizeRateLimits(rateLimits(
    { usedPercent: 58, duration: 300, resetsAt: 1_000 },
    { usedPercent: 33, duration: 10_080, resetsAt: 2_000 },
  ), 100);
  const after = normalizeRateLimits(rateLimits(
    { usedPercent: 59, duration: 300, resetsAt: 1_000 },
    { usedPercent: 33, duration: 10_080, resetsAt: 1_999 },
  ), 200);
  const manual = recordManualAnchor(state, safeCompletedStableResult(before, after));
  assert.deepEqual(manual.baselineWindowIds, ["codex:primary:300"]);

  const unsafeState = emptyState();
  const unsafe = safeCompletedStableResult(before, after);
  unsafe.turnCompletedSafely = false;
  assert.equal(recordManualAnchor(unsafeState, unsafe).status, "unverified");
  assert.equal(manualAnchorAllowsEnable(unsafeState, 200), false);

  unsafeState.manualAnchor = { status: "unverified", completedAt: 300, detail: "legacy" };
  assert.equal(manualAnchorAllowsAutoAnchoring(unsafeState), false);
  assert.equal(manualAnchorAllowsEnable(unsafeState, 200), false);
});

test("the affected ready legacy state is re-baselined without a catch-up candidate", () => {
  const state = emptyState();
  const now = 1_000_000;
  const resetAt = Math.floor(now / 1_000) + 3_600;
  const window = normalizeRateLimits(rateLimits({ usedPercent: 2, duration: 300, resetsAt: resetAt }), now).windows[0]!;
  state.manualAnchor = {
    status: "ready",
    completedAt: now,
    detail: "safe manual result",
    baselineWindowIds: [window.id],
  };
  state.windows[window.id] = {
    ...window,
    observedAt: now,
    verifiedResetAt: resetAt,
    baselineEvidence: "verified_advance",
    lastAnchorGeneration: "manual",
  };

  assert.equal(migrateLegacyRolloverState(state, now), true);
  assert.equal(state.windows[window.id]?.baselineEvidence, "recovered_rollover");
  assert.equal(state.windows[window.id]?.verifiedResetAt, resetAt);
  assert.deepEqual(observeSnapshot(state, normalizeRateLimits(rateLimits({ usedPercent: 2, duration: 300, resetsAt: resetAt }), now + 1_000), DEFAULT_CONFIG), []);
  assert.equal(Object.keys(state.anchors).length, 0);
});

test("unknown windows remain permanently ineligible", () => {
  const state = emptyState();
  const unknown = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 1_440, resetsAt: 1_000 }), BEFORE_BOUNDARY_MS).windows[0]!;
  state.windows[unknown.id] = { ...unknown, observedAt: BEFORE_BOUNDARY_MS, verifiedResetAt: 1_000, lastAnchorGeneration: "manual" };
  assert.deepEqual(observeSnapshot(state, normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 1_440, resetsAt: 87_400 }), AFTER_BOUNDARY_MS), DEFAULT_CONFIG), []);
});

/**
 * A window whose reset timestamp tracks the clock is not a boundary, so it
 * must not become a scheduling baseline. Relabelling the evidence would not
 * have been enough: hasStoredBaseline gates on verifiedResetAt and never reads
 * baselineEvidence, so the adoption itself has to be refused.
 */
test("a manual anchor does not adopt a sliding window as a scheduling baseline", () => {
  const state = emptyState();
  const before = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS }), 100);
  // The timestamp is later than before -- the old check would have accepted it.
  const after = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS + 18_000 }), 200);
  const windowId = after.windows[0]!.id;
  const manual = recordManualAnchor(state, {
    ...safeCompletedStableResult(before, after),
    verificationVerdicts: { [windowId]: "sliding" },
  });

  assert.equal(state.windows[windowId], undefined, "no baseline may be stored for a sliding window");
  assert.notEqual(manual.status, "ready");
  assert.equal(manualAnchorAllowsAutoAnchoring(state), false);
  assert.equal(manualAnchorAllowsEnable(state, 200), false, "automation must stay closed");
});

/** The same run, without the sliding verdict, still adopts its baseline. */
test("a manual anchor still adopts a baseline when no window was sliding", () => {
  const state = emptyState();
  const before = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS }), 100);
  const after = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS + 18_000 }), 200);
  const windowId = after.windows[0]!.id;
  const manual = recordManualAnchor(state, {
    ...safeCompletedStableResult(before, after),
    verificationVerdicts: { [windowId]: "not_advanced" },
  });

  assert.equal(manual.status, "ready");
  assert.equal(state.windows[windowId]?.verifiedResetAt, BASELINE_SECONDS + 18_000);
  // The turn was not verified, so the evidence must not claim it was.
  assert.equal(state.windows[windowId]?.baselineEvidence, "manual_ready");
  assert.equal(manualAnchorAllowsEnable(state, 200), true);
});

/**
 * The hole a deny-list left open. A genuinely sliding window lands on
 * "indeterminate" whenever the series is non-monotonic or the drift does not
 * clear the elapsed-time threshold, so refusing only "sliding" would still
 * adopt a moving target as a scheduling baseline -- and the monitor would then
 * wait forever for a boundary that keeps receding.
 */
test("a manual anchor refuses an indeterminate window as a scheduling baseline", () => {
  const state = emptyState();
  const before = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS }), 100);
  const after = normalizeRateLimits(rateLimits({ usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS + 18_000 }), 200);
  const windowId = after.windows[0]!.id;
  const manual = recordManualAnchor(state, {
    ...safeCompletedStableResult(before, after),
    verificationVerdicts: { [windowId]: "indeterminate" },
  });

  assert.equal(state.windows[windowId], undefined, "an unproven window must not become a baseline");
  assert.notEqual(manual.status, "ready");
  assert.equal(manualAnchorAllowsEnable(state, 200), false);
  assert.deepEqual(manual.refusedWindowIds, [windowId], "the refusal must be visible to the operator");
});

test("a manual anchor records every refused window so status can explain the gap", () => {
  const state = emptyState();
  const before = normalizeRateLimits(
    rateLimits(
      { usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS },
      { usedPercent: 0, duration: 10_080, resetsAt: BASELINE_SECONDS },
    ),
    100,
  );
  const after = normalizeRateLimits(
    rateLimits(
      { usedPercent: 0, duration: 300, resetsAt: BASELINE_SECONDS + 18_000 },
      { usedPercent: 0, duration: 10_080, resetsAt: BASELINE_SECONDS + 604_800 },
    ),
    200,
  );
  const fiveHour = after.windows.find((window) => window.kind === "five_hour")!.id;
  const weekly = after.windows.find((window) => window.kind === "weekly")!.id;
  const manual = recordManualAnchor(state, {
    ...safeCompletedStableResult(before, after),
    verificationVerdicts: { [fiveHour]: "not_advanced", [weekly]: "sliding" },
  });

  assert.deepEqual(manual.baselineWindowIds, [fiveHour]);
  assert.deepEqual(manual.refusedWindowIds, [weekly]);
  assert.equal(manual.status, "ready", "one good window still enables scheduling");
});
