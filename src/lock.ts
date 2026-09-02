import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissing } from "./files.js";

interface LockOwner {
  pid: number;
  startedAt: number;
  nonce?: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH");
  }
}

export class ProcessLock {
  private held = false;
  private owner: LockOwner | null = null;

  public constructor(private readonly directory: string) {}

  public async acquire(): Promise<void> {
    if (this.held) {
      return;
    }
    await this.acquireDirectory();
    const owner: LockOwner = { pid: process.pid, startedAt: Date.now(), nonce: randomUUID() };
    try {
      await writeFile(join(this.directory, "owner.json"), JSON.stringify(owner), "utf8");
    } catch (error: unknown) {
      await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    this.owner = owner;
    this.held = true;
  }

  public async release(): Promise<void> {
    if (!this.held) {
      return;
    }
    this.held = false;
    const owner = await this.readOwner();
    if (sameOwner(owner, this.owner)) {
      await rm(this.directory, { recursive: true, force: true });
    }
    this.owner = null;
  }

  private async acquireDirectory(): Promise<void> {
    try {
      await mkdir(this.directory);
      return;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }

    const owner = await this.readOwner();
    if (owner !== null && processIsAlive(owner.pid)) {
      throw new Error(`Another Codex Reset Manager daemon is running (pid ${owner.pid}).`);
    }
    if (owner === null && await this.isFreshDirectory()) {
      throw new Error("Another Codex Reset Manager daemon is initializing its lock.");
    }
    // Re-read immediately before removal. This does not replace an OS-level
    // flock, but it prevents a stale-lock recovery from blindly removing a
    // newly written live owner in the normal concurrent-start path.
    const currentOwner = await this.readOwner();
    if (!sameOwner(currentOwner, owner)) {
      return this.acquireDirectory();
    }
    if (currentOwner !== null && processIsAlive(currentOwner.pid)) {
      throw new Error(`Another Codex Reset Manager daemon is running (pid ${currentOwner.pid}).`);
    }
    await rm(this.directory, { recursive: true, force: true });
    return this.acquireDirectory();
  }

  private async readOwner(): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, "owner.json"), "utf8")) as Partial<LockOwner>;
      const pid = parsed.pid;
      const startedAt = parsed.startedAt;
      if (typeof pid !== "number" || !Number.isInteger(pid) || (startedAt !== undefined && !Number.isFinite(startedAt))) {
        return null;
      }
      return {
        pid,
        startedAt: typeof startedAt === "number" ? startedAt : 0,
        ...(typeof parsed.nonce === "string" ? { nonce: parsed.nonce } : {}),
      };
    } catch (error: unknown) {
      if (isMissing(error) || isSyntaxError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async isFreshDirectory(): Promise<boolean> {
    try {
      return Date.now() - (await stat(this.directory)).mtimeMs < 5_000;
    } catch (error: unknown) {
      if (isMissing(error)) {
        return true;
      }
      throw error;
    }
  }
}

function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.pid === right.pid && left.startedAt === right.startedAt && left.nonce === right.nonce;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function isSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
