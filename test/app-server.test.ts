import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppServerClient, selectLowestCostAnchorRoute } from "../src/app-server.js";
import { Logger } from "../src/logger.js";
import { resolveAppPaths } from "../src/paths.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const fakeServer = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
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
