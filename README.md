# Copilot Pocket Printer

A portable macOS foundation for printing your own bitmap cards on the Tronic
5890 thermal pocket printer without its vendor app. GitHub Copilot, Claude Code,
another AI client, or a person can use the same CLI. A daily card is one future
example, not a hard-coded product or a requirement to use Copilot or WorkIQ.

**Milestone 1 is incomplete: offline preparation works; physical print/feed are
deliberately blocked by defects in the pinned upstream transport. No paper
output has been verified.** There is no renderer for live data, MCP server,
canvas, calendar integration, or automation yet.

## Build and offline checks

Requires macOS 13 or later and a Swift 5.9+ toolchain. Full Xcode provides the
XCTest runtime used by the unit tests. Do not install system components without
the machine owner's approval. The first build downloads the pinned Swift
Package dependency; subsequent offline commands do not access a network.

```sh
swift build
swift test
BIN_DIR="$(swift build --show-bin-path)"
BIN="$BIN_DIR/printer-cli"
"$BIN_DIR/printer-cli-checks"
"$BIN" --help
"$BIN" print examples/test-pattern.png --dry-run
"$BIN" feed 80 --dry-run
python3 scripts/smoke_test.py "$BIN"
```

`--show-bin-path` avoids assuming a particular SwiftPM build-system directory.
The `printer-cli-checks` executable needs no XCTest runtime or extra package.
It runs the **same shared assertions** as the XCTest wrapper, prints each
result, and exits nonzero if any assertion fails. Both runners cover command
parsing, German transliteration,
thresholding, transparency, row/bit order, input limits, activation boundaries,
24-line bands, credit-frame classification, printer selection, metadata
preflight and the guard against physical operations. They do **not** prove additive credit accounting
inside the private upstream BLE queue, radio delivery, or paper output.
The Python smoke checks exercise executable exit codes and actual file IO,
including invalid input and guarded physical commands. They use only the
standard library. Neither suite scans or connects to Bluetooth.

On the development Mac, `swift build` succeeds but `swift test` cannot import
`XCTest`: only Command Line Tools are installed, without XCTest or Swift Testing.
The native SwiftPM test runner encounters the same missing module. No system
installation was attempted. **11/11 shared Swift behavioral checks and 7/7
Python process-level smoke checks pass.** `swift test` itself remains unavailable
here, not passed; run its XCTest wrapper on a Mac with that runtime.

## CLI

| Command | Current behavior |
|---|---|
| `print <png> --dry-run` | Validates, thresholds and assembles an offline print job; no Bluetooth access. |
| `feed [dots] --dry-run` | Assembles activation, feed and stop segments; default 80, range 1...255. |
| `print <png>` / `feed [dots]` | Fail with `upstream_transport_blocked`, exit 6, before any Bluetooth access. |
| `status [--device <uuid>] [--timeout <seconds>]` | Metadata preflight, then bounded advertisement scan; currently blocked from the observed Copilot host. Never connects or sends commands. |
| `test-pattern <new.png>` | Generates a local 384x288 PNG; refuses to overwrite an existing file. |

Use `--help` for accepted options. `status` waits the full scan window (default
8 seconds, range 1...30, plus at most 5 seconds for Bluetooth startup) so a
stronger or earlier advertisement does not silently win. Automatic selection
requires the exact name `Mini Pocket Printer_BLE`. Multiple matches fail;
`--device` explicitly selects a previously known advertised UUID. A UUID match
is not device-model verification. DP-L13 and generic "printer" matches are not
automatically selected.

Status reports discovery, not readiness: battery, paper, model and firmware
remain unknown. A missing advertisement could mean off, out of range, connected
elsewhere, or differently named; a scan cannot distinguish those causes.
Upstream scanning writes a diagnostic log to
`~/Library/Logs/PocketPrinter5890App/ble.log`; it is outside this repository.

Errors go to stderr with a stable bracketed code:

| Exit | Code / meaning |
|---|---|
| 2 | `invalid_input` or `invalid_image` |
| 3 | `bluetooth_denied`, `bluetooth_unavailable`, or `bluetooth_host_missing_description` |
| 4 | `printer_missing_or_offline` |
| 5 | `printer_ambiguous` |
| 6 | `upstream_transport_blocked` |
| 130 | Task cancellation or process interrupt |
| 1 | Unexpected local error |

Transfer stalled/interrupted/completed states are **not implemented**, because
no transfer is permitted. There is no reconnect, retry, daemon, login item,
configuration command, firmware access, or hidden paper-consuming action.

### Images and the test pattern

![384-dot test pattern](examples/test-pattern.png)

Input must be a regular, single-frame PNG, exactly **384 pixels wide**, 1...4096
pixels high, at most 16 MiB, with normal orientation. Other dimensions are
rejected, not silently resized. Transparency is composited over white.
Upstream `MonochromeConverter` uses a hard threshold of 160, no dithering;
upstream `RasterEncoder` creates complete raster commands of at most 24 rows.
Text in generated images is transliterated to ASCII before rasterization,
including `ae`, `oe`, `ue`, `ss` for German letters. The CLI does not OCR or alter
text already inside a supplied PNG, and never sends native printer text.

The fixture contains 12 full raster bands, a full-width border, top and bottom
labels, and different stroke widths. Generate another without overwriting it:

```sh
"$BIN" test-pattern /tmp/pocket-printer-test.png
"$BIN" print /tmp/pocket-printer-test.png --dry-run
```

An offline job retains separate activation `10 FF F1 03` and twelve-zero-byte
wake segments, then the raster, 80 clearance dots, and `10 FF F1 45` stop.
Feed is activated the same way. The adapter uses upstream command constants
and bitmap encoding rather than `PrintJobBuilder`'s default prologue, because
that prologue unconditionally changes density. This milestone must not change
device settings. Do not flatten the activation and wake segments into one write.

## Bluetooth permission and hardware checkpoint

`Support/Info.plist` is embedded in the native executable's Mach-O
`__TEXT,__info_plist` section, including `NSBluetoothAlwaysUsageDescription`.
Neither help, image generation, dry runs, nor blocked print/feed initialize
CoreBluetooth. `status` is the only command that can reach Bluetooth, and
metadata preflight can stop it before any scan.

**Observed app-host blocker:** the first bounded status attempt from the
Copilot app exited 134. macOS TCC identified **GitHub Copilot**
(`com.github.githubapp`), not Terminal or the CLI, as the responsible process.
TCC refused its authorization request because the installed Copilot app lacks
`NSBluetoothAlwaysUsageDescription`. No valid approval prompt, discovery result,
or settings entry was observed. This is **not fixable by approving an ordinary
Bluetooth toggle**.

The CLI now checks that known host's actual usage-description metadata and
returns `bluetooth_host_missing_description` (exit 3) before CoreBluetooth
initialization if it is absent. Nonempty metadata allows the normal permission
flow; the app name alone is not a permanent ban. The inherited bundle marker is
a conservative check for the observed host, not a universal TCC-owner discovery
API. Do not unset it to bypass the check. The signed app needs an owner-supplied
fix; this repository does not modify the app, permission state, or launch route.
A preflight-only failure is not a successful scan.

Once the responsible host is fixed and a read-only check is appropriate,
switch on the printer and keep it nearby, then run:

```sh
"$BIN" status --timeout 8
```

If macOS asks **to allow Bluetooth access**, approve that native Bluetooth
prompt for the application it actually names. In **System Settings > Privacy &
Security > Bluetooth**, enable the entry with that same name. This is not a
request for Accessibility, Screen Recording, Full Disk Access, or permission
for the vendor app. Do not reset TCC or bypass a refusal or managed restriction.

The responsible application can differ between a terminal-launched CLI and
the Copilot app's execution host. Embedded CLI metadata is not sufficient for
the observed Copilot host. If a corrected host shows a native request for
**GitHub Copilot**, approve its Bluetooth access and expect the matching
**GitHub Copilot** entry under **System Settings > Privacy & Security >
Bluetooth**; that prompt and entry still need observation after the fix.
An independent Terminal check requires separate user approval and observation
of its actual owner; it would not verify end-to-end Copilot printing. None was
attempted. If approval takes longer than the bounded startup window, explicitly
rerun status afterward. No automatic retry.

After the upstream blocker below is resolved, the next checkpoint is:

1. Resolve the responsible app's missing Bluetooth metadata and confirm a
   reviewed dependency revision, passing offline checks, and a
   bounded, single-job adapter with explicit stall/disconnect errors.
2. Observe the Bluetooth prompt and record its exact application name. Identify
   exactly one intended printer. Do not treat advertisement discovery as a
   successful device query.
3. **Obtain explicit approval before one test print or any feed.** The
   288-row fixture plus 80 clearance dots consumes about 46 mm of paper at
   203 dpi. Nothing should automatically repeat a partial or failed job.
4. Run the approved test print once. Ask the user to check both border edges,
   all bands, upright readable text, the bottom label, and clearance feed.
   Only that visual confirmation completes milestone 1.

Queue empty, bytes handed to CoreBluetooth, `01 nn` credits, or the unsolicited
`AA 0D 0A` service frame are **not proof that paper printed**. Current dry-run
success explicitly states that nothing was transmitted.

### Pinned upstream hardware blocker

Dependency: [dimer47/PocketPrinter5890](https://github.com/dimer47/PocketPrinter5890),
MIT, copyright 2026 Dimitri Iachi. It remains a separate hardware library, not a
fork or copied source tree. `Package.swift` and `Package.resolved` pin reviewed
commit `20118975f6e58d5910657d7ba3daa62c3e5edae9`; no version tag is assumed.
Retain [NOTICE](NOTICE) when distributing a linked binary.

The [protocol specification](https://github.com/dimer47/PocketPrinter5890/blob/20118975f6e58d5910657d7ba3daa62c3e5edae9/docs/PROTOCOL_SPEC.md)
requires separate activation writes, additive `01 nn` credits, and raster
bands of about 24 lines. Inspection of the pinned
[BLE transport](https://github.com/dimer47/PocketPrinter5890/blob/20118975f6e58d5910657d7ba3daa62c3e5edae9/swift/Sources/PocketPrinter5890BLE/PocketPrinterBLETransport.swift)
found:

- Lines 291 and 306-320 gate credits using **remaining request length >64**.
  A short raster band or tail at or below 64 bytes bypasses that gate. For
  example, a 384x25 bitmap has a final 56-byte, one-row raster command. A full
  24-row band at the default 180-byte chunk size happens not to hit this edge;
  that does not make arbitrary PNG heights or negotiated MTUs safe.
- Lines 499-519 request FF01/FF03 notification subscriptions, then immediately
  mark connected and drain writes. There is no notification-state completion
  callback or public confirmed-readiness signal.
- Lines 341-357 retain pending writes on disconnect; reconnect drains that
  queue. The wrapper could avoid replay by never reconnecting, but that does
  not solve credit/readiness correctness. Connection also starts automatic
  unactivated battery writes, which is why current status never connects.

Minimal upstream changes to review: preserve a per-request raster-credit
requirement across all chunks; expose readiness only after both notification
subscriptions succeed; cancel and clear queued work on disconnect. A usable
adapter also needs bounded deadlines and transport outcomes that do not claim
physical completion. The dependency has **not** been patched, vendored, or
replaced. Actual print and feed remain guarded pending that review and fix.

## One portable core, optional integrations

One repository keeps the reusable core together. The upstream hardware library
is already the separate second repository. Split integrations into another
repository only if independent release or ownership needs emerge.

The planned boundary is:

```text
Any client -> JSON-to-PNG templates -> PNG -> native printer-cli -> upstream BLE
Any AI client -> local/stdio MCP render_card, preview_card, print_card
Copilot app (optional) -> Project, canvas preview, local recurring automation
```

Only the offline PNG/CLI foundation and discovery exist today. Later templates
will let people choose their own layouts and content. Local MCP tools should
reuse the same renderer and CLI, without making Copilot, WorkIQ, or a particular
daily-card schema prerequisites. BLE stays in native Swift/CoreBluetooth, not
Web Bluetooth inside a canvas.

Calendar access belongs to milestone 2 or later. The shared provider boundary
will accept **validated meeting times only**, never titles, customers,
attendees, or company names. Privacy tests are part of that milestone; there
is no calendar access or privacy-boundary implementation to claim here.

| Milestone | Status / checkpoint |
|---|---|
| 1. CLI test pattern on real hardware | Offline foundation; blocked, not hardware verified. Stop here for user confirmation. |
| 2. Real-data card PNG and templates | Planned; includes provider validation and privacy tests. |
| 3. Canvas preview and explicit print | Planned; native BLE behind reusable tools. |
| 4. Daily local automation | Planned; weekday 07:00 requires an awake Mac and nearby powered-on printer. No automation created. |

## What this showcases

| Feature | Copilot app capability | State |
|---|---|---|
| Coordinate milestones and keep reference context | Project | Used to coordinate this work |
| Implement and verify an isolated change | Session | Used for this local CLI foundation |
| Reusable rendering/preview/print operations | MCP tools or a client skill | Planned; usable by other AI clients |
| Optional calendar context under a strict times-only boundary | WorkIQ | Planned; not required by shared code |
| Preview, content toggles and explicit print | Canvas | Planned; no in-canvas Web Bluetooth |
| Recurring local card delivery | Local automation | Planned; awake Mac and nearby printer required |

Projects launched in **public preview** in the
[October 28 Universe release](https://github.blog/changelog/2026-10-28-github-copilot-app-universe-releases).
This does not mean every capability above was newly shipped or generally
available at Universe. The app's
[local-folder workflows](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/copilot-surfaces/github-copilot-app)
and the portable CLI provide a starting point for people working with Azure
DevOps or GitLab as well; this project does not require migration or claim
unverified native pull-request parity across those hosts.
