import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Codex CLI reads its configuration from $CODEX_HOME/config.toml, falling
 * back to ~/.codex/config.toml.
 */
export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const configured = env.CODEX_HOME?.trim();
  return join(configured === undefined || configured.length === 0 ? join(userHome, ".codex") : configured, "config.toml");
}

/**
 * Extract configured MCP server names from a config.toml.
 *
 * This deliberately matches only table headers rather than adding a TOML
 * parser: the single question being answered is "would starting a thread
 * initialize any MCP server", and a header scan answers it without taking on
 * a runtime dependency. Inline `mcp_servers = { ... }` table syntax is not
 * recognised, which fails toward reporting fewer servers than exist; the
 * doctor line is advisory and gates nothing.
 */
export function parseMcpServerNames(toml: string): string[] {
  const names: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\s*mcp_servers\s*\.\s*(.+?)\s*\](?:\s*#.*)?\s*$/.exec(line);
    if (header === null) {
      continue;
    }
    // Keep only the first key segment so that a subtable such as
    // [mcp_servers.filesystem.env] does not count as a second server.
    const first = /^(?:"([^"]*)"|'([^']*)'|([^.\s"']+))/.exec(header[1]!);
    const name = first?.[1] ?? first?.[2] ?? first?.[3];
    if (name !== undefined && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Null when the file cannot be read; an empty array when none are configured. */
export async function readMcpServerNames(path: string): Promise<string[] | null> {
  try {
    return parseMcpServerNames(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
