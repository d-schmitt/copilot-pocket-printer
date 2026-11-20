# Chat-to-print V2

Start with **Daily card**, **Focus list** or **Vortragsnotiz** in the gallery. For Daily card and Focus list,
describe changes in normal Copilot chat. The agent sends a bounded
document to the canvas; the existing offline renderer wraps it at readable,
fixed sizes. Ask in chat for revisions. There is no second chat, content form,
external generation service or HTML renderer. Generic text/checklists are not
mapped into daily-card fields. An explicit original-daily-card document can reuse
that existing layout without changing the generic defaults. Selecting a card
hides the gallery; **Back to templates** returns to it. Reopening starts in the
gallery, with **Continue current card** for retained content.

Daily card starts with a clearly labelled synthetic example, using the original
meeting-time, sunrise/sunset, walk and joke composition. Chat can replace the
offline inputs and choose the existing Easy/Medium Sudoku instead of a joke.
Focus starts with exactly three empty numbered priority lines.
Surprise is no longer in the picker. Existing Surprise documents and snapshots
remain recoverable, and existing `request_template` callers can still select it.
Surprise draws an original classic-caption meme with a small printer doodle, or
a real seeded Sudoku with randomized Easy/Medium difficulty.

Surprise remains concealed until the user's **Reveal preview** click. Every
chat revision makes a fresh draw and hides it again, including an unchanged
message. Returning to the gallery or reopening also requires reveal again,
but preserves the stored draw. Nothing is printed by revealing.

Vortragsnotiz is a scripted stage cue, not a note-taking service.
**Notizen gebündelt.** is fixed demo copy; no notes, calendar, customer data or
other inputs are retrieved or processed, and no wait or external work is
simulated. The selected magician illustration is a cover only. The fixed paper
artwork cannot be changed through `update_document`; use `request_template`
with `template: "vortragsnotiz"` to select it.

The paper raster uses GitHub's official [Primer Octicons mark](https://github.com/primer/octicons/blob/e6626e159c4ba786d512e252182b62617014c752/icons/mark-github-24.svg)
in black on white, aspect ratio preserved, above a separate plain-text caption.
The [MIT notice](../.github/extensions/pocket-printer-preview/octicons-license.txt)
ships with the staged bundle. The mark remains a GitHub trademark; the
[GitHub usage guidelines](https://brand.github.com/foundations/logo#legal)
apply separately. The demo caption is not a custom or official product logo.
Verify applicable trademark permissions before public use or distribution.

Changing templates only asks for confirmation when the current card contains
chat-provided or chat-edited content. The choices are **Save as draft**,
**Replace without saving** and **Cancel**. Untouched/generated template cards
switch directly. Legacy V2 content is conservatively considered customized.
The replacement question is bound to the current revision; a concurrent edit
invalidates it. Saved snapshots are private and recoverable through chat,
not a new draft-library UI.

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

Opening from the app's canvas picker needs no input: omitted input, `null` or
`{}` uses the existing `project-chat-v2` document. An explicit `documentId`
remains validated and selects a separate document.

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
to fit. The generic schema accepts only headings, text and checklist items with
explicit boolean `checked`. It rejects extra fields.

The additional `update_document` shapes are:

```json
{"version":1,"layout":"focus","priorities":["First priority","",""]}
```

```json
{"version":1,"layout":"surprise","message":"An optional short personal note"}
```

Focus requires exactly three strings. A blank string keeps an empty line.
Each priority and the optional Surprise message is a single line of at most
512 UTF-8 bytes. Text wraps without shrinking; overlong unbroken words fail
explicitly. A Surprise note is retained in the printed card, not silently
substituted for the random draw. Seeds are server-generated and retained with
the document, not accepted from chat for this variant.

`request_template` takes `{"revision":N,"template":"daily"|"focus"|"surprise"}`.
Use it before changing document variants. It either selects a generated card
or returns `flow.pendingReplacement`; stop and let the user answer in the
canvas. `update_document` cannot bypass the customized-content replacement
question. All chat updates mark content as customized; generated defaults do
not. Re-selecting the active template resumes it without erasing its contents.

`list_saved_documents` with `{}` returns saved IDs, templates and revisions.
`open_saved_document` takes `{"revision":N,"savedId":"<returned UUID>"}` and uses
the same guarded replacement flow. Snapshots retain their draw and provenance,
never a selection or approval. Up to 20 snapshots per document are retained;
a failed/full save leaves the current document intact. No automatic deletion.
There is no SDK action to resolve a replacement, reveal Surprise or print.

Other read-only actions: `get_print_status` with `{"jobId":"<retained UUID>"}`
and `list_prints` with `{}`. **There is no agent-facing print action or approval
token.** Never use shell/HTTP access to simulate the user's Print click.

### Original daily-card layout

When the user asks for the original daily card, use the same `update_document`
action with this alternate document shape, not an approximation made of generic
heading blocks:

```json
{
  "version": 1,
  "layout": "daily-card",
  "config": {
    "location": "Friedrichshafen",
    "latitude": 47.65,
    "longitude": 9.48,
    "timezone": "Europe/Berlin",
    "work_start": "08:00",
    "work_end": "17:00",
    "lunch_start": "12:00",
    "lunch_end": "13:00"
  },
  "date": "2026-11-17",
  "now": "2026-11-17T06:00:00+01:00",
  "calendar": {"state":"unavailable"},
  "weather": {"state":"unavailable"},
  "bottom": "joke",
  "seed": 17,
  "synthetic": true
}
```

For available calendar data, supply
`{"state":"available","events":[{"start":"<ISO instant>","end":"<ISO instant>"}]}`.
Only timing fields are accepted, at most 500 intervals. For available weather,
supply `{"state":"available","sunrise":"<ISO instant>","sunset":"<ISO instant>",
"hours":[{"start":"<ISO instant>","cloud":10,"precipitation":0}]}` with at most
26 numeric hourly observations. Timestamps require seconds and an explicit
offset. Missing observations remain honestly unavailable, not zero or sunny.
Never insert private calendar titles, provider URLs or fetched HTML.

The adapter calls the original `daily_card.template.template` and validated
offline model, then passes its unmodified output to the existing renderer.
It preserves the original 24-dot title, 18-dot section headings, 16-dot body,
13-dot annotations, separator rules, aligned header and measured compact rows.
`bottom` is `joke`, `sudoku-easy` or `sudoku-medium`; Sudoku uses the existing
seeded generator, not a text approximation. There is no content-editing form.
Rendering is bounded by the same height and PNG limits, with no cropping.

This optional path needs Python 3.9+ with standard-library timezone support.
The standalone V2 package includes only the original offline model, template,
package initializer and bounded stdin adapter. It excludes the provider module
and network-capable CLI. Python runs in isolated mode with a fixed import root;
it never scans or prints. Generic text/checklists do not invoke Python.

## Preview and printing

There is exactly one image region. Before inspection it is clearly labelled
**Draft preview**, not print-ready. The user chooses **Find printer**, explicitly
selects a discovered device, and waits for discovery to finish. No scan or
printer selection occurs on open or chat update.

The helper's exact inspected bitmap replaces the draft in that same region.
Print stays disabled until that image loads. Estimated length follows the
existing 203-dpi convention, including 80 dots of feed:
`(height + 80) / 203 * 25.4` mm. Physical length is approximate.

Gallery, replacement-question and concealed-Surprise states serve neither the
draft nor inspected image, and invalidate print approval. For ordinary cards
the canvas requires the exact inspected image to load before enabling Print.
A late image load, render or poll cannot restore approval for hidden or revised
content.

Vortragsnotiz is the only exception: the trusted **Notiz ohne Vorschau drucken**
click approves the inspected, digest-pinned 384-dot raster for the explicit
target. The canvas only serves the cover; neither image endpoint serves the
artwork, even after submission. The private helper inspection, job identity,
durable claim and confirmation policy are unchanged. The native helper displays
the active job bitmap in its own window after admission, including potentially
while an AI-client-mode job runs. Do not share the helper window or the full
desktop if the reveal must stay off-screen. Native mode still explicitly asks
for approval there; AI-client mode requires an existing opt-in.

The fixed raster follows the existing at-most-once ledger key (payload,
selected printer and confirmation mode). Reopening the template or switching
cards does not create a fresh job for the same key. Check the original job
instead of attempting to replay it.

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
Schema-rejected edits retain the last valid document for recovery and guarded
saving, with an explicit error and no printable image. They do not clear its
customized status or bypass the replacement question.
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

Gallery regressions additionally cover generated/customized provenance,
save/replace/cancel, failed saves, stale replacement decisions, retained
Surprise draws, re-reveal on edit/reopen, hidden image endpoints, and exact-image
load after reveal. All renderer examples and browser mockups use synthetic data.

Daily-layout regressions compare PNG bytes against the original Python template
for identical synthetic inputs, including joke and both Sudoku difficulties,
and verify that invalid daily data invalidates old print approval. Updating the
daily document does not modify other saved sample documents.
