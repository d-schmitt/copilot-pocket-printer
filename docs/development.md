# Contributor checks and native probe

Start with the [demo](../README.md) for normal setup. Development apps under
`.build` are not the stable runtime: use the
[per-user installation](../bridge/README.md#setup-with-explicit-approval-gates)
for ordinary client registration.

## Toolchain compatibility

The package declares macOS 13 and Swift tools 5.9 as minima. That declaration
is not evidence that every older compiler can build the pinned dependency.
Use a toolchain verified for the chosen source revision.

The renderer's [passing hosted offline checks](https://github.com/d-schmitt/copilot-pocket-printer/actions/runs/43756968371)
use macOS 26 and Xcode 26.6 with Swift 6.3.3, including full XCTest and the
integrated installer suite. That result belongs to
[#13](https://github.com/d-schmitt/copilot-pocket-printer/pull/13), which is
still under review, not merged main. Its build recovery includes source-identical
entrypoint renames; an older compiler also hit a dependency type-checker limit.
Do not treat those passing branch checks as validation of main with that
toolchain, or mistake the earlier failures for a current CI blocker.

## Offline checks

In addition to the native toolchain, use Python 3 and Node 22+. Full Xcode
provides the XCTest runtime. Do not install system components without the
machine owner's approval. The first Swift build downloads the
[pinned dependency](architecture.md#reviewed-dependency-and-transport);
the checks below use no calendar, weather, Bluetooth, or paper.

From the repository root:

```sh
swift build
swift test
BIN_DIR="$(swift build --show-bin-path)"
"$BIN_DIR/printer-cli-checks"
"$BIN_DIR/printer-helper-checks"
"$BIN_DIR/printer-cli" --help
"$BIN_DIR/printer-cli" print examples/test-pattern.png --dry-run
"$BIN_DIR/printer-cli" feed 80 --dry-run
python3 scripts/smoke_test.py "$BIN_DIR/printer-cli"
HELPER_CHECKS_BIN="$BIN_DIR/printer-helper-checks" npm test --prefix bridge
python3 -m unittest discover -s scripts -p 'test_install_printer.py'
```

On a Command Line Tools-only installation, `swift test` may fail to import
`XCTest`. That is not a passing test run. The `printer-cli-checks` executable
needs no XCTest runtime and executes the same shared assertions as the XCTest
wrapper. Continue with the standalone checks when that runtime is unavailable;
record the limitation rather than installing Xcode implicitly.
For release coverage, repeat with `swift build -c release` and
`swift build -c release --show-bin-path` before running the executable checks.

The shared assertions cover parsing, ASCII transliteration, thresholding,
transparency, bit/row order, input limits, activation boundaries, 24-line bands,
credit classification, printer selection, metadata preflight, and the paper
approval gate. Inert transport tests cover notification readiness, synchronous
Combine delivery, status-only batches, unrelated battery drains, response
callbacks, deadlines, cancellation, and no replay.
The repair fork separately tests its additive-credit state and adapter wiring.

The probe checks cover user initiation, unlimited consent waiting, bounded
controller/scan timers, typed failures, repeat/cancel/close behavior, stale
callbacks, and UI state without native Bluetooth. Python smoke checks exercise
real process exit codes and file IO, including invalid input and guarded
physical commands, using the standard library.

The Node harness exercises child-process stdio initialization/list/call,
real macOS sockets and peer checks, and durable receipts across inert helper
restarts. Its explicitly fake executor cannot access Bluetooth. Installer tests
use workspace-local fixtures, paths with spaces, source removal, no-op/update
cases, running-target/collision/symlink refusals, and failure preservation.
They mock signatures for non-executable fixtures, but use the real Node bridge
and macOS atomic rename.

Actual staging additionally verifies the copied app with `codesign` and
`otool`, then initializes/lists the bridge from an unrelated cwd without calling
helper tools. None of these tests proves registered-client exposure, retained
Bluetooth permission, radio delivery, or paper output. Those need separately
authorized observations; see [evidence boundaries](architecture.md#verification-boundaries).

## Build a helper without activation

```sh
python3 scripts/build_printer_helper.py --stage
```

The output is `.build/staged/Pocket Printer Helper.app`. The script checks for
a running target, builds release Swift code, copies the real bundle metadata,
rejects non-system dynamic libraries, and ad-hoc signs/verifies the app.
It does not launch, install, register MCP, or access Bluetooth.
The installer reuses this staging path. Without `--stage`, the development
builder writes `.build/Pocket Printer Helper.app` and refuses while any helper
process is running. Neither path replaces ordinary setup approval.

## Scan-only permission probe

The probe is a contributor diagnostic, **not a prerequisite for the demo**.
Its target depends only on discovery state and UI, not the printer library
or CLI. It cannot connect, query, feed, or print.

Build without launching:

```sh
python3 scripts/build_permission_probe.py
```

The fixed output is `.build/Pocket Printer Probe.app`. The script refuses while
a `permission-probe` process is running, copies the release executable and real
`Contents/Info.plist`, verifies system-only linked libraries, and ad-hoc
signs/verifies the bundle. It does not install, launch, create certificates, or
change system policy. This is a local-architecture build, not a notarized release.

Its bundle ID is `io.github.copilot-pocket-printer.permission-probe`; metadata
includes `NSBluetoothAlwaysUsageDescription`. Signature inspection and a detached
AppKit view render are offline evidence, not launch or discovery evidence.
An ad-hoc CDHash-based designated requirement does not guarantee stable TCC
permission across changed rebuilds.

For a separately approved probe run:

1. Independently open the app in Finder. Do not launch the executable through
   an AI host, MCP, or shell. Initially it should be idle without requesting
   Bluetooth. Respect a Gatekeeper block; do not remove quarantine attributes.
2. With the printer nearby, press **Scan nearby printers** once. Approve only
   an ordinary prompt naming **Pocket Printer Probe**. Stop on another owner.
3. Observe the prompt name, displayed state, and matching entry under
   **System Settings > Privacy & Security > Bluetooth**. Keep discovered UUIDs
   private. Do not reset TCC, change unrelated toggles, or bypass a denial.

Pending consent has no deadline and can be cancelled or closed. After permission
is known, controller startup is bounded to 10 seconds; a powered-on controller
scans for 8 seconds, stops, and releases its manager. It retains at most 32 exact
`Mini Pocket Printer_BLE` matches. Advertisement discovery is neither model
verification nor paper readiness.

Denied, restricted, Bluetooth-off, unsupported, startup timeout, and
no-advertisement timeout are distinct states. There is no automatic scan,
polling, reconnect, or retry. Observed repeat scan/quit and changed-build
reauthorization do not establish long-term permission retention or every UI
cancellation behavior. Probe success never authorizes a later print.
