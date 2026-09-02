import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProcessLock } from "../src/lock.js";

test("prevents a second live owner and reclaims a crashed owner's lock", async () => {
  const directory = join(tmpdir(), `codex-lock-test-${process.pid}-${Date.now()}`);
  const first = new ProcessLock(directory);
  const second = new ProcessLock(directory);
  await first.acquire();
  await assert.rejects(second.acquire(), /Another Codex Reset Manager daemon is running/);
  await first.release();

  await mkdir(directory);
  await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 0 }), "utf8");
  const afterCrash = new ProcessLock(directory);
  await afterCrash.acquire();
  await afterCrash.release();
});
