# Pocket Card Editor

The optional `pocket-printer-editor` canvas starts with a populated synthetic
card. Edit the title, name and section text; choose a joke, easy/medium Sudoku
or garden art; toggle sections and drag whole section headings vertically.
Up/Down buttons provide the same ordering operation without dragging.
This is not a freeform layout designer and it fetches no live source data.

The editor uses the existing renderer and its 384-pixel layout, typography,
Sudoku generation and PNG limits. Build it from the checkout root:

```sh
swift build --product card-renderer
```

The extension invokes only that fixed offline renderer executable, with a
bounded template on stdin and a temporary output inside a private directory.
It does not build, install or launch the native helper. Rendering failures
remove the current printable preview rather than passing off old pixels as
the current draft. A late render cannot replace a newer edit.

After separately approving repository-extension activation, reload the
`pocket-printer-preview` extension and open canvas `pocket-printer-editor`
with empty input. Its SDK actions mirror the editor's draft operations.
The existing read-only PNG preview remains a separate canvas.

### Available in every Copilot chat

The project-scoped extension appears only in sessions for this repository.
For a standalone user-local copy, stage and verify first:

```sh
python3 scripts/install_canvas.py
```

After approving user-wide availability, install with:

```sh
python3 scripts/install_canvas.py --install
```

This copies the extension, assets, a standalone renderer and the IPC client into
`~/.copilot/extensions/pocket-printer-preview/` (or `$COPILOT_HOME/extensions/`
when configured). The installed copy has no executable, import or symlink back
to the checkout. It is not updated merely by editing repository source.
Unrecognized destinations or local user modifications are not overwritten.

Preserve unsaved drafts before reloading extensions in the destination chat.
Choose **Pocket Card Editor** from the canvas menu. The provider is
`user:pocket-printer-preview`; the canvas IDs remain `pocket-printer-editor`
and `pocket-printer-preview`. In this repository, the same-name project extension
shadows the user copy, so there is no duplicate provider in that session.
Both scopes use the same private draft and print-intent stores, preserving
cross-process duplicate protection rather than creating a second print history.
Installing availability never launches the helper, scans, or prints.

## Private drafts

Save and Save a copy explicitly store drafts under
`~/Library/Application Support/Copilot Pocket Printer Canvas/drafts/`.
Open saved draft explicitly lists and loads them. Nothing is saved in Git
or uploaded. The store is shared across this user's local Pocket Printer
sessions, capped at 20 drafts, with owned 0700 directories and 0600 records.
Concurrent changes to a saved draft fail with a conflict instead of
overwriting another panel's saved revision.

Each new panel starts with the synthetic example. Unsaved edits are discarded
on close or provider reload. Opening a saved draft replaces unsaved panel
edits; it never restores a print approval. Drafts are not encrypted by the
extension. OS backups and same-user programs remain outside this isolation.

No background private-history collection or automatic expiration occurs.
The storage cap is explicit; at the limit, update an existing draft rather
than silently dropping another one. Interrupted writes or an abandoned store
lock fail closed and need deliberate inspection rather than automatic lock
stealing.

## Focused checks

```sh
swift build --product card-renderer
node --test .github/extensions/pocket-printer-preview/test/*.test.mjs
```

Tests use synthetic content and isolated temporary stores. They exercise
field projection and ordering, actual rendering, both Sudoku difficulties,
overflow/invalid fields, stale responses, permissions, storage bounds,
conflicting saves and authenticated loopback endpoints.

## Printing from the canvas

Printing is a separately approved activation boundary, not a side effect of
editing. The canvas never launches the helper or initializes Bluetooth. Open
and authorize the helper independently using its existing setup. The helper
must advertise the atomic confirmation-mode guard; an older helper fails
closed with an upgrade message instead of falling back to an unsafe dispatch.

Choose **Scan for printers**, then select a result from the **Printer** list.
The native helper scans compatible advertisements for up to 10 seconds, with a
**Stop scan** control and visible permission, unavailable and failure states.
The first device is never selected automatically. Names, distinguishing ID
suffixes and signal readings help distinguish duplicate names; IDs remain
internal rather than requiring manual entry. Results and selection are panel-only.
There is no remembered-printer preference in this increment.

Discovery reuses the native printer transport, not Web Bluetooth. Only the known
`Mini Pocket Printer_BLE` advertisement is listed; this is not a list of every
macOS Bluetooth device or proof of a verified printer profile. The helper must
already be open and authorized with its native Bluetooth control. Discovery
never connects, sends commands, or prints. Scanning and print admission are
serialized; stopping does not release that guard until scanner cleanup finishes.
Closing the panel requests scan cancellation, and the native deadline also
bounds abandoned scans. Older helpers report that a separately approved update
is needed for discovery; the canvas does not silently reinstall or launch one.

After scanning stops and a printer is selected, the exact print preview is
prepared automatically after settled edits. Opening a fresh panel does not
contact the helper.
Use **Refresh print preview** after resolving an inspection error. Review the helper-produced bitmap,
target, revision, original-image digest, confirmation mode and estimated paper
length. The original renderer PNG and helper bitmap remain distinct.
The helper's controller state does not establish reachability or paper supply.

After reviewing the exact bitmap, click **Print** once. That click is the
per-job paper approval; no separate checkbox is required. Submission may start immediately when the
helper has explicitly opted into AI-client confirmations; native mode still
requires the helper's confirmation. The mode cannot change silently between
inspection and admission: canvas submissions include an optional expected mode
that the native service checks atomically before admitting a new job.
Existing CLI/MCP callers without this optional field retain their behavior.

Any draft or target change discards the panel approval. An older asynchronous
inspection cannot restore it. The print endpoint is not exposed as an SDK
action. The loopback URL and a per-inspection token bind browser confirmation
to the image/target/revision; they do not prove a human click or isolate the
canvas from malicious same-user software. The helper's existing trust model
and native-only recovery controls remain authoritative.

### Durable single-dispatch behavior

Private print intents are separate from editable drafts, under
`~/Library/Application Support/Copilot Pocket Printer Canvas/print-intents/`.
They retain the exact original PNG, helper bitmap, target, digest, initial
revision, expected mode and stable UUID. Owned 0700 directories and 0600
records are required. The store is limited to 64 intents, each at most 3 MiB
of serialized data, plus small dispatch/rejection records. No automatic
expiration or deletion occurs; reaching the limit fails closed. Find retained
job shows capacity and allows explicit confirmed deletion of an **unsubmitted**
intent only. Any dispatch claim permanently prevents deletion through the UI.
Automatic preview preparation can retain one intent for each distinct completed
image/target/mode; it never submits a job or retries a failed submission.

The same original-image digest, target and mode reuse one retained identity
across panels and provider restarts. A synced, create-only cross-process claim
must exist before native submission. Duplicate clicks/providers cannot dispatch
the same intent again. A lost reply, corrupt record or claim without a verifiable
receipt remains uncertain, never permission to retry or generate a replacement
UUID. Unknown/active/unacknowledged uncertain claims also block new intents and
jobs. The native helper still decides whether uncertainty can be acknowledged.

A correlated helper response explicitly rejecting a submission before admission
(for example busy or confirmation-mode changed) is distinct from a lost reply.
The canvas durably records that narrow, verified rejection, keeps its original
ID non-dispatchable, and does not block unrelated future jobs forever. Status
errors, storage failures and transport errors never establish non-admission.

Use **Check original job status** or **Find retained job** to query, not resend.
Provider restart does not restore any approval, reconnect automatically, submit
or replay. Closing the panel does not cancel an admitted native job.
`submitted_only` is a transport result, not proof of readable paper.

This conservative increment intentionally has no reprint/reset-claim button:
an already claimed identical image/target/mode remains status-only. Do not edit
or remove claims to force a retry. An abandoned store lock or unknown receipt
requires deliberate investigation, not automatic lock stealing or browser
recovery. Retention and any future deliberate-repeat workflow must preserve
the original single-dispatch evidence.
