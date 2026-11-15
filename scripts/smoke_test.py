#!/usr/bin/env python3
"""Offline process-level checks using only the Python standard library."""

import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


CLI = pathlib.Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else None


def png(width, height):
    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload))
        )

    scanlines = (b"\0" + b"\xff" * width) * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines))
        + chunk(b"IEND", b"")
    )


class CLISmokeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pocket-printer-smoke-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)

    def run_cli(self, *arguments, code=0):
        result = subprocess.run(
            [str(CLI), *map(str, arguments)],
            text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def write_png(self, name="card.png", width=384, height=49):
        path = self.root / name
        path.write_bytes(png(width, height))
        return path

    def test_help_is_offline_and_honest(self):
        result = self.run_cli("--help")
        self.assertIn("BLOCKED", result.stdout)
        self.assertIn("scans only", result.stdout)

    def test_pattern_and_no_overwrite(self):
        path = self.root / "pattern.png"
        self.run_cli("test-pattern", path)
        original = path.read_bytes()
        self.assertEqual(struct.unpack(">II", original[16:24]), (384, 288))
        self.run_cli("test-pattern", path, code=2)
        self.assertEqual(path.read_bytes(), original)
        result = self.run_cli("print", path, "--dry-run")
        self.assertIn("12 raster bands", result.stdout)
        self.assertIn("Image: 384x288", result.stdout)

    def test_partial_band_and_one_line_images(self):
        result = self.run_cli("print", self.write_png(), "--dry-run")
        self.assertIn("7 separate segments, 3 raster bands, 2399 protocol bytes", result.stdout)
        result = self.run_cli("print", self.write_png("one.png", height=1), "--dry-run")
        self.assertIn("5 separate segments, 1 raster bands, 79 protocol bytes", result.stdout)

    def test_feed_limits_and_activation_job_size(self):
        result = self.run_cli("feed", "--dry-run")
        self.assertIn("4 separate segments, 0 raster bands, 23 protocol bytes, 80 feed dots", result.stdout)
        self.run_cli("feed", "255", "--dry-run")
        for value in ("0", "-1", "256", "1.5"):
            self.assertIn("invalid_input", self.run_cli("feed", value, "--dry-run", code=2).stderr)

    def test_actual_print_and_feed_fail_closed(self):
        path = self.write_png()
        for arguments in (("print", path), ("feed", "80")):
            result = self.run_cli(*arguments, code=6)
            self.assertIn("upstream_transport_blocked", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_invalid_images_fail_before_hardware_guard(self):
        malformed = self.root / "bad.png"
        malformed.write_bytes(b"not a PNG")
        oversized = self.root / "oversized.png"
        with oversized.open("wb") as handle:
            handle.truncate(16 * 1024 * 1024 + 1)
        for path in (
            self.root / "missing.png", self.root, malformed, oversized,
            self.write_png("narrow.png", width=96),
            self.write_png("tall.png", height=4097),
        ):
            result = self.run_cli("print", path, code=2)
            self.assertIn("invalid_image", result.stderr)
            self.assertNotIn("upstream_transport_blocked", result.stderr)

    def test_invalid_arguments(self):
        for arguments in (
            ("print",), ("status", "--dry-run"), ("status", "--timeout", "nan"),
            ("status", "--device", "not-a-uuid"), ("feed", "--dry-run", "--dry-run"),
            ("print", "one.png", "two.png"),
        ):
            result = self.run_cli(*arguments, code=2)
            self.assertIn("invalid_input", result.stderr)


if __name__ == "__main__":
    if CLI is None or not CLI.is_file():
        sys.exit("Usage: python3 scripts/smoke_test.py /path/to/printer-cli")
    unittest.main()
