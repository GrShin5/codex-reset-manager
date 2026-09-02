import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseMcpServerNames, readMcpServerNames, resolveCodexConfigPath } from "../src/codex-config.js";

test("counts each configured MCP server once, ignoring its subtables", () => {
  const toml = [
    "model = \"gpt-5.4\"",
    "[mcp_servers.filesystem]",
    "command = \"node\"",
    "[mcp_servers.filesystem.env]",
    "TOKEN = \"x\"",
    "[mcp_servers.\"git-tools\"]",
    "command = \"cu\"",
    "[ mcp_servers . search_index ]",
    "[other.section]",
  ].join("\n");
  assert.deepEqual(parseMcpServerNames(toml), ["filesystem", "git-tools", "search_index"]);
});

test("reports no MCP servers for a config that configures none", () => {
  assert.deepEqual(parseMcpServerNames("model = \"gpt-5.4\"\n[history]\npersistence = \"none\"\n"), []);
});

test("distinguishes an unreadable config from one with no servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-config-scan-test-"));
  assert.equal(await readMcpServerNames(join(root, "missing.toml")), null);
  const present = join(root, "config.toml");
  await writeFile(present, "[mcp_servers.only]\ncommand = \"x\"\n", "utf8");
  assert.deepEqual(await readMcpServerNames(present), ["only"]);
});

test("prefers CODEX_HOME over the default Codex directory", () => {
  assert.equal(resolveCodexConfigPath({ CODEX_HOME: "/tmp/ch" }, "/Users/x"), join("/tmp/ch", "config.toml"));
  assert.equal(resolveCodexConfigPath({}, "/Users/x"), join("/Users/x", ".codex", "config.toml"));
  assert.equal(resolveCodexConfigPath({ CODEX_HOME: "   " }, "/Users/x"), join("/Users/x", ".codex", "config.toml"));
});
