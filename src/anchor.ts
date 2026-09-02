import { formatAnchorRoute, selectLowestCostAnchorRoute } from "./app-server.js";
import type { CodexAppServer } from "./app-server.js";
import { anchorWorkspaceIsEmpty } from "./files.js";
import type { Logger } from "./logger.js";
import { ProcessLock } from "./lock.js";
import type { AnchorRoute, AppPaths, AnchorRunResult, ManagerConfig, NormalizedSnapshot } from "./types.js";
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

    await delay(this.config.verificationDelaySeconds * 1_000);
    const after = normalizeRateLimits(await this.client.readRateLimits());
    const verifiedWindowIds = advancedTargetResetWindowIds(before, after, effectiveTargetWindowIds);
    const verified = verifiedWindowIds.length > 0;
    const result: AnchorRunResult = {
      status: verified ? "verified" : "unverified",
      detail: verified
        ? `The isolated ${formatAnchorRoute(route)} turn advanced ${verifiedWindowIds.length} of ${effectiveTargetWindowIds.length} target window reset timestamps.`
        : "The turn completed, but the target window timestamp could not be verified as advanced.",
      before,
      after,
      threadId: thread.id,
      route,
      targetWindowIds: effectiveTargetWindowIds,
      turnCompletedSafely: true,
      verifiedWindowIds,
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
