import { appendFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AppPaths, ManagerConfig } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  at: string;
  level: LogLevel;
  event: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /token|authorization|cookie|secret|password|email|raw|response|prompt|input|message|content/i;

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]),
    );
  }
  return value;
}

export class Logger {
  private readonly eventLog: string;

  public constructor(
    private readonly paths: AppPaths,
    private readonly config: Pick<ManagerConfig, "logFileMaxBytes" | "logFilesToKeep">,
  ) {
    this.eventLog = join(paths.logsDirectory, "events.jsonl");
  }

  public async log(level: LogLevel, event: string, details?: Record<string, unknown>): Promise<void> {
    try {
      await this.rotateIfNeeded();
      const record: LogRecord = {
        at: new Date().toISOString(),
        level,
        event,
        ...(details === undefined ? {} : { details: redact(details) as Record<string, unknown> }),
      };
      await appendFile(this.eventLog, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Logging must never stop monitoring or cause a second anchor attempt.
    }
  }

  public debug(event: string, details?: Record<string, unknown>): Promise<void> {
    return this.log("debug", event, details);
  }

  public info(event: string, details?: Record<string, unknown>): Promise<void> {
    return this.log("info", event, details);
  }

  public warn(event: string, details?: Record<string, unknown>): Promise<void> {
    return this.log("warn", event, details);
  }

  public error(event: string, details?: Record<string, unknown>): Promise<void> {
    return this.log("error", event, details);
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const current = await stat(this.eventLog);
      if (current.size < this.config.logFileMaxBytes) {
        return;
      }
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      await rename(this.eventLog, join(this.paths.logsDirectory, `events.${timestamp}.jsonl`));
      const files = (await readdir(this.paths.logsDirectory))
        .filter((file) => file.startsWith("events.") && file.endsWith(".jsonl"))
        .sort()
        .reverse();
      await Promise.all(
        files.slice(this.config.logFilesToKeep).map(async (file) => {
          const { rm } = await import("node:fs/promises");
          await rm(join(this.paths.logsDirectory, file), { force: true });
        }),
      );
    } catch {
      // Missing logs are normal on the first run.
    }
  }
}
