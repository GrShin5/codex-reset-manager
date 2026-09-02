# Security

Codex Reset Manager runs as a per-user macOS LaunchAgent and spends real Codex
usage. This document states what it trusts, what it guarantees, and — just as
importantly — what it does not.

## Reporting a vulnerability

Open an issue labelled `security`, or contact the maintainer privately if the
report itself would disclose the problem. There is no published response
timeline; this is a single-maintainer project.

## Supported versions

- Node.js 22 or newer.
- macOS only (`launchd`, `plutil`, `osascript`).
- Codex CLI: see `TESTED_CODEX_CLI_VERSIONS` in `src/codex-command.ts`.
  `doctor` warns about an unlisted version. It does **not** block automatic
  anchoring, because the App Server protocol changes faster than this tool can
  be revalidated and a hard gate would break working installations on every
  Codex upgrade.

## Trust boundaries

This tool audits none of the following. Each is trusted as it stands:

- **The Codex CLI binary and its App Server.** The manager speaks JSON-RPC to
  `codex app-server --stdio` as a child process. It never reads `auth.json`,
  parses OAuth tokens, or makes network calls of its own.
- **The Codex sandbox.** Anchor threads request `read-only` with
  `networkAccess: false` and `approvalPolicy: "never"`. Enforcement is
  upstream's. Treat the sandbox as a strong control, not an absolute one.
- **MCP servers the user configured** in `~/.codex/config.toml`. Starting a
  thread may initialize them, and that happens before any model turn. The
  anchor prompt forbids tool use and any tool-like item aborts the turn, but
  server startup is earlier than that abort. `doctor` reports whether any are
  configured.
- **macOS `launchd` and `osascript`**, and the local user account. Anything
  running as this user can already do everything this tool does.

## Treated as untrusted input

- **Rate-limit values and App Server notifications.** Used only for scheduling
  and verification. Anything unprovable resolves to `unverified` or `skipped`,
  never to a second turn.
- **`state.json` and `config.json`.** A corrupt file falls back to defaults,
  and safety-relevant config fields are pinned to `DEFAULT_CONFIG` on load, so
  hand-editing the file cannot weaken the anchor policy or its verification.
- **`CODEX_RESET_MANAGER_CODEX`.** Re-validated at spawn time rather than
  trusted from install time.

## What this tool guarantees

- A reset generation is claimed and persisted **before** any turn starts, and
  is never retried. A crash, timeout, or RPC failure cannot produce a second
  turn for the same generation. Availability is deliberately traded for
  at-most-once.
- Anchor turns run in an ephemeral thread in a dedicated workspace, and are
  refused if that workspace is not empty.
- A tool-like item, an approval request, or a provider reroute interrupts the
  turn.
- Only an explicitly advertised model and reasoning effort is used; an unknown
  model is ineligible.
- The rate-limit snapshot is re-read immediately before the durable claim, so
  usage that appears during the coalesce window cancels the attempt.
- `verified` requires the target window's reset timestamp to have advanced and
  then held steady across several samples (see below).
- Logs redact prompt-, response-, and credential-shaped keys. State, config,
  and logs are owner-only (0600 / 0700).
- The tool itself makes no network requests.

## What this tool does **not** guarantee

- **That passive reads are free.** `account/rateLimits/read` is assumed not to
  consume quota. That is an assumption about the backend, not a guarantee. The
  daemon already issues this read on every poll; multi-sample verification adds
  two more reads per anchor, which is a small fraction of that existing volume.
- **Causation.** Multi-sample verification proves that a window's reset
  timestamp advanced and then stopped moving with the clock. It does **not**
  prove that *this* turn caused the advance. If the timestamp advanced once for
  an unrelated reason before the first sample and then held steady, no external
  observation can distinguish that from a successful anchor. The check exists
  to eliminate the *sliding-timestamp* false positive, not to establish
  causation.
- **That "steady" means fixed.** Steadiness is judged over the sampling span
  (4 samples across 45 seconds by default). If the backend served every sample
  from a single cached snapshot lasting longer than that span, identical values
  would prove nothing. This assumption cannot be eliminated from outside — any
  span can be defeated by a coarser cache — so it is bounded rather than
  removed: the configured span is pinned, the samples must genuinely be spread
  across it, and the observed span is recorded as `spanMs` in the
  `anchor_verification_sampled` log entry so any verdict can be audited later.
- **That a refused window will recover on its own.** A window the samples
  cannot prove steady is refused as a scheduling baseline and stays unscheduled
  until a later manual `test-anchor` succeeds. That is deliberate: scheduling
  against a timestamp that keeps receding would mean waiting for a boundary
  that never arrives. `test-anchor` and `status` name the refused windows.
- **That the backend's timestamps are correct or timely**, or that every
  applicable limit is exposed. Windows the API does not expose are not managed;
  the tool does not guess at them.
- **That MCP servers are not started** by an anchor thread.
- **Defence against a compromised Codex CLI, or against anything else running
  as this user.**
- **Notification delivery.** macOS may suppress notifications.

## Non-goals

This tool does not bypass, raise, or circumvent any usage limit. It issues one
ordinary, minimal, fully metered request so that a rolling usage window begins
at reset time rather than whenever the user happens to start working. If your
account is governed by a Business or Enterprise agreement, confirm with your
administrator before running it.
