# Chat-to-print V2

Describe text or a checklist in normal Copilot chat. The agent sends a bounded
document to the canvas; the existing offline renderer wraps it at readable,
fixed sizes. Ask in chat for revisions. There is no second chat, content form,
external generation service, HTML renderer or daily-card field mapping.

V2 is an **additional, separately installed surface**. The V1 entrypoint, open
panels, saved drafts and helper are not replaced. Source modules live alongside
V1 to reuse its renderer, discovery, loopback protections and printing code.
The V2 entrypoint is packaged as `extension.mjs` only in the dedicated package.

## Stage and activate

```sh
python3 scripts/install_canvas.py --v2
```

Staging builds a standalone release renderer and verifies initial content and a
revision without any helper, Bluetooth or paper access. The package under
`.build/canvas-installation/pocket-printer-chat/` contains all runtime files and
has no dependency on this checkout's location. It installs alongside, not over,
`pocket-printer-preview`.

**Obtain explicit approval before installation or extension reload.** Reloading
providers can interrupt open panels, including V1. Preserve unsaved V1 work first.
After approval, use the app's Copilot home, not a separately configured CLI home:

```sh
python3 scripts/install_canvas.py --v2 --install
```

Then reload extensions in the destination Project chat. No helper update is
required by V2. If the existing helper reports a missing capability, stop and
request separate approval; do not silently replace or launch it.

Expected provider: `user:pocket-printer-chat`.
Canvas type: `pocket-printer-chat`. A fresh, unique instance handle names the
panel, not its persistent content. There is no new V1-shadowing project extension.

## Agent interaction

Discover `pocket-printer-chat` with `list_canvas_capabilities`, then open:

```json
{"canvasId":"pocket-printer-chat","instanceId":"walk-preview","input":{"documentId":"weekend-walk"}}
```

`documentId` is a stable agent-chosen lowercase name, 1-64 letters, digits or
hyphens, beginning with a letter or digit. It is not a printer UUID.
Reusing it resumes the same document, including across providers or panels.
Use a distinct name for unrelated content.

Call `get_document` with `{}` and use its current `revision`:

```json
{
  "instanceId": "walk-preview",
  "actionName": "update_document",
  "input": {
    "revision": 1,
    "document": {
      "version": 1,
      "blocks": [
        {"kind":"heading","text":"WEEKEND WALK"},
        {"kind":"text","text":"Meet by the stone bridge at ten."},
        {"kind":"checklist","items":[
          {"text":"Water bottle","checked":false},
          {"text":"Comfortable shoes","checked":true}
        ]}
      ]
    }
  }
}
```

To revise, call `get_document`, then `update_document` on the **same instance**
with the returned revision and complete replacement document. The canvas updates
automatically. Preserve the user's content; do not summarize, crop or shrink it
to fit. The schema accepts only headings, text and checklist items with explicit
boolean `checked`. It rejects extra fields.

Other read-only actions: `get_print_status` with `{"jobId":"<retained UUID>"}`
and `list_prints` with `{}`. **There is no agent-facing print action or approval
token.** Never use shell/HTTP access to simulate the user's Print click.

## Preview and printing

There is exactly one image region. Before inspection it is clearly labelled
**Draft preview**, not print-ready. The user chooses **Find printer**, explicitly
selects a discovered device, and waits for discovery to finish. No scan or
printer selection occurs on open or chat update.

The helper's exact inspected bitmap replaces the draft in that same region.
Print stays disabled until that image loads. Estimated length follows the
existing 203-dpi convention, including 80 dots of feed:
`(height + 80) / 203 * 25.4` mm. Physical length is approximate.

The user's trusted **Print** click submits the inspected image to the selected
printer once. Existing independent helper launch and native opt-in are unchanged.
Native confirmation mode still requires its helper approval. Transport submission
is not proof of paper output. Use **Check print status** for the original job;
never automatically retry or replace an uncertain job.

The existing global print-intent directory and content/target/mode identity are
shared with V1. Document revisions are private records under the existing canvas
store's `chat-documents/<documentId>/document.json`, protected by per-document
locks through print admission. This prevents a second provider from editing
content between revision validation and durable dispatch claim. Images,
selection and approval are deliberately not restored after provider restart.
Rejected content invalidates the previous printable revision across panels.
No drafts, claims or receipts are automatically deleted.

## Bounds and recovery

- 1-64 document blocks, 1-64 items per checklist, at most 128 rendered text blocks.
- Nonblank text: up to 4096 UTF-8 bytes per heading/paragraph, 4092 per checklist
  item before its `[ ] ` or `[x] ` marker; 60 KiB total document/template.
- Existing transliteration is preserved: German transliteration and diacritic
  folding; unsupported characters become `?`. No new Unicode font assumptions.
- Fixed 24-dot headings and 18-dot body text; no fit-to-page shrinking. V2 uses
  the existing renderer's 18-dot preset because synthetic native-resolution
  inspection showed more readable thin strokes than its 16-dot body preset.
- Exactly 384 dots wide, height 1-4096, PNG at most 1 MiB. Long words and
  excess height produce actionable errors rather than clipping or extra prints.

If content is too long, ask the user to reduce it. If the helper is unavailable,
open it independently and choose **Refresh preview**. A stale revision requires
`get_document` before updating. An interrupted storage lock or unresolved print
claim fails closed; inspect the original state rather than deleting it.

## Paper-free verification

```sh
swift build --product card-renderer
swift build --product card-renderer-checks
.build/debug/card-renderer-checks
node --test .github/extensions/pocket-printer-preview/test/*.test.mjs
python3 scripts/test_install_canvas.py
```

Tests use private temporary stores and inert helpers. They cover same-panel
initial/revised content, persistence, limits, stale render/approval, exact image
load, trusted click, cross-provider document locking, V1/V2 shared dispatch
identity and standalone packaging. Actual app discovery/open/action validation
requires installation/reload approval; direct factory tests are not proof that
the canvas is registered in the current Project.
