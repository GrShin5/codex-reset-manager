import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import { appServerCommandFromEnvironment, appServerSpawnEnvironment } from "./codex-command.js";
import type { Logger } from "./logger.js";
import type { AnchorEffort, AnchorRoute, JsonRpcError, JsonRpcResponse, RateLimitReadResult } from "./types.js";

export interface AccountSummary {
  account?: { type?: string; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
}

export interface ModelSummary {
  slug?: string;
  id?: string;
  /** App Server has used both strings and descriptor objects for this field. */
  supportedReasoningEfforts?: Array<string | { reasoningEffort?: string; effort?: string }>;
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

export interface StartedThread {
  id?: string;
  ephemeral?: boolean;
  path?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartedTurn {
  id?: string;
  status?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface CodexAppServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAccount(): Promise<AccountSummary>;
  readRateLimits(): Promise<RateLimitReadResult>;
  listModels(): Promise<ModelSummary[]>;
  startEphemeralThread(anchorCwd: string, route: AnchorRoute): Promise<StartedThread>;
  startAnchorTurn(threadId: string, route: AnchorRoute): Promise<StartedTurn>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
}

export class RpcRequestError extends Error {
  public constructor(
    public readonly method: string,
    public readonly rpcError: JsonRpcError,
  ) {
    super(`${method} failed: ${rpcError.message}`);
    this.name = "RpcRequestError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class AppServerClient extends EventEmitter implements CodexAppServer {
  private child: ReturnType<typeof spawn> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private started = false;

  public constructor(
    private readonly logger: Logger,
    private readonly command = appServerCommandFromEnvironment(),
  ) {
    super();
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const child = spawn(this.command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: appServerSpawnEnvironment(this.command),
    });
    this.child = child;

    child.once("error", (error) => this.handleExit(`spawn_error:${error.name}`));
    child.once("exit", (code, signal) => this.handleExit(`exit:${code ?? "null"}:${signal ?? "null"}`));
    child.stdin?.on("error", (error) => this.handleExit(`stdin_error:${error.name}`));
    child.stderr?.on("data", () => {
      void this.logger.debug("app_server_stderr_received");
    });

    const reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => this.handleLine(line));
    reader.on("close", () => this.handleExit("stdout_closed"));

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "codex-reset-manager",
          version: "0.1.0",
        },
        capabilities: {
          optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/delta"],
        },
      });
      this.started = true;
      await this.logger.info("app_server_connected");
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.started = false;
    this.child = null;
    this.rejectPending(new Error("App Server stopped."));
    if (child !== null && !child.killed) {
      child.kill();
    }
  }

  public async getAccount(): Promise<AccountSummary> {
    return this.request<AccountSummary>("account/read", { refreshToken: false });
  }

  public async readRateLimits(): Promise<RateLimitReadResult> {
    return this.request<RateLimitReadResult>("account/rateLimits/read");
  }

  public async listModels(): Promise<ModelSummary[]> {
    const models: ModelSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const result: { data?: ModelSummary[]; nextCursor?: string | null } = await this.request<{ data?: ModelSummary[]; nextCursor?: string | null }>("model/list", {
        limit: 100,
        cursor,
      });
      models.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor === null) {
        return models;
      }
    }
    throw new Error("model/list returned more than 100 pages; refusing an unbounded read.");
  }

  /**
   * VERIFIED (extracted from the installed Codex binary's serde field
   * clusters): `thread/start` takes `sandbox` as a kebab-case string enum —
   * `read-only` / `workspace-write` / `danger-full-access` — and
   * `approvalPolicy` as a kebab-case enum that includes `never`. This is a
   * different wire shape from `turn/start` below (see the comment there).
   * That asymmetry is intentional on the Codex side and MUST NOT be
   * "unified" between the two calls — the current code is correct on both.
   */
  public async startEphemeralThread(anchorCwd: string, route: AnchorRoute): Promise<StartedThread> {
    const result = await this.request<StartedThread & { thread?: StartedThread }>("thread/start", {
      model: route.model,
      cwd: anchorCwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "none",
      serviceName: "codex_reset_manager",
      config: {
        model_reasoning_effort: route.effort,
      },
    });
    // The current server has returned both nested and flat response shapes in
    // nearby protocol revisions. Accept either representation, but leave the
    // caller to fail closed unless the normalized model/effort is exact.
    const thread = result.thread ?? result;
    return {
      id: thread.id,
      ephemeral: thread.ephemeral,
      path: thread.path,
      model: result.model ?? thread.model ?? null,
      reasoningEffort: result.reasoningEffort ?? thread.reasoningEffort ?? null,
    };
  }

  /**
   * VERIFIED (extracted from the installed Codex binary's serde field
   * clusters): `turn/start` takes `sandboxPolicy` as an internally-tagged
   * camelCase union — `readOnly` / `workspaceWrite` / `dangerFullAccess`,
   * plus a `networkAccess` flag — not the kebab-case `sandbox` string enum
   * used by `thread/start` above. `approvalPolicy` is still the same
   * kebab-case enum (including `never`) on both calls. This asymmetry is
   * intentional on the Codex side and MUST NOT be "unified" between the two
   * calls — the current code is correct on both.
   */
  public async startAnchorTurn(threadId: string, route: AnchorRoute): Promise<StartedTurn> {
    const result = await this.request<StartedTurn & {
      turn?: StartedTurn;
      effort?: string | null;
    }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply exactly OK. Do not use tools." }],
      model: route.model,
      effort: route.effort,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      personality: "none",
      summary: "none",
    });
    const turn = result.turn ?? result;
    return {
      id: turn.id,
      status: turn.status,
      model: result.model ?? turn.model ?? null,
      reasoningEffort: result.reasoningEffort ?? result.effort ?? turn.reasoningEffort ?? null,
    };
  }

  public async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  public onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.on("notification", listener);
    return () => this.off("notification", listener);
  }

  private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (child?.stdin === null || child?.stdin === undefined || child.killed) {
      throw new Error("Codex App Server is not running.");
    }
    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 30_000);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    try {
      child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
    } catch (error: unknown) {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error("Could not write to Codex App Server."));
      }
    }
    return response;
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      void this.logger.warn("app_server_invalid_json");
      return;
    }
    if (message.method !== undefined) {
      this.emit("notification", message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error !== undefined) {
      pending.reject(new RpcRequestError(pending.method, message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(reason: string): void {
    if (this.child === null && !this.started) {
      return;
    }
    this.child = null;
    const wasStarted = this.started;
    this.started = false;
    this.rejectPending(new Error(`Codex App Server disconnected (${reason}).`));
    if (wasStarted) {
      this.emit("disconnected", reason);
      void this.logger.warn("app_server_disconnected", { reason });
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Official API list-price order, used only as a stable relative preference for
 * this tiny fixed prompt. It is not a Codex subscription-cost calculation.
 * An unknown model is deliberately ineligible: without audited price and
 * effort semantics, selecting it would widen the automatic-anchor contract.
 */
const ANCHOR_MODEL_COST_ORDER = [
  "gpt-5.6-luna",
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5.6-terra",
  "gpt-5.4",
  "gpt-5.6-sol",
  "gpt-5.5",
] as const;

const ANCHOR_EFFORT_COST_ORDER: AnchorEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * Select exactly one explicitly advertised model/effort pair immediately
 * before an anchor. Provider reroutes are not part of this selector and must
 * still be interrupted by the anchor safety path.
 */
export function selectLowestCostAnchorRoute(models: ModelSummary[]): AnchorRoute | null {
  for (const modelName of ANCHOR_MODEL_COST_ORDER) {
    const supportedEfforts = new Set<AnchorEffort>();
    for (const model of models) {
      if (model.slug !== modelName && model.id !== modelName) {
        continue;
      }
      for (const effort of modelEfforts(model)) {
        if (ANCHOR_EFFORT_COST_ORDER.includes(effort)) {
          supportedEfforts.add(effort);
        }
      }
    }
    for (const effort of ANCHOR_EFFORT_COST_ORDER) {
      if (supportedEfforts.has(effort)) {
        return { model: modelName, effort };
      }
    }
  }
  return null;
}

export function formatAnchorRoute(route: AnchorRoute): string {
  return `${route.model} / ${route.effort}`;
}

function modelEfforts(model: ModelSummary): AnchorEffort[] {
  const direct = (model.supportedReasoningEfforts ?? []).flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    const effort = entry.reasoningEffort ?? entry.effort;
    return effort === undefined ? [] : [effort];
  });
  const nested = model.supported_reasoning_levels?.map((entry) => entry.effort).filter((entry): entry is string => entry !== undefined) ?? [];
  return [...direct, ...nested].filter((effort): effort is AnchorEffort => ANCHOR_EFFORT_COST_ORDER.includes(effort as AnchorEffort));
}
