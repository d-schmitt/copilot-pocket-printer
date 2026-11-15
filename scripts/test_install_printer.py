"""Installer tests use only owned fixture paths and never execute the helper."""
import importlib.util
import io
import json
import os
import pathlib
import plistlib
import select
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "installer", pathlib.Path(__file__).with_name("install_printer.py"))
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
REAL_COMMAND = installer.command


class InstallationTests(unittest.TestCase):
    def setUp(self):
        root = installer.ROOT / ".build/installation-tests"
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="spaces in fixture ", dir=root)
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / "source checkout"
        self.helper = self.source / installer.APP
        executable = self.helper / "Contents/MacOS/printer-helper"
        executable.parent.mkdir(parents=True)
        executable.write_text("fixture, not a native executable\n")
        executable.chmod(0o755)
        shutil.copy2(installer.ROOT / "Support/PrinterHelper-Info.plist",
                     self.helper / "Contents/Info.plist")
        signature = self.helper / "Contents/_CodeSignature"
        signature.mkdir()
        (signature / "CodeResources").write_text("fixture signature\n")
        self.bridge = self.source / "bridge"
        self.bridge.mkdir()
        for name in installer.BRIDGE_FILES:
            shutil.copy2(installer.ROOT / "bridge" / name, self.bridge / name)
        self.target = self.root / "Applications" / installer.PACKAGE
        self.node = shutil.which("node")
        self.assertIsNotNone(self.node, "Node 22+ is required for inert bridge discovery.")
        self.processes = ""
        self.arguments = ""
        real_command = installer.command

        def fixture_command(*args, **kwargs):
            if args[0] == "/bin/ps":
                return self.processes if args[-1] == "comm=" else self.arguments
            if args[0] == "/usr/bin/codesign":
                return ""
            if args[0] == "/usr/bin/otool":
                return f"{args[-1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0)\n"
            return real_command(*args, **kwargs)

        self.commands = patch.object(installer, "command", side_effect=fixture_command)
        self.commands.start()
        self.addCleanup(self.commands.stop)

    def install(self):
        return installer.stage_package(self.helper, self.bridge, self.target, self.node)

    def assert_preserved(self, before):
        self.assertEqual(installer.installed_manifest(self.target), before)
        self.assertEqual(list(self.target.parent.glob(".printer-install-*")), [])

    def test_standalone_bridge_with_source_unavailable_and_spaces(self):
        self.assertEqual(self.install(), "Created")
        self.assertEqual(set((self.target / "bridge").iterdir()),
                         {self.target / "bridge" / name for name in installer.BRIDGE_FILES})
        self.source.rename(self.root / "unavailable source fixture")
        installer.verify_bridge(self.target / "bridge", self.node)
        self.assertEqual(installer.configuration(self.target, self.node)["mcpServers"]["pocket-printer"],
                         {"command": self.node, "args": [str(self.target / "bridge/server.mjs")]})
        for file in (self.target / "bridge").iterdir():
            self.assertNotIn(str(self.source), file.read_text())
        self.assertNotIn(str(self.source), (self.target / installer.MANIFEST).read_text())

    def test_repeat_is_noop_and_update_atomically_replaces_both_components(self):
        self.install()
        inode = self.target.stat().st_ino
        self.assertEqual(self.install(), "Unchanged")
        self.assertEqual(self.target.stat().st_ino, inode)
        executable = self.helper / "Contents/MacOS/printer-helper"
        executable.write_text("new fixture helper\n")
        server = self.bridge / "server.mjs"
        server.write_text(server.read_text() + "\n// fixture update\n")
        self.assertEqual(self.install(), "Updated")
        self.assertEqual((self.target / installer.APP / "Contents/MacOS/printer-helper").read_bytes(),
                         executable.read_bytes())
        self.assertEqual((self.target / "bridge/server.mjs").read_bytes(), server.read_bytes())
        self.assertEqual(self.install(), "Unchanged")

    def test_unrelated_and_modified_destinations_are_never_replaced(self):
        self.target.mkdir(parents=True)
        unrelated = self.target / "personal.txt"
        unrelated.write_text("keep this\n")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(unrelated.read_text(), "keep this\n")
        unrelated.unlink()
        self.target.rmdir()
        self.install()
        server = self.target / "bridge/server.mjs"
        server.write_text("user modification\n")
        with self.assertRaisesRegex(installer.InstallError, "modified"):
            self.install()
        self.assertEqual(server.read_text(), "user modification\n")

    def test_symlink_sources_targets_and_ancestors_are_rejected(self):
        self.target.parent.mkdir()
        self.target.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.target.unlink()
        linked = self.root / "linked parent"
        linked.symlink_to(self.target.parent, target_is_directory=True)
        with self.assertRaises(installer.InstallError):
            installer.stage_package(self.helper, self.bridge, linked / installer.PACKAGE, self.node)
        server = self.bridge / "server.mjs"
        server.unlink()
        server.symlink_to(installer.ROOT / "bridge/server.mjs")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertFalse(self.target.exists())

    def test_running_target_helper_or_bridge_refuses_even_identical_update(self):
        self.install()
        before = installer.installed_manifest(self.target)
        self.processes = str(self.target / installer.APP / "Contents/MacOS/printer-helper") + "\n"
        with self.assertRaisesRegex(installer.InstallError, "Quit"):
            self.install()
        self.processes = ""
        self.arguments = f'{self.node} {self.target / "bridge/server.mjs"}\n'
        with self.assertRaisesRegex(installer.InstallError, "Disconnect"):
            self.install()
        self.assert_preserved(before)
        self.arguments = ""
        self.processes = "/unrelated/old checkout/Pocket Printer Helper.app/Contents/MacOS/printer-helper\n"
        self.assertEqual(self.install(), "Unchanged")

    def test_failed_copy_verification_and_publish_preserve_previous_installation(self):
        self.install()
        before = installer.installed_manifest(self.target)
        (self.bridge / "server.mjs").write_text(
            (self.bridge / "server.mjs").read_text() + "\n// next version\n")
        for function in ("copytree", "verify_helper", "verify_bridge", "publish"):
            with self.subTest(function=function):
                owner = installer.shutil if function == "copytree" else installer
                with patch.object(owner, function, side_effect=OSError("injected failure")):
                    with self.assertRaisesRegex(OSError, "injected failure"):
                        self.install()
                self.assert_preserved(before)
        (self.bridge / "ipc.mjs").unlink()
        with self.assertRaisesRegex(installer.InstallError, "Missing bridge"):
            self.install()
        self.assert_preserved(before)

    def test_real_invalid_bridge_preserves_previous_installation(self):
        self.install()
        before = installer.installed_manifest(self.target)
        (self.bridge / "ipc.mjs").write_text("this is not valid JavaScript\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.install()
        self.assert_preserved(before)

    def test_real_running_bridge_is_refused_without_helper_calls(self):
        self.install()
        child = subprocess.Popen([self.node, str(self.target / "bridge/server.mjs")],
                                 cwd=self.root, text=True,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "running-check", "version": "1"}}
            }) + "\n")
            child.stdin.flush()
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "Bridge must respond.")
            self.assertEqual(json.loads(child.stdout.readline())["id"], 1)
            with patch.object(installer, "command", side_effect=REAL_COMMAND):
                with self.assertRaisesRegex(installer.InstallError, "Disconnect"):
                    installer.check_running(self.target)
        finally:
            child.terminate()
            child.communicate(timeout=5)

    def test_from_stage_uses_both_staged_runtimes_not_changed_checkout(self):
        self.install()
        with patch.object(sys, "argv", [
                "install_printer.py", "--from-stage", str(self.target),
                "--stage-root", str(self.root / "second staging area")]), \
                patch.object(installer, "stage_package", return_value="Created") as stage, \
                patch("builtins.print"):
            installer.main()
        self.assertEqual(stage.call_args.args[:3], (
            self.target / installer.APP, self.target / "bridge",
            self.root / "second staging area" / installer.PACKAGE))
        (self.target / "bridge/server.mjs").write_text("tampered stage")
        with patch.object(sys, "argv", [
                "install_printer.py", "--from-stage", str(self.target)]):
            with self.assertRaisesRegex(installer.InstallError, "modified"):
                installer.main()

    def test_default_only_stages_and_install_cannot_hide_in_stage_root(self):
        with patch.object(sys, "argv", ["install_printer.py", "--helper-app", str(self.helper)]), \
                patch.object(installer, "stage_package", return_value="Created") as stage, \
                patch("builtins.print"):
            installer.main()
        self.assertEqual(stage.call_args.args[2], installer.ROOT / ".build/installation" / installer.PACKAGE)
        for directory in (pathlib.Path.home() / "Applications",
                          pathlib.Path.home() / "Applications" / installer.PACKAGE,
                          pathlib.Path.home() / "Applications" / installer.PACKAGE / "nested"):
            with self.subTest(directory=directory), patch.object(sys, "argv", [
                    "install_printer.py", "--stage-root", str(directory)]):
                with self.assertRaisesRegex(installer.InstallError, "--install"):
                    installer.main()

    def test_copilot_arguments_guidance_is_one_literal_json_array(self):
        home = self.root / "user home"
        with patch.object(sys, "argv", [
                "install_printer.py", "--helper-app", str(self.helper), "--node", self.node]), \
                patch.object(pathlib.Path, "home", return_value=home), \
                patch.object(installer, "stage_package", return_value="Created"), \
                patch.object(sys, "stdout", new_callable=io.StringIO) as output:
            installer.main()
        lines = output.getvalue().splitlines()
        self.assertIn(f"Command: {self.node}", lines)
        arguments = next(line.removeprefix("Arguments: ") for line in lines
                         if line.startswith("Arguments: "))
        self.assertEqual(json.loads(arguments),
                         [str(home / "Applications" / installer.PACKAGE / "bridge/server.mjs")])
        self.assertIn("Paste the entire JSON array into Arguments", output.getvalue())

    def test_finder_metadata_allows_noop_and_update_but_not_symlinks_or_directories(self):
        self.install()
        metadata = self.target / ".DS_Store"
        metadata.write_bytes(b"Finder metadata")
        bundle_metadata = self.target / installer.APP / "Contents/.DS_Store"
        bundle_metadata.write_bytes(b"Finder bundle metadata")
        self.assertEqual(self.install(), "Unchanged")
        (self.helper / ".DS_Store").write_bytes(b"source Finder metadata")
        (self.helper / "Contents/MacOS/printer-helper").write_text("updated fixture")
        self.assertEqual(self.install(), "Updated")
        self.assertFalse(metadata.exists())
        self.assertFalse(bundle_metadata.exists())
        metadata.symlink_to(self.root / "missing")
        with self.assertRaises(installer.InstallError):
            self.install()
        metadata.unlink()
        metadata.mkdir()
        with self.assertRaisesRegex(installer.InstallError, ".DS_Store"):
            self.install()

    def test_cleanup_failure_keeps_primary_error_and_reports_completed_publish(self):
        self.install()
        before = installer.installed_manifest(self.target)
        with patch.object(installer, "verify_bridge", side_effect=OSError("primary check failed")), \
                patch.object(installer.shutil, "rmtree", side_effect=OSError("cleanup failed")), \
                patch.object(sys, "stderr", new_callable=io.StringIO) as errors:
            with self.assertRaisesRegex(OSError, "primary check failed"):
                self.install()
            self.assertIn("Destination was not replaced", errors.getvalue())
        self.assertEqual(installer.installed_manifest(self.target), before)
        (self.helper / "Contents/MacOS/printer-helper").write_text("updated fixture")
        with patch.object(installer.shutil, "rmtree", side_effect=OSError("cleanup failed")), \
                patch.object(installer, "verify_bridge"):
            with self.assertRaisesRegex(installer.InstallError, "Package was published"):
                self.install()
        self.assertNotEqual(installer.installed_manifest(self.target), before)

    def test_wrong_bundle_identity_and_non_system_linkage_are_rejected(self):
        self.install()
        before = installer.installed_manifest(self.target)
        info_path = self.helper / "Contents/Info.plist"
        original = info_path.read_bytes()
        info = plistlib.loads(original)
        info["CFBundleIdentifier"] = "unrelated.application"
        info_path.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(installer.InstallError, "identity"):
            self.install()
        info_path.write_bytes(original)
        with patch.object(installer, "command", return_value="helper:\n\t/source/libDependency.dylib\n"):
            with self.assertRaisesRegex(installer.InstallError, "non-system"):
                self.install()
        self.assert_preserved(before)

    def test_invalid_manifest_entries_fail_closed_without_reading_unrelated_trees(self):
        self.target.mkdir(parents=True)
        with patch.object(installer, "inventory", side_effect=AssertionError("must not inspect")):
            with self.assertRaisesRegex(installer.InstallError, "unrecognized installation"):
                self.install()
        self.target.rmdir()
        self.install()
        marker = self.target / installer.MANIFEST
        value = json.loads(marker.read_text())
        value["entries"]["unexpected"] = None
        marker.write_text(json.dumps(value))
        with self.assertRaisesRegex(installer.InstallError, "unexpected"):
            self.install()

    def test_atomic_no_clobber_and_failed_swap_preserve_both_sides(self):
        first = self.root / "first"
        second = self.root / "second"
        first.mkdir()
        second.mkdir()
        (first / "value").write_text("new")
        (second / "value").write_text("old")
        with self.assertRaises(OSError):
            installer.publish(first, second, replacing=False)
        self.assertEqual((first / "value").read_text(), "new")
        self.assertEqual((second / "value").read_text(), "old")
        with self.assertRaises(OSError):
            installer.publish(self.root / "missing", second, replacing=True)
        self.assertEqual((second / "value").read_text(), "old")


if __name__ == "__main__":
    unittest.main()
