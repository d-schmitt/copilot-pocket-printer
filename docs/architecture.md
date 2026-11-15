# Architecture, privacy, and protocol notes

The [README](../README.md) is the demo entry point.
[CLI reference](cli.md), [contributor checks](development.md), and
[MCP/helper reference](../bridge/README.md) cover operation and maintenance.

## Portable boundaries

The current implementation keeps Bluetooth in native Swift/CoreBluetooth:

```text
Copilot or another MCP client
  -> BLE-free Node stdio bridge
  -> private same-user Unix socket
  -> independently user-launched native helper
  -> PrinterCLIKit -> pinned PocketPrinter5890 BLE library

Person or compatible command client
  -> native printer-cli -> the same native core
```

The bridge never launches the helper, reads image paths, or exposes raw BLE
commands. Its five tools accept bounded data and delegate to an independently
authorized process. The CLI is portable between callers, not between operating
systems: the native implementation requires macOS.
Copilot Projects and sessions coordinate work; they are not runtime dependencies.
Azure DevOps/GitLab users can start from a local-folder workflow without moving
their source hosting. Native pull-request integration parity is not established.

The upstream hardware library remains a separate repository. Keep this
repository's reusable core together unless independent release or ownership
needs justify a split. The [JSON-to-PNG renderer and daily-card assembler](daily-card.md)
produce PNGs for the same core without introducing Copilot, WorkIQ, or a daily-card
schema as printing prerequisites. They run separately from the installed helper
and bridge; MCP rendering is still planned.
Canvas controls must use native tools, not Web Bluetooth.

The installer copies the helper and two bridge modules into one managed per-user
directory for atomic paired updates. Preferences and receipts are separate.
There is no login item, automatic startup, updater, or retained rollback archive.
The [installation reference](../bridge/README.md#setup-with-explicit-approval-gates)
describes validation, ownership checks, refusals, and the update race boundary.

## Native permission boundary

The CLI embeds usage metadata in Mach-O `__TEXT,__info_plist`, but macOS can
attribute its Bluetooth request to its execution host. During development,
direct Copilot-host initialization was refused because that host lacked
`NSBluetoothAlwaysUsageDescription`. The current preflight checks actual metadata
for that known host and fails before initialization when it is missing.
The inherited bundle marker is a conservative guard, not a universal TCC-owner
discovery API or a permanent ban based on the application's name.

The supported app workflow instead uses an independently Finder-launched helper
with its own truthful, print-capable usage description. Native permission is
requested only by the user's **Enable Bluetooth** action. Consent waiting has
no deadline; authorized controller startup is bounded to 10 seconds.
Keep its window open. Rebuilds or moves may require normal permission again.
Do not unset the host marker, alter signed app metadata, reset TCC, install
certificates, or bypass Gatekeeper to evade a refusal.

The helper's Bluetooth-ready state is controller authorization/readiness,
not discovery, a connected printer query, or paper readiness.
The [scan-only probe](development.md#scan-only-permission-probe) established the
feasibility of an independent permission owner; it is not needed for normal use.

## Approval, replay, and privacy

Native confirmation is the default. An explicit native UI opt-in can select
`ai_client`, allowing a fresh `paper_approved: true` request to start immediately.
This trusts **all same-user callers**, not an attested human approval or a
specific app. Client **Always allow** settings can remove its per-job prompt.
A token readable by the same user would not repair this boundary.
See [confirmation modes](../bridge/README.md#confirmation-modes-and-trust).

The helper admits one job at a time and persists its receipt before execution.
A stable UUID is bound to the PNG digest and device; matching duplicates return
the original receipt. Startup never replays a job. Approved unfinished work
becomes uncertain and blocks new jobs until native acknowledgment after paper
inspection; this is not paper confirmation or permission to replay.
Storage failures block printing. Protection covers process restarts, not malicious
same-user tampering, deleted ledgers, rollback, or hardware power-loss guarantees.
The [IPC and receipt contract](../bridge/README.md#ipc-receipts-and-failure-semantics)
contains the wire limits, storage modes, and recovery rules.

The bridge/helper neither logs nor stores PNG bytes in the receipt ledger.
Receipts retain identifiers, image digest/height, timestamps, and state/error
information. The calling client may retain tool payloads and previews.
Private socket permissions are not isolation from other same-user programs.
Keep personal images, device IDs, and client transcripts out of public examples.

### Calendar boundary and roadmap

The merged [daily-card pipeline](daily-card.md#privacy-boundary) projects supplied
calendar records into validated start/end intervals and availability, never
retaining titles, attendees, customer/company names, locations, links, or raw
transcripts in its render JSON. Supply times-only records even though the
normalizer discards extra fields. It accepts portable timing data or a scoped
Graph timing response; automatic WorkIQ/calendar acquisition is not implemented.
Unavailable input stays unavailable, not a false zero-event day.
The generic renderer accepts arbitrary template text and the printer accepts
arbitrary PNGs; neither is an OCR or redaction service.

The assembler can optionally fetch numeric Open-Meteo weather for the requested
day, or consume injected data. Provider failures remain explicit in output
warnings and exit status. See [daily-card policies](daily-card.md#time-and-walk-policy)
for time boundaries, weather coverage and walk-selection limits.

Future work is tracked in [rendering through MCP](https://github.com/d-schmitt/copilot-pocket-printer/issues/7),
[canvas controls](https://github.com/d-schmitt/copilot-pocket-printer/issues/8),
[private acquisition and scheduling](https://github.com/d-schmitt/copilot-pocket-printer/issues/9),
and [helper availability](https://github.com/d-schmitt/copilot-pocket-printer/issues/10).
Scheduled delivery needs an awake Mac and an available printer and must not
weaken approval or replay rules. These are backlog items, not installed features.

## Reviewed dependency and transport

The separate [PocketPrinter5890](https://github.com/dimer47/PocketPrinter5890)
hardware library is MIT-licensed, copyright 2026 Dimitri Iachi.
[Package.swift](../Package.swift) and [Package.resolved](../Package.resolved)
pin the reviewed repair fork
[`f5a31521e5e415b8091a49f20cc836956947604b`](https://github.com/d-schmitt/PocketPrinter5890/commit/f5a31521e5e415b8091a49f20cc836956947604b),
not a moving branch or version tag. No implementation is vendored or dependency
checkout patched. Retain [NOTICE](../NOTICE) when distributing linked binaries.

The original reviewed base was
[`20118975f6e58d5910657d7ba3daa62c3e5edae9`](https://github.com/dimer47/PocketPrinter5890/tree/20118975f6e58d5910657d7ba3daa62c3e5edae9).
Its [protocol specification](https://github.com/dimer47/PocketPrinter5890/blob/20118975f6e58d5910657d7ba3daa62c3e5edae9/docs/PROTOCOL_SPEC.md)
requires separate activation writes, additive `01 nn` credits, and roughly
24-line raster bands.

Each image job preserves activation `10 FF F1 03`, a separate twelve-zero-byte
wake write, raster bands, 80 clearance dots, and stop `10 FF F1 45`.
Feed and connected status use the same activation/wake/stop envelope.
Connected status sends model/firmware/battery/paper queries, not raster, feed,
label, density, or persistent-setting commands. Bare upstream
`readDeviceInformation()` calls do not satisfy the activation requirement.
The adapter reuses upstream command constants and bitmap encoding but avoids
`PrintJobBuilder`'s unconditional density write. Never flatten activation and
wake into one write.

Inspection of the original [BLE transport](https://github.com/dimer47/PocketPrinter5890/blob/20118975f6e58d5910657d7ba3daa62c3e5edae9/swift/Sources/PocketPrinter5890BLE/PocketPrinterBLETransport.swift)
motivated the repair:

| Original behavior | Failure risk | Reviewed repair / adapter boundary |
|---|---|---|
| Credits gated on remaining request length greater than 64 bytes | Short raster tails bypass credits; a 384 x 25 image ends with a 56-byte one-row command | Classify raster requests before chunking, preserving credit requirements for short bands/tails |
| Notification requests immediately followed by connected/drain state | Writes can precede confirmed FF01/FF03 subscriptions | Typed readiness waits for required notification completions; the CLI verifies FF00/FF02 too |
| Pending writes retained across disconnect | Reconnect can replay queued work | Clear work and invalidate stale callbacks; each job uses a fresh one-shot client |
| Automatic battery traffic and synchronous Combine delivery | Unrelated drains or willSet reads can falsely finish a job | Install observers first, consume emitted values, submit one atomic batch, and track that batch's own pending/drained cycle |

Queue drain, credits, and unsolicited `AA 0D 0A` service frames never prove paper
output. See [CLI deadlines and outcomes](cli.md#outcomes-deadlines-and-errors).

## Verification boundaries

Recorded development checkpoints established native Terminal test-pattern
output from a user photograph, and real registered Copilot/helper printing
with user-confirmed output in both native and opted-in AI-client modes.
In the latter mode, the user confirmed correct output without a helper click.
These are evidence for the tested device and fixture, not every PNG, printer,
client, or error condition. Transport receipts remained `submitted_only` with
`paper_confirmed: false`; they were not rewritten to represent user testimony.
Physical dimensions/feed were not measured.

The independent probe also demonstrated discovery and repeat scan/quit.
A changed ad-hoc rebuild requested fresh permission, demonstrating
reauthorization rather than permission retention. Stable installed paths do not
prove retained permission or guarantee future client tool discovery.
No previously completed checkpoint authorizes another hardware operation.
Current status must be observed at use time; historical process/cache problems
are not assumed to be active defects.
