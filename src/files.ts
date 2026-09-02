import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, emptyState } from "./types.js";
import type { AppPaths, ManagerConfig, ManagerState } from "./types.js";
import { migrateLegacyRolloverState } from "./state-machine.js";

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.anchorWorkspace, { recursive: true, mode: 0o700 }),
  ]);
  await tightenAppPermissions(paths);
}

/**
 * `mode` on mkdir/appendFile only applies at creation, so an installation
 * created before those modes were set keeps its original permissions forever.
 * Tighten those once, best effort.  Every step is swallowed: these are
 * owner-only operations on the owner's own files, and a failure must never
 * stop a CLI command or prevent the daemon from starting.
 */
async function tightenAppPermissions(paths: AppPaths): Promise<void> {
  for (const directory of [paths.root, paths.logsDirectory, paths.anchorWorkspace]) {
    await tighten(directory, 0o700);
  }
  try {
    const entries = await readdir(paths.logsDirectory);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("events.") && entry.endsWith(".jsonl"))
        .map(async (entry) => tighten(join(paths.logsDirectory, entry), 0o600)),
    );
  } catch {
    // A missing logs directory is normal before the first run.
  }
  await Promise.all([paths.stdoutLog, paths.stderrLog].map(async (file) => tighten(file, 0o600)));
}

/**
 * Tighten one path we own, and only one we own.
 *
 * CODEX_ANCHOR_HOME is arbitrary user-supplied input, so this must never be a
 * primitive for relaxing or narrowing arbitrary files. Two guards matter:
 *
 * - lstat, and refuse symlinks. chmod follows links, so a symlink planted as
 *   `events.x.jsonl` in a writable logs directory would otherwise have its
 *   target chmod'ed.
 * - refuse anything this user does not own, so pointing the home at a shared
 *   directory cannot lock other accounts out of it.
 */
async function tighten(path: string, mode: number): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) {
      return;
    }
    if ((current.mode & 0o077) === 0) {
      return;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && current.uid !== uid) {
      return;
    }
    await chmod(path, mode);
  } catch {
    // Missing paths are normal before the first run; anything else is not
    // ours to repair.
  }
}

/**
 * Anchors must never inherit an arbitrary user workspace.  Do not clear this
 * directory automatically: if something appears in it, fail closed instead.
 */
export async function anchorWorkspaceIsEmpty(paths: AppPaths): Promise<boolean> {
  await mkdir(paths.anchorWorkspace, { recursive: true, mode: 0o700 });
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
    // Weakening verification is precisely how a sliding reset timestamp would
    // be mistaken for a successful anchor, so these are pinned like the rest.
    verificationSampleCount: DEFAULT_CONFIG.verificationSampleCount,
    verificationSampleIntervalSeconds: DEFAULT_CONFIG.verificationSampleIntervalSeconds,
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
