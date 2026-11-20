#!/usr/bin/env python3
"""Stage a standalone canvas; install user-wide only with --install."""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

from install_printer import InstallError, command, inventory, publish, safe_path

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAME = "pocket-printer-preview"
V2_NAME = "pocket-printer-chat"
MANIFEST = ".pocket-canvas-install.json"
FILES = ("extension.mjs", "editor.mjs", "editor.js", "editor.html", "editor.css",
         "draft.mjs", "private-store.mjs", "printing.mjs", "loopback.mjs",
         "png.mjs", "view.css")
V2_FILES = ("editor.mjs", "draft.mjs", "private-store.mjs", "printing.mjs", "loopback.mjs",
            "png.mjs", "document.mjs", "daily-document.mjs", "templates.mjs", "chat.mjs", "chat.js", "chat.html", "chat.css")
DAILY_FILES = ("__init__.py", "model.py", "template.py", "canvas.py")
RELOCATIONS = {
    "draft.mjs": ("../../../.build/debug/card-renderer", "./runtime/card-renderer"),
    "printing.mjs": ("../../../bridge/ipc.mjs", "./runtime/ipc.mjs"),
}


def ensure_staging_is_separate(target, extensions):
    for name in (NAME, V2_NAME):
        destination = extensions / name
        if target == destination or target in destination.parents or destination in target.parents:
            raise InstallError("Staging must not overlap either user installation. Use --install explicitly.")


def managed(target, name=NAME):
    safe_path(target)
    if not target.exists():
        return None
    entries = inventory(target)
    marker = target / MANIFEST
    if not marker.is_file() or marker.stat().st_size > 64 * 1024:
        raise InstallError("Refusing to overwrite an unrelated canvas extension.")
    try:
        saved = json.loads(marker.read_text())
    except (ValueError, UnicodeError) as error:
        raise InstallError("Canvas installation manifest is invalid.") from error
    entries.pop(MANIFEST)
    if (not isinstance(saved, dict) or set(saved) != {"format", "extension", "entries"} or
            saved["format"] != 1 or saved["extension"] != name or saved["entries"] != entries):
        raise InstallError("The installed canvas has user changes or an invalid manifest. Nothing was replaced.")
    return saved


def verify(target, node, v2=False):
    for file in target.rglob("*.mjs"):
        command(node, "--check", str(file))
    for file in target.glob("*.js"):
        command(node, "--check", str(file))
    renderer = target / "runtime/card-renderer"
    command("/usr/bin/codesign", "--verify", "--strict", str(renderer))
    links = command("/usr/bin/otool", "-L", str(renderer)).splitlines()
    if len(links) < 2 or any(not line.strip().startswith(("/System/Library/", "/usr/lib/")) for line in links[1:]):
        raise InstallError("Renderer has non-system dependencies and is not standalone.")
    script = """
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const base = pathToFileURL(process.argv[1] + '/');
      const { editorCanvas } = await import(new URL('editor.mjs', base));
      const { Printing } = await import(new URL('printing.mjs', base));
      let helperCalls = 0;
      const editor = editorCanvas(undefined, { printing: () => new Printing({ helper: async () => {
        helperCalls++; throw new Error('Standalone verification must not contact the helper');
      } }) });
      const context = { instanceId: 'offline-install-check', input: {} };
      try {
        const panel = await editor.open(context);
        const state = await (await fetch(panel.url + 'state')).json();
        assert.equal(state.error, null);
        assert.equal(state.image.width, 384);
        for (const asset of ['', 'editor.js', 'editor.css', 'view.css']) {
          assert.equal((await fetch(panel.url + asset)).status, 200, 'Missing editor asset: ' + asset);
        }
        const action = editor.actions.find(value => value.name === 'update_draft');
        const changed = await action.handler({ ...context, input: { revision: state.revision,
          draft: { ...state.draft, bottom: 'sudoku', order: [...state.draft.order].reverse() } } });
        assert.equal(changed.error, null);
        assert.equal(changed.renderedRevision, changed.revision);
        assert.equal((await fetch(panel.url + 'image.png?revision=' + changed.revision)).status, 200);
      } finally { await editor.onClose(context); }
      assert.equal(helperCalls, 0);
      console.log('Standalone editor/render verified; no helper, BLE, storage or paper access.');
    """
    if v2:
        script = """
          import assert from 'node:assert/strict';
          import { pathToFileURL } from 'node:url';
          const base = pathToFileURL(process.argv[1] + '/');
          const { chatCanvas } = await import(new URL('chat.mjs', base));
          const { documentStore } = await import(new URL('document.mjs', base));
          const { Printing } = await import(new URL('printing.mjs', base));
          let helperCalls = 0;
          const canvas = chatCanvas(undefined, {
            documents: documentStore('offline-install-check', process.argv[2] + '/private'),
            printing: () => new Printing({ helper: async () => {
              helperCalls++; throw new Error('Standalone verification must not contact the helper');
            } })
          });
          const ctx = { instanceId: 'offline-install-check', input: { documentId: 'offline-install-check' } };
          try {
            const panel = await canvas.open(ctx);
            const get = () => canvas.actions.find(a => a.name === 'get_document').handler({ ...ctx, input: {} });
            let state = await get();
            assert.equal(state.document, null);
            const action = canvas.actions.find(a => a.name === 'update_document');
            for (const text of ['Synthetic packing list', 'Revised synthetic packing list']) {
              state = await action.handler({ ...ctx, input: { revision: state.revision,
                document: { version: 1, blocks: [{ kind: 'heading', text },
                  { kind: 'checklist', items: [{ text: 'Water bottle', checked: false }] }] } } });
              assert.equal(state.error, null);
              assert.equal(state.image.width, 384);
              assert.equal(state.renderedRevision, state.revision);
              assert.equal(state.prepared, null);
            }
            state = await canvas.actions.find(a => a.name === 'request_template').handler({
              ...ctx, input: { revision: state.revision, template: 'daily' }
            });
            assert.ok(state.flow.pendingReplacement);
            const replacement = await fetch(panel.url + 'resolve_replacement', {
              method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(panel.url).origin },
              body: JSON.stringify({ requestId: state.flow.pendingReplacement.requestId, decision: 'replace' })
            });
            assert.equal(replacement.status, 200);
            state = await replacement.json();
            for (const bottom of ['joke', 'sudoku-easy']) {
              state = await action.handler({ ...ctx, input: { revision: state.revision, document: {
                version: 1, layout: 'daily-card', config: {
                  location: 'Sampletown', latitude: 0, longitude: 0, timezone: 'Europe/Berlin',
                  work_start: '08:00', work_end: '17:00', lunch_start: '12:00', lunch_end: '13:00'
                }, date: '2026-11-17', now: '2026-11-17T06:00:00+01:00',
                calendar: { state: 'unavailable' }, weather: { state: 'unavailable' },
                bottom, seed: 17, synthetic: true
              } } });
              assert.equal(state.error, null);
              assert.equal(state.image.width, 384);
              assert.equal(state.renderedRevision, state.revision);
              assert.equal(state.prepared, null);
            }
            for (const asset of ['', 'chat.js', 'chat.css', 'image.png?revision=' + state.revision]) {
              assert.equal((await fetch(panel.url + asset)).status, 200, 'Missing chat asset: ' + asset);
            }
          } finally { await canvas.onClose(ctx); }
          assert.equal(helperCalls, 0);
          console.log('Standalone V2 initial/revised document verified; no helper, BLE or paper access.');
        """
    with tempfile.TemporaryDirectory(prefix="canvas-check-", dir=target.parent.parent) as cwd:
        return command(node, "--input-type=module", "-e", script, str(target), cwd, cwd=cwd).strip()


def package(source, renderer, ipc, target, node, v2=False):
    for path in (source, renderer, ipc, target):
        safe_path(path)
    inventory(source)
    for path in (renderer, ipc):
        if not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
            raise InstallError("Runtime source must be an owned, non-writable regular file.")
    name = V2_NAME if v2 else NAME
    previous = managed(target, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_path(target.parent)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".canvas-install-", dir=target.parent))
    try:
        candidate = temporary / name
        candidate.mkdir(mode=0o700)
        for file in V2_FILES if v2 else FILES:
            path = safe_path(source / file)
            shutil.copy2(path, candidate / file)
        if v2:
            shutil.copy2(safe_path(source / "chat-extension.mjs"), candidate / "extension.mjs")
        for file, (old, new) in RELOCATIONS.items():
            path = candidate / file
            text = path.read_text()
            if text.count(old) != 1:
                raise InstallError(f"Canvas relocation contract changed in {file}; nothing was installed.")
            path.write_text(text.replace(old, new))
        if v2:
            path = candidate / "daily-document.mjs"
            text = path.read_text()
            old = "new URL('../../../', import.meta.url)"
            if text.count(old) != 1:
                raise InstallError("Daily-card relocation contract changed; nothing was installed.")
            path.write_text(text.replace(old, "new URL('./runtime/', import.meta.url)"))
        runtime = candidate / "runtime"
        runtime.mkdir(mode=0o700)
        shutil.copy2(renderer, runtime / "card-renderer")
        shutil.copy2(ipc, runtime / "ipc.mjs")
        if v2:
            daily = runtime / "daily_card"
            daily.mkdir(mode=0o700)
            for file in DAILY_FILES:
                shutil.copy2(safe_path(ROOT / "daily_card" / file), daily / file)
        verify(candidate, node, v2=v2)
        saved = {"format": 1, "extension": name, "entries": inventory(candidate)}
        (candidate / MANIFEST).write_text(json.dumps(saved, indent=2, sort_keys=True) + "\n")
        (candidate / MANIFEST).chmod(0o600)
        if managed(target, name) != previous:
            raise InstallError("Destination changed during preparation. Nothing was replaced.")
        if previous == saved:
            return "Unchanged"
        publish(candidate, target, previous is not None)
        return "Updated" if previous is not None else "Created"
    finally:
        # This private preparation folder contains only this invocation's candidate or verified old copy.
        shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true", help="Install into the user's Copilot extensions directory")
    mode.add_argument("--stage-root", type=pathlib.Path, help="Absolute staging parent")
    parser.add_argument("--renderer", type=pathlib.Path, help="Existing standalone release renderer; otherwise build it")
    parser.add_argument("--v2", action="store_true", help="Package chat-to-print alongside V1, never replacing it")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        raise InstallError("Run as a normal macOS user, never with sudo.")
    node = shutil.which("node")
    if not node or int(command(node, "--version").strip().lstrip("v").split(".")[0]) < 22:
        raise InstallError("Node 22 or later is required.")
    name = V2_NAME if args.v2 else NAME
    extensions = pathlib.Path(os.environ.get("COPILOT_HOME", str(pathlib.Path.home() / ".copilot"))) / "extensions"
    destination = extensions / name
    target = destination if args.install else (args.stage_root or ROOT / ".build/canvas-installation") / name
    if not args.install:
        ensure_staging_is_separate(target, extensions)
    renderer = args.renderer
    if renderer is None:
        subprocess.run(["swift", "build", "-c", "release", "--product", "card-renderer", "-q"],
                       cwd=ROOT, check=True, timeout=600)
        binary_dir = subprocess.run(["swift", "build", "-c", "release", "--show-bin-path"],
                                    cwd=ROOT, check=True, capture_output=True, text=True, timeout=60).stdout.strip()
        renderer = pathlib.Path(binary_dir) / "card-renderer"
    result = package(ROOT / ".github/extensions" / NAME, renderer, ROOT / "bridge/ipc.mjs", target, node, v2=args.v2)
    print(f"{result}: {target}")
    print(verify(target, node, v2=args.v2))
    print("User-local files installed; reload in the destination chat after preserving any unsaved drafts."
          if args.install else "Staged only; user-local extensions and running providers are unchanged.")
    print("Canvas ID: " + ("pocket-printer-chat" if args.v2 else "pocket-printer-editor"))
    print("A project extension with the same name shadows this user copy in that repository.")
    print("Draft and print-intent stores remain shared and unchanged. No helper install, launch, scan or print.")


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, ValueError, subprocess.SubprocessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"Canvas installation failed: {detail or error}", file=sys.stderr)
        sys.exit(1)
