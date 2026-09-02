import assert from "node:assert/strict";
import test from "node:test";

import { isTargetWindowExposed, mergeSparseRateLimitSnapshot, normalizeRateLimits } from "../src/windows.js";
import { rateLimits } from "./helpers.js";

test("normalizes target and unknown windows without assuming primary/secondary meanings", () => {
  const snapshot = normalizeRateLimits(rateLimits(
    { usedPercent: 20, duration: 300, resetsAt: 1_000 },
    { usedPercent: 40, duration: 999, resetsAt: 2_000 },
  ));
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0]?.kind, "five_hour");
  assert.equal(snapshot.windows[1]?.kind, "unknown");
  assert.match(snapshot.windows[0]?.id ?? "", /^codex:primary:300$/);
});

test("recognizes the 10,080-minute weekly window by duration", () => {
  const snapshot = normalizeRateLimits(rateLimits(
    { usedPercent: 20, duration: 300, resetsAt: 1_000 },
    { usedPercent: 40, duration: 10_080, resetsAt: 2_000 },
  ));
  assert.equal(snapshot.windows[1]?.kind, "weekly");
});

test("treats an absent 5-hour window as normal when only weekly is exposed", () => {
  const snapshot = normalizeRateLimits(rateLimits(
    null,
    { usedPercent: 40, duration: 10_080, resetsAt: 2_000 },
  ));
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0]?.kind, "weekly");
  assert.equal(isTargetWindowExposed(snapshot, "five_hour"), false);
  assert.equal(isTargetWindowExposed(snapshot, "weekly"), true);
});

test("merges sparse rate-limit updates without clearing unavailable spend control", () => {
  const previous = rateLimits({ usedPercent: 40, duration: 300, resetsAt: 1_000 });
  previous.rateLimits.spendControlReached = true;
  const merged = mergeSparseRateLimitSnapshot(previous, {
    rateLimits: {
      primary: { usedPercent: 43 },
      spendControlReached: null,
    },
  });
  assert.equal(merged.rateLimits.primary?.usedPercent, 43);
  assert.equal(merged.rateLimits.primary?.resetsAt, 1_000);
  assert.equal(merged.rateLimits.spendControlReached, true);
});

test("keeps a top-level limit alongside separately keyed limits", () => {
  const result = rateLimits({ usedPercent: 20, duration: 300, resetsAt: 1_000 });
  result.rateLimits.limitId = "root";
  result.rateLimitsByLimitId = {
    weekly: {
      limitId: "weekly",
      primary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 2_000 },
      secondary: null,
    },
  };
  const snapshot = normalizeRateLimits(result);
  assert.deepEqual(snapshot.windows.map((window) => window.id), ["root:primary:300", "weekly:primary:10080"]);
});
