export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
  method?: string;
  params?: unknown;
}

export interface RawRateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RawRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
  [key: string]: unknown;
}

export interface RateLimitReadResult {
  rateLimits: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
}

export type WindowKind = "five_hour" | "weekly" | "unknown";

export interface NormalizedWindow {
  id: string;
  limitId: string;
  bucket: "primary" | "secondary";
  kind: WindowKind;
  durationMinutes: number | null;
  usedPercent: number | null;
  resetsAt: number | null;
  rateLimitReachedType: string | null;
}

export interface NormalizedSnapshot {
  observedAt: number;
  windows: NormalizedWindow[];
}

export interface TrackedWindow {
  id: string;
  kind: WindowKind;
  limitId: string;
  bucket: "primary" | "secondary";
  durationMinutes: number | null;
  usedPercent: number | null;
  resetsAt: number | null;
  rateLimitReachedType: string | null;
  observedAt: number;
  /**
   * A trusted future scheduling baseline.  Legacy state records only the
   * timestamp; newer records also retain how it was established.
   */
  verifiedResetAt: number | null;
  /** Optional to preserve compatibility with existing version-1 state files. */
  baselineEvidence?: BaselineEvidence;
  lastAnchorGeneration: string | null;
}

/**
 * Why `verifiedResetAt` is safe to use as the next scheduling boundary.
 * Optional so existing version-1 state files remain readable.
 */
export type BaselineEvidence =
  | "verified_advance"
  | "manual_ready"
  | "external_usage"
  | "recovered_rollover";

export type AnchorStatus =
  | "claimed"
  | "verified"
  | "unverified"
  | "safety_abort"
  | "rejected"
  /** A reset was observed but was not safe to consume automatically. */
  | "skipped";

/** A model/effort pair chosen from the current App Server model list. */
export type AnchorEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AnchorRoute {
  model: string;
  effort: AnchorEffort;
}

export interface AnchorRecord {
  generation: string;
  windowIds: string[];
  status: AnchorStatus;
  claimedAt: number;
  completedAt: number | null;
  detail: string;
  /** Recorded after an anchor attempt so later status/log inspection shows the actual requested route. */
  route?: AnchorRoute | null;
  /** Set once the user-visible "anchor verified" notification has fired for this generation. Optional so existing construction sites and persisted JSON stay valid. */
  notifiedAt?: number | null;
}

export interface ManualAnchorResult {
  /**
   * `ready` means a guarded manual turn completed and adopted at least one
   * future scheduling baseline; reset advancement remains pending until an
   * automatic anchor observes it.
   */
  status: "verified" | "ready" | "unverified" | "safety_abort" | "rejected";
  completedAt: number;
  detail: string;
  /** Optional so pre-route-selection state.json files remain valid. */
  route?: AnchorRoute | null;
  /** Optional so old verified state remains valid without a migration. */
  baselineWindowIds?: string[];
  /**
   * Target windows the samples could not prove steady, so they were refused as
   * scheduling baselines. Recorded only so the operator can see why.
   */
  refusedWindowIds?: string[];
}

export interface ManagerState {
  version: 1;
  autoAnchorEnabled: boolean;
  windows: Record<string, TrackedWindow>;
  anchors: Record<string, AnchorRecord>;
  manualAnchor: ManualAnchorResult | null;
  lastUpdatedAt: number;
}

export interface ManagerConfig {
  version: 1;
  pollIntervalSeconds: number;
  resetGraceSeconds: number;
  coalesceSeconds: number;
  verificationDelaySeconds: number;
  /** Post-turn rate-limit samples used to decide whether a window is anchored. */
  verificationSampleCount: number;
  verificationSampleIntervalSeconds: number;
  rollbackThresholdPercent: number;
  logFileMaxBytes: number;
  logFilesToKeep: number;
}

export interface AppPaths {
  root: string;
  logsDirectory: string;
  anchorWorkspace: string;
  configFile: string;
  stateFile: string;
  lockDirectory: string;
  anchorLockDirectory: string;
  launchAgentFile: string;
  stdoutLog: string;
  stderrLog: string;
}

/**
 * How a target window behaved across the post-turn samples.
 *
 * `sliding` is the case that matters: an uninitialized window can report
 * `resetsAt` as roughly `now + duration`, recomputed on every read, so its
 * timestamp "advances" purely because the clock moved. Only `advanced_stable`
 * is treated as verified; everything else fails closed.
 */
export type AnchorWindowVerdict = "advanced_stable" | "not_advanced" | "sliding" | "indeterminate";

export interface AnchorRunResult {
  status: "verified" | "unverified" | "safety_abort" | "rejected";
  detail: string;
  before: NormalizedSnapshot;
  after: NormalizedSnapshot | null;
  threadId: string | null;
  /** Null only when no eligible route could be selected before thread creation. */
  route: AnchorRoute | null;
  /** The targets this run was allowed to affect, captured before thread creation. */
  targetWindowIds: string[];
  /**
   * True only after the selected route completed successfully with no observed
   * tool, approval, or reroute safety signal.  It is separate from reset
   * timestamp advancement so manual validation never needs to parse text.
   */
  turnCompletedSafely: boolean;
  /** Target windows whose future reset timestamp strictly advanced. Empty unless status is "verified". */
  verifiedWindowIds: string[];
  /** Per-target-window sampling verdict. Optional: rejected runs never sample. */
  verificationVerdicts?: Record<string, AnchorWindowVerdict>;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  version: 1,
  pollIntervalSeconds: 60,
  resetGraceSeconds: 5,
  coalesceSeconds: 30,
  verificationDelaySeconds: 5,
  verificationSampleCount: 4,
  verificationSampleIntervalSeconds: 15,
  rollbackThresholdPercent: 5,
  logFileMaxBytes: 1_000_000,
  logFilesToKeep: 5,
};

export function emptyState(): ManagerState {
  return {
    version: 1,
    autoAnchorEnabled: false,
    windows: {},
    anchors: {},
    manualAnchor: null,
    lastUpdatedAt: Date.now(),
  };
}
