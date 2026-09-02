import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CODEX_COMMAND_ENV } from "../src/codex-command.js";
import {
  bootstrapLaunchAgentWithRetry,
  buildLaunchAgentPlist,
  installLaunchAgent,
  launchAgentInstalled,
  launchAgentRegistered,
  LAUNCH_AGENT_LABEL,
} from "../src/launch-agent.js";
import { resolveAppPaths } from "../src/paths.js";

const execFileAsync = promisify(execFile);

test("generates a user LaunchAgent with escaped arguments and no shell command", () => {
  const paths = resolveAppPaths("/tmp/Codex & Reset");
  const plist = buildLaunchAgentPlist("/usr/local/bin/node", "/tmp/a<&>.js", paths, "/Users/example/bin/codex<&>");
  assert.match(plist, new RegExp(LAUNCH_AGENT_LABEL));
  assert.match(plist, /<string>\/tmp\/a&lt;&amp;&gt;\.js<\/string>/);
  assert.doesNotMatch(plist, /<key>Program<\/key>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, new RegExp(`<key>${CODEX_COMMAND_ENV}<\\/key>`));
  assert.match(plist, /<string>\/Users\/example\/bin\/codex&lt;&amp;&gt;<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.doesNotMatch(plist, /WakeSystem|StartInterval/);
});

test("generated plist passes macOS plutil validation", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-launch-agent-test-"));
  const paths = resolveAppPaths(directory);
  const plistPath = join(directory, "com.codex-reset-manager.plist");
  await writeFile(plistPath, buildLaunchAgentPlist(process.execPath, "/tmp/cli.js", paths, "/tmp/codex"), "utf8");
  await execFileAsync("/usr/bin/plutil", ["-lint", plistPath]);
});

test("retries a transient launchd bootstrap failure without changing the registration request", async () => {
  let calls = 0;
  await bootstrapLaunchAgentWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("launchd is still removing the previous service");
      }
    },
    async () => undefined,
  );
  assert.equal(calls, 2);
});

/**
 * A plist that launchd never registered must not linger,
 * because status's file-presence check would then report a daemon that does
 * not exist. The launchctl runner is faked so the real user domain is never
 * touched.
 */
test("removes the plist when launchd never registers it", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-launch-agent-fail-test-"));
  const paths = {
    ...resolveAppPaths(directory),
    // Keep this regression test inside its disposable fixture rather than the
    // user's real ~/Library/LaunchAgents directory. The launchctl runner below
    // is already faked; the plist path must be isolated as well.
    launchAgentFile: join(directory, "com.codex-reset-manager.plist"),
  };
  const attempted: string[][] = [];
  const alwaysFails = async (args: string[]): Promise<void> => {
    attempted.push(args);
    if (args[0] === "bootstrap") {
      throw new Error("Load failed: 5: Input/output error");
    }
  };

  await assert.rejects(
    () => installLaunchAgent(paths, "/tmp/codex", "/tmp/cli.js", alwaysFails),
    /Load failed/,
  );
  assert.equal(await launchAgentInstalled(paths), false, "a plist launchd rejected must not stay on disk");
  assert.equal(attempted.filter((args) => args[0] === "bootstrap").length, 3, "the bounded retry must stop at three attempts");
});

test("reports launchd registration from launchctl rather than file presence", async () => {
  assert.equal(await launchAgentRegistered(async () => undefined), true);
  assert.equal(
    await launchAgentRegistered(async () => {
      throw new Error("Could not find service");
    }),
    false,
  );
});

test("surfaces a permanently failing bootstrap after a bounded number of attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () => bootstrapLaunchAgentWithRetry(
      async () => {
        calls += 1;
        throw new Error("permission denied");
      },
      async () => undefined,
    ),
    /permission denied/,
  );
  assert.equal(calls, 3);
});
