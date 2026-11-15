# Local MCP bridge

This Node 22+ stdio bridge is BLE-free. It uses only Node built-ins, never
launches a native process, and talks to an independently user-launched
**Pocket Printer Helper**. No global MCP configuration is installed by this
repository. `examples/mcp-client.example.json` is a generic client example,
not an automatically loaded Copilot app customization.

**Real Copilot printing passed on 2026-11-15.** After explicit setup approval,
the user manually registered `pocket-printer`, authorized the helper's own native
Bluetooth prompt and completed one separately approved test-pattern print.
Registered status/preview/submission calls and the user's expected-output
confirmation are recorded in the [verification result](../README.md#copilot-in-app-verification-result).
The transport receipt still says `submitted_only`, `paper_confirmed: false`;
user confirmation is separate evidence, not a receipt rewrite.

That successful test used **native confirmation**, the default. The optional
**AI-client confirmation** mode is now implemented and staged, but has not
been activated or physically verified. It removes the second per-print helper
click after a one-time helper opt-in; see the trust boundary below.

**Keep the helper open.** Closing it produces `helper_not_running`; the bridge
does not relaunch it. Development rebuilds may require fresh Bluetooth
permission. These setup prompts are distinct from per-print confirmation.
The successful test approval is consumed; this change and the setup procedure
below do not authorize another paper operation.

The server implements the narrow JSON-RPC/MCP stdio subset it advertises:
initialization/version negotiation, `notifications/initialized`, `ping`,
`tools/list`, `tools/call` and cancellation notifications. It negotiates
2025-06-18. Older batching-era protocol versions are not advertised.
There are no resources, prompts, rendering, sampling or task capabilities.
The [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
and [tool contracts](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
are the protocol references. A maintained SDK was considered first but was
unavailable through the build environment's approved package-install path.
This is a directly tested protocol implementation, **not an SDK-backed server**
or a claim of conformance to every optional MCP feature.

| Tool | Effect |
|---|---|
| `printer_helper_status` | Helper availability, controller/authorization state, active job ID, effective `confirmation_mode` and any `confirmation_preference_error`; no Bluetooth initialization, scan or printer query. |
| `inspect_png` | Revalidate bounded PNG bytes in the helper; return metadata and the exact thresholded print-bitmap preview. No card rendering or BLE. |
| `submit_png` | Submit one job with explicit device UUID, stable job UUID, PNG bytes and `paper_approved: true`. Native mode stages it; opted-in AI-client mode may begin printing immediately. |
| `get_print_job` | Return the durable receipt for that same job UUID, including uncertainty after restart. |
| `cancel_print_job` | Cancel before approval, or request interruption; never claim sent paper was undone. |

PNG arguments are strict base64, at most **1 MiB decoded**, 384 pixels wide and
1...4096 high. The helper uses the existing PNG decoder and protocol builder.
The stricter IPC byte limit does not change the standalone CLI's 16 MiB limit.
No tool accepts image file paths, shell commands, raw BLE packets or separate
feed requests. Both `inspect_png` and the native approval window show the exact
black/white bitmap that will be printed, including white composition and the
160 threshold. The digest still identifies the original input PNG.
This is not a newly rendered card. Tool input/output may be retained by the calling AI
client; use only content you intend to share with that client.

## Confirmation modes and trust

Native confirmation is the default and remains available: each job waits for
**Approve this one print** in the helper. To use only the AI client's per-print
confirmation, the user must explicitly enable **Use AI-client confirmations
(skip per-print helper click)** once in the helper UI.

**Opt-in trusts every program running under the same macOS user account.**
Any such program can submit `paper_approved: true` and start a fresh valid job.
The helper cannot distinguish Copilot from other same-user callers or verify
that a human clicked. The AI client must obtain explicit per-job approval;
if it is configured to **Always allow**, its prompt may disappear. This is not
a non-suppressible human gate or app attestation. A per-user token file would
be readable by those same callers and would not provide that protection, so
no token scheme was added.

The effective `confirmation_mode` is `native` or `ai_client`. The helper saves
the explicit selection in private `confirmation.json` alongside its receipts,
using the existing atomic synced file mechanism. It applies a selection only
after a successful save. Missing preferences default to native; read/parse/write
failures visibly fall back to native and are returned in helper status. A failed
save may leave the previous disk setting intact, so a later restart can reload
that old value. Repair the setting through the helper UI, not by deleting
receipts. No tool can change the preference.

Only a **fresh admission** captures the selected mode. AI-client mode uses
the same guarded durable approval-to-execution path in that handler turn,
returning the current receipt, normally `in_progress`, not a stale
`awaiting_approval`. Toggling never executes a pre-existing staged job, and
startup never resumes work. Duplicates still return their original receipt.
The default native mode's pending approval expires after five minutes.
**Stop remaining work** cannot undo bytes already submitted in either mode.

## Setup, with explicit approval gates

Build from the repository root:

```sh
swift build
python3 scripts/build_printer_helper.py
```

If the existing helper must remain running, use
`python3 scripts/build_printer_helper.py --stage` instead. This packages
`.build/staged/Pocket Printer Helper.app` without changing
`.build/Pocket Printer Helper.app`. Do not launch the staged copy or replace
the active bundle until the user quits the old helper and approves the switch.
The current single-confirmation change stops at this staged boundary.

The app is `.build/Pocket Printer Helper.app`. It is separate from the original
scan-only **Pocket Printer Probe.app**, with a new bundle ID and a truthful
print-capable Bluetooth description. It is ad-hoc signed for development,
not installed or notarized. The probe already demonstrated that a changed
ad-hoc build can request permission again; do not promise update stability.

The user must close the old probe, independently open the helper in Finder,
and press **Enable Bluetooth**. Approve an ordinary Bluetooth request only if
it names **Pocket Printer Helper**. Pending consent has no deadline; authorized
controller startup has a 10-second deadline. If another app is named, or access
is denied/restricted, stop. Do not reset TCC, alter host metadata, install
certificates or bypass Gatekeeper. The existing Copilot-host metadata guard is
also checked before the helper requests Bluetooth and by each native job.

Only after that checkpoint, obtain approval to register this **stdio** server
in the desired AI client. Use an absolute Node executable path and an absolute
`bridge/server.mjs` argument; no shell wrapper and no native helper command.
The example configuration does not grant authority to install or enable it.
The bridge defaults to `/tmp/cpp-<uid>/helper.sock`; an explicitly configured
`POCKET_PRINTER_SOCKET` environment variable can select another private socket
for tests. There is no network listener or automatic helper launch.

First registered-client calls should be `printer_helper_status` and
`inspect_png`, with the existing test-pattern bytes. Those calls must be
observed in the real client; the offline harness is not a Copilot tool call.

For a **new, separately approved** physical test, choose a job UUID once,
keep it for every status query, use the discovered device UUID and set
`paper_approved: true` only after that approval. The helper window shows the
image, digest, device, dimensions and nominal paper use. In native mode the
user must also click **Approve this one print**. In opted-in AI-client mode
submission may start immediately without that click, so review `inspect_png`
and obtain the AI-client approval before submitting. Each approved job uses
a fresh one-shot `PrinterClient` and the existing repaired transport.

Do not resubmit or create a replacement ID after a timeout/disconnect. Query
the original ID. `submitted_only` means local transport drain and required
callbacks, never physical completion. Actual paper inspection remains a
separate user checkpoint. No paper operation is authorized by setup or tests.

## IPC, receipts and failure semantics

The helper creates a 0700 socket directory and a 0600 Unix socket. It validates
the connecting process's user with macOS `getpeereid`; the bridge also checks
socket/directory ownership, type and modes. **Same-user access is not isolation**:
another process running as that user can inspect or tamper with the files.
Native mode uses an independent approval screen. AI-client mode deliberately
trusts the client-supplied approval assertion from any same-user caller.

Each connection carries one length-prefixed JSON request, maximum 2 MiB.
At most four connections are handled concurrently, with a three-second
absolute input deadline; the bridge waits at most five seconds and never
retries. Malformed, truncated, oversized, wrong-peer, permission, busy and
unavailable-helper failures are explicit. Disconnecting an MCP call does not
retract a durably admitted request. `cancel_print_job` is a distinct operation.

Receipts live in
`~/Library/Application Support/CopilotPocketPrinter` (directory 0700, files
0600). A process lock permits one helper owner. The service writes and
`fsync`s an admission receipt before enabling physical submission. Admissions
are atomically published from a complete synced temporary file with macOS
no-overwrite rename; updates use synced replacement files. A job UUID is permanently bound to its
image SHA-256 and device. Matching duplicates return the same receipt; a
different payload/device is rejected. No PNG bytes are stored in the ledger
or logged by the bridge/helper. Only IDs, image digest/height, ISO-8601 timestamps and
state/error information are retained.

On startup the helper reconciles every receipt before accepting work.
An unfinished **approved** receipt becomes **uncertain**, never an automatic
replay. A pending-approval receipt becomes `cancelled_before_submission`:
durable approval must precede execution, so it was provably unsent within the
process-restart contract. Unacknowledged uncertain outcomes block fresh IDs too
and appear in helper status and the window. A transfer error or in-progress
cancellation first requires quitting/restarting to release old radio resources;
then the user must inspect the paper and click **Acknowledge shown uncertain
outcome** for each receipt. There is no MCP acknowledgment method. The recorded
acknowledgment is not paper confirmation and never permits that job ID to replay.
Only then can a genuinely new, separately approved job be staged.
Storage failure blocks printing rather than falling back to an in-memory job.
Abandoned private temporary writes are cleaned on startup; Finder metadata
does not count as a receipt. Corrupt actual receipt files fail closed.
There is no reset/delete API or automatic receipt pruning; the store stops
admitting jobs at 4096 receipts. Deleting the ledger, restoring an older copy,
switching accounts or deliberate same-user tampering defeats its replay
history. It is process-restart protection, not a guarantee against storage
rollback or hardware power-loss behavior.

## Offline validation

From the repository root:

```sh
swift build
BIN_DIR="$(swift build --show-bin-path)"
"$BIN_DIR/printer-cli-checks"
"$BIN_DIR/printer-helper-checks"
python3 scripts/smoke_test.py "$BIN_DIR/printer-cli"
HELPER_CHECKS_BIN="$BIN_DIR/printer-helper-checks" npm test --prefix bridge
```

Repeat with `swift build -c release` and its `--show-bin-path`. Standard XCTest
remains unavailable on the development Command Line Tools installation; the
dependency-free Swift harness exits nonzero on failed assertions.
The Node harness exercises actual child-process stdio initialization/list/call,
real macOS sockets/peer checks and durable receipts across inert helper
process restarts. Its executor is explicitly fake and cannot access Bluetooth.
Those harness runs are not registered Copilot calls or real printing. The
separate live checkpoint above supplies that evidence for the one approved
test pattern, not every image, client, device or failure condition.
