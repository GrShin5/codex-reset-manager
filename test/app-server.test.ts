import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppServerClient, selectLowestCostAnchorRoute } from "../src/app-server.js";
import { Logger } from "../src/logger.js";
import { ensureAppDirectories } from "../src/files.js";
import { resolveAppPaths } from "../src/paths.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const fakeServer = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const trace = process.env.FAKE_TRACE_FILE;
for await (const line of input) {
  const request = JSON.parse(line);
  // Record every inbound message, in order, including id-less notifications.
  // This fake deliberately does NOT reject messages that arrive before
  // \`initialized\`: the real 0.152.0 App Server does not enforce that
  // ordering, and encoding a stricter contract here would make the suite
  // assert something the server does not actually guarantee.
  if (trace) appendFileSync(trace, JSON.stringify({ method: request.method, id: request.id ?? null }) + "\\n");
  if (request.id === undefined) continue;
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "initialize") reply({});
  else if (request.method === "account/read") setTimeout(() => reply({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }), 15);
  else if (request.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 4 } } } }) + "\\n");
    reply({ rateLimits: { limitId: "codex", primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1234 }, secondary: null } });
  } else if (request.method === "model/list") reply({ data: [], nextCursor: null });
  else if (request.method === "thread/start") reply({
    id: "flat_thread",
    ephemeral: true,
    path: null,
    model: request.params.model,
    reasoningEffort: request.params.config.model_reasoning_effort,
  });
  else if (request.method === "turn/start") reply({
    id: "flat_turn",
    status: "inProgress",
    model: request.params.model,
    effort: request.params.effort,
  });
  else reply({});
}
`;

test("correlates out-of-order JSON-RPC responses and forwards rate-limit notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fake-app-server-"));
  const command = join(directory, "fake-codex.mjs");
  await writeFile(command, fakeServer, { mode: 0o755 });
  const paths = resolveAppPaths(directory);
  const client = new AppServerClient(new Logger(paths, DEFAULT_CONFIG), command);
  const notifications: string[] = [];
  const unsubscribe = client.onNotification((method) => notifications.push(method));
  try {
    await client.start();
    const [account, limits] = await Promise.all([client.getAccount(), client.readRateLimits()]);
    assert.equal(account.account?.type, "chatgpt");
    assert.equal(limits.rateLimits.primary?.usedPercent, 4);
    assert.deepEqual(notifications, ["account/rateLimits/updated"]);
    const route = { model: "gpt-5.4-mini", effort: "none" } as const;
    const thread = await client.startEphemeralThread(directory, route);
    const turn = await client.startAnchorTurn(thread.id!, route);
    assert.deepEqual(thread, { id: "flat_thread", ephemeral: true, path: null, model: route.model, reasoningEffort: route.effort });
    assert.deepEqual(turn, { id: "flat_turn", status: "inProgress", model: route.model, reasoningEffort: route.effort });
  } finally {
    unsubscribe();
    await client.stop();
  }
});

test("selects the first known model and its lowest explicitly supported safe effort", () => {
  const route = selectLowestCostAnchorRoute([
    { slug: "gpt-5.6-sol", supportedReasoningEfforts: ["low"] },
    { slug: "gpt-5.4-mini", supportedReasoningEfforts: ["ultra", "medium", "none"] },
    {
      id: "gpt-5.6-luna",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }],
      supported_reasoning_levels: [{ effort: "medium" }],
    },
  ]);
  assert.deepEqual(route, { model: "gpt-5.6-luna", effort: "low" });
});

test("selects a deterministic fallback when Luna is absent and ignores unknown and ultra-only entries", () => {
  const route = selectLowestCostAnchorRoute([
    { slug: "experimental-model", supportedReasoningEfforts: ["none"] },
    { slug: "gpt-5.6-luna", supportedReasoningEfforts: ["ultra"] },
    { slug: "gpt-5.4-mini", supportedReasoningEfforts: ["high", "none"] },
    { slug: "gpt-5.6-terra", supportedReasoningEfforts: ["low"] },
  ]);
  assert.deepEqual(route, { model: "gpt-5.4-mini", effort: "none" });
});

test("returns null when no known model explicitly advertises a permitted effort", () => {
  const route = selectLowestCostAnchorRoute([
    { slug: "gpt-5.4-nano", supportedReasoningEfforts: [] },
    { slug: "gpt-5.6-sol", supportedReasoningEfforts: ["ultra"] },
    { slug: "unknown", supportedReasoningEfforts: ["low"] },
  ]);
  assert.equal(route, null);
});

/**
 * The documented App Server lifecycle is initialize -> initialized -> ordinary
 * RPC. Codex 0.152.0 does not enforce the middle step on this surface, so this
 * pins the ordering we send rather than a rejection we would receive.
 */
test("sends exactly one initialized notification between initialize and the first request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-initialized-order-test-"));
  const command = join(directory, "fake-codex.mjs");
  const tracePath = join(directory, "trace.jsonl");
  await writeFile(command, fakeServer, { mode: 0o755 });
  const paths = resolveAppPaths(directory);
  await ensureAppDirectories(paths);
  const logger = new Logger(paths, DEFAULT_CONFIG);
  process.env.FAKE_TRACE_FILE = tracePath;
  const client = new AppServerClient(logger, command);
  try {
    await client.start();
    await client.getAccount();
    await client.readRateLimits();
  } finally {
    await client.stop();
    delete process.env.FAKE_TRACE_FILE;
  }

  const trace = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; id: number | null });

  assert.equal(trace[0]?.method, "initialize");
  assert.deepEqual(trace[1], { method: "initialized", id: null });
  assert.ok(trace[2] !== undefined && trace[2].method !== "initialized", "an ordinary request must follow initialized");
  assert.equal(trace.filter((entry) => entry.method === "initialized").length, 1);
  // The notification must be framed without an id, or the client would sit
  // waiting for a reply that is never coming.
  assert.equal(trace[1]?.id, null);
});

/**
 * An error reply carrying no id cannot be matched to the request that caused
 * it, so it used to be dropped in silence -- which would have hidden a server
 * rejecting the initialized notification. It must now be recorded.
 */
test("records error responses that match no pending request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-unmatched-error-test-"));
  const command = join(directory, "fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) {
    // Reject the notification the way a stricter server would.
    process.stdout.write(JSON.stringify({ id: null, error: { code: -32601, message: "unknown method: " + request.method } }) + "\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
}
`, { mode: 0o755 });
  const paths = resolveAppPaths(directory);
  await ensureAppDirectories(paths);
  const client = new AppServerClient(new Logger(paths, DEFAULT_CONFIG), command);
  try {
    await client.start();
    await client.getAccount();
  } finally {
    await client.stop();
  }

  const unmatched = client.takeUnmatchedErrors();
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0]?.code, -32601);
  assert.match(unmatched[0]?.message ?? "", /initialized/);
  // Draining is destructive so a second report cannot double-count.
  assert.deepEqual(client.takeUnmatchedErrors(), []);
});

/**
 * Nothing drains this buffer in the daemon -- only verify-protocol does -- so
 * a server that emits unmatched errors continuously must not grow it forever.
 */
test("keeps only a bounded window of unmatched error responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-unmatched-bound-test-"));
  const command = join(directory, "fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  // Answer every request, then add an unmatched error alongside it.
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ id: null, error: { code: -32000, message: "noise" } }) + "\\n");
}
`, { mode: 0o755 });
  const paths = resolveAppPaths(directory);
  await ensureAppDirectories(paths);
  const client = new AppServerClient(new Logger(paths, DEFAULT_CONFIG), command);
  try {
    await client.start();
    for (let index = 0; index < 60; index += 1) {
      await client.getAccount();
    }
  } finally {
    await client.stop();
  }

  assert.ok(client.takeUnmatchedErrors().length <= 32, "the diagnostic buffer must stay bounded");
});
