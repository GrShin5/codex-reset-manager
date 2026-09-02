import type { CodexAppServer, ModelSummary, StartedThread, StartedTurn } from "../src/app-server.js";
import type { AnchorRoute, RateLimitReadResult } from "../src/types.js";

export function rateLimits(
  primary: { usedPercent: number | null; duration: number | null; resetsAt: number | null } | null,
  secondary: { usedPercent: number | null; duration: number | null; resetsAt: number | null } | null = null,
): RateLimitReadResult {
  return {
    rateLimits: {
      limitId: "codex",
      primary: primary === null ? null : {
        usedPercent: primary.usedPercent,
        windowDurationMins: primary.duration,
        resetsAt: primary.resetsAt,
      },
      secondary: secondary === null ? null : {
        usedPercent: secondary.usedPercent,
        windowDurationMins: secondary.duration,
        resetsAt: secondary.resetsAt,
      },
      rateLimitReachedType: null,
    },
  };
}

export class FakeAppServer implements CodexAppServer {
  public started = false;
  public turnCalls = 0;
  public interruptCalls = 0;
  public threadCalls = 0;
  public readCalls = 0;
  public startCalls = 0;
  public readFailuresRemaining = 0;
  /** Override an otherwise exact echo of the requested route. */
  public thread: StartedThread | null = null;
  /** Override an otherwise exact echo of the requested route. */
  public turn: StartedTurn | null = null;
  public readonly threadRoutes: AnchorRoute[] = [];
  public readonly turnRoutes: AnchorRoute[] = [];
  public models: ModelSummary[] = [{ slug: "gpt-5.6-luna", supportedReasoningEfforts: ["low", "medium"] }];
  public emitToolItem = false;
  /**
   * The real App Server delivers every notification asynchronously on the
   * readline `line` handler, i.e. strictly AFTER `turn/start` resolves.
   * Emitting safety signals synchronously (the default here, kept for the
   * existing fixtures) only ever exercises the pre-acknowledgement path.
   */
  public emitSafetyAsync = false;
  public emitModelRerouted = false;
  public emitApprovalRequest = false;
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private snapshotIndex = 0;

  public constructor(private readonly snapshots: RateLimitReadResult[]) {}

  public async start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.started = false;
  }

  public async getAccount(): Promise<{ account: { type: string }; requiresOpenaiAuth: boolean }> {
    return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
  }

  public async readRateLimits(): Promise<RateLimitReadResult> {
    this.readCalls += 1;
    if (this.readFailuresRemaining > 0) {
      this.readFailuresRemaining -= 1;
      throw new Error("fixture App Server disconnect");
    }
    const snapshot = this.snapshots[Math.min(this.snapshotIndex, this.snapshots.length - 1)];
    this.snapshotIndex += 1;
    if (snapshot === undefined) {
      throw new Error("No rate-limit fixture was supplied.");
    }
    return structuredClone(snapshot);
  }

  public async listModels(): Promise<ModelSummary[]> {
    return structuredClone(this.models);
  }

  public async startEphemeralThread(_anchorCwd: string, route: AnchorRoute): Promise<StartedThread> {
    this.threadCalls += 1;
    this.threadRoutes.push(structuredClone(route));
    return structuredClone(this.thread ?? {
      id: "thread_anchor",
      ephemeral: true,
      path: null,
      model: route.model,
      reasoningEffort: route.effort,
    });
  }

  public async startAnchorTurn(threadId: string, route: AnchorRoute): Promise<StartedTurn> {
    this.turnCalls += 1;
    this.turnRoutes.push(structuredClone(route));
    const turn = this.turn ?? {
      id: "turn_anchor",
      status: "inProgress",
      model: route.model,
      reasoningEffort: route.effort,
    };
    const emitSafetySignals = (): void => {
      if (this.emitToolItem) {
        this.emit("item/started", { threadId, item: { type: "commandExecution" } });
      }
      if (this.emitApprovalRequest) {
        this.emit("server/requestApproval", { threadId });
      }
      if (this.emitModelRerouted) {
        this.emit("model/rerouted", { threadId, fromModel: route.model, toModel: "gpt-5.5" });
      }
    };
    const emitCompleted = (): void => {
      this.emit("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
    };
    if (this.emitSafetyAsync) {
      // Model the real ordering: notifications stream in while the turn is
      // still running, and completion arrives last.
      setTimeout(emitSafetySignals, 5);
      setTimeout(emitCompleted, 25);
    } else {
      emitSafetySignals();
      queueMicrotask(emitCompleted);
    }
    return structuredClone(turn);
  }

  public async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  public onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(method: string, params: unknown): void {
    for (const listener of this.listeners) {
      listener(method, params);
    }
  }
}
