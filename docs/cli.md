# Native CLI reference

For the recommended Copilot workflow, start with the [demo](../README.md).
The native CLI is a client-neutral alternative, not a way to initialize
Bluetooth inside an unauthorized AI host. It requires macOS 13+ and a working
Swift toolchain; check [revision-specific compatibility](development.md#toolchain-compatibility).
Build from the repository root; the first build downloads the pinned dependency:

```sh
swift build
BIN_DIR="$(swift build --show-bin-path)"
BIN="$BIN_DIR/printer-cli"
"$BIN" --help
"$BIN" print examples/test-pattern.png --dry-run
```

Use `--show-bin-path` rather than assuming a SwiftPM output directory.
These commands do not initialize Bluetooth or move paper. The stable installer
packages the helper and bridge, not this standalone CLI.

## Commands

| Command | Behavior |
|---|---|
| `print <png> --dry-run` | Validates, thresholds, and assembles an offline print job. |
| `feed [dots] --dry-run` | Assembles activation, feed, and stop segments; default 80, range 1...255. |
| `print <png>` / `feed [dots]` | Require separate paper approval, `--device <uuid>`, and `--confirm-paper`; otherwise fail with `paper_approval_required` before Bluetooth access for valid input. |
| `status [--device <uuid>] [--timeout <seconds>]` | Metadata preflight and bounded advertisement scan; no connection or device query. |
| `status --device <uuid> --connect` | Confirm FF00/FF02 and FF01/FF03 notifications, query model/firmware/battery/paper with activation/wake/stop writes, then disconnect. No raster, feed, or settings requested. |
| `test-pattern <new.png>` | Generate a local 384 x 288 PNG; refuse to overwrite an existing file. |
| `card-renderer <template.json\|-> <new.png>` (separate executable) | Render bounded JSON blocks into a 384-dot PNG and emit a layout report, without the helper or Bluetooth. |

See [daily-card interfaces](daily-card.md#call-from-any-assistant-or-cli) for
renderer and optional assembler usage. These are separate from `printer-cli`
and are not included in the installed MCP package.

`--timeout` is 1...30 seconds, default 8. It bounds scan and connection
separately, after at most 5 seconds of Bluetooth startup. Status waits the
full scan window so a stronger or earlier advertisement does not silently win.
Automatic selection requires exactly one device named `Mini Pocket Printer_BLE`.
Multiple matches fail. A supplied `--device` selects that advertised UUID,
not a verified printer model. DP-L13 and generic printer names are not
automatically selected.

## Discovery and native permissions

Only from a separately approved, independently opened native host such as
Terminal, with the printer nearby:

```sh
"$BIN" status --timeout 8
# Separate connected check, only after approving this hardware interaction.
"$BIN" status --device YOUR-DISCOVERED-UUID --connect --timeout 8
```

Replace the placeholder with the UUID reported by the scan. It is local device
information, not a repository default. Without `--connect`, model, firmware,
battery, and paper remain unknown. A missing advertisement cannot distinguish
off, out of range, already connected elsewhere, or a different advertised name.
A connected query is not passive: it includes activation and wake commands.
Battery alone does not verify the solicited status query; missing values remain
unknown and paper is a raw informational byte, not a readiness guarantee.

Observe the application actually named by macOS when requesting Bluetooth.
The matching entry is under **System Settings > Privacy & Security > Bluetooth**.
No Accessibility, Screen Recording, Full Disk Access, or vendor-app permission
is required. Respect denial and managed restrictions. If permission takes longer
than startup allows, explicitly rerun status after consent; there is no retry.

The CLI embeds `NSBluetoothAlwaysUsageDescription`, but an observed Copilot
execution host lacked its own usage metadata. macOS attributed direct CLI BLE
to that host. The preflight therefore returns `bluetooth_host_missing_description`
before CoreBluetooth initialization when the known host lacks it. A regular
Bluetooth toggle cannot supply missing metadata. Do not unset the host marker,
alter the signed app, reset TCC, or change launch routes to bypass this guard.
Use the [independently authorized helper](../bridge/README.md) for Copilot.
See [permission architecture](architecture.md#native-permission-boundary).

## Images and one physical test

Input must be a regular, single-frame PNG, exactly **384 pixels wide**,
1...4096 pixels high, at most **16 MiB**, with normal orientation.
Images are rejected rather than resized. Transparency is composited over white;
the hard threshold is 160 with no dithering. Raster commands contain at most
24 rows. The MCP/helper boundary has a stricter **1 MiB** PNG limit.

Generated text is transliterated to ASCII before rasterization, including
`ae`, `oe`, `ue`, and `ss` for German letters. The CLI does not OCR or alter
text already in a supplied PNG and never sends native printer text.

The [synthetic fixture](../examples/test-pattern.png) includes 12 full bands,
a border, upright top/bottom labels, and varying stroke widths. To generate
another local copy without overwriting:

```sh
"$BIN" test-pattern /tmp/pocket-printer-test.png
"$BIN" print /tmp/pocket-printer-test.png --dry-run
```

Before a physical test, use the reviewed dependency and
[offline checks](development.md#offline-checks) in an approved host. Separately
approve a connected status check for the discovered UUID. Then review the
bitmap and obtain fresh approval for **one** print or feed. The fixture's
288 rows plus 80 clearance dots use about 46 mm at nominal 203 dpi.
Only for that approved operation:

```sh
"$BIN" print examples/test-pattern.png \
  --device YOUR-DISCOVERED-UUID --confirm-paper
```

Inspect both border edges, all bands, upright readable text, bottom label, and
clearance. Nominal paper use is not a measurement. Neither a dry run, setup
approval, nor a previous successful print authorizes another physical action.

## Outcomes, deadlines, and errors

A submitted job has a 120-second overall deadline and a 10-second no-progress
deadline. Replies or post-submission observation have a 2-second window,
followed by a 2-second disconnect deadline. The observation delay is not raster
pacing or proof of completion.

`SUBMITTED ONLY` means local bytes were handed to CoreBluetooth and required
write-response callbacks completed. Without-response writes have no delivery
acknowledgment. Neither proves firmware receipt, motor completion, or paper
output. A disconnect, cancellation, stall, or write failure discards pending
work and returns nonzero. Partial paper is possible: **never automatically
retry**. The standalone CLI does not have the helper's durable receipt ledger.

Errors go to stderr with a stable bracketed code:

| Exit | Code / meaning |
|---|---|
| 2 | `invalid_input` or `invalid_image` |
| 3 | `bluetooth_denied`, `bluetooth_unavailable`, or `bluetooth_host_missing_description` |
| 4 | `printer_missing_or_offline` |
| 5 | `printer_ambiguous` |
| 6 | `paper_approval_required` |
| 7 | `connection_failed`, including service/notification readiness failure |
| 8 | `transfer_stalled` |
| 9 | `transfer_interrupted` |
| 10 | `status_unverified`: no model, firmware, or solicited paper value decoded |
| 130 | Task cancellation or process interrupt |
| 1 | Unexpected local error |

The CLI disables the upstream BLE file logger; existing logs are not removed.
There is no daemon, login item, firmware update, persistent settings change,
hidden feed, reconnect, or automatic replay.
