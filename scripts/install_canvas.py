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
MANIFEST = ".pocket-canvas-install.json"
FILES = ("extension.mjs", "editor.mjs", "editor.js", "editor.html", "editor.css",
         "draft.mjs", "private-store.mjs", "printing.mjs", "loopback.mjs",
         "png.mjs", "preview.mjs", "view.js", "view.css", "view.html", "sample.png")
RELOCATIONS = {
    "draft.mjs": ("../../../.build/debug/card-renderer", "./runtime/card-renderer"),
    "printing.mjs": ("../../../bridge/ipc.mjs", "./runtime/ipc.mjs"),
}


def managed(target):
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
            saved["format"] != 1 or saved["extension"] != NAME or saved["entries"] != entries):
        raise InstallError("The installed canvas has user changes or an invalid manifest. Nothing was replaced.")
    return saved


def verify(target, node):
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
      const { previewCanvas } = await import(new URL('preview.mjs', base));
      const { Printing } = await import(new URL('printing.mjs', base));
      let helperCalls = 0;
      const editor = editorCanvas(undefined, { printing: () => new Printing({ helper: async () => {
        helperCalls++; throw new Error('Standalone verification must not contact the helper');
      } }) });
      const preview = previewCanvas();
      const context = { instanceId: 'offline-install-check', input: {} };
      try {
        const panel = await editor.open(context);
        const state = await (await fetch(panel.url + 'state')).json();
        assert.equal(state.error, null);
        assert.equal(state.image.width, 384);
        const action = editor.actions.find(value => value.name === 'update_draft');
        const changed = await action.handler({ ...context, input: { revision: state.revision,
          draft: { ...state.draft, bottom: 'sudoku', order: [...state.draft.order].reverse() } } });
        assert.equal(changed.error, null);
        assert.equal(changed.renderedRevision, changed.revision);
        const image = await preview.open(context);
        assert.equal((await fetch(image.url + 'image.png')).status, 200);
      } finally { await editor.onClose(context); await preview.onClose(context); }
      assert.equal(helperCalls, 0);
      console.log('Standalone editor/render/preview verified; no helper, BLE, storage or paper access.');
    """
    with tempfile.TemporaryDirectory(prefix="canvas-check-", dir=target.parent.parent) as cwd:
        return command(node, "--input-type=module", "-e", script, str(target), cwd=cwd).strip()


def package(source, renderer, ipc, target, node):
    for path in (source, renderer, ipc, target):
        safe_path(path)
    inventory(source)
    for path in (renderer, ipc):
        if not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
            raise InstallError("Runtime source must be an owned, non-writable regular file.")
    previous = managed(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_path(target.parent)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".canvas-install-", dir=target.parent))
    try:
        candidate = temporary / NAME
        candidate.mkdir(mode=0o700)
        for name in FILES:
            path = safe_path(source / name)
            shutil.copy2(path, candidate / name)
        for name, (old, new) in RELOCATIONS.items():
            path = candidate / name
            text = path.read_text()
            if text.count(old) != 1:
                raise InstallError(f"Canvas relocation contract changed in {name}; nothing was installed.")
            path.write_text(text.replace(old, new))
        runtime = candidate / "runtime"
        runtime.mkdir(mode=0o700)
        shutil.copy2(renderer, runtime / "card-renderer")
        shutil.copy2(ipc, runtime / "ipc.mjs")
        verify(candidate, node)
        saved = {"format": 1, "extension": NAME, "entries": inventory(candidate)}
        (candidate / MANIFEST).write_text(json.dumps(saved, indent=2, sort_keys=True) + "\n")
        (candidate / MANIFEST).chmod(0o600)
        if managed(target) != previous:
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
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        raise InstallError("Run as a normal macOS user, never with sudo.")
    node = shutil.which("node")
    if not node or int(command(node, "--version").strip().lstrip("v").split(".")[0]) < 22:
        raise InstallError("Node 22 or later is required.")
    destination = pathlib.Path(os.environ.get("COPILOT_HOME", str(pathlib.Path.home() / ".copilot"))) / "extensions" / NAME
    target = destination if args.install else (args.stage_root or ROOT / ".build/canvas-installation") / NAME
    if not args.install and (target == destination or target in destination.parents or destination in target.parents):
        raise InstallError("Staging must not overlap the user installation. Use --install explicitly.")
    renderer = args.renderer
    if renderer is None:
        subprocess.run(["swift", "build", "-c", "release", "--product", "card-renderer", "-q"],
                       cwd=ROOT, check=True, timeout=600)
        binary_dir = subprocess.run(["swift", "build", "-c", "release", "--show-bin-path"],
                                    cwd=ROOT, check=True, capture_output=True, text=True, timeout=60).stdout.strip()
        renderer = pathlib.Path(binary_dir) / "card-renderer"
    result = package(ROOT / ".github/extensions" / NAME, renderer, ROOT / "bridge/ipc.mjs", target, node)
    print(f"{result}: {target}")
    print(verify(target, node))
    print("User-local files installed; reload in the destination chat after preserving any unsaved drafts."
          if args.install else "Staged only; user-local extensions and running providers are unchanged.")
    print("Canvas IDs: pocket-printer-editor, pocket-printer-preview")
    print("A project extension with the same name shadows this user copy in that repository.")
    print("Draft and print-intent stores remain shared and unchanged. No helper install, launch, scan or print.")


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, ValueError, subprocess.SubprocessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"Canvas installation failed: {detail or error}", file=sys.stderr)
        sys.exit(1)
