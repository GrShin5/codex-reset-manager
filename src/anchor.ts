import { formatAnchorRoute, selectLowestCostAnchorRoute } from "./app-server.js";
import type { CodexAppServer } from "./app-server.js";
import { anchorWorkspaceIsEmpty } from "./files.js";
import type { Logger } from "./logger.js";
import { ProcessLock } from "./lock.js";
import type { AnchorRoute, AnchorWindowVerdict, AppPaths, AnchorRunResult, ManagerConfig, NormalizedSnapshot } from "./types.js";
import { normalizeRateLimits } from "./windows.js";

const TURN_TIMEOUT_MS = 90_000;
const NOTIFICATION_TIMEOUT_MS = 5_000;

export interface AnchorTurnCompleted {
  threadId: string;
  turnId: string;
  targetWindowIds: string[];
  route: AnchorRoute;
}

export type AnchorTurnCompletedHandler = (event: AnchorTurnCompleted) => Promise<void> | void;


export class AnchorExecutor {
  public constructor(
    private readonly client: CodexAppServer,
    private readonly paths: AppPaths,
    private readonly config: ManagerConfig,
    private readonly logger: Logger,
  ) {}

  public async run(targetWindowIds?: string[], onTurnCompleted?: AnchorTurnCompletedHandler): Promise<AnchorRunResult> {
    const lock = new ProcessLock(this.paths.anchorLockDirectory);
    await lock.acquire();
    try {
      return await this.runLocked(targetWindowIds, onTurnCompleted);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async runLocked(targetWindowIds?: string[], onTurnCompleted?: AnchorTurnCompletedHandler): Promise<AnchorRunResult> {
    const before = normalizeRateLimits(await this.client.readRateLimits());
    const effectiveTargetWindowIds = targetWindowIds ?? before.windows
      .filter((window) => window.kind !== "unknown")
      .map((window) => window.id);
    const reject = (detail: string, route: AnchorRoute | null = null): AnchorRunResult => ({
      status: "rejected",
      detail,
      before,
      after: null,
      threadId: null,
      route,
      targetWindowIds: effectiveTargetWindowIds,
      turnCompletedSafely: false,
      verifiedWindowIds: [],
    });

    const models = await this.client.listModels();
    const route = selectLowestCostAnchorRoute(models);
    if (route === null) {
      const result = reject("No known model with an explicitly supported safe effort was advertised by App Server; no thread or turn was started.");
      await this.logger.warn("anchor_rejected", { reason: "no_supported_anchor_route" });
      return result;
    }

    if (!await anchorWorkspaceIsEmpty(this.paths)) {
      const result = reject("The dedicated anchor workspace is not empty; no turn was started.", route);
      await this.logger.warn("anchor_rejected", { reason: "anchor_workspace_not_empty", ...routeLogFields(route) });
      return result;
    }

    const thread = await this.client.startEphemeralThread(this.paths.anchorWorkspace, route);
    if (typeof thread.id !== "string" || thread.id.length === 0) {
      const result = reject("App Server did not return an ephemeral thread ID.", route);
      await this.logger.warn("anchor_rejected", { reason: "thread_id_missing", ...routeLogFields(route) });
      return result;
    }
    if (thread.ephemeral !== true || thread.path !== null) {
      const result = reject("App Server did not strictly confirm an in-memory ephemeral thread.", route);
      await this.logger.warn("anchor_rejected", { reason: "ephemeral_not_confirmed", ...routeLogFields(route) });
      return result;
    }
    if (!routeMatches(thread, route)) {
      const result = reject(`App Server did not confirm ${formatAnchorRoute(route)} for the ephemeral anchor thread.`, route);
      await this.logger.warn("anchor_rejected", { reason: "thread_model_or_effort_mismatch", ...routeLogFields(route) });
      return result;
    }

    let turnId: string | null = null;
    let completedTurnId: string | null = null;
    let safetyAbort = false;
    let modelRerouted = false;
    let completionStatus: string | null = null;
    let completed = false;
    let completionResolve: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });
    const unsubscribe = this.client.onNotification((method, params) => {
      if (!notificationBelongsToThread(params, thread.id!)) {
        return;
      }
      if (method === "item/started" && isToolLikeItem(params)) {
        safetyAbort = true;
        void this.logger.warn("anchor_tool_like_item_observed", { threadId: thread.id });
        if (turnId !== null) {
          void this.client.interrupt(thread.id!, turnId).catch(() => undefined);
        }
      }
      if (looksLikeApprovalRequest(method)) {
        safetyAbort = true;
        void this.logger.warn("anchor_approval_observed", { threadId: thread.id });
        if (turnId !== null) {
          void this.client.interrupt(thread.id!, turnId).catch(() => undefined);
        }
      }
      if (method === "model/rerouted") {
        // A provider/model reroute is never acceptable for an anchor.  The
        // request has already been issued at this point, so interrupt it and
        // retain the generation claim rather than trying another model.
        modelRerouted = true;
        void this.logger.warn("anchor_model_rerouted", { threadId: thread.id, ...routeLogFields(route) });
        if (turnId !== null) {
          void this.client.interrupt(thread.id!, turnId).catch(() => undefined);
        }
      }
      if (method === "turn/completed") {
        const notificationTurnId = turnIdFromNotification(params);
        const notificationStatus = turnStatusFromNotification(params);
        if (turnId === null) {
          completedTurnId = notificationTurnId;
          completionStatus = notificationStatus;
        } else if (notificationTurnId === turnId) {
          completed = true;
          completionStatus = notificationStatus;
          completionResolve();
        }
      }
    });

    try {
      const turn = await this.client.startAnchorTurn(thread.id, route);
      turnId = typeof turn.id === "string" && turn.id.trim().length > 0 ? turn.id : null;
      if (turnId === null) {
        return {
          status: "rejected",
          detail: "App Server did not acknowledge an anchor turn ID.",
          before,
          after: null,
          threadId: thread.id,
          route,
          targetWindowIds: effectiveTargetWindowIds,
          turnCompletedSafely: false,
          verifiedWindowIds: [],
        };
      }
      // App Server currently acknowledges turn/start with an ID and status but
      // may omit the model/effort fields entirely. The exact route has already
      // been confirmed by the ephemeral thread response and is sent again in
      // this turn request. An omitted echo is therefore not a reroute; an
      // explicit partial or different echo still fails closed below, and the
      // model/rerouted notification remains an immediate abort.
      if (!turnRouteMatchesOrIsOmitted(turn, route)) {
        await this.client.interrupt(thread.id, turnId).catch(() => undefined);
        await this.logger.warn("anchor_rejected", { reason: "turn_explicit_model_or_effort_mismatch", ...routeLogFields(route) });
        return {
          status: "rejected",
          detail: `App Server explicitly returned a different model or effort from ${formatAnchorRoute(route)} for the anchor turn; it was interrupted and no further turn will be started.`,
          before,
          after: null,
          threadId: thread.id,
          route,
          targetWindowIds: effectiveTargetWindowIds,
          turnCompletedSafely: false,
          verifiedWindowIds: [],
        };
      }
      if (turnRouteIsOmitted(turn)) {
        await this.logger.debug("anchor_turn_route_not_echoed", routeLogFields(route));
      }
      if (completedTurnId === turnId) {
        completed = true;
        completionResolve();
      }
      if (safetyAbort || modelRerouted) {
        await this.client.interrupt(thread.id, turnId).catch(() => undefined);
      } else {
        await this.logger.info("anchor_turn_started", { targetWindowCount: effectiveTargetWindowIds.length, ...routeLogFields(route) });
      }
      await waitForCompletion(completion, TURN_TIMEOUT_MS);
    } catch (error: unknown) {
      await this.logger.warn("anchor_turn_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      return {
        status: safetyAbort ? "safety_abort" : "rejected",
        detail: safetyAbort
          ? "A tool-like action was observed and the anchor turn was interrupted."
          : modelRerouted
            ? `The provider rerouted the ${formatAnchorRoute(route)} anchor; no fallback was accepted.`
            : "The anchor turn was not accepted.",
        before,
        after: null,
        threadId: thread.id,
        route,
        targetWindowIds: effectiveTargetWindowIds,
        turnCompletedSafely: false,
        verifiedWindowIds: [],
      };
    } finally {
      unsubscribe();
    }

    if (safetyAbort) {
      return {
        status: "safety_abort",
        detail: "A tool-like action was observed and the anchor turn was interrupted.",
        before,
        after: null,
        threadId: thread.id,
        route,
        targetWindowIds: effectiveTargetWindowIds,
        turnCompletedSafely: false,
        verifiedWindowIds: [],
      };
    }
    if (modelRerouted) {
      return {
        status: "rejected",
        detail: `The provider rerouted the ${formatAnchorRoute(route)} anchor; no fallback was accepted.`,
        before,
        after: null,
        threadId: thread.id,
        route,
        targetWindowIds: effectiveTargetWindowIds,
        turnCompletedSafely: false,
        verifiedWindowIds: [],
      };
    }
    if (!completed) {
      return {
        status: "unverified",
        detail: "The anchor turn timed out; it will not be retried for this reset generation.",
        before,
        after: null,
        threadId: thread.id,
        route,
        targetWindowIds: effectiveTargetWindowIds,
        turnCompletedSafely: false,
        verifiedWindowIds: [],
      };
    }
    if (completionStatus !== null && !isSuccessfulCompletionStatus(completionStatus)) {
      return {
        status: "unverified",
        detail: `The anchor turn completed with status ${completionStatus}; reset advancement was not verified.`,
        before,
        after: null,
        threadId: thread.id,
        route,
        targetWindowIds: effectiveTargetWindowIds,
        turnCompletedSafely: false,
        verifiedWindowIds: [],
      };
    }

    const samples = await this.sampleAfterTurn();
    const after = samples[samples.length - 1];
    if (after === undefined) {
      // sampleAfterTurn rethrows a first-read failure, so this is only
      // reachable via a malformed sample count. Fail loudly rather than
      // dereferencing nothing after a turn has already been spent.
      throw new Error("No post-turn rate-limit sample was taken.");
    }
    const classification = classifyVerificationSamples(
      before,
      samples,
      effectiveTargetWindowIds,
      Date.now(),
      minimumStabilitySpanMs(this.config),
    );
    const verifiedWindowIds = classification.verifiedWindowIds;
    const verified = verifiedWindowIds.length > 0;
    const slidingWindowIds = Object.entries(classification.verdicts)
      .filter(([, verdict]) => verdict === "sliding")
      .map(([windowId]) => windowId);
    await this.logger.info("anchor_verification_sampled", {
      sampleCount: samples.length,
      spanMs: after.observedAt - (samples[0]?.observedAt ?? after.observedAt),
      verdicts: classification.verdicts,
    });
    const result: AnchorRunResult = {
      status: verified ? "verified" : "unverified",
      detail: verified
        ? `The isolated ${formatAnchorRoute(route)} turn advanced ${verifiedWindowIds.length} of ${effectiveTargetWindowIds.length} target window reset timestamps.`
        : slidingWindowIds.length > 0
          ? `The turn completed, but ${slidingWindowIds.length} target window reset timestamp kept sliding with wall-clock time across ${samples.length} samples, so it was not anchored by this turn.`
          : "The turn completed, but the target window timestamp could not be verified as advanced.",
      before,
      after,
      threadId: thread.id,
      route,
      targetWindowIds: effectiveTargetWindowIds,
      turnCompletedSafely: true,
      verifiedWindowIds,
      verificationVerdicts: classification.verdicts,
    };
    await this.logger.info("anchor_completed", {
      status: result.status,
      targetWindowCount: targetWindowIds?.length ?? before.windows.length,
      ...routeLogFields(route),
    });

    // The notification is the very last step, and only for a fully verified
    // anchor.  Reporting at turn start would announce runs that a later
    // tool-like item, approval, or provider reroute goes on to abort, and
    // reporting at completion would announce runs whose reset never advanced.
    // Both are cases the documented contract requires to stay silent.
    if (verified) {
      await this.reportTurnCompleted(onTurnCompleted, {
        threadId: thread.id,
        turnId,
        targetWindowIds: verifiedWindowIds,
        route,
      });
    }
    return result;
  }

  /**
   * Read the rate limits several times after the turn so a window whose
   * timestamp merely tracks the clock can be told apart from one this turn
   * actually anchored. A read that fails after at least one sample stops the
   * series rather than aborting: fewer samples degrade to a non-verified
   * verdict, which is the safe direction. The first read still throws, since
   * that leaves nothing to classify.
   */
  private async sampleAfterTurn(): Promise<NormalizedSnapshot[]> {
    await delay(this.config.verificationDelaySeconds * 1_000);
    const samples: NormalizedSnapshot[] = [];
    const configured = this.config.verificationSampleCount;
    const count = Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 1;
    for (let index = 0; index < count; index += 1) {
      if (index > 0) {
        await delay(this.config.verificationSampleIntervalSeconds * 1_000);
      }
      try {
        samples.push(normalizeRateLimits(await this.client.readRateLimits()));
      } catch (error: unknown) {
        if (samples.length === 0) {
          throw error;
        }
        await this.logger.warn("anchor_verification_sample_failed", { sampleIndex: index });
        break;
      }
    }
    return samples;
  }

  private async reportTurnCompleted(handler: AnchorTurnCompletedHandler | undefined, event: AnchorTurnCompleted): Promise<void> {
    if (handler === undefined) {
      return;
    }
    try {
      let timedOut = false;
      await Promise.race([
        Promise.resolve(handler(event)),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, NOTIFICATION_TIMEOUT_MS);
        }),
      ]);
      if (timedOut) {
        await this.logger.warn("anchor_completion_notification_timed_out", {
          timeoutMs: NOTIFICATION_TIMEOUT_MS,
        });
      }
    } catch (error: unknown) {
      await this.logger.warn("anchor_completion_notification_failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/**
 * Reset timestamps within this many seconds of each other count as unchanged.
 * Measured against the live backend: an anchored window's timestamp jitters by
 * about a second between reads, so a zero-tolerance comparison would misread a
 * correctly anchored window as unstable.
 */
const RESET_STABILITY_TOLERANCE_SECONDS = 1;

/**
 * Fraction of the intended sampling span that must actually have elapsed
 * before identical timestamps count as proof of steadiness.
 *
 * Steadiness is only meaningful over a span longer than the backend's own
 * refresh granularity: if every sample came from one cached snapshot,
 * identical values prove nothing. That assumption cannot be eliminated from
 * outside -- any span can be defeated by a coarser cache -- so it is bounded
 * two ways instead. The configured span is pinned in loadConfig, and this
 * check confirms the samples really were spread across it rather than taken
 * back to back. The observed span is logged as spanMs so a verdict stays
 * auditable after the fact.
 */
const MIN_STABILITY_SPAN_FRACTION = 0.6;

export function minimumStabilitySpanMs(config: Pick<ManagerConfig, "verificationSampleCount" | "verificationSampleIntervalSeconds">): number {
  const gaps = Math.max(0, Math.trunc(config.verificationSampleCount) - 1);
  return gaps * config.verificationSampleIntervalSeconds * 1_000 * MIN_STABILITY_SPAN_FRACTION;
}

/**
 * Decide, per target window, whether the post-turn samples show a window this
 * turn anchored.
 *
 * The distinction that matters: an anchored window has a fixed reset
 * timestamp, so repeated reads return the same value. An uninitialized window
 * can report `now + duration`, recomputed per read, so its timestamp advances
 * by roughly the elapsed wall-clock time. Comparing the timestamp's drift
 * against elapsed time separates the two; comparing a single "after" against
 * "before" cannot, because the clock alone satisfies it.
 *
 * Only `advanced_stable` verifies. Because stability is judged from the
 * samples' own timestamps, a local clock jump can only push a window into
 * `sliding` or `indeterminate` -- both non-verified.
 */
export function classifyVerificationSamples(
  before: NormalizedSnapshot,
  samples: NormalizedSnapshot[],
  targetWindowIds?: string[],
  now = Date.now(),
  minSpanMs = 0,
): { verdicts: Record<string, AnchorWindowVerdict>; verifiedWindowIds: string[] } {
  const targets = targetWindowIds
    ?? before.windows.filter((window) => window.kind !== "unknown").map((window) => window.id);
  const verdicts: Record<string, AnchorWindowVerdict> = {};
  const verifiedWindowIds: string[] = [];
  const last = samples[samples.length - 1];

  for (const windowId of targets) {
    const series: number[] = [];
    let complete = true;
    for (const sample of samples) {
      const window = sample.windows.find((candidate) => candidate.id === windowId);
      if (window === undefined || window.kind === "unknown" || window.resetsAt === null) {
        complete = false;
        break;
      }
      series.push(window.resetsAt);
    }
    if (!complete || series.length < 2 || last === undefined) {
      verdicts[windowId] = "indeterminate";
      continue;
    }

    const spanMs = last.observedAt - samples[0]!.observedAt;
    const spread = Math.max(...series) - Math.min(...series);
    if (spread <= RESET_STABILITY_TOLERANCE_SECONDS) {
      if (spanMs < minSpanMs) {
        // Identical values across too short a window are not evidence of a
        // fixed timestamp; they are equally consistent with one cached read.
        verdicts[windowId] = "indeterminate";
        continue;
      }
      const advanced = advancedTargetResetWindowIds(before, last, [windowId], now).includes(windowId);
      verdicts[windowId] = advanced ? "advanced_stable" : "not_advanced";
      if (advanced) {
        verifiedWindowIds.push(windowId);
      }
      continue;
    }

    const elapsedSeconds = spanMs / 1_000;
    const monotonic = series.every((value, index) => index === 0 || value >= series[index - 1]!);
    verdicts[windowId] = monotonic && elapsedSeconds > 0 && spread >= elapsedSeconds * 0.5
      ? "sliding"
      : "indeterminate";
  }

  return { verdicts, verifiedWindowIds };
}

export function advancedTargetResetWindowIds(
  before: NormalizedSnapshot,
  after: NormalizedSnapshot,
  targetWindowIds?: string[],
  now = Date.now(),
): string[] {
  const allowed = new Set(
    targetWindowIds ?? before.windows.filter((window) => window.kind !== "unknown").map((window) => window.id),
  );
  const advanced: string[] = [];
  for (const afterWindow of after.windows) {
    if (!allowed.has(afterWindow.id) || afterWindow.kind === "unknown" || afterWindow.resetsAt === null) {
      continue;
    }
    if (afterWindow.resetsAt * 1_000 <= now) {
      continue; // an advance into the past is not a new generation
    }
    const beforeWindow = before.windows.find((candidate) => candidate.id === afterWindow.id);
    if (beforeWindow === undefined || beforeWindow.resetsAt === null || afterWindow.resetsAt > beforeWindow.resetsAt) {
      advanced.push(afterWindow.id);
    }
  }
  return advanced;
}

export function didAdvanceTargetReset(
  before: NormalizedSnapshot,
  after: NormalizedSnapshot,
  targetWindowIds?: string[],
  now = Date.now(),
): boolean {
  return advancedTargetResetWindowIds(before, after, targetWindowIds, now).length > 0;
}

function notificationBelongsToThread(params: unknown, threadId: string): boolean {
  return isRecord(params) && params.threadId === threadId;
}

function turnIdFromNotification(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  return isRecord(params.turn) && typeof params.turn.id === "string" ? params.turn.id : null;
}

function turnStatusFromNotification(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }
  if (typeof params.status === "string") {
    return params.status;
  }
  return isRecord(params.turn) && typeof params.turn.status === "string" ? params.turn.status : null;
}

function isSuccessfulCompletionStatus(status: string): boolean {
  return ["completed", "complete", "succeeded", "success"].includes(status.toLowerCase());
}

function routeMatches(
  response: { model?: string | null; reasoningEffort?: string | null },
  route: AnchorRoute,
): boolean {
  return response.model === route.model && response.reasoningEffort === route.effort;
}

function turnRouteMatchesOrIsOmitted(
  response: { model?: string | null; reasoningEffort?: string | null },
  route: AnchorRoute,
): boolean {
  return turnRouteIsOmitted(response) || routeMatches(response, route);
}

function turnRouteIsOmitted(response: { model?: string | null; reasoningEffort?: string | null }): boolean {
  return (response.model === undefined || response.model === null)
    && (response.reasoningEffort === undefined || response.reasoningEffort === null);
}

function routeLogFields(route: AnchorRoute): { model: string; effort: AnchorRoute["effort"] } {
  return { model: route.model, effort: route.effort };
}

function isToolLikeItem(params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params.item)) {
    return false;
  }
  const type = typeof params.item.type === "string" ? params.item.type.toLowerCase() : "";
  return /tool|command|function|mcp|web|computer|patch|file/.test(type);
}

function looksLikeApprovalRequest(method: string): boolean {
  return /approval|requestapproval|elicitation/i.test(method);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForCompletion(completion: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    void completion.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
