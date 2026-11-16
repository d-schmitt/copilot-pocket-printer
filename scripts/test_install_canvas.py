"""Canvas installation tests never contact a helper or real printer."""
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

import install_canvas as installer


class CanvasInstallationTests(unittest.TestCase):
    def setUp(self):
        root = installer.ROOT / ".build/canvas-install-tests"
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="spaces in fixture ", dir=root)
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / "source"
        shutil.copytree(installer.ROOT / ".github/extensions" / installer.NAME, self.source)
        self.renderer = pathlib.Path(os.environ.get("CARD_RENDERER_BIN", str(installer.ROOT / ".build/debug/card-renderer"))).resolve()
        self.assertTrue(self.renderer.is_file(), "Build card-renderer first or set CARD_RENDERER_BIN.")
        self.ipc = self.root / "ipc.mjs"
        shutil.copy2(installer.ROOT / "bridge/ipc.mjs", self.ipc)
        self.target = self.root / "extensions" / installer.NAME
        self.node = shutil.which("node")

    def install(self):
        return installer.package(self.source, self.renderer, self.ipc, self.target, self.node)

    def test_standalone_copy_relocation_and_repeat_install(self):
        self.assertEqual(self.install(), "Created")
        inode = self.target.stat().st_ino
        self.assertEqual(self.install(), "Unchanged")
        self.assertEqual(self.target.stat().st_ino, inode)
        self.source.rename(self.root / "unavailable source")
        self.ipc.rename(self.root / "unavailable ipc")
        self.assertIn("no helper", installer.verify(self.target, self.node))
        for path in self.target.rglob("*.mjs"):
            self.assertNotIn(str(installer.ROOT), path.read_text())
            self.assertNotIn("../../../", path.read_text())
        self.assertFalse(any(path.is_symlink() for path in self.target.rglob("*")))
        self.assertIn("'Copilot Pocket Printer Canvas'", (self.target / "private-store.mjs").read_text())
        installer.command(self.node, "--test", "--test-name-pattern=two separate provider processes",
                          str(installer.ROOT / ".github/extensions/pocket-printer-preview/test/printing.test.mjs"),
                          env={**os.environ, "POCKET_TEST_PACKAGED_PRINTING": (self.target / "printing.mjs").as_uri()})

    def test_unrelated_or_user_modified_extension_is_preserved(self):
        self.target.mkdir(parents=True)
        custom = self.target / "personal.txt"
        custom.write_text("Do not replace")
        with self.assertRaisesRegex(installer.InstallError, "unrelated"):
            self.install()
        self.assertEqual(custom.read_text(), "Do not replace")
        custom.unlink(); self.target.rmdir()
        self.install()
        entry = self.target / "extension.mjs"
        entry.write_text(entry.read_text() + "\n// User customization\n")
        before = entry.read_bytes()
        with self.assertRaisesRegex(installer.InstallError, "user changes"):
            self.install()
        self.assertEqual(entry.read_bytes(), before)

    def test_symlinks_changed_relocation_and_failed_verification_never_replace(self):
        self.install()
        before = installer.managed(self.target)
        renderer = self.root / "renderer-link"
        renderer.symlink_to(self.renderer)
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.package(self.source, renderer, self.ipc, self.target, self.node)
        with patch.object(installer, "verify", side_effect=installer.InstallError("verification failed")):
            with self.assertRaisesRegex(installer.InstallError, "verification failed"):
                self.install()
        self.assertEqual(installer.managed(self.target), before)
        draft = self.source / "draft.mjs"
        draft.write_text(draft.read_text().replace("../../../.build/debug/card-renderer", "unknown-renderer"))
        with self.assertRaisesRegex(installer.InstallError, "relocation contract"):
            self.install()
        self.assertEqual(installer.managed(self.target), before)
        self.assertEqual(list(self.target.parent.glob(".canvas-install-*")), [])


if __name__ == "__main__":
    unittest.main()
