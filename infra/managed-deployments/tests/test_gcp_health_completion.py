"""Offline heartbeat-collision and exact-execution controls. No cloud access."""
import base64
import hashlib
import io
import json
import os
import subprocess
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch

from test_gcp_installer import ENV, health, runner


def proof(iat, audience):
    # Synthetic metadata JWT shape; RSA validity is covered by Den's TS suite.
    payload = base64.urlsafe_b64encode(json.dumps({"iat": iat, "aud": audience}).encode()).decode().rstrip("=")
    return "test." + payload + ".synthetic-signature"


def claims(headers):
    payload = headers["Authorization"].split(" ", 1)[1].split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def http_error(status, code):
    return urllib.error.HTTPError("https://api.example.com/heartbeat", status, "secret-error-detail", {},
                                  io.BytesIO(json.dumps({"error": code, "private": "secret-body"}).encode()))


class HealthReportRecoveryTests(unittest.TestCase):
    def run_agent(self, *, status=409, code="stale_report", always_stale=False, next_iat=None, replay=False, frozen_wall=False, timeout=200):
        clock = [100.75]
        posts, snapshots, audiences, output = [], [], [], []
        previous = [100]  # Another valid report was accepted in this same second.
        first_proof = []
        def collect():
            snapshots.append(len(snapshots) + 1)
            return {"checks": [{"id": "api_health", "status": "ok", "value": snapshots[-1]}]}
        def metadata(path):
            audience = urllib.parse.parse_qs(path.split("?", 1)[1])["audience"][0]
            audiences.append(audience)
            iat = next_iat if len(audiences) > 1 and next_iat is not None else int(clock[0])
            if replay and first_proof:
                return first_proof[0]
            result = proof(iat, audience).encode()
            first_proof.append(result)
            return result
        def post(url, headers, body):
            payload = json.loads(body)
            signed = claims(headers)
            self.assertEqual(signed["aud"], url + "#" + hashlib.sha256(body).hexdigest())
            posts.append((payload, signed["iat"], headers["Authorization"]))
            if status != 409 or code != "stale_report":
                raise http_error(status, code)
            if always_stale or previous[0] >= signed["iat"]:
                raise http_error(409, "stale_report")
            previous[0] = signed["iat"]
            return b'{"ok":true}'
        def sleep(seconds):
            clock[0] += seconds
        with patch.dict(os.environ, ENV), patch.object(health, "collect", side_effect=collect), \
                patch.object(health, "metadata", side_effect=metadata), patch.object(health, "fetch", side_effect=post), \
                patch.object(health.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(health.time, "time", side_effect=lambda: 100.75 if frozen_wall else clock[0]), \
                patch.object(health.time, "sleep", side_effect=sleep), patch("builtins.print", side_effect=lambda value: output.append(value)):
            failure = None
            try:
                health.main() if timeout == 200 else health.main(timeout=timeout)
            except Exception as error:
                failure = error
        self.assertNotIn("secret-body", str(output) + str(failure))
        self.assertNotIn("secret-error-detail", str(output) + str(failure))
        self.assertNotIn("synthetic-signature", str(output) + str(failure))
        return posts, snapshots, audiences, output, failure

    def test_same_second_distinct_report_recollects_and_resigns_after_stale_rejection(self):
        posts, snapshots, audiences, output, failure = self.run_agent()
        self.assertIsNone(failure)
        self.assertEqual([p[1] for p in posts], [100, 101])
        self.assertEqual(snapshots, [1, 2])
        self.assertNotEqual(posts[0][0]["nonce"], posts[1][0]["nonce"])
        self.assertNotEqual(posts[0][2], posts[1][2])
        self.assertNotEqual(audiences[0], audiences[1])
        self.assertEqual([p[0]["checks"][0]["value"] for p in posts], [1, 2])
        self.assertTrue(json.loads(output[-1])["reported"])

    def test_replayed_or_older_proof_is_never_resubmitted(self):
        for iat in (100, 99):
            with self.subTest(iat=iat):
                posts, _, _, _, failure = self.run_agent(next_iat=iat)
                self.assertIsInstance(failure, ValueError)
                self.assertEqual(len(posts), 1)

    def test_identical_proof_replay_is_never_resubmitted(self):
        posts, _, _, _, failure = self.run_agent(replay=True)
        self.assertIsInstance(failure, ValueError)
        self.assertEqual(len(posts), 1)

    def test_only_exact_stale_report_409_can_retry(self):
        for status, code in [(409, "other-secret-code"), (401, "unauthorized"), (403, "unauthorized"),
                             (429, "rate_limited"), (401, "stale_report")]:
            with self.subTest(status=status, code=code):
                posts, snapshots, _, output, failure = self.run_agent(status=status, code=code)
                self.assertIsInstance(failure, ValueError)
                self.assertEqual(len(posts), 1)
                self.assertEqual(snapshots, [1])
                self.assertNotIn("other-secret-code", str(output) + str(failure))

    def test_retry_exhaustion_stays_failed_and_never_reuses_a_proof(self):
        posts, _, _, _, failure = self.run_agent(always_stale=True)
        self.assertIsInstance(failure, ValueError)
        self.assertEqual(len(posts), 2)
        self.assertNotEqual(posts[0][2], posts[1][2])

    def test_wall_clock_stall_has_a_monotonic_deadline(self):
        posts, _, _, _, failure = self.run_agent(frozen_wall=True, timeout=0.3)
        self.assertIsInstance(failure, TimeoutError)
        self.assertEqual(len(posts), 1)


    def test_budget_exhausted_during_collection_never_signs_or_submits(self):
        with patch.dict(os.environ, ENV), patch.object(health.time, "monotonic", side_effect=[0, 0, 201]), \
                patch.object(health, "collect", return_value={"checks": []}), patch.object(health, "metadata") as metadata, \
                patch.object(health, "fetch") as post:
            with self.assertRaises(TimeoutError):
                health.main()
        metadata.assert_not_called()
        post.assert_not_called()

    def test_http_timeout_is_capped_by_remaining_job_budget(self):
        opener = Mock()
        opener.open.return_value.__enter__ = Mock(return_value=Mock(read=Mock(return_value=b"{}")))
        opener.open.return_value.__exit__ = Mock(return_value=False)
        with patch.object(health, "_report_deadline", 10), patch.object(health.time, "monotonic", return_value=9.5), \
                patch.object(health.urllib.request, "build_opener", return_value=opener):
            health.fetch("https://api.example.com/health")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 0.5)
        with patch.object(health, "_report_deadline", 10), patch.object(health.time, "monotonic", return_value=10), \
                patch.object(health.urllib.request, "build_opener") as build:
            with self.assertRaises(TimeoutError):
                health.fetch("https://api.example.com/health")
        build.assert_not_called()


class HealthExecutionReceiptTests(unittest.TestCase):
    job = "ow-123456781234-health"

    def execution(self, name=None, completed=False, failed=False):
        return {"metadata": {"name": name or self.job + "-manual", "namespace": ENV["PROJECT_NUMBER"],
                             "labels": {"run.googleapis.com/job": self.job, "cloud.googleapis.com/location": ENV["REGION"]}},
                "spec": {"taskCount": 1}, "status": {"completionTime": "known" if completed else None,
                    "succeededCount": 0 if failed or not completed else 1,
                    "conditions": [{"type": "Completed", "status": "False" if failed else "True" if completed else "Unknown"}]}}

    def test_waits_only_for_own_async_execution_not_scheduler_success(self):
        calls = []
        def cloud(*args, **kwargs):
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], 30)
            calls.append(args)
            if args[:3] == ("run", "jobs", "execute"):
                self.assertIn("--async", args)
                self.assertNotIn("--wait", args)
                return self.execution()
            self.assertEqual(args[:4], ("run", "jobs", "executions", "describe"))
            self.assertEqual(args[4], self.job + "-manual")
            return self.execution(completed=len(calls) > 2)
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=cloud), \
                patch.object(runner.time, "sleep"), patch("builtins.print") as output:
            runner.verify_health_job({"health_agent": self.job})
        self.assertEqual(sum(c[:3] == ("run", "jobs", "execute") for c in calls), 1)
        self.assertIn(self.job + "-manual", str(output.call_args_list))

    def test_failed_or_foreign_execution_cannot_pass_on_any_other_success(self):
        variants = [self.execution(completed=True, failed=True), self.execution(name=self.job + "-scheduled", completed=True)]
        for field in ("namespace", "job", "region"):
            value = self.execution(completed=True)
            if field == "namespace":
                value["metadata"]["namespace"] = "other-project"
            else:
                value["metadata"]["labels"]["run.googleapis.com/job" if field == "job" else "cloud.googleapis.com/location"] = "other"
            variants.append(value)
        for value in variants:
            with self.subTest(value=value), patch.dict(os.environ, ENV), \
                    patch.object(runner, "gcloud", side_effect=[self.execution(), value]), patch("builtins.print"):
                with self.assertRaises(ValueError):
                    runner.verify_health_job({"health_agent": self.job}, timeout=1)

    def test_safe_cli_diagnostic_keeps_receipt_without_stderr_or_token(self):
        error = subprocess.CalledProcessError(1, ["gcloud"], stderr="HTTPError 403 PERMISSION_DENIED secret-token secret-body")
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=[self.execution(), error]), patch("builtins.print") as output:
            with self.assertRaises(ValueError) as raised:
                runner.verify_health_job({"health_agent": self.job})
        text = str(raised.exception) + str(output.call_args_list)
        self.assertIn(self.job + "-manual", text)
        self.assertIn("403", text)
        self.assertIn("PERMISSION_DENIED", text)
        self.assertNotIn("secret-token", text)
        self.assertNotIn("secret-body", text)

    def test_uncertain_start_is_never_replayed_and_deadline_is_bounded(self):
        error = subprocess.CalledProcessError(1, ["gcloud"], stderr="unknown secret-token")
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=error) as cloud, patch("builtins.print"):
            with self.assertRaises(ValueError):
                runner.verify_health_job({"health_agent": self.job})
        self.assertEqual(cloud.call_count, 1)
        clock = [0]
        def pending(*args, **kwargs):
            if args[:3] != ("run", "jobs", "execute"):
                clock[0] = 1
            return self.execution()
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=pending) as cloud, \
                patch.object(runner.time, "monotonic", side_effect=lambda: clock[0]), patch("builtins.print"):
            with self.assertRaises(ValueError):
                runner.verify_health_job({"health_agent": self.job}, timeout=1)
        self.assertEqual(sum(c.args[:3] == ("run", "jobs", "execute") for c in cloud.call_args_list), 1)


if __name__ == "__main__":
    unittest.main()
