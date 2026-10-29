"""Credential-free observer controls; no Azure call, restart or real delay."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).with_name("wait-for-migration.py")))
EXECUTION = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.App/jobs/test/executions/exact"
QUERY = json.dumps({"execution_id": EXECUTION, "timeout": "120"})


class MigrationObserverTests(unittest.TestCase):
    def invoke(self, status, returncode=0):
        response = subprocess.CompletedProcess([], returncode, stdout=json.dumps(status))
        output = io.StringIO()
        with patch("sys.stdin", io.StringIO(QUERY)), contextlib.redirect_stdout(output), patch("subprocess.run", return_value=response) as observer:
            try:
                MODULE["main"]()
            finally:
                observer.assert_called_once()
                arguments = observer.call_args.args[0]
                self.assertEqual(arguments[arguments.index("--method") + 1], "get")
                self.assertIn("https://management.azure.com" + EXECUTION + "?api-version=2025-01-01", arguments)
        return output.getvalue()

    def test_exact_execution_succeeds(self):
        self.assertEqual(json.loads(self.invoke("Succeeded")), {"status": "Succeeded", "execution_id": EXECUTION})

    def test_failed_stopped_and_degraded_never_promote(self):
        for status in ["Failed", "Stopped", "Degraded"]:
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, "unsuccessful"):
                self.invoke(status)

    def test_running_times_out_without_start_or_retry(self):
        with patch("time.monotonic", side_effect=[0, 0, 121, 121]), patch("time.sleep"), self.assertRaisesRegex(RuntimeError, "deadline exceeded"):
            self.invoke("Running")

    def test_non_arm_target_rejected_before_any_request(self):
        with patch("sys.stdin", io.StringIO(json.dumps({"execution_id": "https://untrusted.example", "timeout": "120"}))), patch("subprocess.run") as observer, self.assertRaises(ValueError):
            MODULE["main"]()
        observer.assert_not_called()

    def test_transport_failure_never_restarts_a_job(self):
        with self.assertRaisesRegex(RuntimeError, "no restart attempted"):
            self.invoke("Unknown", returncode=1)


if __name__ == "__main__":
    unittest.main()
