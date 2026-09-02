import { spawn } from "node:child_process";

import type { Logger } from "./logger.js";

/**
 * macOS does not expose a reliable, non-prompting permission query for an
 * `osascript display notification` caller.  Report that limitation plainly
 * instead of pretending a read-only doctor check can prove delivery.
 */
export function notificationPermissionDiagnostic(): string {
  return process.platform === "darwin"
    ? "OS-controlled; delivery permission cannot be queried noninteractively by this tool."
    : "unavailable (not running on macOS)";
}

export async function notifyMac(title: string, message: string, logger: Logger): Promise<void> {
  if (process.platform !== "darwin") {
    await logger.debug("notification_skipped", { reason: "not_macos", title });
    return;
  }
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await new Promise<void>((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await logger.debug("notification_requested", { title });
}
