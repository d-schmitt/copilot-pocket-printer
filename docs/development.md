# Contributor checks and native probe

Start with the [demo](../README.md) for normal setup. Development apps under
`.build` are not the stable runtime: use the
[per-user installation](../bridge/README.md#setup-with-explicit-approval-gates)
for ordinary client registration.

## Toolchain compatibility

The package declares macOS 13 and Swift tools 5.9 as minima. That declaration
is not evidence that every older compiler can build the pinned dependency.
Use a toolchain verified for the chosen source revision.

[PR CI](../.github/workflows/ci.yml) pins macOS 26 and Xcode 26.6 with Swift
6.3.3. The merged renderer's [hosted checks](https://github.com/d-schmitt/copilot-pocket-printer/actions/runs/43756968371)
passed on that toolchain with full XCTest and integrated installer coverage.
Check the current revision's **Offline checks** result rather than treating
that historical pass as validation of subsequent changes.

The multi-file `PermissionProbe` and `PrinterHelper` targets keep their `@main`
types in named application files, not the special `main.swift` filename.
Swift 6.1 otherwise treats that file as a top-level entrypoint and rejects the
additional `@main`. Xcode 16.4/Swift 6.1 and Xcode 26.3/Swift 6.2 also exhausted
their type checkers on the pinned dependency's `LuckPrinterCommands.setTimeFormat`
expression. The newer CI toolchain avoids patching dependency checkouts,
changing the verified revision, or relaxing compiler limits.

## Offline checks

In addition to the native toolchain, use Python 3.9+ and Node 22+. Full Xcode
provides the XCTest runtime. Do not install system components without the
machine owner's approval. The first Swift build downloads the
[pinned dependency](architecture.md#reviewed-dependency-and-transport);
the checks below use no calendar, weather, Bluetooth, or paper.

From the repository root, use the same entry point as CI:

```sh
bash scripts/checks.sh
```

This builds the package, runs Swift CLI/helper/card assertions, Python CLI/card
integration and installer safety tests, Node stdio/Unix-IPC and canvas editor tests, then
`swift test`. The CLI and card XCTest wrappers use the same shared assertions
as their standalone executables. No npm/Python packages or extra lint framework
are needed. For focused commands, see the [CLI](cli.md) and
[renderer checks](daily-card.md#offline-verification).
The [canvas checks](card-editor.md#focused-checks) use Node and the offline renderer;
they do not activate an extension or start the native helper.

On a Command Line Tools-only installation, XCTest may be unavailable. Use:

```sh
bash scripts/checks.sh --without-xctest
```

This explicitly reports XCTest as **not run** and runs all other suites.
It is not a complete CI pass. Do not install Xcode implicitly.
For release coverage, build with `swift build -c release` and obtain the
executable paths with `swift build -c release --show-bin-path`.

The shared assertions cover parsing, ASCII transliteration, thresholding,
transparency, bit/row order, input limits, activation boundaries, 24-line bands,
credit classification, printer selection, metadata preflight, and the paper
approval gate. Inert transport tests cover notification readiness, synchronous
Combine delivery, status-only batches, unrelated battery drains, response
callbacks, deadlines, cancellation, and no replay.
The repair fork separately tests its additive-credit state and adapter wiring.
Renderer checks cover layout/PNG bounds, compact fit/fallback, ASCII wrapping,
privacy sentinels, diagnostics, Sudoku uniqueness/difficulty, time/DST handling,
walk selection and provider failures using synthetic inputs, not live services.

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

## Hosted CI

[PR CI](../.github/workflows/ci.yml) runs on pull requests and pushes to main.
The stable check name is **Offline checks**; making it required is a separate
repository-rule decision. The job uses full Xcode 26.6, Node 24 and Python 3.13
on `macos-26`. External actions are pinned to release commits.

It has read-only contents permission, no retained checkout credentials, no
secrets, no `pull_request_target`, no deployment or artifact upload, a 20-minute
timeout, and cancellation of superseded runs. Build/runtime setup may download
dependencies, but tests do not call live calendar/weather services or Bluetooth.
Helper tests use isolated temporary stores and inert executors, never the running
user's helper or preferences; installer tests never install or launch the real app.

The [runner inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)
and pinned [checkout](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0), and
[setup-python](https://github.com/actions/setup-python/releases/tag/v7.1.0)
releases document the hosted environment. Local validation is not a hosted run.

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
