import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, emptyState } from "./types.js";
import type { AppPaths, ManagerConfig, ManagerState } from "./types.js";
import { migrateLegacyRolloverState } from "./state-machine.js";

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.logsDirectory, { recursive: true }),
    mkdir(paths.anchorWorkspace, { recursive: true }),
  ]);
}

/**
 * Anchors must never inherit an arbitrary user workspace.  Do not clear this
 * directory automatically: if something appears in it, fail closed instead.
 */
export async function anchorWorkspaceIsEmpty(paths: AppPaths): Promise<boolean> {
  await mkdir(paths.anchorWorkspace, { recursive: true });
  return (await readdir(paths.anchorWorkspace)).length === 0;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    // A truncated/corrupt file is treated the same as a missing one: the
    // caller falls back to its default and rewrites the file, instead of
    // throwing a SyntaxError that would otherwise propagate as an unhandled
    // rejection out of loadState -> syncControlState.
    if (isMissing(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function loadConfig(paths: AppPaths): Promise<ManagerConfig> {
  const existing = await readJsonFile<Partial<ManagerConfig>>(paths.configFile);
  const config: ManagerConfig = {
    ...DEFAULT_CONFIG,
    version: 1,
    // Monitoring cadence, coalescing, and route-selection policy are part of
    // the safety contract, not user-tunable knobs. A hand-edited config file
    // must never create extra polling/turns or widen an automatic anchor.
    // Legacy version-1 anchorModel/anchorEffort values are intentionally
    // ignored; the current App Server model list is selected safely at run
    // time instead.
    pollIntervalSeconds: DEFAULT_CONFIG.pollIntervalSeconds,
    resetGraceSeconds: DEFAULT_CONFIG.resetGraceSeconds,
    coalesceSeconds: DEFAULT_CONFIG.coalesceSeconds,
    verificationDelaySeconds: DEFAULT_CONFIG.verificationDelaySeconds,
    rollbackThresholdPercent: DEFAULT_CONFIG.rollbackThresholdPercent,
    logFileMaxBytes: DEFAULT_CONFIG.logFileMaxBytes,
    logFilesToKeep: DEFAULT_CONFIG.logFilesToKeep,
  };
  if (existing === null) {
    await writeJsonAtomic(paths.configFile, config);
  }
  return config;
}

export async function loadState(paths: AppPaths): Promise<ManagerState> {
  const existing = await readJsonFile<ManagerState>(paths.stateFile);
  const state = existing?.version === 1 ? existing : emptyState();
  const migrated = existing?.version === 1 && migrateLegacyRolloverState(state);
  if (existing === null || existing.version !== 1 || migrated) {
    await saveState(paths, state);
  }
  return state;
}

export async function saveState(paths: AppPaths, state: ManagerState): Promise<void> {
  state.lastUpdatedAt = Date.now();
  await writeJsonAtomic(paths.stateFile, state);
}

export async function tailFile(path: string, lineCount = 80): Promise<string> {
  try {
    const contents = await readFile(path, "utf8");
    return contents.split("\n").slice(-lineCount - 1).filter(Boolean).join("\n");
  } catch (error: unknown) {
    if (isMissing(error)) {
      return "";
    }
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export async function removeKnownPath(path: string): Promise<void> {
  // This is used for the manager's single plist. Do not recursively remove a
  // directory should that path ever be replaced unexpectedly.
  await rm(path, { force: true });
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
