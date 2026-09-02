import type {
  NormalizedSnapshot,
  NormalizedWindow,
  RateLimitReadResult,
  RawRateLimitSnapshot,
  WindowKind,
} from "./types.js";

export function kindForDuration(durationMinutes: number | null): WindowKind {
  if (durationMinutes === 300) {
    return "five_hour";
  }
  if (durationMinutes === 10_080) {
    return "weekly";
  }
  return "unknown";
}

export function isTargetWindowExposed(
  snapshot: NormalizedSnapshot,
  kind: Exclude<WindowKind, "unknown">,
): boolean {
  return snapshot.windows.some((window) => window.kind === kind);
}

export function normalizeRateLimits(result: RateLimitReadResult, observedAt = Date.now()): NormalizedSnapshot {
  // Some App Server versions expose both the legacy top-level snapshot and a
  // map keyed by limit ID.  Keep the root as a valid source rather than
  // silently dropping it when the map is present; a map entry with the same
  // ID wins because it is the more specific representation.
  const sources = new Map<string, RawRateLimitSnapshot>();
  sources.set(result.rateLimits.limitId ?? "default", result.rateLimits);
  for (const [limitId, snapshot] of Object.entries(result.rateLimitsByLimitId ?? {})) {
    sources.set(limitId, snapshot);
  }
  const windows: NormalizedWindow[] = [];
  for (const [mapLimitId, snapshot] of sources) {
    const limitId = snapshot.limitId ?? mapLimitId ?? "default";
    for (const bucket of ["primary", "secondary"] as const) {
      const rawWindow = snapshot[bucket];
      if (rawWindow === null || rawWindow === undefined) {
        continue;
      }
      const durationMinutes = numberOrNull(rawWindow.windowDurationMins);
      windows.push({
        id: `${limitId}:${bucket}:${durationMinutes ?? "unknown"}`,
        limitId,
        bucket,
        kind: kindForDuration(durationMinutes),
        durationMinutes,
        usedPercent: numberOrNull(rawWindow.usedPercent),
        resetsAt: numberOrNull(rawWindow.resetsAt),
        rateLimitReachedType: stringOrNull(snapshot.rateLimitReachedType),
      });
    }
  }
  windows.sort((left, right) => left.id.localeCompare(right.id));
  return { observedAt, windows };
}

export function mergeSparseRateLimitSnapshot(
  previous: RateLimitReadResult,
  update: Partial<RateLimitReadResult>,
): RateLimitReadResult {
  return {
    rateLimits: mergeSnapshot(previous.rateLimits, update.rateLimits),
    rateLimitsByLimitId: mergeLimitMap(previous.rateLimitsByLimitId, update.rateLimitsByLimitId),
  };
}

function mergeLimitMap(
  previous: Record<string, RawRateLimitSnapshot> | null | undefined,
  update: Record<string, RawRateLimitSnapshot> | null | undefined,
): Record<string, RawRateLimitSnapshot> | null | undefined {
  if (update === undefined) {
    return previous;
  }
  if (update === null) {
    return previous;
  }
  const merged: Record<string, RawRateLimitSnapshot> = { ...(previous ?? {}) };
  for (const [limitId, snapshot] of Object.entries(update)) {
    merged[limitId] = mergeSnapshot(merged[limitId] ?? {}, snapshot);
  }
  return merged;
}

function mergeSnapshot(previous: RawRateLimitSnapshot, update: Partial<RawRateLimitSnapshot> | undefined): RawRateLimitSnapshot {
  if (update === undefined) {
    return previous;
  }
  const merged: RawRateLimitSnapshot = { ...previous };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) {
      continue;
    }
    if ((key === "spendControlReached" || key === "individualLimit") && value === null) {
      continue;
    }
    if ((key === "primary" || key === "secondary") && isRecord(value) && isRecord(merged[key])) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function hasMeaningfulRollback(
  previous: NormalizedWindow,
  current: NormalizedWindow,
  threshold: number,
): boolean {
  if (previous.usedPercent === null || current.usedPercent === null) {
    return false;
  }
  if (previous.usedPercent - current.usedPercent < threshold) {
    return false;
  }
  return current.resetsAt !== null && (previous.resetsAt === null || current.resetsAt > previous.resetsAt);
}

export function hasAvailabilityRecovery(previous: NormalizedWindow, current: NormalizedWindow): boolean {
  return previous.rateLimitReachedType !== null
    && current.rateLimitReachedType === null
    && current.resetsAt !== null
    && (previous.resetsAt === null || current.resetsAt > previous.resetsAt);
}

export function isFutureUnixTime(value: number | null, now = Date.now()): value is number {
  return value !== null && value * 1_000 > now;
}

export function formatWindow(window: NormalizedWindow): string {
  const label = window.kind === "five_hour" ? "5h" : window.kind === "weekly" ? "Weekly" : "Unknown";
  const used = window.usedPercent === null ? "unknown" : `${window.usedPercent}%`;
  const reset = window.resetsAt === null ? "unset" : new Date(window.resetsAt * 1_000).toLocaleString();
  return `${label} (${window.limitId}/${window.bucket}): used ${used}, reset ${reset}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
