import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAppDirectories } from "../src/files.js";
import { Logger } from "../src/logger.js";
import { resolveAppPaths } from "../src/paths.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("redacts prompt-like data and rotates JSONL event logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-logger-test-"));
  const paths = resolveAppPaths(root);
  await ensureAppDirectories(paths);
  const logger = new Logger(paths, { ...DEFAULT_CONFIG, logFileMaxBytes: 1, logFilesToKeep: 2 });
  await logger.info("first", { prompt: "private user content", stable: "safe" });
  await logger.info("second", { message: "also private" });
  const files = await readdir(paths.logsDirectory);
  assert.ok(files.some((file) => file.startsWith("events.") && file.endsWith(".jsonl")));
  const allLogs = await Promise.all(files.map((file) => readFile(join(paths.logsDirectory, file), "utf8")));
  assert.doesNotMatch(allLogs.join("\n"), /private user content|also private/);
  assert.match(allLogs.join("\n"), /\[redacted\]/);
});
