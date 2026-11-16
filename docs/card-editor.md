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
