import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appServerCommandFromEnvironment,
  appServerSpawnEnvironment,
  CODEX_COMMAND_ENV,
  codexVersionDiagnostic,
  parseCodexCliVersion,
  resolveCodexExecutable,
  TESTED_CODEX_CLI_VERSIONS,
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

test("reads the version out of codex --version output", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.152.0\n"), "0.152.0");
  assert.equal(parseCodexCliVersion("codex-cli 0.153.0-alpha.1"), "0.153.0-alpha.1");
  assert.equal(parseCodexCliVersion("something else entirely"), null);
  assert.equal(parseCodexCliVersion(""), null);
});

/**
 * An unrecognised Codex version must produce a warning and nothing else. The
 * App Server protocol moves faster than this tool can be revalidated, so a
 * hard version gate would break a working installation on every upgrade.
 */
test("warns about an untested Codex version without implying a block", () => {
  const tested = TESTED_CODEX_CLI_VERSIONS[0]!;
  assert.equal(codexVersionDiagnostic(tested), `${tested} (in the tested set)`);
  assert.match(codexVersionDiagnostic(null), /^unknown \(could not run/);

  const untested = codexVersionDiagnostic("0.999.0");
  assert.match(untested, /WARNING: not in the tested set/);
  assert.match(untested, /automatic anchoring is NOT blocked/);
});
