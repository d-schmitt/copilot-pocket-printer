#!/usr/bin/env python3
"""Package the print-capable helper locally, without launching or installing."""
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / ".build/Pocket Printer Helper.app"


def run(*args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def main():
    running = run("/bin/ps", "-axo", "comm=", capture=True).splitlines()
    if any(pathlib.Path(line.strip()).name == "printer-helper" for line in running):
        raise SystemExit("Quit Pocket Printer Helper before rebuilding.")
    run("swift", "build", "-c", "release", "--product", "printer-helper")
    binary_dir = pathlib.Path(run("swift", "build", "-c", "release", "--show-bin-path", capture=True).strip())
    executable = APP / "Contents/MacOS/printer-helper"
    executable.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary_dir / "printer-helper", executable)
    shutil.copy2(ROOT / "Support/PrinterHelper-Info.plist", APP / "Contents/Info.plist")
    links = run("otool", "-L", str(executable), capture=True)
    if any(not line.strip().startswith(("/System/Library/", "/usr/lib/")) for line in links.splitlines()[1:]):
        raise SystemExit("Helper has unexpected non-system dynamic dependencies.")
    run("codesign", "--force", "--sign", "-", "--timestamp=none", str(APP))
    run("codesign", "--verify", "--strict", "--verbose=2", str(APP))
    print(f"Built, NOT launched: {APP}")
    print("New print-capable identity. Requires independent Finder launch and its own ordinary Bluetooth approval.")


if __name__ == "__main__":
    main()
