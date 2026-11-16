# Read-only Pocket Printer canvas

This is the small [canvas v0 increment (#16)](https://github.com/d-schmitt/copilot-pocket-printer/issues/16),
not the full [canvas tracker (#1)](https://github.com/d-schmitt/copilot-pocket-printer/issues/1).
It displays the original PNG bytes, dimensions and **estimated** paper length.
It has no helper dependency, printer target, Bluetooth access, print button,
source acquisition, generation, settings or automation. The CLI and MCP remain
independently usable and unchanged.

## Setup and short demo

The reusable extension source lives in
`.github/extensions/pocket-printer-preview/`. It was bootstrapped with the
installed Copilot canvas scaffold and SDK guide. Use a Copilot app/runtime
with extension canvases and Node 22+. The SDK is supplied by Copilot, not npm.
No Swift build, native helper, printer or MCP registration is needed.

**Activation requires separate approval.** Review the source and approve
loading this repository-scoped extension before opening the checkout in a
runtime that auto-discovers project extensions, or asking Copilot to reload
extensions in an existing session. Do not copy it to a user-global or session
extension directory implicitly. Project scope makes it available in sessions
for this checkout; it does not install a global printer integration.

After approval, ask Copilot:

> Reload extensions and inspect pocket-printer-preview. Discover the
> pocket-printer-preview canvas and open it as demo-card with empty input.
> Do not use any printer or helper tools.

The initial card is the bundled **synthetic** 384 x 288 test pattern, copied
byte-for-byte from `examples/test-pattern.png`. At a panel width of about
450 pixels or more, the entire card width is visible. Narrower panels scroll
horizontally rather than shrinking the image. Long cards scroll vertically.
One image pixel is one CSS pixel; device pixel density and app zoom still apply.

Choose **Replace with a local PNG** and select a synthetic file. Alternatively,
explicitly supply its absolute path and ask Copilot to invoke `replace_png`
with `{"path": "/absolute/path/to/synthetic-card.png"}` on `demo-card`.
The supported agent actions are `get_preview`, `replace_png`, and
`reset_sample`. Open takes only `{}`: it cannot persist a private filename
as an automatic restore input.

Verify that dimensions and paper estimate change with the new image. Try a
wrong-width, malformed or oversized file: an error appears and the previous
valid image remains visibly labelled. A nonexistent or unreadable path
likewise produces both an action error and a visible panel error.
Use `reset_sample` to discard the local image. Close the panel when finished;
opening a fresh panel starts with the synthetic sample again.

The estimate is `(height + 80) / 203 * 25.4` mm, matching the helper's nominal
203 dpi and 80 clearance dots. It is not measured paper consumption and does
not imply approval or printing. This preview is the original image, **not**
the helper's thresholded black/white printer bitmap.

## Input and privacy boundaries

PNG input is bounded to **1 MiB, exactly 384 pixels wide, 1-4096 pixels tall**.
The validator checks chunk boundaries and CRCs, header encodings, critical
chunks, palette/transparency structure, image chunk order, decompression size,
row filters and end-of-file. Standard PNG color/bit-depth encodings and Adam7
scanlines are supported; animated PNG is explicitly rejected. The browser
also reports decoding failures rather than silently showing a broken image.
The original bytes are served unchanged; this does not promise identical
browser color management to the native rasterizer.

Agent paths must be absolute, readable regular files. Final-component symlinks
are rejected, special files do not block, and reads are bounded even if a file
grows. The file picker transfers only the selected file. There is no directory
browsing, cache discovery, remote URL fetch or HTTP file-path endpoint.

One in-memory snapshot belongs to each panel, with at most four panels per
provider. Refreshing the iframe retains that snapshot without re-reading the
file. Closing the panel releases it and closes its loopback server. Provider
reload/restart restores only the synthetic sample, never a private image.
No image files, filenames, history or image bytes in action results are saved
by the extension. Copilot may retain explicitly supplied paths in the chat/tool
transcript, and the OS/browser can retain process memory; this is not secure
erasure or a promise about host-level retention.

The loopback-only server uses an unguessable per-panel URL, exact Host/Origin
checks, same-origin authenticated uploads, bounded request bytes/time and
connections, no permissive CORS, no-store responses, and a restrictive CSP.
GET only reads assets/current state; the only mutation is PNG replacement.
There is no helper IPC or general RPC proxy. The capability URL is sensitive
while the panel is open; this is not isolation from other same-user processes.

## Offline checks

```sh
node --test .github/extensions/pocket-printer-preview/test/*.test.mjs
```

The standard `scripts/checks.sh` also runs these tests. They cover original
byte preservation, exact limits, corrupt input, file-access failures, visible
error state, HTTP authentication/bounds, panel isolation, concurrent opens and
close/restart cleanup. Socket/process tripwires exercise open, replacement,
refresh, reset, close and provider restart; runtime imports are restricted to
the SDK and local preview modules/Node built-ins, with no bridge/native imports.
All fixtures are synthetic. These tests are not evidence of actual Copilot
discovery or visual rendering.

For app validation after approval, verify extension list/inspect, canvas
capabilities, open and all three actions. Invalid open input should return
`canvas_input_invalid`; reserved action `canvas.open` should be rejected.
Visually inspect the card, replace it, trigger an error, reload the extension
and close/reopen the panel. Capture only synthetic content. Record the actual
runtime outcome separately from offline checks in the issue handoff.
