#!/usr/bin/env python3
"""Stage a standalone printer package; install for this user only with --install."""
import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = "Copilot Pocket Printer"
APP = "Pocket Printer Helper.app"
MANIFEST = ".pocket-printer-install.json"
BUNDLE_ID = "io.github.copilot-pocket-printer.helper"
BRIDGE_FILES = ("server.mjs", "ipc.mjs")
TOOLS = ["printer_helper_status", "inspect_png", "submit_png",
         "get_print_job", "cancel_print_job"]


class InstallError(Exception):
    pass


def command(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=30, **kwargs).stdout


def safe_path(path):
    if not path.is_absolute() or path.resolve() != path:
        raise InstallError(f"Expected an absolute path without symlinks: {path}")
    if any(character in str(path) for character in "\r\n\t"):
        raise InstallError("Installation paths cannot contain tabs or newlines.")
    return path


def inventory(directory, *, manifest=False):
    safe_path(directory)
    if not directory.is_dir():
        raise InstallError(f"Expected a directory: {directory}")
    entries = {}
    for path in [directory, *sorted(directory.rglob("*"))]:
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode) or
                info.st_uid != os.getuid() or info.st_mode & 0o022):
            raise InstallError(f"Refusing unowned, writable or non-regular content: {path}")
        relative = path.relative_to(directory).as_posix()
        if manifest and relative == MANIFEST:
            continue
        # Finder creates this metadata during the required independent launch.
        if path.name == ".DS_Store" and stat.S_ISREG(info.st_mode):
            continue
        entry = {"mode": stat.S_IMODE(info.st_mode),
                 "kind": "directory" if path.is_dir() else "file"}
        if entry["kind"] == "file":
            with path.open("rb") as stream:
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            entry["sha256"] = digest.hexdigest()
        entries[relative] = entry
    return entries


def verify_helper(app):
    entries = inventory(app)
    expected = {".", "Contents", "Contents/Info.plist", "Contents/MacOS",
                "Contents/MacOS/printer-helper", "Contents/_CodeSignature",
                "Contents/_CodeSignature/CodeResources"}
    if set(entries) != expected:
        different = ", ".join(sorted(set(entries) ^ expected)[:10])
        raise InstallError(f"Helper bundle contains missing or unexpected paths: {different}")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    usage = plistlib.loads((ROOT / "Support/PrinterHelper-Info.plist").read_bytes())
    if (info.get("CFBundleIdentifier") != BUNDLE_ID or
            info.get("CFBundleExecutable") != "printer-helper" or
            info.get("NSBluetoothAlwaysUsageDescription") != usage["NSBluetoothAlwaysUsageDescription"]):
        raise InstallError("Helper identity or Bluetooth usage description does not match.")
    executable = app / "Contents/MacOS/printer-helper"
    if not os.access(executable, os.X_OK):
        raise InstallError("Helper is not executable.")
    command("/usr/bin/codesign", "--verify", "--strict", str(app))
    links = command("/usr/bin/otool", "-L", str(executable)).splitlines()
    if len(links) < 2 or any(not line.strip().startswith(("/System/Library/", "/usr/lib/"))
                             for line in links[1:]):
        raise InstallError("Helper has unexpected non-system dynamic dependencies.")


def verify_bridge(bridge, node):
    for name in BRIDGE_FILES:
        command(node, "--check", str(bridge / name))
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "installation-check", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    # No tools/call, helper process, socket connection or ledger access.
    with tempfile.TemporaryDirectory(prefix="discovery-", dir=bridge.parent.parent) as cwd:
        output = command(node, str(bridge / "server.mjs"), cwd=cwd,
                         input="".join(json.dumps(message) + "\n" for message in messages))
    replies = [json.loads(line) for line in output.splitlines()]
    if (len(replies) != 2 or replies[0].get("id") != 1 or
            replies[0].get("result", {}).get("protocolVersion") != "2025-06-18" or
            replies[1].get("id") != 2 or
            [tool["name"] for tool in replies[1].get("result", {}).get("tools", [])] != TOOLS):
        raise InstallError("Installed bridge did not return the expected MCP initialization and five tools.")


def check_running(target):
    executable = target / APP / "Contents/MacOS/printer-helper"
    processes = command("/bin/ps", "-ww", "-axo", "comm=").splitlines()
    if any(line.strip() == str(executable) for line in processes):
        raise InstallError("Quit the target helper yourself before updating. No process was stopped.")
    server = str(target / "bridge/server.mjs")
    arguments = command("/bin/ps", "-ww", "-axo", "args=")
    if server in arguments or server.replace(" ", "\\ ") in arguments:
        raise InstallError("Disconnect clients using the target bridge before updating. No process was stopped.")


def installed_manifest(target):
    safe_path(target)
    if not target.exists():
        return None
    marker = safe_path(target / MANIFEST)
    if not marker.is_file() or marker.stat().st_size > 1024 * 1024:
        raise InstallError(f"Refusing an unrecognized installation: {target}")
    entries = inventory(target, manifest=True)
    try:
        saved = json.loads(marker.read_text())
    except (ValueError, UnicodeError) as error:
        raise InstallError(f"Invalid installation manifest: {marker}") from error
    if (not isinstance(saved, dict) or set(saved) != {"format", "package", "entries"} or
            saved["format"] != 1 or saved["package"] != BUNDLE_ID or
            not isinstance(saved["entries"], dict)):
        raise InstallError(f"Unrecognized installation manifest: {marker}")
    recorded = saved["entries"]
    different = sorted((recorded.keys() ^ entries.keys()) |
                       {name for name in recorded.keys() & entries.keys()
                        if recorded[name] != entries[name]})
    if different:
        raise InstallError(f"Installation was modified at {', '.join(different[:10])}: {target}")
    return saved


def publish(candidate, target, replacing):
    # One directory holds both runtimes. macOS swap keeps the old complete
    # installation in candidate on success, and leaves it untouched on failure.
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename = library.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    flags = 0x00000002 if replacing else 0x00000004  # RENAME_SWAP / RENAME_EXCL
    if rename(os.fsencode(candidate), os.fsencode(target), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def stage_package(helper, bridge, target, node):
    safe_path(helper)
    safe_path(bridge)
    safe_path(target)
    check_running(target)
    previous = installed_manifest(target)
    verify_helper(helper)
    for name in BRIDGE_FILES:
        path = safe_path(bridge / name)
        if not path.is_file():
            raise InstallError(f"Missing bridge runtime: {path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_path(target.parent)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".printer-install-", dir=target.parent))
    published = False
    try:
        candidate = temporary / PACKAGE
        candidate.mkdir(mode=0o700)
        shutil.copytree(helper, candidate / APP, ignore=shutil.ignore_patterns(".DS_Store"))
        (candidate / "bridge").mkdir(mode=0o700)
        for name in BRIDGE_FILES:
            shutil.copy2(bridge / name, candidate / "bridge" / name)
        verify_helper(candidate / APP)
        verify_bridge(candidate / "bridge", node)
        saved = {"format": 1, "package": BUNDLE_ID, "entries": inventory(candidate)}
        with (candidate / MANIFEST).open("x") as stream:
            json.dump(saved, stream, indent=2, sort_keys=True)
            stream.write("\n")
        (candidate / MANIFEST).chmod(0o600)
        if installed_manifest(target) != previous:
            raise InstallError("Destination changed during preparation. Nothing was replaced.")
        check_running(target)
        if saved == previous:
            return "Unchanged"
        publish(candidate, target, previous is not None)
        published = True
        return "Updated" if previous is not None else "Created"
    finally:
        # Only this invocation's private preparation directory is disposable.
        # After a successful swap it holds the previously verified installation.
        original_error = sys.exc_info()[1]
        try:
            shutil.rmtree(temporary)
        except OSError as error:
            state = "Package was published" if published else "Destination was not replaced"
            message = f"{state}, but temporary cleanup failed at {temporary}: {error}"
            if original_error is None:
                raise InstallError(message) from error
            print(f"Cleanup warning: {message}", file=sys.stderr)


def configuration(target, node):
    return {"mcpServers": {"pocket-printer": {
        "command": node, "args": [str(target / "bridge/server.mjs")]}}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true",
                      help="Explicitly install/update ~/Applications/Copilot Pocket Printer")
    mode.add_argument("--stage-root", type=pathlib.Path,
                      help="Absolute staging parent (default: this checkout's .build/installation)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--helper-app", type=pathlib.Path,
                        help="Reuse an already built, signed helper with this checkout's bridge")
    source.add_argument("--from-stage", type=pathlib.Path,
                        help="Copy both runtimes from a verified staged package without rebuilding")
    parser.add_argument("--node", help="Absolute Node 22+ executable (default: node on PATH)")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        raise InstallError("Run as a normal macOS user, never with sudo.")
    node = args.node or shutil.which("node")
    if not node or not pathlib.Path(node).is_absolute():
        raise InstallError("An absolute path to an installed Node 22+ executable is required.")
    version = command(node, "--version").strip()
    if not version.startswith("v") or int(version[1:].split(".")[0]) < 22:
        raise InstallError("Node 22 or later is required.")
    destination = pathlib.Path.home() / "Applications" / PACKAGE
    target = destination if args.install else (
        args.stage_root or ROOT / ".build/installation") / PACKAGE
    safe_path(target)
    if not args.install and (target == destination or destination in target.parents or
                             target in destination.parents):
        raise InstallError("Staging must not overlap the stable destination; use --install explicitly.")
    helper = args.helper_app
    bridge = ROOT / "bridge"
    if args.from_stage:
        if installed_manifest(args.from_stage) is None:
            raise InstallError("The requested staged package does not exist.")
        helper = args.from_stage / APP
        bridge = args.from_stage / "bridge"
    elif helper is None:
        subprocess.run([sys.executable, str(ROOT / "scripts/build_printer_helper.py"), "--stage"],
                       check=True, cwd=ROOT)
        helper = ROOT / ".build/staged" / APP
    result = stage_package(helper, bridge, target, node)
    print(f"{result}: {target}")
    print("Installed, NOT launched." if args.install else "Staged only. The live installation/configuration is unchanged.")
    print("After separate approval, independently open the installed helper in Finder.")
    print("Normal Bluetooth consent may be requested again. No preference or receipt was changed.")
    print("Proposed stable MCP configuration (not applied):")
    config = configuration(destination, node)
    print(json.dumps(config, indent=2))
    fields = config["mcpServers"]["pocket-printer"]
    print("Copilot settings fields (not applied):")
    print(f"Command: {fields['command']}")
    print(f"Arguments: {json.dumps(fields['args'])}")
    print("Paste the entire JSON array into Arguments, including brackets and double quotes. "
          "A bare path containing spaces is split into multiple arguments. "
          "Do not paste the full mcpServers configuration into that field.")
    if not args.install:
        print("After approval, re-run with --install --from-stage and this staged package path "
              "to copy the exact verified runtimes without rebuilding.")


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, ValueError, subprocess.SubprocessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"Installation failed: {detail or error}", file=sys.stderr)
        sys.exit(1)
