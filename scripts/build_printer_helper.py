#!/usr/bin/env python3
"""Package the print-capable helper locally, without launching or installing."""
import argparse
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / ".build/Pocket Printer Helper.app"


def run(*args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", action="store_true",
                        help="Build separately under .build/staged without replacing the active helper")
    args = parser.parse_args()
    app = ROOT / ".build/staged/Pocket Printer Helper.app" if args.stage else APP
    executable = app / "Contents/MacOS/printer-helper"
    if app.resolve() != app or executable.resolve() != executable:
        raise SystemExit("Refusing a helper output path containing symlinks.")
    running = run("/bin/ps", "-axo", "comm=", capture=True).splitlines()
    if any((pathlib.Path(line.strip()) == executable if args.stage else
            pathlib.Path(line.strip()).name == "printer-helper") for line in running):
        raise SystemExit("Quit the target Pocket Printer Helper before replacing its bundle.")
    run("swift", "build", "-c", "release", "--product", "printer-helper")
    binary_dir = pathlib.Path(run("swift", "build", "-c", "release", "--show-bin-path", capture=True).strip())
    executable.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary_dir / "printer-helper", executable)
    shutil.copy2(ROOT / "Support/PrinterHelper-Info.plist", app / "Contents/Info.plist")
    links = run("otool", "-L", str(executable), capture=True)
    if any(not line.strip().startswith(("/System/Library/", "/usr/lib/")) for line in links.splitlines()[1:]):
        raise SystemExit("Helper has unexpected non-system dynamic dependencies.")
    run("codesign", "--force", "--sign", "-", "--timestamp=none", str(app))
    run("codesign", "--verify", "--strict", "--verbose=2", str(app))
    print(f"Built, NOT launched: {app}")
    if args.stage:
        print("Staged only. Active bundle unchanged. Do not launch or switch until the user quits the old helper and approves.")
    print("User launch and ordinary Bluetooth permission remain required; development updates may re-prompt.")


if __name__ == "__main__":
    main()
