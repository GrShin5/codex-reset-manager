import { AnchorExecutor } from "./anchor.js";
import type { AnchorTurnCompleted } from "./anchor.js";
import { formatAnchorRoute } from "./app-server.js";
import type { CodexAppServer } from "./app-server.js";
import { loadState, saveState } from "./files.js";
import type { Logger } from "./logger.js";
import { notifyMac } from "./notify.js";
import {
  applyAnchorResult,
  claimCandidates,
  manualAnchorAllowsAutoAnchoring,
  nextScheduledWakeAt,
  observeSnapshot,
} from "./state-machine.js";
import type { AnchorCandidate } from "./state-machine.js";
import type { AppPaths, ManagerConfig, ManagerState, RateLimitReadResult } from "./types.js";
import { mergeSparseRateLimitSnapshot, normalizeRateLimits } from "./windows.js";

export type MonitorNotifier = (title: string, message: string, logger: Logger) => Promise<void>;

export class UsageMonitor {
  private state: ManagerState;
  private latestRawSnapshot: RateLimitReadResult | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private queuedRefreshTimer: NodeJS.Timeout | null = null;
  private readonly queued = new Map<string, AnchorCandidate>();
  private running = false;
  private refreshing = false;
  private queuedRefreshSource: string | null = null;
  private anchoring = false;
  private unsubscribe: (() => void) | null = null;
  private lastSuccessfulRefreshAt: number | null = null;

  public constructor(
    private readonly client: CodexAppServer,
    private readonly paths: AppPaths,
    private readonly config: ManagerConfig,
    initialState: ManagerState,
    private readonly logger: Logger,
    private readonly notifier: MonitorNotifier = notifyMac,
  ) {
    this.state = initialState;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.unsubscribe = this.client.onNotification((method, params) => {
      if (method !== "account/rateLimits/updated") {
        return;
      }
      const sparse = asRateLimitReadResult(params);
      if (sparse !== null && this.latestRawSnapshot !== null) {
        this.latestRawSnapshot = mergeSparseRateLimitSnapshot(this.latestRawSnapshot, sparse);
      }
      if (this.refreshing) {
        // Likely the echo of the read already in flight (some servers emit
        // `updated` as a side effect of `read`). Merging above already picked
        // up anything new; skip triggering another refresh cycle from it.
        return;
      }
      this.requestRefresh("rate_limit_updated");
    });
    await this.refresh("startup_reconciliation");
    this.pollTimer = setInterval(() => {
      this.requestRefresh("poll");
    }, this.config.pollIntervalSeconds * 1_000);
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of [this.pollTimer, this.wakeTimer, this.coalesceTimer, this.reconnectTimer, this.queuedRefreshTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.pollTimer = null;
    this.wakeTimer = null;
    this.coalesceTimer = null;
    this.reconnectTimer = null;
    this.queuedRefreshTimer = null;
    this.queuedRefreshSource = null;
    this.queued.clear();
    await this.client.stop();
  }

  public getState(): ManagerState {
    return this.state;
  }

  private async refresh(source: string): Promise<void> {
    if (!this.running) {
      return;
    }
    if (this.refreshing) {
      this.queuedRefreshSource = source;
      return;
    }
    this.refreshing = true;
    try {
      await this.syncControlState();
      if (!this.anchoring) {
        // While an anchor is mid-turn it already holds the live client; do
        // not restart it out from under that in-flight turn.
        await this.client.start();
      }
      const raw = await this.client.readRateLimits();
      this.latestRawSnapshot = raw;
      const snapshot = normalizeRateLimits(raw);
      const observedAt = Date.now();
      const previousSuccessfulRefreshAt = this.lastSuccessfulRefreshAt;
      const delayed = previousSuccessfulRefreshAt !== null
        && observedAt - previousSuccessfulRefreshAt > Math.max(90_000, this.config.pollIntervalSeconds * 2_000);
      this.lastSuccessfulRefreshAt = observedAt;
      const anchorGenerationsBeforeObservation = new Set(Object.keys(this.state.anchors));
      const candidates = observeSnapshot(this.state, snapshot, this.config);
      await this.persistState();
      await this.logNewSkippedAnchors(source, anchorGenerationsBeforeObservation);
      const unknownWindowCount = snapshot.windows.filter((window) => window.kind === "unknown").length;
      await this.logger.debug("rate_limits_observed", {
        source,
        windowCount: snapshot.windows.length,
        targetWindowCount: snapshot.windows.length - unknownWindowCount,
        unknownWindowCount,
        candidateCount: candidates.length,
      });
      if (snapshot.windows.length === 0) {
        await this.logger.warn("rate_limits_no_windows_exposed");
      }
      if (delayed) {
        await this.logger.info("delayed_reconciliation", { source, delayedMilliseconds: observedAt - previousSuccessfulRefreshAt! });
      }
      this.scheduleNextWake();
      this.enqueue(candidates);
    } catch (error: unknown) {
      await this.logger.warn("monitor_refresh_failed", { source, errorName: error instanceof Error ? error.name : "unknown" });
      await this.reconnectLater();
    } finally {
      this.refreshing = false;
      const queuedSource = this.queuedRefreshSource;
      this.queuedRefreshSource = null;
      if (queuedSource !== null && this.running) {
        // Dispatch on a later tick rather than synchronously, so a server
        // that echoes an `updated` notification as a side effect of `read`
        // cannot spin refresh calls back-to-back on the same stack.
        this.queuedRefreshTimer = setTimeout(() => {
          this.queuedRefreshTimer = null;
          this.requestRefresh(queuedSource);
        }, 0);
      }
    }
  }

  private requestRefresh(source: string): void {
    if (this.refreshing) {
      this.queuedRefreshSource = source;
      return;
    }
    void this.refresh(source);
  }

  private enqueue(candidates: AnchorCandidate[]): void {
    if (candidates.length === 0) {
      return;
    }
    if (!this.state.autoAnchorEnabled || !manualAnchorAllowsAutoAnchoring(this.state)) {
      void this.logger.info("anchor_candidate_observed_but_disabled", { candidateCount: candidates.length });
      return;
    }
    for (const candidate of candidates) {
      this.queued.set(candidate.generation, candidate);
    }
    this.scheduleCoalesce();
  }

  private scheduleCoalesce(): void {
    if (this.coalesceTimer !== null || !this.running) {
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      void this.runQueuedAnchor().catch(async (error: unknown) => {
        await this.logger.error("anchor_dispatch_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      });
    }, this.config.coalesceSeconds * 1_000);
  }

  private async runQueuedAnchor(): Promise<void> {
    if (!this.running) {
      return;
    }
    if (this.anchoring) {
      // An anchor is already in flight. Do not drop the queued candidates —
      // re-arm the coalesce timer so they are retried once it finishes.
      this.scheduleCoalesce();
      return;
    }
    // Latch immediately after the guard, before any await, so two overlapping
    // invocations can never both pass the guard above and both proceed.
    this.anchoring = true;
    let candidates: AnchorCandidate[] = [];
    try {
      await this.syncControlState();
      if (!this.state.autoAnchorEnabled || !manualAnchorAllowsAutoAnchoring(this.state)) {
        this.queued.clear();
        return;
      }
      const queuedCandidates = [...this.queued.values()].filter((candidate) => this.state.anchors[candidate.generation] === undefined);
      this.queued.clear();
      if (queuedCandidates.length === 0) {
        return;
      }

      // A candidate is only an observation, never permission to spend Usage.
      // Re-read the complete rate-limit snapshot immediately before its
      // durable claim so user activity during the 30-second coalesce window
      // cancels the attempt before thread/start or turn/start.
      await this.client.start();
      const anchorGenerationsBeforePreflight = new Set(Object.keys(this.state.anchors));
      const preflightRaw = await this.client.readRateLimits();
      this.latestRawSnapshot = preflightRaw;
      const preflight = normalizeRateLimits(preflightRaw);
      const preflightCandidates = observeSnapshot(this.state, preflight, this.config);
      await this.persistState();
      await this.logNewSkippedAnchors("anchor_preflight", anchorGenerationsBeforePreflight);
      const queuedGenerations = new Set(queuedCandidates.map((candidate) => candidate.generation));
      candidates = preflightCandidates.filter((candidate) => queuedGenerations.has(candidate.generation));
      // A distinct reset that appears during this re-check gets its own full
      // coalescing interval; it must not piggyback on an already-mature batch.
      this.enqueue(preflightCandidates.filter((candidate) => !queuedGenerations.has(candidate.generation)));
      await this.logger.info("anchor_preflight_observed", {
        queuedCandidateCount: queuedCandidates.length,
        eligibleCandidateCount: candidates.length,
      });
      if (candidates.length === 0) {
        return;
      }

      claimCandidates(this.state, candidates);
      await this.persistState();
      const targetWindowIds = [...new Set(candidates.map((candidate) => candidate.windowId))];
      await this.logger.info("anchor_claimed", { candidateCount: candidates.length, targetWindowCount: targetWindowIds.length });
      const claimedCandidates = candidates;
      const result = await new AnchorExecutor(this.client, this.paths, this.config, this.logger).run(
        targetWindowIds,
        async (event) => this.notifyAnchorVerified(event, claimedCandidates),
      );
      if (result.after !== null) {
        const anchorGenerationsBeforeResult = new Set(Object.keys(this.state.anchors));
        this.enqueue(observeSnapshot(this.state, result.after, this.config));
        await this.logNewSkippedAnchors("anchor_result", anchorGenerationsBeforeResult);
      }
      applyAnchorResult(this.state, candidates, result);
      await this.persistState();
    } catch (error: unknown) {
      const detail = "The anchor could not be completed. It will not be retried for this reset generation.";
      for (const candidate of candidates) {
        const record = this.state.anchors[candidate.generation];
        if (record !== undefined) {
          record.status = "rejected";
          record.completedAt = Date.now();
          record.detail = detail;
        }
      }
      await this.persistState();
      await this.logger.error("anchor_executor_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    } finally {
      this.anchoring = false;
      // stop() may have run while an in-flight anchor was completing. Never
      // recreate a wake timer after shutdown; doing so can keep a foreground
      // daemon alive or schedule stale work after a LaunchAgent unload.
      if (this.running) {
        this.scheduleNextWake();
      }
    }
  }

  private async notifyAnchorVerified(event: AnchorTurnCompleted, candidates: AnchorCandidate[]): Promise<void> {
    // Only describe the windows that actually advanced, not every candidate
    // that was in the coalesced batch.
    const notifiedCandidates = candidates.filter((candidate) => event.targetWindowIds.includes(candidate.windowId));
    if (notifiedCandidates.length === 0) {
      return;
    }
    const alreadyNotified = notifiedCandidates.some((candidate) => {
      const record = this.state.anchors[candidate.generation];
      return record?.notifiedAt !== undefined && record.notifiedAt !== null;
    });
    if (alreadyNotified) {
      return;
    }
    await this.notifier(
      "Codex usage window anchor verified",
      "A guarded " + formatAnchorRoute(event.route) + " anchor turn verified " + describeTargetWindows(notifiedCandidates, this.state) + ".",
      this.logger,
    );
    const notifiedAt = Date.now();
    for (const candidate of notifiedCandidates) {
      const record = this.state.anchors[candidate.generation];
      if (record !== undefined) {
        record.notifiedAt = notifiedAt;
      }
    }
  }

  private scheduleNextWake(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const wakeAt = nextScheduledWakeAt(this.state, this.config);
    if (wakeAt === null) {
      return;
    }
    const delay = Math.max(0, wakeAt - Date.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.requestRefresh("scheduled_wake");
    }, Math.min(delay, 2_147_000_000));
  }

  private async reconnectLater(): Promise<void> {
    if (this.anchoring) {
      // An anchor holds the live client mid-turn; tearing it down here would
      // make its turn/completed unreachable and burn the full 90s timeout
      // (and the generation would get marked rejected after real Usage was
      // already spent). Still make sure this refresh gets retried later.
      this.scheduleReconnect();
      return;
    }
    try {
      await this.client.stop();
    } catch {
      // The next poll still gets a fresh client start attempt.
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.requestRefresh("reconnect");
    }, Math.min(this.config.pollIntervalSeconds * 1_000, 15_000));
  }

  private async syncControlState(): Promise<void> {
    const disk = await loadState(this.paths);
    this.state.autoAnchorEnabled = disk.autoAnchorEnabled;
    this.state.manualAnchor = disk.manualAnchor;
    for (const [windowId, diskWindow] of Object.entries(disk.windows)) {
      const memoryWindow = this.state.windows[windowId];
      if (memoryWindow === undefined || (diskWindow.verifiedResetAt !== null && (memoryWindow.verifiedResetAt === null || diskWindow.verifiedResetAt > memoryWindow.verifiedResetAt))) {
        this.state.windows[windowId] = { ...diskWindow };
      }
    }
    for (const [generation, record] of Object.entries(disk.anchors)) {
      if (this.state.anchors[generation] === undefined) {
        this.state.anchors[generation] = { ...record };
      }
    }
  }

  private async persistState(): Promise<void> {
    await this.syncControlState();
    await saveState(this.paths, this.state);
  }

  private async logNewSkippedAnchors(source: string, before: Set<string>): Promise<void> {
    const skipped = Object.values(this.state.anchors).filter((record) => !before.has(record.generation) && record.status === "skipped");
    for (const record of skipped) {
      await this.logger.info("anchor_skipped", {
        source,
        generation: record.generation,
        windowIds: record.windowIds,
        detail: record.detail,
      });
    }
  }
}

function describeTargetWindows(candidates: AnchorCandidate[], state: ManagerState): string {
  const names = [...new Set(candidates.map((candidate) => state.windows[candidate.windowId]?.kind))]
    .filter((kind): kind is "five_hour" | "weekly" => kind === "five_hour" || kind === "weekly")
    .map((kind) => kind === "five_hour" ? "the 5-hour" : "the weekly")
    .sort();
  if (names.length === 0) {
    return "the reset usage";
  }
  return names.length === 1 ? names[0] + " usage window" : names.join(" and ") + " usage windows";
}

function asRateLimitReadResult(params: unknown): Partial<RateLimitReadResult> | null {
  if (!isRecord(params)) {
    return null;
  }
  if (isRecord(params.rateLimits)) {
    return {
      rateLimits: params.rateLimits as RateLimitReadResult["rateLimits"],
      ...(isRecord(params.rateLimitsByLimitId)
        ? { rateLimitsByLimitId: params.rateLimitsByLimitId as Record<string, RateLimitReadResult["rateLimits"]> }
        : {}),
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
