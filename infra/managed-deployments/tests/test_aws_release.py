from pathlib import Path
import subprocess
import unittest


class AwsInstallerReleaseTests(unittest.TestCase):
    def test_shared_module_dependencies_and_archive_bytes(self):
        test_file = Path(__file__).with_name("build-release.test.mjs")
        result = subprocess.run(
            ["node", "--test", str(test_file)],
            cwd=Path(__file__).resolve().parents[3],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
