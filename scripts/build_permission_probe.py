#!/usr/bin/env python3
"""Build and ad-hoc sign a local app. Never launch it or change system policy."""

import pathlib
import plistlib
import shutil
import subprocess


ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / ".build" / "Pocket Printer Probe.app"


def run(*arguments, capture=False):
    return subprocess.run(
        arguments, cwd=ROOT, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    ).stdout


def main():
    running = run("/bin/ps", "-axo", "comm=", capture=True).splitlines()
    if any(pathlib.Path(command.strip()).name == "permission-probe" for command in running):
        raise SystemExit("Quit Pocket Printer Probe before rebuilding. No running app was changed.")
    run("swift", "build", "-c", "release", "--product", "permission-probe")
    binary_dir = pathlib.Path(run("swift", "build", "-c", "release", "--show-bin-path", capture=True).strip())
    executable_dir = APP / "Contents" / "MacOS"
    executable_dir.mkdir(parents=True, exist_ok=True)
    # Only replace named build artifacts. No installation, registration or launch.
    shutil.copy2(binary_dir / "permission-probe", executable_dir / "permission-probe")
    shutil.copy2(ROOT / "Support" / "PermissionProbe-Info.plist", APP / "Contents" / "Info.plist")
    with (APP / "Contents" / "Info.plist").open("rb") as stream:
        metadata = plistlib.load(stream)
    if metadata["CFBundleIdentifier"] != "io.github.copilot-pocket-printer.permission-probe":
        raise ValueError("Unexpected probe bundle identifier")
    if not metadata.get("NSBluetoothAlwaysUsageDescription"):
        raise ValueError("Bluetooth usage description is missing")
    linked = run("otool", "-L", str(executable_dir / "permission-probe"), capture=True)
    for line in linked.splitlines()[1:]:
        library = line.strip().split(" (", 1)[0]
        if not library.startswith(("/System/Library/", "/usr/lib/")):
            raise ValueError(f"App is not self-contained; unexpected dynamic dependency: {library}")
    run("codesign", "--force", "--sign", "-", "--timestamp=none", str(APP))
    run("codesign", "--verify", "--strict", "--verbose=2", str(APP))
    print(f"\nBuilt only, NOT launched: {APP}")
    print("Local ad-hoc signature only. TCC attribution and rebuild persistence remain unverified.")


if __name__ == "__main__":
    main()
