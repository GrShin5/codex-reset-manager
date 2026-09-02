import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import type { ManagerState } from "../src/types.js";

const fakeAppServer = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// doctor now asks for the CLI version before connecting.
if (process.argv.includes("--version")) {
  console.log("codex-cli " + (process.env.FAKE_CLI_VERSION ?? "0.152.0"));
  process.exit(0);
}

const input = createInterface({ input: process.stdin });
let rateLimitReads = 0;
const route = { model: "gpt-5.4-mini", effort: "none" };
const resetMode = process.env.FAKE_RESET_MODE ?? "advance";
const stableResetAt = Math.floor(Date.now() / 1000) + 3600;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

function reject(id, message) {
  process.stdout.write(JSON.stringify({ id, error: { code: -32602, message } }) + "\\n");
}

function hasThreadSafety(params) {
  return params?.model === route.model
    && params?.ephemeral === true
    && params?.approvalPolicy === "never"
    && params?.sandbox === "read-only"
    && params?.config?.model_reasoning_effort === route.effort;
}

function hasTurnSafety(params) {
  return params?.model === route.model
    && params?.effort === route.effort
    && params?.approvalPolicy === "never"
    && params?.sandboxPolicy?.type === "readOnly"
    && params?.sandboxPolicy?.networkAccess === false;
}

for await (const line of input) {
  const request = JSON.parse(line);
  // Notifications carry no id and expect no reply. Without this the fake
  // would reject \`initialized\`, and because the client cannot match an
  // id-less error to a request, the test would pass while hiding it.
  if (process.env.FAKE_TRACE_FILE) {
    appendFileSync(process.env.FAKE_TRACE_FILE, (request.method ?? "?") + "\\n");
  }
  if (request.id === undefined) continue;
  if (request.method === "initialize") {
    reply(request.id, {});
  } else if (request.method === "account/read") {
    reply(request.id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  } else if (request.method === "model/list") {
    reply(request.id, { data: [{ slug: route.model, supportedReasoningEfforts: [route.effort] }], nextCursor: null });
  } else if (request.method === "account/rateLimits/read") {
    rateLimitReads += 1;
    const resetsAt = resetMode === "past"
      ? Math.floor(Date.now() / 1000) - 1
      : resetMode === "stable"
        ? stableResetAt
        : stableResetAt + (rateLimitReads === 1 ? 0 : 3600);
    reply(request.id, {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: rateLimitReads === 1 ? 0 : 1,
          windowDurationMins: 300,
          resetsAt,
        },
        secondary: null,
      },
    });
  } else if (request.method === "thread/start") {
    if (!hasThreadSafety(request.params)) {
      reject(request.id, "thread/start did not receive the selected route and safety settings");
      continue;
    }
    reply(request.id, {
      thread: { id: "thread_anchor", ephemeral: true, path: null, model: route.model, reasoningEffort: route.effort },
      model: route.model,
      reasoningEffort: route.effort,
    });
  } else if (request.method === "turn/start") {
    if (!hasTurnSafety(request.params)) {
      reject(request.id, "turn/start did not receive the selected route and safety settings");
      continue;
    }
    reply(request.id, {
      // Production App Server currently acknowledges turn/start without
      // echoing model/effort. The request itself is asserted above, while the
      // verified thread response and reroute guard bind the selected route.
      turn: { id: "turn_anchor", status: "inProgress" },
    });
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread_anchor", turn: { id: "turn_anchor", status: "completed" } },
      }) + "\\n");
    }, 0);
  } else if (request.method === "turn/interrupt") {
    reply(request.id, {});
  } else {
    reject(request.id, "unexpected method: " + request.method);
  }
}
`;

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
      // Anchoring samples the rate limits across the full configured span
      // after the turn (pinned to 4 samples / 15s = ~50s per test-anchor), so
      // a CLI run legitimately takes far longer than it used to.
    }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

test("a verified fallback manual anchor enables automatic anchoring", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-fallback-test-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, fakeAppServer, { mode: 0o755 });
  // A CODEX_HOME with no config.toml exercises the unreadable-config branch;
  // a fixture below covers the configured-servers branch.
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
    CODEX_HOME: codexHome,
  };

  const doctor = await runCli(["doctor"], env);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /Lowest-cost eligible anchor route: gpt-5\.4-mini \/ none/);
  assert.match(doctor.stdout, /Ephemeral thread \(no model turn\): confirmed/);
  assert.match(doctor.stdout, /Codex CLI version: 0\.152\.0 \(in the tested set\)/);
  assert.match(doctor.stdout, /MCP servers in .*config\.toml: config\.toml not readable/);

  // An unrecognised version must warn without blocking: doctor still exits 0.
  await writeFile(join(codexHome, "config.toml"), '[mcp_servers.filesystem]\ncommand = "node"\n[mcp_servers.filesystem.env]\nA = "1"\n', "utf8");
  const untested = await runCli(["doctor"], { ...env, FAKE_CLI_VERSION: "0.999.0" });
  assert.equal(untested.code, 0, untested.stderr);
  assert.match(untested.stdout, /Codex CLI version: 0\.999\.0 \(WARNING: not in the tested set/);
  assert.match(untested.stdout, /automatic anchoring is NOT blocked/);
  // The subtable [mcp_servers.filesystem.env] must not count as a second server.
  assert.match(untested.stdout, /MCP servers in .*config\.toml: 1 configured \(filesystem\)/);

  const manual = await runCli(["test-anchor", "--confirm-consume-usage"], env);
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(manual.stdout, /Result: verified/);
  assert.match(manual.stdout, /Selected route: gpt-5\.4-mini \/ none/);

  const enable = await runCli(["enable"], env);
  assert.equal(enable.code, 0, enable.stderr);
  assert.match(enable.stdout, /Automatic anchoring enabled/);

  const status = await runCli(["status"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Manual anchor route: gpt-5\.4-mini \/ none/);

  const state = JSON.parse(await readFile(resolveAppPaths(root).stateFile, "utf8")) as ManagerState;
  assert.equal(state.autoAnchorEnabled, true);
  assert.equal(state.manualAnchor?.status, "verified");
  assert.deepEqual(state.manualAnchor?.route, { model: "gpt-5.4-mini", effort: "none" });
});

test("a safe stable manual anchor becomes ready and enables automatic anchoring", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-ready-test-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, fakeAppServer, { mode: 0o755 });
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
    FAKE_RESET_MODE: "stable",
  };

  const manual = await runCli(["test-anchor", "--confirm-consume-usage"], env);
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(manual.stdout, /Result: ready/);
  assert.match(manual.stdout, /Safety and route validation: passed/);
  assert.match(manual.stdout, /Reset timestamp advancement: pending first automatic anchor/);
  assert.match(manual.stdout, /Automatic anchoring can be enabled: yes/);

  const enable = await runCli(["enable"], env);
  assert.equal(enable.code, 0, enable.stderr);
  assert.match(enable.stdout, /safe manual completion with reset advancement pending/);

  const status = await runCli(["status"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Automatic anchor: enabled/);
  assert.match(status.stdout, /Manual anchor validation: ready/);
  assert.match(status.stdout, /Manual safety and route check: passed/);
  assert.match(status.stdout, /Manual reset advancement: pending first automatic anchor/);
  assert.match(status.stdout, /adopted after safe manual test/);

  const state = JSON.parse(await readFile(resolveAppPaths(root).stateFile, "utf8")) as ManagerState;
  assert.equal(state.autoAnchorEnabled, true);
  assert.equal(state.manualAnchor?.status, "ready");
  assert.deepEqual(state.manualAnchor?.baselineWindowIds, ["codex:primary:300"]);
  assert.equal(state.windows["codex:primary:300"]?.baselineEvidence, "manual_ready");
});

test("an unverified manual anchor cannot enable automatic anchoring", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-unverified-test-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, fakeAppServer, { mode: 0o755 });
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
    FAKE_RESET_MODE: "past",
  };

  const manual = await runCli(["test-anchor", "--confirm-consume-usage"], env);
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(manual.stdout, /Result: unverified/);
  assert.match(manual.stdout, /Automatic anchoring can be enabled: no/);

  const enable = await runCli(["enable"], env);
  assert.equal(enable.code, 1);
  assert.match(enable.stderr, /verified result or a ready result with an adopted future baseline/);
});

/**
 * verify-protocol exists because unit tests can only ever be as correct as our
 * belief about the wire contract. Its defining property is that it starts no
 * model turn, so that is what this pins.
 */
test("verify-protocol reports the handshake and starts no model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-verify-protocol-test-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  const tracePath = join(root, "trace.txt");
  await writeFile(fakeCodex, fakeAppServer, { mode: 0o755 });
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
    FAKE_TRACE_FILE: tracePath,
  };

  const result = await runCli(["verify-protocol"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /initialize: ok/);
  assert.match(result.stdout, /initialized: sent/);
  assert.match(result.stdout, /account\/rateLimits\/read: 1 window/);
  assert.match(result.stdout, /unmatched error responses: none/);
  assert.match(result.stdout, /turn\/start issued: no/);
  assert.match(result.stdout, /Protocol verification passed\./);
  assert.match(result.stdout, /thread\/start: skipped/);

  const seen = (await readFile(tracePath, "utf8")).split("\n").filter((line) => line.length > 0);
  assert.equal(seen[0], "initialize");
  assert.equal(seen[1], "initialized");
  assert.ok(!seen.includes("turn/start"), "verify-protocol must never start a turn");
  assert.ok(!seen.includes("thread/start"), "thread/start requires --allow-thread-start");
});

test("verify-protocol starts one ephemeral thread only when explicitly allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-verify-thread-test-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  const tracePath = join(root, "trace.txt");
  await writeFile(fakeCodex, fakeAppServer, { mode: 0o755 });
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
    FAKE_TRACE_FILE: tracePath,
  };

  const result = await runCli(["verify-protocol", "--allow-thread-start"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /thread\/start: ephemeral thread confirmed/);
  assert.match(result.stdout, /turn\/start issued: no/);

  const seen = (await readFile(tracePath, "utf8")).split("\n").filter((line) => line.length > 0);
  assert.equal(seen.filter((method) => method === "thread/start").length, 1);
  assert.ok(!seen.includes("turn/start"), "even with a thread, no turn may start");
});
