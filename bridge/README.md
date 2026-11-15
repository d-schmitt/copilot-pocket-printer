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

That first successful test used **native confirmation**, the default. A second
separately approved Copilot test on the same date verified **AI-client
confirmation** after the user enabled the one-time helper opt-in. One submission
immediately returned `in_progress` in `ai_client` mode, then `submitted_only`.
The user selected exactly **"Yes, correct print with no helper click"** in the
Project's confirmation control. No native per-print click, duplicate submission
or retry occurred. See the [single-confirmation evidence](../README.md#single-confirmation-verification-result)
and the unchanged trust boundary below.

During that test, the Project's discovered tool description still said native
approval was mandatory, while actual status and execution correctly reported
`ai_client`. The responsible cache/process is unknown. Existing connections
may need tool-metadata refresh for accurate wording; this observation does not
require changing the functioning implementation.

**Keep the helper open.** Closing it produces `helper_not_running`; the bridge
does not relaunch it. Development rebuilds may require fresh Bluetooth
permission. These setup prompts are distinct from per-print confirmation.
All completed test approvals are consumed; this change and the setup procedure
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

Use one installation sourced from a reviewed, up-to-date `main` checkout.
Do not register a per-branch `bridge/server.mjs` or keep a development `.build`
app as the normal runtime. Source is tracked on main; app bundles are not.
Requirements are macOS 13+, Swift 5.9+, Python 3 and an installed Node 22+.
From the repository root, prepare without activating:

```sh
python3 scripts/install_printer.py
```

This reuses `build_printer_helper.py --stage`, then copies and checks a complete
package under `.build/installation/Copilot Pocket Printer/`. An absolute
`--stage-root` selects another staging parent. `--helper-app` accepts an existing
signed bundle with this checkout's bridge; `--from-stage` copies both runtimes
from a verified staged package. Both avoid rebuilding. `--node` selects an
absolute Node executable.
Neither default staging nor the builder installs or launches an app. A running
helper in another location is left alone; a running staging target is refused.

**Only after explicit installation approval**, quit the old helper yourself and
disconnect clients using the installation being updated. Do not launch it or
reconnect clients while installation is in progress. Install the staged package
without rebuilding:

```sh
python3 scripts/install_printer.py --install \
  --from-stage "$PWD/.build/installation/Copilot Pocket Printer"
```

The stable paths are:

| Component | Per-user destination |
|---|---|
| Native app | `~/Applications/Copilot Pocket Printer/Pocket Printer Helper.app` |
| MCP entry point | `~/Applications/Copilot Pocket Printer/bridge/server.mjs` |
| Local bridge module | `~/Applications/Copilot Pocket Printer/bridge/ipc.mjs` |

Both runtimes deliberately share **one managed directory**, allowing an atomic
whole-package update instead of a partly updated app/bridge pair. They are real
copies, not symlinks. The bridge needs only its two runtime modules and Node
built-ins, not npm packages, source files, a particular cwd or a Copilot-specific
folder. Do not store personal files inside this directory. Its private manifest
contains only relative file names, modes and content hashes, not source paths,
credentials or user data. Preferences and uncertain receipts remain untouched in
the established **separate** `~/Library/Application Support/CopilotPocketPrinter`.

For an update, repeat preparation from the reviewed main source and explicitly
install again. Identical content is a no-op. Only an unmodified, recognized
installation can be replaced. Symlinks, unrelated files, invalid signatures,
non-system dynamic libraries and running target helper/bridge processes cause
refusal; no process is stopped. Both copies must pass validation before a macOS
atomic directory swap. Preparation or swap failure leaves the previous package
unchanged. The replaced, verified package is then removed from the invocation's
private temporary directory. There is no retained rollback archive, updater,
login item, uninstall command or automatic client reconfiguration. Process checks
are snapshots, not a lock against a user launching the app during installation.
This guards ordinary setup mistakes, not malicious same-user filesystem changes.
Owned regular `.DS_Store` Finder metadata is ignored and discarded on replacement;
other added or changed paths are named in the refusal. Source and installed files
must be user-owned and not group/world writable. Staging cannot be placed inside
the stable installation. A cleanup error explicitly reports whether publication
already happened; it is not a rollback.

The helper keeps bundle ID `io.github.copilot-pocket-printer.helper` and its
truthful print-capable Bluetooth description. It remains ad-hoc signed, not
notarized. Moving or rebuilding it may request normal permission again.

After a separate activation approval, the user must independently open the
**installed** helper in Finder and press **Enable Bluetooth**.
Approve an ordinary Bluetooth request only if
it names **Pocket Printer Helper**. Pending consent has no deadline; authorized
controller startup has a 10-second deadline. If another app is named, or access
is denied/restricted, stop. Do not reset TCC, alter host metadata, install
certificates or bypass Gatekeeper. The existing Copilot-host metadata guard is
also checked before the helper requests Bluetooth and by each native job.

Only after that checkpoint, obtain approval to register this **stdio** server
in the desired AI client. The installer prints exact proposed configuration
using the stable server path and absolute Node executable; it never applies it.
Use those values, with no shell wrapper or native helper command. No tilde
expansion is needed in client configuration. Keep that Node installation
available independently of this repository. The example configuration does not
grant authority to install or enable it.

**Copilot's separate settings fields are not a shell command.** Copy the
installer's `Command` value into **Command**, and its complete one-item JSON
array into **Arguments**, including the square brackets and double quotes.
For a user named `YOUR-USER`, the fields look like this:

| Field | Literal field value |
|---|---|
| Command | `/usr/local/bin/node` |
| Arguments | `["/Users/YOUR-USER/Applications/Copilot Pocket Printer/bridge/server.mjs"]` |

Use the actual paths printed by the installer. Do not paste the bare
space-containing server path into Arguments: the field splits bare text on
spaces. Its hint permits a JSON array for arguments containing spaces or empty
arguments. A split entry point can cause Node to exit with `MODULE_NOT_FOUND`
before MCP initialization. The full `mcpServers` JSON remains the format for
configuration files; it does not belong in the separate Arguments field.

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
python3 -m unittest discover -s scripts -p 'test_install_printer.py'
```

Installer tests use workspace-local fixture installations, including paths with
spaces, source removal, no-op/repeated updates, running-target refusal, collision
and symlink rejection, and failure preservation. They mock native signatures for
non-executable fixture apps, but use the real Node stdio bridge and macOS atomic
rename. Actual staging separately verifies the real copied app with `codesign`
and `otool`, and initializes/lists the bridge from an unrelated cwd without
calling any helper tool. None of these checks proves registered-client tool
exposure or physical printing.

Repeat with `swift build -c release` and its `--show-bin-path`. Standard XCTest
remains unavailable on the development Command Line Tools installation; the
dependency-free Swift harness exits nonzero on failed assertions.
The Node harness exercises actual child-process stdio initialization/list/call,
real macOS sockets/peer checks and durable receipts across inert helper
process restarts. Its executor is explicitly fake and cannot access Bluetooth.
Those harness runs are not registered Copilot calls or real printing. The
separate live checkpoint above supplies that evidence for the one approved
test pattern, not every image, client, device or failure condition.
