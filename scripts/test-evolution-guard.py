#!/usr/bin/env python3
"""evolution-guard 的独立正负向验收。"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GUARD = PROJECT_ROOT / "scripts/evolution-guard.py"


class EvolutionGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="km-evolution-guard-")
        self.root = Path(self.temporary.name)
        self.run_git("init", "-q")
        self.run_git("config", "user.email", "guard-test@example.invalid")
        self.run_git("config", "user.name", "Evolution Guard Test")
        self.write("src/existing.py", "x = 1\n" * 650)
        self.write("src/short.py", "x = 1\n")
        for name in "abcdefgh":
            self.write(f"wide/{name}/tracked.txt", "tracked\n")
        self.run_git("add", ".")
        self.run_git("commit", "-qm", "test baseline")
        self.config = {
            "version": 1,
            "limits": {"directory_children": 7, "file_lines": 600},
            "scope": {"code_extensions": [".py"]},
            "baseline": {
                "commit": self.git_output("rev-parse", "HEAD"),
                "expires_on": "2099-12-31",
                "owner": "test-owner",
                "reason": "test baseline",
                "directory_widths": {"wide": 8},
                "file_lines": {"src/existing.py": 650},
            },
        }
        self.write_config()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_git(self, *arguments: str) -> None:
        subprocess.run(
            ["git", "-C", str(self.root), *arguments],
            check=True,
            capture_output=True,
            text=True,
        )

    def git_output(self, *arguments: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.root), *arguments],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def write(self, relative: str, content: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def write_config(self) -> None:
        self.write("evolution-guard.json", json.dumps(self.config, ensure_ascii=False))

    def run_guard(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(GUARD),
                str(self.root),
                "--config",
                str(self.root / "evolution-guard.json"),
            ],
            capture_output=True,
            text=True,
        )

    def test_current_baseline_passes(self) -> None:
        result = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("演化护栏通过", result.stdout)

    def test_staged_eight_child_directory_is_rejected(self) -> None:
        for name in "abcdefgh":
            self.write(f"new-wide/{name}/tracked.txt", "tracked\n")
        self.run_git("add", "new-wide")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("new-wide", result.stderr)
        self.assertIn("8 个子目录", result.stderr)

    def test_existing_wide_directory_cannot_grow(self) -> None:
        self.write("wide/i/tracked.txt", "tracked\n")
        self.run_git("add", "wide/i/tracked.txt")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("超过存量基线 8", result.stderr)

    def test_shrunk_directory_requires_baseline_removal(self) -> None:
        self.run_git("rm", "-q", "wide/h/tracked.txt")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("基线可移除", result.stderr)
        del self.config["baseline"]["directory_widths"]["wide"]
        self.write_config()
        self.assertEqual(self.run_guard().returncode, 0)

    def test_untracked_width_is_not_seen_until_added(self) -> None:
        for name in "abcdefgh":
            self.write(f"untracked/{name}/x", "untracked\n")
        self.assertEqual(self.run_guard().returncode, 0)
        self.run_git("add", "untracked")
        self.assertEqual(self.run_guard().returncode, 1)

    def test_new_601_line_file_is_rejected(self) -> None:
        self.write("src/new.py", "x = 1\n" * 601)
        self.run_git("add", "src/new.py")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("src/new.py", result.stderr)
        self.assertIn("601 行", result.stderr)

    def test_new_600_line_file_is_allowed(self) -> None:
        self.write("src/boundary.py", "x = 1\n" * 600)
        self.run_git("add", "src/boundary.py")
        self.assertEqual(self.run_guard().returncode, 0)

    def test_601_lines_without_final_newline_is_rejected(self) -> None:
        self.write("src/no-final-newline.py", "\n".join("x = 1" for _ in range(601)))
        self.run_git("add", "src/no-final-newline.py")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("601 行", result.stderr)

    def test_existing_file_cannot_grow_past_baseline(self) -> None:
        self.write("src/existing.py", "x = 1\n" * 651)
        self.run_git("add", "src/existing.py")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("存量基线 650", result.stderr)

    def test_shrunk_file_requires_baseline_tightening(self) -> None:
        self.write("src/existing.py", "x = 1\n" * 620)
        self.run_git("add", "src/existing.py")

        result = self.run_guard()

        self.assertEqual(result.returncode, 1)
        self.assertIn("可收紧到 620", result.stderr)
        self.config["baseline"]["file_lines"]["src/existing.py"] = 620
        self.write_config()
        self.assertEqual(self.run_guard().returncode, 0)

    def test_expired_baseline_is_rejected(self) -> None:
        self.config["baseline"]["expires_on"] = "2000-01-01"
        self.write_config()

        result = self.run_guard()

        self.assertEqual(result.returncode, 2)
        self.assertIn("已过期", result.stderr)

    def test_missing_exception_metadata_is_rejected(self) -> None:
        del self.config["baseline"]["owner"]
        self.write_config()

        result = self.run_guard()

        self.assertEqual(result.returncode, 2)
        self.assertIn("owner", result.stderr)


if __name__ == "__main__":
    unittest.main()
