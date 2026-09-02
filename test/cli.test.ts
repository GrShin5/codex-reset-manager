import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import type { ManagerState } from "../src/types.js";

const fakeAppServer = `#!/usr/bin/env node
import { createInterface } from "node:readline";

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
    }, 20_000);
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
  const env = {
    ...process.env,
    CODEX_ANCHOR_HOME: root,
    CODEX_RESET_MANAGER_CODEX: fakeCodex,
  };

  const doctor = await runCli(["doctor"], env);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /Lowest-cost eligible anchor route: gpt-5\.4-mini \/ none/);
  assert.match(doctor.stdout, /Ephemeral thread \(no model turn\): confirmed/);

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
