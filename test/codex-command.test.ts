import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appServerCommandFromEnvironment,
  appServerSpawnEnvironment,
  CODEX_COMMAND_ENV,
  resolveCodexExecutable,
} from "../src/codex-command.js";

test("uses the LaunchAgent-provided absolute Codex CLI path when present", () => {
  assert.equal(
    appServerCommandFromEnvironment({ [CODEX_COMMAND_ENV]: "/Users/example/.npm-global/bin/codex" }),
    "/Users/example/.npm-global/bin/codex",
  );
  assert.equal(appServerCommandFromEnvironment({}), "codex");
});

test("supplies the Node runtime PATH and HOME required by an npm-installed Codex script", () => {
  const environment = appServerSpawnEnvironment(
    "/Users/example/.npm-global/bin/codex",
    { PATH: "/usr/bin:/bin", HOME: "" },
    "/usr/local/bin/node",
    "/Users/example",
  );
  assert.equal(
    environment.PATH,
    "/usr/local/bin:/Users/example/.npm-global/bin:/usr/bin:/bin",
  );
  assert.equal(environment.HOME, "/Users/example");
});

test("resolves an executable Codex CLI from the interactive shell PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-command-test-"));
  const executable = join(directory, "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  assert.equal(await resolveCodexExecutable({ PATH: directory }), executable);
  assert.equal(
    await resolveCodexExecutable({ PATH: "/missing", [CODEX_COMMAND_ENV]: executable }),
    executable,
  );
});
