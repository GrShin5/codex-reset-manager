[English](./README.md) | [日本語](./README.ja.md)

# Codex Reset Manager

Codex Reset Manager is a macOS user-level monitor for Codex usage windows. It
observes the five-hour and weekly windows that an account actually exposes
without starting a model turn, then can use one tightly constrained,
currently eligible model turn to anchor a newly reset, previously verified
window.

## What it does—and does not do

- Uses only <code>codex app-server --stdio</code> and the supported App Server
  rate-limit methods. It does not call undocumented ChatGPT endpoints, read
  OAuth tokens, or consume reset credits.
- Identifies windows by limit ID, bucket, and duration. Only 300-minute and
  10,080-minute windows are automatic-anchor targets.
- Does not infer limits from a ChatGPT plan name. If the App Server exposes
  only the weekly window, it monitors and anchors only that window; an absent
  five-hour window is normal. If neither target window is exposed, it keeps
  monitoring and starts no anchor.
- Immediately before each anchor, selects one pair explicitly advertised by
  the current App Server <code>model/list</code> response. The allowed model
  preference order is <code>gpt-5.6-luna</code>, <code>gpt-5.4-nano</code>,
  <code>gpt-5.4-mini</code>, <code>gpt-5.6-terra</code>,
  <code>gpt-5.4</code>, <code>gpt-5.6-sol</code>, then
  <code>gpt-5.5</code>. Within one model it selects the first supported effort
  in this order: <code>none</code>, <code>low</code>, <code>medium</code>,
  <code>high</code>, <code>xhigh</code>, <code>max</code>.
- This is a fixed, audited allowlist and a relative lowest-cost preference for
  this tiny prompt—not a calculation of Codex subscription Usage or remaining
  quota. Unknown models and <code>ultra</code> are never selected. If no known
  model advertises an allowed effort, it starts neither a thread nor a turn.
- Sends the one selected model/effort pair to both <code>thread/start</code>
  and <code>turn/start</code>. The ephemeral-thread response must echo that
  pair exactly. Current App Server versions may acknowledge <code>turn/start</code>
  with only a turn ID and status; that omitted echo is accepted only because the
  exact thread response already bound the route. If a turn response does echo
  either route field, both must match exactly. A mismatch, provider reroute,
  tool-like item, or approval request is rejected or interrupted without
  starting another turn.
- Sends at most one anchor turn per reset generation. A generation is claimed
  before sending, so an ambiguous result is not automatically retried.
- Does **not** treat a changed reset timestamp by itself as evidence that a
  user already used the new window. After a stored boundary passes, it waits
  for a complete, timely snapshot of the same window whose reset timestamp
  moved to a newer future cycle and whose Usage is exactly <code>0%</code>.
  Only then can it create one candidate for the *old* boundary. If Usage is
  above 0%, the observation is recorded as <code>skipped</code> and the next
  boundary is re-baselined without a model turn. Missing, stale, delayed,
  inconsistent, or multi-cycle observations also fail closed without a turn.
- The normal five-second reset grace and 30-second coalescing interval mean an
  automatic decision happens after the displayed reset time, not exactly at
  it. Immediately before a durable claim and any model RPC, the manager takes
  one more complete Usage reading; activity that appears during coalescing
  cancels the candidate before <code>thread/start</code>.
- Uses an empty dedicated workspace, an ephemeral thread, read-only sandbox,
  network disabled, and <code>approvalPolicy: never</code>. A
  persistent-thread fallback is intentionally disabled.
- Interrupts an anchor if a tool-like item, approval request, or model reroute
  is observed. It records the outcome as <code>safety_abort</code>,
  <code>rejected</code>, or <code>unverified</code> instead of trying another
  turn.

There is no heartbeat, scheduled model turn, or calendar wake request. The Mac
is not intentionally woken from sleep; monitoring reconciles when the process
resumes or restarts.

## Requirements

- macOS
- Node.js 22 or later
- Codex CLI installed and authenticated
- The <code>codex</code> executable available from the interactive shell used
  for <code>doctor</code> and <code>install</code>

Check the local prerequisites before installing:

~~~sh
node --version
command -v codex
codex --version
npm ci
npm run build
node dist/src/cli.js doctor
~~~

<code>doctor</code> performs App Server, authentication, lowest-cost eligible
route, rate-limit, empty-workspace, ephemeral-thread,
notification-capability, and executable-path checks. It reports the selected
model/effort (or that no safe route is available), the resolved Codex CLI path,
and five-hour and weekly exposure separately. It does not start a model turn.

<code>install</code> resolves the executable absolute path from that interactive
shell, verifies it is executable, and writes it into the LaunchAgent plist.
The background process then uses that exact path rather than launchd's minimal
<code>PATH</code>. If it cannot resolve Codex CLI, installation stops before an
existing agent is replaced.

## Platform and usage-window behavior

This tool is macOS-only. Codex CLI may be available on Windows, but this
manager depends on macOS LaunchAgents, notifications, and
<code>~/Library/...</code> storage. On Windows it exits early with an explicit
unsupported-platform error rather than attempting a partial installation.

The manager does not assume that a particular ChatGPT plan has or lacks a
five-hour limit. It uses only the App Server snapshot observed for the signed-in
account:

- Five-hour absent and weekly present: normal; the weekly window alone is
  monitored and can be anchored.
- Both target windows present: both are monitored; nearby candidates are
  combined into one selected-route turn.
- Neither target window present: monitoring continues, but no anchor is sent.

## Install and first use

Clone the repository first:

~~~sh
git clone https://github.com/GrShin5/codex-reset-manager.git
cd codex-reset-manager
~~~

Run these commands from the repository root:

~~~sh
npm ci
npm run build
node dist/src/cli.js doctor
node dist/src/cli.js install
node dist/src/cli.js test-anchor --confirm-consume-usage
node dist/src/cli.js enable
~~~

<code>install</code> registers a per-user LaunchAgent but always leaves
automatic anchoring disabled. <code>test-anchor --confirm-consume-usage</code>
is the only manual command that intentionally uses a small real Codex turn. It
first validates the guarded route and then records each usable future reset
timestamp as a scheduling baseline. A <code>verified</code> result means a
target timestamp advanced after the turn. A <code>ready</code> result means the
turn completed safely and a still-future timestamp was adopted, so reset
advancement remains pending until the first automatic anchor. Either result can
enable automatic anchoring; <code>unverified</code>, <code>safety_abort</code>,
and <code>rejected</code> cannot. A ready result does not start an immediate
automatic turn: it waits for the adopted reset boundary plus the configured
grace period, then requires a complete new-window reading with exactly 0% Usage.
If any use is already visible, it records a safe skip instead of trying to
"catch up" with a model turn. <code>enable</code> accepts ready only while at
least one adopted baseline is still future; if every adopted boundary has
passed, run a new manual test instead of triggering an immediate anchor. The
command prints its exact selected model/effort, and the next automatic anchor
selects again from the then-current App Server list.

## Update an existing installation

From the existing clone, update the source, rebuild it, and restart the already
registered LaunchAgent:

~~~sh
git pull --ff-only
npm ci
npm run build
node dist/src/cli.js doctor
launchctl kickstart -k gui/$(id -u)/com.codex-reset-manager
node dist/src/cli.js status
~~~

This update path preserves the existing control state and does not start a
model turn. Do not run <code>install</code> merely to apply a build update: it
intentionally turns automatic anchoring off. Use <code>install</code> only when
the LaunchAgent is absent or its recorded Codex CLI path must change; afterward,
review <code>status</code> and run a new explicit manual validation before
enabling automatic anchors.

## Check that it is working

~~~sh
node dist/src/cli.js status
node dist/src/cli.js logs
node dist/src/cli.js verify-monitoring-cost --reads=20
node dist/src/cli.js verify-protocol
launchctl print gui/$(id -u)/com.codex-reset-manager
~~~

Use the results as follows:

- <code>status</code> shows whether the LaunchAgent plist exists, whether
  automatic anchoring is enabled, the separate manual safety/route result and
  reset-advancement result, adopted baselines, whether each target window has
  been observed, the next reset evaluation, how each baseline was established,
  the actual route of the manual test, and recent anchor generations with
  their selected routes. A latest <code>skipped</code> decision explains why
  the manager deliberately did not spend a model turn.
- <code>logs</code> shows JSONL events with credential-shaped fields redacted
  by field name: tokens, authorization headers, cookies, secrets, passwords,
  email addresses, and raw request/response/prompt/message content. Local
  filesystem paths are not redacted; the resolved Codex CLI path, including a
  home-directory name, is recorded verbatim. Review output before sharing it.
  A healthy installed monitor records <code>daemon_started</code> and
  <code>rate_limits_observed</code>; an automatic run records
  <code>anchor_preflight_observed</code>,
  <code>anchor_claimed</code>, and <code>anchor_completed</code>. A safe
  no-turn decision records <code>anchor_skipped</code> with its reason.
- <code>verified</code> means the target window's future reset timestamp
  advanced after the isolated selected-route turn. <code>ready</code> is a
  manual-only result: the guarded turn completed, but the same still-future
  timestamp was adopted as the first scheduling baseline instead of being
  called an advancement. It is eligible for <code>enable</code>, but it stays
  silent and becomes fully verified only if an automatic anchor later observes
  an advance. <code>unverified</code>, <code>safety_abort</code>, and
  <code>rejected</code>, and <code>skipped</code> are safe non-success
  outcomes. They are never retried for the same reset generation. A later
  reset is considered only after a complete, timely snapshot proves a newer
  same-window cycle is still exactly 0% used.
- <code>verify-monitoring-cost</code> compares snapshots before and after
  passive reads. It demonstrates this client path starts no model turn; it
  does not claim a zero backend-cost guarantee.
- <code>verify-protocol</code> checks this client against the installed Codex
  CLI: the handshake, <code>account/read</code>, <code>model/list</code>, and
  <code>account/rateLimits/read</code>. It starts no model turn. Add
  <code>--stability-seconds=N</code> to see whether a window's reset timestamp
  holds steady or slides with the clock, and
  <code>--allow-thread-start</code> to include one ephemeral thread, which may
  initialize configured MCP servers. Unit tests can only be as correct as our
  belief about the wire protocol, so run this after a Codex upgrade.
- <code>launchctl print</code> confirms whether the loaded LaunchAgent is
  actually running. It should also show the
  <code>CODEX_RESET_MANAGER_CODEX</code> environment entry containing the
  absolute CLI path. <code>status</code> alone confirms only that its plist is
  present.

macOS sends one local notification only after an automatic anchor has completed
and its target reset timestamp has been verified as advanced. It includes the
actual selected model/effort and names only the windows that actually advanced.
It does not notify for connections, reconnections, sleep
recovery, candidate detection, turn start, completion without verification,
verification failures, rejections, safety aborts, exceptions, or manual
<code>test-anchor</code>. If notification delivery itself fails or hangs it is
abandoned after five seconds; the anchor result is never affected and the
failure is only logged.

## Control, stop, and uninstall

To stop automatic anchors while keeping passive monitoring active:

~~~sh
node dist/src/cli.js disable
~~~

To remove the background LaunchAgent:

~~~sh
node dist/src/cli.js uninstall
~~~

If you started <code>daemon</code> manually in a foreground Terminal, stop
that process with Control-C as well. For the safest shutdown sequence, run
<code>disable</code> first and then <code>uninstall</code>.

<code>uninstall</code> unloads the LaunchAgent and removes only this plist:

~~~text
~/Library/LaunchAgents/com.codex-reset-manager.plist
~~~

It deliberately preserves the following local data so that you can inspect
logs or diagnose a problem:

~~~text
~/Library/Application Support/Codex Reset Manager/
~~~

That folder contains <code>state.json</code>, <code>config.json</code>, the
<code>logs/</code> directory with field-name redaction for credential-shaped
values, and the dedicated <code>anchor-workspace/</code>. Local filesystem
paths, including the resolved Codex CLI path and home-directory name, are not
redacted; review logs before sharing them. To remove all local tool data, first
run <code>disable</code> and <code>uninstall</code>, then move that exact
folder to the Trash in Finder. Remove the cloned repository folder separately
only when you no longer need its source code or local Node dependencies.

## Environment variables

- <code>CODEX_RESET_MANAGER_CODEX</code> — absolute path to the Codex CLI
  executable. <code>install</code> resolves it from the interactive shell and
  writes it into the LaunchAgent plist, avoiding launchd's minimal
  <code>PATH</code>. Setting it manually overrides that resolution.
- <code>CODEX_ANCHOR_HOME</code> — overrides the application data root
  (default: <code>~/Library/Application Support/Codex Reset Manager</code>).
  It is not written into the LaunchAgent plist, so the launchd-managed daemon
  always uses the default root. An interactive shell export makes
  <code>status</code> and <code>logs</code> read a different root and appear
  inactive. Use it for testing and isolated runs, not normal relocation.

## Commands

| Command | Purpose | Starts a model turn? |
| --- | --- | --- |
| <code>doctor</code> | Diagnose CLI, auth, eligible route, rate-limit, ephemeral, and notification prerequisites. | No |
| <code>install</code> / <code>uninstall</code> | Register or remove the per-user LaunchAgent. | No |
| <code>daemon</code> | Run the monitor in the foreground. | Only after an enabled boundary has a fresh newer-cycle 0% Usage reading |
| <code>status</code> / <code>logs</code> | Inspect recorded state and field-name-redacted events; paths may be verbatim, so review before sharing. | No |
| <code>enable</code> / <code>disable</code> | Control automatic anchors; enable requires a verified result or a ready result with an adopted future baseline. | No |
| <code>verify-monitoring-cost</code> | Compare passive rate-limit reads. | No |
| <code>test-anchor --confirm-consume-usage</code> | Explicitly validate the real anchor path and print its selected route. | Yes — one minimal selected-route turn |

## Development verification

~~~sh
npm run typecheck
npm test
~~~

The automated suite covers JSON-RPC correlation, sparse rate-limit updates,
target-window classification (including weekly-only and no-target accounts),
zero-use reset-rollover detection, positive-use and delayed-rollover skips,
preflight cancellation during coalescing, reset-generation claims, restart
behavior, exact-once automatic-start notifications, deterministic route
selection and RPC propagation, ephemeral refusal, tool/approval/reroute aborts,
logging, lock recovery, macOS-only rejection, executable-path resolution, and
LaunchAgent plist validation. A fake App Server integration tests verify that
verified and ready fallback manual validation can safely enable automatic
anchoring, while an unverified result cannot; the suite never runs a real
<code>test-anchor</code> against an account.

## License and disclaimer

Released under the [MIT License](./LICENSE).

This is an unofficial, independent project. It is not affiliated with,
endorsed by, or supported by OpenAI. "Codex" and "ChatGPT" are referenced only
to describe interoperability. Use it at your own risk: it interacts with your
own Codex account through the supported App Server interface, and the author
provides no warranty, no guarantee of continued compatibility, and no support.
Review the source and the `doctor` output before enabling automatic anchoring.
