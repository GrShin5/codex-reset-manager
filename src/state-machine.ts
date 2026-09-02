import type {
  AnchorRecord,
  AnchorRunResult,
  ManagerConfig,
  ManagerState,
  NormalizedSnapshot,
  NormalizedWindow,
  TrackedWindow,
  WindowKind,
} from "./types.js";
import { isFutureUnixTime } from "./windows.js";

export interface AnchorCandidate {
  generation: string;
  windowId: string;
  /** The pre-reset boundary this candidate is allowed to consume for. */
  baselineResetAt: number;
  reason: "scheduled";
}

const DURATION_MINUTES_BY_KIND: Record<Exclude<WindowKind, "unknown">, number> = {
  five_hour: 300,
  weekly: 10_080,
};

/**
 * Length of one usage cycle for an anchorable window, in seconds, or null when
 * the window must never be anchored.  Null is a fail-closed answer: without a
 * known cycle length there is no way to bound retries to one turn per cycle.
 */
export function anchorCycleSeconds(window: Pick<TrackedWindow, "kind" | "durationMinutes">): number | null {
  if (window.kind === "unknown") {
    return null;
  }
  const minutes = window.durationMinutes ?? DURATION_MINUTES_BY_KIND[window.kind];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? Math.round(minutes * 60)
    : null;
}

/** Whole cycles elapsed between the verified baseline and `atSeconds`. */
export function boundaryOrdinal(baselineSeconds: number, cycleSeconds: number, atSeconds: number): number {
  return Math.max(0, Math.floor((atSeconds - baselineSeconds) / cycleSeconds));
}

/**
 * Ordinal 0 deliberately reuses the pre-fix key shape.  A state.json written by
 * the old code therefore keeps suppressing exactly the boundary it already
 * attempted, with no migration pass and no rewrite of persisted keys.
 */
export function scheduledGeneration(windowId: string, baselineSeconds: number, ordinal: number): string {
  return ordinal === 0
    ? `scheduled:${windowId}:${baselineSeconds}`
    : `scheduled:${windowId}:${baselineSeconds}:${ordinal}`;
}

/** Smallest baseline + n*cycle that is strictly after `atSeconds`. */
export function nextBoundarySeconds(baselineSeconds: number, cycleSeconds: number, atSeconds: number): number {
  if (baselineSeconds > atSeconds) {
    return baselineSeconds;
  }
  return baselineSeconds + (Math.floor((atSeconds - baselineSeconds) / cycleSeconds) + 1) * cycleSeconds;
}

export function observeSnapshot(
  state: ManagerState,
  snapshot: NormalizedSnapshot,
  config: ManagerConfig,
): AnchorCandidate[] {
  const candidates: AnchorCandidate[] = [];

  for (const window of snapshot.windows) {
    const previous = state.windows[window.id];
    const tracked = trackWindow(window, snapshot.observedAt, previous);
    state.windows[window.id] = tracked;

    // A snapshot that changes the identity or duration behind an otherwise
    // familiar key cannot prove that this is the same reset generation.
    // Clear the scheduling boundary and wait for a safe manual/bootstrap path.
    if (window.kind === "unknown" || previous === undefined || !sameTrackedAnchorWindow(previous, window)) {
      if (previous !== undefined && !sameTrackedAnchorWindow(previous, window)) {
        tracked.verifiedResetAt = null;
        tracked.baselineEvidence = undefined;
        tracked.lastAnchorGeneration = null;
      }
      continue;
    }

    const baselineResetAt = previous.verifiedResetAt;
    const cycleSeconds = anchorCycleSeconds(previous);
    if (baselineResetAt === null || cycleSeconds === null) {
      continue;
    }

    const dueAt = baselineResetAt * 1_000 + config.resetGraceSeconds * 1_000;
    if (snapshot.observedAt < dueAt) {
      continue;
    }

    // A complete post-reset observation must identify a newer, future cycle
    // of the same window. The App Server's reset timestamp need not advance by
    // an exact fixed-duration delta, so freshness (not arithmetic equality)
    // bounds whether the daemon could have slept through multiple cycles.
    const generation = scheduledGeneration(window.id, baselineResetAt, 0);
    if (window.resetsAt === null || !isFutureUnixTime(window.resetsAt, snapshot.observedAt)) {
      recordSkippedWithoutRebaseline(
        state,
        generation,
        window.id,
        "Skipped automatic anchor: a complete, future reset timestamp was not available for the new usage window.",
      );
      continue;
    }
    const existingRecord = state.anchors[generation];
    if (existingRecord !== undefined) {
      // A durable record already owns the old boundary.  Never retry it, but
      // a later passive observation may safely establish the following future
      // boundary so the monitor is not stuck forever after a skipped/error
      // generation.
      if (window.resetsAt > baselineResetAt) {
        tracked.verifiedResetAt = window.resetsAt;
        tracked.baselineEvidence = "recovered_rollover";
        tracked.lastAnchorGeneration = existingRecord.generation;
      }
      continue;
    }

    if (window.resetsAt <= baselineResetAt) {
      recordSkippedBoundary(
        state,
        tracked,
        generation,
        window.id,
        window.resetsAt,
        "recovered_rollover",
        "Skipped automatic anchor: reset timestamp did not move beyond the stored boundary, so the observation was re-baselined without a model turn.",
      );
      continue;
    }

    if (snapshot.observedAt - previous.observedAt > resetObservationFreshnessMilliseconds(config)) {
      recordSkippedBoundary(
        state,
        tracked,
        generation,
        window.id,
        window.resetsAt,
        "recovered_rollover",
        "Skipped automatic anchor: the first post-reset observation arrived too late to prove that the new usage window was untouched.",
      );
      continue;
    }

    if (window.usedPercent === 0) {
      // Keep the old baseline intact until the guarded anchor itself verifies
      // an advance.  This is what preserves the just-reset generation.
      candidates.push({ generation, windowId: window.id, baselineResetAt, reason: "scheduled" });
      continue;
    }

    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent > 0) {
      recordSkippedBoundary(
        state,
        tracked,
        generation,
        window.id,
        window.resetsAt,
        "external_usage",
        "Skipped automatic anchor: usage was already above 0% in the new reset window.",
      );
      continue;
    }

    recordSkippedBoundary(
      state,
      tracked,
      generation,
      window.id,
      window.resetsAt,
      "recovered_rollover",
      "Skipped automatic anchor: the new reset window did not expose a valid 0% usage value.",
    );
  }

  return deduplicateCandidates(candidates).filter((candidate) => state.anchors[candidate.generation] === undefined);
}

/** A full snapshot older than this is too stale to authorize a model turn. */
export function resetObservationFreshnessMilliseconds(config: ManagerConfig): number {
  return Math.max(90_000, config.pollIntervalSeconds * 2_000);
}

/**
 * Safely upgrades the precise state shape written by the old rollover logic.
 * It preserves the currently observed future boundary, but never recreates or
 * consumes the reset generation that the old daemon accidentally discarded.
 */
export function migrateLegacyRolloverState(state: ManagerState, now = Date.now()): boolean {
  if (state.manualAnchor?.status !== "ready") {
    return false;
  }
  let changed = false;
  for (const [windowId, window] of Object.entries(state.windows)) {
    const hasRecordedExecution = Object.values(state.anchors).some((record) => record.windowIds.includes(windowId));
    if (
      !hasRecordedExecution
      && window.baselineEvidence === "verified_advance"
      && window.lastAnchorGeneration === "manual"
      && window.verifiedResetAt !== null
      && window.resetsAt === window.verifiedResetAt
      && isFutureUnixTime(window.verifiedResetAt, now)
    ) {
      window.baselineEvidence = "recovered_rollover";
      window.lastAnchorGeneration = "recovered";
      changed = true;
    }
  }
  return changed;
}

export function nextScheduledWakeAt(state: ManagerState, config: ManagerConfig, now = Date.now()): number | null {
  const nowSeconds = Math.floor(now / 1_000);
  const times: number[] = [];
  for (const window of Object.values(state.windows)) {
    if (window.kind === "unknown" || window.verifiedResetAt === null) {
      continue;
    }
    const cycleSeconds = anchorCycleSeconds(window);
    if (cycleSeconds === null) {
      continue;
    }
    const dueAt = window.verifiedResetAt * 1_000 + config.resetGraceSeconds * 1_000;
    const wakeAt = dueAt > now
      ? dueAt
      : nextBoundarySeconds(window.verifiedResetAt, cycleSeconds, nowSeconds) * 1_000 + config.resetGraceSeconds * 1_000;
    if (wakeAt > now) {
      times.push(wakeAt);
    }
  }
  return times.length === 0 ? null : Math.min(...times);
}

export function claimCandidates(state: ManagerState, candidates: AnchorCandidate[]): void {
  const now = Date.now();
  for (const candidate of candidates) {
    if (state.anchors[candidate.generation] !== undefined) {
      continue;
    }
    const record: AnchorRecord = {
      generation: candidate.generation,
      windowIds: [candidate.windowId],
      status: "claimed",
      claimedAt: now,
      completedAt: null,
      detail: candidate.reason,
    };
    state.anchors[candidate.generation] = record;
  }
}

export function applyAnchorResult(
  state: ManagerState,
  candidates: AnchorCandidate[],
  result: AnchorRunResult,
): void {
  const completedAt = Date.now();
  const advanced = new Set(result.verifiedWindowIds);
  for (const candidate of candidates) {
    const record = state.anchors[candidate.generation];
    if (record === undefined) {
      continue;
    }
    // A coalesced turn produces one result but one verdict per window.  Never
    // let another window's advance mark this one verified.
    const windowVerified = result.status === "verified" && advanced.has(candidate.windowId);
    record.status = result.status === "verified" && !windowVerified ? "unverified" : result.status;
    record.detail = result.status === "verified" && !windowVerified
      ? result.verificationVerdicts?.[candidate.windowId] === "sliding"
        ? "The coalesced turn advanced another window; this window's reset timestamp kept sliding with wall-clock time."
        : "The coalesced turn advanced another window; this window's reset timestamp did not advance."
      : result.detail;
    record.completedAt = completedAt;
    record.route = result.route;
    if (!windowVerified || result.after === null) {
      continue;
    }
    const afterWindow = result.after.windows.find((window) => window.id === candidate.windowId);
    const tracked = state.windows[candidate.windowId];
    if (tracked === undefined || afterWindow === undefined || afterWindow.resetsAt === null) {
      continue;
    }
    tracked.verifiedResetAt = afterWindow.resetsAt;
    tracked.baselineEvidence = "verified_advance";
    tracked.lastAnchorGeneration = candidate.generation;
  }
}

export function recordManualAnchor(state: ManagerState, result: AnchorRunResult): NonNullable<ManagerState["manualAnchor"]> {
  const refusedWindowIds: string[] = [];
  const baselineWindowIds = adoptManualBaselines(state, result, refusedWindowIds);
  const status = result.status === "verified"
    ? "verified"
    : result.turnCompletedSafely && baselineWindowIds.length > 0
      ? "ready"
      : result.status;
  const detail = status === "ready"
    ? "The guarded manual turn completed safely. Current future reset timestamps were adopted as scheduling baselines; reset advancement will be verified by the first automatic anchor."
    : result.detail;
  const manual = {
    status,
    completedAt: Date.now(),
    detail,
    route: result.route,
    baselineWindowIds,
    // Recorded so status can explain why a window is not being scheduled,
    // instead of leaving it silently absent from the adopted list.
    ...(refusedWindowIds.length > 0 ? { refusedWindowIds } : {}),
  } as const;
  state.manualAnchor = manual;
  return manual;
}

/**
 * A legacy `verified` record remains accepted. A `ready` record must point at
 * a stored baseline. Once its boundary passes, the monitor still requires a
 * fresh snapshot of a newer same-window cycle reporting 0% usage before it
 * may anchor.
 */
export function manualAnchorAllowsAutoAnchoring(state: ManagerState): boolean {
  const manual = state.manualAnchor;
  if (manual?.status === "verified") {
    return manual.baselineWindowIds === undefined || hasStoredBaseline(state, manual.baselineWindowIds, false);
  }
  return manual?.status === "ready"
    && manual.baselineWindowIds !== undefined
    && hasStoredBaseline(state, manual.baselineWindowIds, false);
}

/**
 * A manual `ready` record may enable automation only before one of its adopted
 * boundaries elapses.  This prevents a delayed enable command from creating an
 * immediate paid turn; once enabled, the monitor uses the helper above.
 */
export function manualAnchorAllowsEnable(state: ManagerState, now = Date.now()): boolean {
  if (state.manualAnchor?.status !== "ready") {
    return manualAnchorAllowsAutoAnchoring(state);
  }
  const windowIds = state.manualAnchor.baselineWindowIds;
  return windowIds !== undefined && hasStoredBaseline(state, windowIds, true, now);
}

export function snapshotContainsTargetWindow(snapshot: NormalizedSnapshot): boolean {
  return snapshot.windows.some((window) => window.kind !== "unknown");
}

function trackWindow(window: NormalizedWindow, observedAt: number, previous: TrackedWindow | undefined): TrackedWindow {
  return {
    id: window.id,
    kind: window.kind,
    limitId: window.limitId,
    bucket: window.bucket,
    durationMinutes: window.durationMinutes,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    rateLimitReachedType: window.rateLimitReachedType,
    observedAt,
    verifiedResetAt: previous?.verifiedResetAt ?? null,
    baselineEvidence: previous?.baselineEvidence,
    lastAnchorGeneration: previous?.lastAnchorGeneration ?? null,
  };
}

function adoptManualBaselines(
  state: ManagerState,
  result: AnchorRunResult,
  refused: string[] = [],
): string[] {
  if (!result.turnCompletedSafely || result.after === null) {
    return [];
  }
  const adopted: string[] = [];
  for (const windowId of result.targetWindowIds) {
    // Only adopt a boundary the samples actually proved to be steady.
    //
    // This is an allow-list on purpose. Denying just "sliding" is not enough:
    // a genuinely sliding window lands on "indeterminate" whenever the series
    // is non-monotonic, or whenever RPC latency stretches the observation
    // window so the drift no longer clears the elapsed-time threshold. Both
    // are routine. Adopting either would let the monitor schedule against a
    // value that moves away as fast as the clock, so its boundary would never
    // arrive and the window would never be anchored again.
    //
    // The evidence label alone could never have prevented this:
    // hasStoredBaseline gates on verifiedResetAt and never reads
    // baselineEvidence. The adoption itself has to be refused.
    //
    // Both allowed verdicts come from the same proven-stable branch of the
    // classifier. verificationVerdicts is always present here, because the
    // only site that sets turnCompletedSafely also sets it, and this function
    // has already returned for runs where that flag is false.
    const verdict = result.verificationVerdicts?.[windowId];
    if (verdict !== "advanced_stable" && verdict !== "not_advanced") {
      refused.push(windowId);
      continue;
    }
    const beforeWindow = result.before.windows.find((candidate) => candidate.id === windowId);
    const afterWindow = result.after.windows.find((candidate) => candidate.id === windowId);
    if (beforeWindow === undefined || afterWindow === undefined || !sameAnchorWindow(beforeWindow, afterWindow)) {
      continue;
    }
    if (afterWindow.kind === "unknown" || !isFutureUnixTime(afterWindow.resetsAt, result.after.observedAt)) {
      continue;
    }
    if (beforeWindow.resetsAt !== null && afterWindow.resetsAt < beforeWindow.resetsAt) {
      continue;
    }
    const tracked = state.windows[windowId] ?? trackWindow(afterWindow, result.after.observedAt, undefined);
    tracked.verifiedResetAt = afterWindow.resetsAt;
    tracked.baselineEvidence = result.verifiedWindowIds.includes(windowId)
      ? "verified_advance"
      : "manual_ready";
    tracked.lastAnchorGeneration = "manual";
    state.windows[windowId] = tracked;
    adopted.push(windowId);
  }
  return adopted;
}

function hasStoredBaseline(state: ManagerState, windowIds: string[], requireFuture: boolean, now = Date.now()): boolean {
  return windowIds.some((windowId) => {
    const window = state.windows[windowId];
    return window !== undefined
      && window.kind !== "unknown"
      && window.verifiedResetAt !== null
      && (!requireFuture || isFutureUnixTime(window.verifiedResetAt, now));
  });
}

function sameAnchorWindow(left: NormalizedWindow, right: NormalizedWindow): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.limitId === right.limitId
    && left.bucket === right.bucket
    && left.durationMinutes === right.durationMinutes;
}

function sameTrackedAnchorWindow(left: TrackedWindow, right: NormalizedWindow): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.limitId === right.limitId
    && left.bucket === right.bucket
    && left.durationMinutes === right.durationMinutes;
}

function recordSkippedBoundary(
  state: ManagerState,
  tracked: TrackedWindow,
  generation: string,
  windowId: string,
  nextResetAt: number,
  evidence: "external_usage" | "recovered_rollover",
  detail: string,
): void {
  recordSkippedWithoutRebaseline(state, generation, windowId, detail);
  tracked.verifiedResetAt = nextResetAt;
  tracked.baselineEvidence = evidence;
  tracked.lastAnchorGeneration = generation;
}

function recordSkippedWithoutRebaseline(
  state: ManagerState,
  generation: string,
  windowId: string,
  detail: string,
): void {
  if (state.anchors[generation] !== undefined) {
    return;
  }
  const now = Date.now();
  state.anchors[generation] = {
    generation,
    windowIds: [windowId],
    status: "skipped",
    claimedAt: now,
    completedAt: now,
    detail,
    route: null,
  };
}

function deduplicateCandidates(candidates: AnchorCandidate[]): AnchorCandidate[] {
  const known = new Set<string>();
  return candidates.filter((candidate) => {
    if (known.has(candidate.generation)) {
      return false;
    }
    known.add(candidate.generation);
    return true;
  });
}
