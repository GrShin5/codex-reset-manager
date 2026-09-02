#!/usr/bin/env node

import { AppServerClient, formatAnchorRoute, selectLowestCostAnchorRoute } from "./app-server.js";
import { AnchorExecutor } from "./anchor.js";
import { codexVersionDiagnostic, readCodexCliVersion, resolveAppServerCommand, resolveCodexExecutable } from "./codex-command.js";
import { readMcpServerNames, resolveCodexConfigPath } from "./codex-config.js";
import { anchorWorkspaceIsEmpty, ensureAppDirectories, loadConfig, loadState, saveState, tailFile } from "./files.js";
import { installLaunchAgent, launchAgentInstalled, launchAgentRegistered, uninstallLaunchAgent } from "./launch-agent.js";
import { Logger } from "./logger.js";
import { ProcessLock } from "./lock.js";
import { UsageMonitor } from "./monitor.js";
import { notificationPermissionDiagnostic } from "./notify.js";
import { resolveAppPaths } from "./paths.js";
import { assertSupportedPlatform } from "./platform.js";
import {
  manualAnchorAllowsAutoAnchoring,
  manualAnchorAllowsEnable,
  nextScheduledWakeAt,
  recordManualAnchor,
  snapshotContainsTargetWindow,
} from "./state-machine.js";
import type { AnchorWindowVerdict } from "./types.js";
import { formatWindow, isTargetWindowExposed, normalizeRateLimits } from "./windows.js";

const usage = `Usage: codex-reset-manager <command>

Commands:
  doctor
  install | uninstall
  daemon
  status | logs
  enable | disable
  verify-monitoring-cost [--reads=N]
  verify-protocol [--stability-seconds=N] [--allow-thread-start]
  test-anchor --confirm-consume-usage

verify-protocol checks this client against the installed Codex CLI. It starts
no model turn. --allow-thread-start additionally creates one ephemeral thread,
which may initialize configured MCP servers.
`;

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }

  assertSupportedPlatform();
  const paths = resolveAppPaths();
  await ensureAppDirectories(paths);
  const config = await loadConfig(paths);
  const logger = new Logger(paths, config);

  switch (command) {
    case "doctor":
      await doctor(paths, config, logger);
      return;
    case "install":
      await install(paths, logger);
      return;
    case "uninstall":
      await uninstall(paths, logger);
      return;
    case "daemon":
      await daemon(paths, config, logger);
      return;
    case "status":
      await status(paths, config);
      return;
    case "logs":
      await logs(paths);
      return;
    case "enable":
      await enable(paths, logger);
      return;
    case "disable":
      await disable(paths, logger);
      return;
    case "verify-monitoring-cost":
      await verifyMonitoringCost(paths, logger, parseReads(argumentsList));
      return;
    case "verify-protocol":
      await verifyProtocol(paths, logger, argumentsList);
      return;
    case "test-anchor":
      await testAnchor(paths, config, logger, argumentsList);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
}

async function doctor(
  paths: ReturnType<typeof resolveAppPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
): Promise<void> {
  const codexExecutable = await requireCodexExecutable();
  const client = new AppServerClient(logger, codexExecutable);
  try {
    await client.start();
    const [account, models, rateLimits] = await Promise.all([
      client.getAccount(),
      client.listModels(),
      client.readRateLimits(),
    ]);
    const snapshot = normalizeRateLimits(rateLimits);
    const route = selectLowestCostAnchorRoute(models);
    const codexConfigPath = resolveCodexConfigPath();
    const [codexVersion, mcpServers] = await Promise.all([
      readCodexCliVersion(codexExecutable),
      readMcpServerNames(codexConfigPath),
    ]);
    const workspaceEmpty = await anchorWorkspaceIsEmpty(paths);
    const ephemeral = route !== null && workspaceEmpty ? await client.startEphemeralThread(paths.anchorWorkspace, route) : null;
    const ephemeralValid = route !== null
      && ephemeral?.ephemeral === true
      && ephemeral.path === null
      && typeof ephemeral.id === "string"
      && ephemeral.id.length > 0
      && ephemeral.model === route.model
      && ephemeral.reasoningEffort === route.effort;
    console.log("Codex Reset Manager doctor");
    console.log(`  App Server: connected`);
    console.log(`  Codex CLI executable: ${codexExecutable}`);
    console.log(`  Codex CLI version: ${codexVersionDiagnostic(codexVersion)}`);
    console.log(`  MCP servers in ${codexConfigPath}: ${mcpServerDiagnostic(mcpServers)}`);
    // config.json is not rewritten for existing installs, so print the values
    // actually in force rather than making the operator infer them.
    console.log(`  Anchor verification: ${config.verificationSampleCount} samples every ${config.verificationSampleIntervalSeconds}s after a ${config.verificationDelaySeconds}s delay`);
    console.log(`  ChatGPT authentication: ${account.requiresOpenaiAuth === false ? "not required by current provider" : account.account?.type ?? "unknown"}`);
    console.log(`  Lowest-cost eligible anchor route: ${route === null ? "unavailable (no known model with an advertised safe effort)" : formatAnchorRoute(route)}`);
    console.log(`  Dedicated anchor workspace: ${workspaceEmpty ? "empty" : "not empty (anchor blocked)"}`);
    console.log(`  Ephemeral thread (no model turn): ${ephemeralValid ? "confirmed" : "not confirmed"}`);
    console.log(`  Target windows exposed: ${snapshotContainsTargetWindow(snapshot) ? "yes" : "no"}`);
    console.log(`  5-hour window: ${exposureText(isTargetWindowExposed(snapshot, "five_hour"))}`);
    console.log(`  Weekly window: ${exposureText(isTargetWindowExposed(snapshot, "weekly"))}`);
    for (const window of snapshot.windows) {
      console.log(`    ${formatWindow(window)}`);
    }
    console.log(`  Notifications: ${notificationPermissionDiagnostic()}`);
    console.log("  Reminder: passive reads do not start a model turn in this client, but backend quota cost is not guaranteed by this tool.");
  } finally {
    await client.stop();
  }
}

async function install(paths: ReturnType<typeof resolveAppPaths>, logger: Logger): Promise<void> {
  const codexExecutable = await requireCodexExecutable();
  const state = await loadState(paths);
  // Installing or reinstalling the background process never carries an old
  // opt-in forward. The user must explicitly enable it after installation.
  state.autoAnchorEnabled = false;
  await saveState(paths, state);
  await installLaunchAgent(paths, codexExecutable);
  await logger.info("launch_agent_installed");
  console.log("LaunchAgent installed. Monitoring starts with automatic anchoring disabled until an eligible manual test and enable command.");
}

async function uninstall(paths: ReturnType<typeof resolveAppPaths>, logger: Logger): Promise<void> {
  await uninstallLaunchAgent(paths);
  await logger.info("launch_agent_uninstalled");
  console.log("LaunchAgent removed. Application state and logs were preserved.");
}

async function daemon(
  paths: ReturnType<typeof resolveAppPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
): Promise<void> {
  const lock = new ProcessLock(paths.lockDirectory);
  await lock.acquire();
  const resolvedCommand = await resolveAppServerCommand();
  if (resolvedCommand.recovered) {
    await logger.warn("codex_executable_recovered", {
      configured: resolvedCommand.configured,
      command: resolvedCommand.command,
    });
  }
  const client = new AppServerClient(logger, resolvedCommand.command);
  const monitor = new UsageMonitor(client, paths, config, await loadState(paths), logger);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await logger.info("daemon_stopping");
    await monitor.stop();
    await lock.release();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  try {
    await monitor.start();
    await logger.info("daemon_started", { autoAnchorEnabled: monitor.getState().autoAnchorEnabled });
    await new Promise<void>(() => undefined);
  } finally {
    await stop();
  }
}

async function status(
  paths: ReturnType<typeof resolveAppPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const state = await loadState(paths);
  console.log("Codex Reset Manager status");
  console.log(`  LaunchAgent plist present: ${await launchAgentInstalled(paths) ? "yes" : "no"}`);
  console.log(`  LaunchAgent registered with launchd: ${await launchAgentRegistered() ? "yes" : "no"}`);
  console.log(`  Automatic anchor: ${state.autoAnchorEnabled ? "enabled" : "disabled"}`);
  console.log(`  Manual anchor validation: ${state.manualAnchor?.status ?? "not run"}`);
  console.log(`  Manual safety and route check: ${manualSafetyText(state.manualAnchor)}`);
  console.log(`  Manual reset advancement: ${manualResetText(state.manualAnchor)}`);
  console.log(`  Manual anchor route: ${state.manualAnchor === null ? "not run" : state.manualAnchor.route === undefined || state.manualAnchor.route === null ? "not recorded (legacy result)" : formatAnchorRoute(state.manualAnchor.route)}`);
  console.log(`  Manual adopted baselines: ${state.manualAnchor?.baselineWindowIds?.length ? state.manualAnchor.baselineWindowIds.join(", ") : "none"}`);
  // A refused window is simply absent from the adopted list, which reads as if
  // it were never a target. Name it instead.
  const statusRefused = state.manualAnchor?.refusedWindowIds ?? [];
  if (statusRefused.length > 0) {
    console.log(`  Manual refused baselines: ${statusRefused.join(", ")} (not proven steady; these are not scheduled)`);
  }
  const eligibility = state.autoAnchorEnabled
    ? `Automatic anchor scheduling eligible: ${manualAnchorAllowsAutoAnchoring(state) ? "yes" : "no"}`
    : `Enable can be run now: ${manualAnchorAllowsEnable(state) ? "yes" : "no"}`;
  console.log(`  ${eligibility}`);
  const nextWakeAt = nextScheduledWakeAt(state, config);
  console.log(`  Next reset evaluation: ${nextWakeAt === null ? "not established" : new Date(nextWakeAt).toLocaleString()}`);
  const recordedFiveHour = Object.values(state.windows).some((window) => window.kind === "five_hour");
  const recordedWeekly = Object.values(state.windows).some((window) => window.kind === "weekly");
  console.log(`  Recorded 5-hour window: ${recordedExposureText(recordedFiveHour)}`);
  console.log(`  Recorded weekly window: ${recordedExposureText(recordedWeekly)}`);
  if (Object.keys(state.windows).length === 0) {
    console.log("  Windows: none observed yet");
  } else {
    console.log("  Windows:");
    for (const window of Object.values(state.windows).sort((left, right) => left.id.localeCompare(right.id))) {
      const reset = window.resetsAt === null ? "unset" : new Date(window.resetsAt * 1_000).toLocaleString();
      const verified = window.verifiedResetAt === null ? "not established" : new Date(window.verifiedResetAt * 1_000).toLocaleString();
      const evidence = baselineEvidenceText(window.baselineEvidence, window.verifiedResetAt !== null);
      const label = window.kind === "unknown" ? "unknown (not monitored)" : window.kind;
      console.log(`    ${label}: used ${window.usedPercent ?? "unknown"}%, observed reset ${reset}, anchor baseline ${verified} (${evidence})`);
    }
  }
  const recentAnchors = Object.values(state.anchors).sort((left, right) => right.claimedAt - left.claimedAt).slice(0, 8);
  console.log(`  Recent anchor generations: ${recentAnchors.length}`);
  for (const record of recentAnchors) {
    const route = record.route === undefined || record.route === null ? "route not recorded" : formatAnchorRoute(record.route);
    console.log(`    ${record.status} (${route}): ${record.detail}`);
  }
  const latestSkipped = recentAnchors.find((record) => record.status === "skipped");
  if (latestSkipped !== undefined) {
    console.log(`  Latest automatic decision: skipped — ${latestSkipped.detail}`);
  }
}

async function logs(paths: ReturnType<typeof resolveAppPaths>): Promise<void> {
  const events = await tailFile(`${paths.logsDirectory}/events.jsonl`);
  console.log(events.length === 0 ? "No event logs yet." : events);
}

async function enable(paths: ReturnType<typeof resolveAppPaths>, logger: Logger): Promise<void> {
  const state = await loadState(paths);
  if (!manualAnchorAllowsEnable(state)) {
    throw new Error("Automatic anchoring remains disabled until test-anchor --confirm-consume-usage produces a verified result or a ready result with an adopted future baseline.");
  }
  state.autoAnchorEnabled = true;
  await saveState(paths, state);
  await logger.info("auto_anchor_enabled");
  const manual = state.manualAnchor;
  if (manual === null) {
    throw new Error("Automatic anchoring eligibility changed before it could be saved.");
  }
  const manualRoute = manual.route === undefined || manual.route === null
    ? "a legacy route that was not recorded"
    : formatAnchorRoute(manual.route);
  const validation = manual.status === "ready"
    ? "a safe manual completion with reset advancement pending"
    : "a verified manual reset advancement";
  console.log(`Automatic anchoring enabled. The manual test used ${manualRoute} and established ${validation}; each future anchor will select the lowest-cost eligible route currently advertised by App Server and use at most one turn per reset generation.`);
}

async function disable(paths: ReturnType<typeof resolveAppPaths>, logger: Logger): Promise<void> {
  const state = await loadState(paths);
  state.autoAnchorEnabled = false;
  await saveState(paths, state);
  await logger.info("auto_anchor_disabled");
  console.log("Automatic anchoring disabled. Passive monitoring can continue.");
}

async function verifyMonitoringCost(paths: ReturnType<typeof resolveAppPaths>, logger: Logger, reads: number): Promise<void> {
  const client = new AppServerClient(logger);
  try {
    await client.start();
    const before = normalizeRateLimits(await client.readRateLimits());
    for (let index = 0; index < reads; index += 1) {
      await client.readRateLimits();
    }
    const after = normalizeRateLimits(await client.readRateLimits());
    console.log("Monitoring-cost comparison (not a zero-cost guarantee)");
    console.log(`  Passive reads executed: ${reads}`);
    console.log("  Before:");
    before.windows.forEach((window) => console.log(`    ${formatWindow(window)}`));
    console.log("  After:");
    after.windows.forEach((window) => console.log(`    ${formatWindow(window)}`));
  } finally {
    await client.stop();
  }
}

/**
 * Checks the wire contract against the real Codex CLI, which unit tests cannot
 * do: their fake server is only ever as correct as our belief about the
 * protocol. GitHub Actions cannot authenticate a Codex account, so this is a
 * local, explicitly-invoked command rather than a CI job.
 *
 * It starts no model turn and consumes no usage beyond the passive reads the
 * daemon already performs on every poll.
 */
async function verifyProtocol(
  paths: ReturnType<typeof resolveAppPaths>,
  logger: Logger,
  argumentsList: string[],
): Promise<void> {
  const allowThreadStart = argumentsList.includes("--allow-thread-start");
  const stabilitySeconds = parseStabilitySeconds(argumentsList);
  const codexExecutable = await requireCodexExecutable();
  const client = new AppServerClient(logger, codexExecutable);
  let failures = 0;
  const fail = (message: string): void => {
    failures += 1;
    console.log(`  FAIL ${message}`);
  };
  try {
    console.log("Codex Reset Manager protocol verification (no model turn)");
    console.log(`  Codex CLI executable: ${codexExecutable}`);
    console.log(`  Codex CLI version: ${codexVersionDiagnostic(await readCodexCliVersion(codexExecutable))}`);

    await client.start();
    console.log("  initialize: ok");
    console.log("  initialized: sent");
    const initialize = client.getInitializeResult();
    if (isRecord(initialize)) {
      for (const key of ["userAgent", "platformOs", "platformFamily", "codexHome"]) {
        if (initialize[key] !== undefined) {
          console.log(`    ${key}: ${String(initialize[key])}`);
        }
      }
    }

    const account = await client.getAccount();
    console.log(`  account/read: ${account.requiresOpenaiAuth === false ? "no ChatGPT auth required" : account.account?.type ?? "unknown"}`);

    const models = await client.listModels();
    const route = selectLowestCostAnchorRoute(models);
    console.log(`  model/list: ${models.length} model(s)`);
    console.log(`  lowest-cost eligible anchor route: ${route === null ? "unavailable" : formatAnchorRoute(route)}`);

    const first = normalizeRateLimits(await client.readRateLimits());
    console.log(`  account/rateLimits/read: ${first.windows.length} window(s)`);
    first.windows.forEach((window) => console.log(`    ${formatWindow(window)}`));

    if (stabilitySeconds > 0) {
      // A window whose reset timestamp slides with wall-clock time is not
      // anchored, however much the timestamp "advances". Measuring the two
      // deltas side by side is what distinguishes the two cases.
      console.log(`  reset-timestamp stability over ${stabilitySeconds}s:`);
      await delay(stabilitySeconds * 1_000);
      const second = normalizeRateLimits(await client.readRateLimits());
      const elapsedSeconds = (second.observedAt - first.observedAt) / 1_000;
      for (const after of second.windows) {
        const before = first.windows.find((window) => window.id === after.id);
        if (before?.resetsAt === undefined || before.resetsAt === null || after.resetsAt === null) {
          console.log(`    ${after.id}: indeterminate (no reset timestamp)`);
          continue;
        }
        const drift = after.resetsAt - before.resetsAt;
        const label = Math.abs(drift) <= 1
          ? "stable (anchored)"
          : drift >= elapsedSeconds * 0.5
            ? "SLIDING with the clock (not anchored)"
            : "indeterminate";
        console.log(`    ${after.id}: reset moved ${drift}s over ${elapsedSeconds.toFixed(1)}s elapsed — ${label}`);
      }
    }

    if (allowThreadStart) {
      if (route === null) {
        fail("thread/start skipped: no eligible anchor route");
      } else if (!await anchorWorkspaceIsEmpty(paths)) {
        fail("thread/start skipped: the dedicated anchor workspace is not empty");
      } else {
        console.log("  starting one ephemeral thread; configured MCP servers may initialize now");
        const thread = await client.startEphemeralThread(paths.anchorWorkspace, route);
        const valid = thread.ephemeral === true
          && thread.path === null
          && typeof thread.id === "string"
          && thread.id.length > 0
          && thread.model === route.model
          && thread.reasoningEffort === route.effort;
        console.log(`  thread/start: ${valid ? "ephemeral thread confirmed" : "NOT confirmed"}`);
        if (!valid) {
          fail("the ephemeral thread response did not match the requested route");
        }
      }
    } else {
      console.log("  thread/start: skipped (pass --allow-thread-start to include it)");
    }

    // The client cannot match an error reply that carries no id to the message
    // that caused it, so a rejected `initialized` would otherwise be invisible.
    const unmatched = client.takeUnmatchedErrors();
    if (unmatched.length === 0) {
      console.log("  unmatched error responses: none");
    } else {
      // These cannot be attributed to a specific request -- a late reply to a
      // timed-out call lands here too -- so report them as something to read,
      // not as a diagnosis. A rejected `initialized` would appear here.
      for (const error of unmatched) {
        fail(`server returned an error that matches no pending request (code ${error.code}): ${error.message}`);
      }
      console.log("    An error here may be a rejected notification, or a late reply to a timed-out request.");
    }

    console.log(`  turn/start issued: no`);
    console.log(failures === 0 ? "Protocol verification passed." : `Protocol verification found ${failures} problem(s).`);
  } finally {
    await client.stop();
  }
  if (failures > 0) {
    process.exitCode = 1;
  }
}

function parseStabilitySeconds(argumentsList: string[]): number {
  const flag = argumentsList.find((entry) => entry.startsWith("--stability-seconds="));
  if (flag === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(flag.slice("--stability-seconds=".length), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, 120);
}

/** Plain-language rendering of a sampling verdict for the operator. */
function verdictText(verdict: AnchorWindowVerdict): string {
  switch (verdict) {
    case "advanced_stable":
      return "advanced and then held steady (anchored)";
    case "sliding":
      return "kept moving with the clock (NOT anchored; this window is not usable as a baseline)";
    case "not_advanced":
      return "held steady but never advanced";
    default:
      return "could not be determined from the samples taken";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function testAnchor(
  paths: ReturnType<typeof resolveAppPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
  argumentsList: string[],
): Promise<void> {
  if (!argumentsList.includes("--confirm-consume-usage")) {
    throw new Error("test-anchor sends one real minimal Codex turn. Re-run with --confirm-consume-usage to continue.");
  }
  const client = new AppServerClient(logger);
  try {
    await client.start();
    const result = await new AnchorExecutor(client, paths, config, logger).run();
    const state = await loadState(paths);
    const manual = recordManualAnchor(state, result);
    await saveState(paths, state);
    console.log("Manual anchor test");
    console.log(`  Result: ${manual.status}`);
    console.log(`  Safety and route validation: ${result.turnCompletedSafely ? "passed" : "not passed"}`);
    console.log(`  Reset timestamp advancement: ${manualResetText(manual)}`);
    const verdicts = Object.entries(result.verificationVerdicts ?? {});
    if (verdicts.length > 0) {
      console.log("  Reset timestamp sampling:");
      for (const [windowId, verdict] of verdicts) {
        console.log(`    ${windowId}: ${verdictText(verdict)}`);
      }
    }
    const baselines = manual.baselineWindowIds ?? [];
    console.log(`  Adopted anchor baselines: ${baselines.length > 0 ? baselines.join(", ") : "none"}`);
    const refused = manual.refusedWindowIds ?? [];
    if (refused.length > 0) {
      console.log(`  Refused as baselines: ${refused.join(", ")}`);
      console.log("    These windows were not proven steady, so they will not be scheduled.");
      console.log("    Re-run test-anchor to try again, or run verify-protocol --stability-seconds=60 to see how they behave.");
    }
    console.log(`  Automatic anchoring can be enabled: ${manualAnchorAllowsEnable(state) ? "yes" : "no"}`);
    console.log(`  Selected route: ${result.route === null ? "not selected" : formatAnchorRoute(result.route)}`);
    console.log(`  Detail: ${result.detail}`);
    console.log(`  Ephemeral thread: ${result.threadId ?? "not created"}`);
    console.log("  Before:");
    result.before.windows.forEach((window) => console.log(`    ${formatWindow(window)}`));
    if (result.after !== null) {
      console.log("  After:");
      result.after.windows.forEach((window) => console.log(`    ${formatWindow(window)}`));
    }
  } finally {
    await client.stop();
  }
}

async function requireCodexExecutable(): Promise<string> {
  const executable = await resolveCodexExecutable();
  if (executable === null) {
    throw new Error("Codex CLI executable was not found on PATH. Install Codex CLI and run this command from a shell where `command -v codex` succeeds.");
  }
  return executable;
}

function exposureText(exposed: boolean): string {
  return exposed ? "exposed" : "not exposed (normal; not monitored)";
}

function recordedExposureText(observed: boolean): string {
  return observed ? "observed" : "not observed yet (normal; run doctor for a live check)";
}

function manualSafetyText(manual: Awaited<ReturnType<typeof loadState>>["manualAnchor"]): string {
  return manual?.status === "verified" || manual?.status === "ready" ? "passed" : "not passed";
}

function manualResetText(manual: Awaited<ReturnType<typeof loadState>>["manualAnchor"]): string {
  if (manual?.status === "verified") {
    return "verified";
  }
  if (manual?.status === "ready") {
    return "pending first automatic anchor";
  }
  return "not verified";
}

function baselineEvidenceText(
  evidence: Awaited<ReturnType<typeof loadState>>["windows"][string]["baselineEvidence"],
  established: boolean,
): string {
  if (!established) {
    return "none";
  }
  switch (evidence) {
    case "manual_ready":
      return "adopted after safe manual test";
    case "external_usage":
      return "re-baselined after external use was observed";
    case "recovered_rollover":
      return "re-baselined from a legacy or ambiguous rollover (no catch-up turn)";
    case "verified_advance":
    default:
      return "strictly verified reset advancement";
  }
}

function parseReads(argumentsList: string[]): number {
  const argument = argumentsList.find((value) => value.startsWith("--reads="));
  if (argument === undefined) {
    return 20;
  }
  const count = Number(argument.slice("--reads=".length));
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("--reads must be an integer from 1 to 100.");
  }
  return count;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unexpected failure.");
  process.exitCode = 1;
});

/**
 * Starting a thread can initialize the user's configured MCP servers, and both
 * doctor's ephemeral check and a real anchor start one. The anchor prompt
 * forbids tools and any tool-like item aborts the turn, but server startup
 * itself happens earlier than that, so it is worth stating plainly.
 *
 * Server names are printed for the operator only; they are never logged.
 */
function mcpServerDiagnostic(names: string[] | null): string {
  if (names === null) {
    return "config.toml not readable";
  }
  if (names.length === 0) {
    return "none configured";
  }
  return `${names.length} configured (${names.join(", ")}). Starting a thread — an anchor, `
    + "or doctor's own ephemeral check when a route is available and the workspace is empty — "
    + "may initialize these servers.";
}
