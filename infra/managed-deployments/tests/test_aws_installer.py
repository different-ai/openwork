import datetime
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1] / "aws"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load("bootstrap", "bootstrap/bootstrap.py")
runner = load("runner", "runner/runner.py")
health = load("health_agent", "health/health_agent.py")


def archive(name="release.json", data=b"{}", symlink=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        entry = tarfile.TarInfo(name)
        entry.size = 0 if symlink else len(data)
        if symlink:
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
        tar.addfile(entry, None if symlink else io.BytesIO(data))
    return output.getvalue()


class BootstrapTests(unittest.TestCase):
    def test_checksum_verified_before_extraction(self):
        data = archive()
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
            with self.assertRaises(ValueError):
                bootstrap.download_bundle("https://release.example.test/bundle", "a" * 64, Path(directory))
            self.assertFalse((Path(directory) / "release.json").exists())

    def test_path_traversal_and_links_rejected(self):
        for data in [archive("../../escape"), archive("/absolute"), archive("link", symlink=True)]:
            with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
                with self.assertRaises(ValueError):
                    bootstrap.download_bundle("https://release.example.test/bundle", hashlib.sha256(data).hexdigest(), Path(directory))

    def test_verified_regular_file_extracted(self):
        data = archive(data=b'{"protocolVersion":1}')
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
            bootstrap.download_bundle("https://release.example.test/bundle", hashlib.sha256(data).hexdigest(), Path(directory))
            self.assertEqual(json.loads((Path(directory) / "release.json").read_text())["protocolVersion"], 1)

    def test_release_requires_https(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                bootstrap.download_bundle("http://release.example.test/bundle", "a" * 64, Path(directory))


class RetryTests(unittest.TestCase):
    def test_retries_only_when_openwork_never_handled_the_request(self):
        import urllib.error
        attempts = []
        def flaky():
            attempts.append(1)
            if len(attempts) < 3:
                raise urllib.error.HTTPError("https://api.example.test", 530, "origin unreachable", {}, None)
            return {"token": "t"}
        self.assertEqual(bootstrap.with_retries(flaky, sleep=lambda _: None), {"token": "t"})
        self.assertEqual(len(attempts), 3)
        for code in (400, 401, 404, 409, 500):
            calls = []
            def definite():
                calls.append(1)
                raise urllib.error.HTTPError("https://api.example.test", code, "no", {}, None)
            with self.assertRaises(urllib.error.HTTPError):
                bootstrap.with_retries(definite, sleep=lambda _: None)
            self.assertEqual(len(calls), 1, code)

    def test_gives_up_after_about_five_minutes(self):
        import urllib.error
        waited = []
        def down():
            raise urllib.error.URLError("connection refused")
        with self.assertRaises(urllib.error.URLError):
            bootstrap.with_retries(down, sleep=waited.append)
        self.assertTrue(240 <= sum(waited) <= 400)


class SigningTests(unittest.TestCase):
    def test_stdlib_signature_matches_botocore(self):
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.credentials import Credentials
        credentials = ("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "session-token")
        proof = "enroll:run:challenge"
        request = AWSRequest(method="POST", url="https://sts.us-east-1.amazonaws.com/", data=bootstrap.STS_BODY,
                             headers={"Content-Type": bootstrap.STS_CONTENT_TYPE, "x-openwork-proof": proof})
        SigV4Auth(Credentials(*credentials), "sts", "us-east-1").add_auth(request)
        amz_date = request.headers["X-Amz-Date"]
        now = datetime.datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
        ours = bootstrap.signed_identity(proof, "us-east-1", credentials, now)
        self.assertEqual(ours["authorization"], request.headers["Authorization"])
        self.assertEqual(ours["x-amz-date"], amz_date)
        self.assertIn("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof", ours["authorization"])

    def test_installer_imports_only_the_standard_library(self):
        import ast, sys
        for path in ["bootstrap/bootstrap.py", "runner/runner.py"]:
            tree = ast.parse((ROOT / path).read_text())
            modules = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
            modules |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
            self.assertTrue(modules <= set(sys.stdlib_module_names), f"{path}: {sorted(modules - set(sys.stdlib_module_names))}")

    def test_buildspec_installs_nothing(self):
        template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())
        buildspec = json.loads(template["Resources"]["Runner"]["Properties"]["Source"]["BuildSpec"])
        self.assertNotIn("install", buildspec["phases"])
        self.assertNotIn("pip", json.dumps(buildspec["phases"]["build"]["commands"][:2]))


class RunnerTests(unittest.TestCase):
    def test_data_bearing_resources_are_never_replaced_automatically(self):
        plan = {"resource_changes": [
            {"address": "module.platform.aws_ecs_task_definition.api", "type": "aws_ecs_task_definition", "change": {"actions": ["delete", "create"]}},
            {"address": "module.platform.aws_db_instance.this[0]", "type": "aws_db_instance", "change": {"actions": ["delete", "create"]}},
            {"address": "module.platform.aws_secretsmanager_secret.app", "type": "aws_secretsmanager_secret", "change": {"actions": ["update"]}},
        ]}
        self.assertEqual(runner.unsafe_changes(plan), ["module.platform.aws_db_instance.this[0]"])

    def test_updates_that_replace_stateless_resources_are_allowed(self):
        plan = {"resource_changes": [{"address": "x", "type": "aws_lambda_function", "change": {"actions": ["delete", "create"]}}]}
        self.assertEqual(runner.unsafe_changes(plan), [])

    @staticmethod
    def tls_upgrade():
        old = {"DATABASE_URL": "mysql://app:unchanged@db.example.test:3306/openwork?sslaccept=accept",
               "BETTER_AUTH_SECRET": "auth-unchanged", "DEN_DB_ENCRYPTION_KEY": "encryption-unchanged",
               "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE": "bootstrap-unchanged", "SMTP_PASS": "smtp-unchanged"}
        new = {**old, "DATABASE_URL": old["DATABASE_URL"].replace("sslaccept=accept", "sslaccept=strict")}
        before = {"secret_id": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ow-test-den-app",
                  "secret_string": json.dumps(old), "version_stages": ["AWSCURRENT"], "secret_binary": "",
                  "has_secret_string_wo": False}
        return {"address": "module.platform.aws_secretsmanager_secret_version.app",
                "type": "aws_secretsmanager_secret_version", "change": {
                    "actions": ["delete", "create"], "before": before,
                    "after": {**before, "secret_string": json.dumps(new), "version_stages": None},
                    "after_unknown": {"version_id": True, "version_stages": True}}}

    def test_tls_upgrade_accepts_provider_empty_binary_absence(self):
        # AWS 5.100's real retained state uses "" for absent binary, not null.
        for before in [None, ""]:
            for after in [None, ""]:
                resource = self.tls_upgrade()
                resource["change"]["before"]["secret_binary"] = before
                resource["change"]["after"]["secret_binary"] = after
                with self.subTest(before=before, after=after):
                    self.assertTrue(runner.tls_only_secret_upgrade(resource))
        for side in ["before", "after"]:
            resource = self.tls_upgrade()
            resource["change"][side]["secret_binary"] = "nonempty-binary-payload"
            with self.subTest(binary_side=side):
                self.assertFalse(runner.tls_only_secret_upgrade(resource))
        # Other observed metadata keeps its original constraints: stages is an
        # AWSCURRENT array and the write-only marker is false, not coerced text.
        self.assertEqual(self.tls_upgrade()["change"]["before"]["version_stages"], ["AWSCURRENT"])
        self.assertIs(self.tls_upgrade()["change"]["before"]["has_secret_string_wo"], False)

    def test_only_exact_tls_secret_upgrade_is_allowed(self):
        resource = self.tls_upgrade()
        self.assertTrue(runner.tls_only_secret_upgrade(resource))
        self.assertEqual(runner.unsafe_changes({"resource_changes": [resource]}), [])
        # An allowed version update never exempts deletion of its parent or DB.
        protected = {"address": "module.platform.aws_secretsmanager_secret.app", "type": "aws_secretsmanager_secret",
                     "change": {"actions": ["delete", "create"]}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [resource, protected]}), [protected["address"]])

    def test_tls_upgrade_refuses_key_rotation_or_database_identity_changes(self):
        for key in ["BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE", "SMTP_PASS"]:
            resource = self.tls_upgrade()
            values = json.loads(resource["change"]["after"]["secret_string"])
            values[key] = "rotated"
            resource["change"]["after"]["secret_string"] = json.dumps(values)
            with self.subTest(key=key):
                self.assertFalse(runner.tls_only_secret_upgrade(resource))
        for old, new in [("app:", "other:"), (":unchanged@", ":new-password@"),
                         ("db.example.test", "other.example.test"), ("/openwork?", "/other?"),
                         (":3306/", ":3307/"), ("sslaccept=strict", "sslaccept=accept")]:
            resource = self.tls_upgrade()
            resource["change"]["after"]["secret_string"] = resource["change"]["after"]["secret_string"].replace(old, new)
            with self.subTest(database_change=old):
                self.assertFalse(runner.tls_only_secret_upgrade(resource))

    def test_tls_upgrade_fails_closed_on_unknown_or_nonstandard_plans(self):
        candidates = []
        for field, value in [("secret_string", None), ("secret_string", "not-json"), ("secret_string", "[]"),
                             ("secret_string", "{}"), ("secret_id", "different"), ("secret_binary", "binary"),
                             ("version_stages", ["CUSTOM"]), ("has_secret_string_wo", True)]:
            resource = self.tls_upgrade()
            resource["change"]["after"][field] = value
            candidates.append(resource)
        for field in ["secret_string", "secret_id", "secret_binary"]:
            resource = self.tls_upgrade()
            resource["change"]["after_unknown"][field] = True
            candidates.append(resource)
        for stages in [None, [], ["AWSPREVIOUS"], ["AWSCURRENT", "CUSTOM"]]:
            resource = self.tls_upgrade()
            resource["change"]["before"]["version_stages"] = stages
            candidates.append(resource)
        for key, value in [("address", "module.other.aws_secretsmanager_secret_version.app"), ("type", "aws_db_instance")]:
            resource = self.tls_upgrade()
            resource[key] = value
            candidates.append(resource)
        for actions in [["delete"], ["create", "delete"], ["update"]]:
            resource = self.tls_upgrade()
            resource["change"]["actions"] = actions
            candidates.append(resource)
        for resource in candidates:
            with self.subTest(resource=resource["address"], actions=resource["change"]["actions"]):
                self.assertFalse(runner.tls_only_secret_upgrade(resource))

    def test_real_apply_guard_allows_only_the_saved_tls_upgrade(self):
        for rotate in [False, True]:
            resource = self.tls_upgrade()
            if rotate:
                resource["change"]["after"]["secret_string"] = resource["change"]["after"]["secret_string"].replace("auth-unchanged", "rotated")
            with tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, {"DEPLOYMENT_ID": "test", "STATE_BUCKET": "state", "AWS_REGION": "us-east-1"}), \
                    patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "terraform_inputs", return_value={}), \
                    patch.object(runner, "certificate_states", return_value={}), \
                    patch.object(runner, "tls_redeploy"), \
                    patch.object(runner.subprocess, "run") as run, \
                    patch.object(runner.subprocess, "check_output", side_effect=[json.dumps({"resource_changes": [resource]}), json.dumps({"cluster_name": {"value": "owned"}, "service_names": {"value": {}}, "task_definition_arns": {"value": {}}})]):
                if rotate:
                    with self.assertRaisesRegex(ValueError, "manual review"):
                        runner.apply(Path(directory), Path(directory))
                else:
                    self.assertEqual(runner.apply(Path(directory), Path(directory)), {"cluster_name": "owned", "service_names": {}, "task_definition_arns": {}})
                self.assertEqual(any(call.args[0][1] == "apply" for call in run.call_args_list), not rotate)

    def test_health_rejects_unexpected_origins(self):
        with patch.dict(os.environ, {"DOMAIN_NAME": "den.example.test"}):
            with self.assertRaises(ValueError):
                runner.verify_health({"web_url": "https://attacker.example.test", "api_url": "https://api.den.example.test"}, attempts=1, delay=0)


    def test_failed_certificates_are_replaced_on_retry(self):
        state = {"values": {"root_module": {"child_modules": [{"resources": [
            {"address": "module.platform.aws_acm_certificate.this[0]", "mode": "managed", "type": "aws_acm_certificate", "values": {"arn": "arn:cert"}}]}]}}}
        with patch.object(runner.subprocess, "check_output", return_value=json.dumps(state)), \
             patch.object(runner, "aws", return_value={"Certificate": {"Status": "FAILED"}}):
            states = runner.certificate_states("terraform", Path("."))
        self.assertEqual(states, {"module.platform.aws_acm_certificate.this[0]": "FAILED"})
        self.assertIn("FAILED", runner.UNRECOVERABLE_CERTIFICATE_STATES)


class TlsLifecycleTests(unittest.TestCase):
    EXPECTED = {
        "den-api": "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork-den-api:2",
        "den-web": "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork-den-web:2",
    }
    ENV = {"TLS_CLUSTER": "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den",
           "TLS_TASK_DEFINITIONS": json.dumps(EXPECTED)}

    @classmethod
    def settled(cls):
        return {"services": [{"serviceName": name, "taskDefinition": arn,
                "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
                "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": arn}]}
                for name, arn in cls.EXPECTED.items()]}

    def test_final_tls_deployment_only_uses_existing_ecs_permissions(self):
        def call(*args):
            return self.settled() if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call) as aws:
            runner.tls_redeploy()
        operations = [call.args[:2] for call in aws.call_args_list]
        self.assertEqual(operations, [("ecs", "describe-services"), ("ecs", "update-service"),
                                     ("ecs", "update-service"), ("ecs", "wait"), ("ecs", "describe-services")])
        for call in aws.call_args_list:
            self.assertNotIn("deregister-task-definition", call.args)
            if call.args[:2] == ("ecs", "update-service"):
                self.assertIn("--force-new-deployment", call.args)
        template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())
        actions = {action for statement in runner_statements(template, "dedicated")
                   if statement["Effect"] == "Allow"
                   for action in (statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]])}
        self.assertIn("ecs:UpdateService", actions)
        self.assertIn("ecs:Describe*", actions)

    def test_ca_barrier_only_waits_and_checks_completed_revision(self):
        def call(*args):
            return self.settled() if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call) as aws:
            runner.tls_redeploy(force=False)
        self.assertEqual([call.args[:2] for call in aws.call_args_list], [("ecs", "wait"), ("ecs", "describe-services")])

    def test_pre_force_waits_for_in_progress_then_completed(self):
        pending = self.settled()
        pending["services"][0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        descriptions = [pending, self.settled(), self.settled()]
        def call(*args):
            return descriptions.pop(0) if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call) as aws, patch.object(runner.time, "sleep") as poll:
            runner.tls_redeploy()
        poll.assert_called_once_with(3)
        self.assertEqual([c.args[:2] for c in aws.call_args_list], [
            ("ecs", "describe-services"), ("ecs", "describe-services"),
            ("ecs", "update-service"), ("ecs", "update-service"),
            ("ecs", "wait"), ("ecs", "describe-services")])

    def test_pre_force_in_progress_then_failed_or_rollback_never_forces(self):
        for outcome in ("FAILED", "rollback"):
            pending = self.settled()
            pending["services"][0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
            terminal = self.settled()
            if outcome == "FAILED":
                terminal["services"][0]["deployments"][0]["rolloutState"] = "FAILED"
            else:
                terminal["services"][0]["taskDefinition"] = self.EXPECTED["den-api"].replace(":2", ":1")
            descriptions = [pending, terminal]
            def call(*args):
                return descriptions.pop(0) if args[:2] == ("ecs", "describe-services") else {}
            with self.subTest(outcome=outcome), patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call) as aws, patch.object(runner.time, "sleep") as poll:
                with self.assertRaisesRegex(ValueError, "left its expected CA revision"):
                    runner.tls_redeploy()
            poll.assert_called_once_with(3)
            self.assertEqual([c.args[:2] for c in aws.call_args_list], [("ecs", "describe-services"), ("ecs", "describe-services")])

    def test_pre_force_pending_timeout_never_forces(self):
        pending = self.settled()
        pending["services"][0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", return_value=pending) as aws, \
                patch.object(runner.time, "monotonic", side_effect=[0, 121]), patch.object(runner.time, "sleep") as poll:
            with self.assertRaisesRegex(ValueError, "not complete"):
                runner.tls_redeploy()
        poll.assert_not_called()
        self.assertEqual([c.args[:2] for c in aws.call_args_list], [("ecs", "describe-services")])

    def test_post_force_waits_for_completed_rollout_not_counts_alone(self):
        pending = self.settled()
        pending["services"][0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        descriptions = [self.settled(), pending, self.settled()]
        def call(*args):
            return descriptions.pop(0) if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call), patch.object(runner.time, "sleep") as poll:
            runner.tls_redeploy()
        poll.assert_called_once_with(3)

    def test_failed_wait_cannot_pass_on_healthy_old_replicas(self):
        def call(*args):
            if args[:2] == ("ecs", "wait"):
                raise subprocess.CalledProcessError(255, ["aws", "ecs", "wait"])
            return self.settled() if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call) as aws:
            with self.assertRaises(subprocess.CalledProcessError):
                runner.tls_redeploy()
        self.assertEqual(sum(call.args[:2] == ("ecs", "describe-services") for call in aws.call_args_list), 1)

    def test_pending_rollout_deadline_fails_without_a_success_result(self):
        pending = self.settled()
        pending["services"][0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        descriptions = [self.settled(), pending]
        def call(*args):
            return descriptions.pop(0) if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call), \
                patch.object(runner.time, "monotonic", side_effect=[0, 0, 121]), patch.object(runner.time, "sleep") as poll:
            with self.assertRaises(ValueError):
                runner.tls_redeploy()
        poll.assert_not_called()

    def test_wrong_revision_or_incomplete_deployment_fails_before_force(self):
        for mutation in ["revision", "pending", "rollback", "overlap"]:
            state = self.settled()
            if mutation == "revision":
                state["services"][0]["taskDefinition"] = self.EXPECTED["den-api"].replace(":2", ":1")
            elif mutation == "pending":
                state["services"][0]["pendingCount"] = 1
            elif mutation == "rollback":
                state["services"][0]["deployments"][0]["rolloutState"] = "FAILED"
            else:
                state["services"][0]["deployments"].append({"status": "ACTIVE"})
            with self.subTest(mutation=mutation), patch.dict(os.environ, self.ENV), patch.object(runner, "aws", return_value=state) as aws, \
                    patch.object(runner.time, "monotonic", side_effect=[0, 121]):
                with self.assertRaises(ValueError):
                    runner.tls_redeploy()
                self.assertEqual(aws.call_count, 1)

    def test_failed_post_force_state_fails_the_run(self):
        descriptions = [self.settled(), self.settled()]
        descriptions[1]["services"][1]["deployments"][0]["rolloutState"] = "FAILED"
        def call(*args):
            return descriptions.pop(0) if args[:2] == ("ecs", "describe-services") else {}
        with patch.dict(os.environ, self.ENV), patch.object(runner, "aws", side_effect=call):
            with self.assertRaises(ValueError):
                runner.tls_redeploy()

    def test_new_strict_version_still_preserves_existing_current_keys(self):
        transition = RunnerTests.tls_upgrade()["change"]
        seed = {"address": "module.platform.aws_secretsmanager_secret_version.app", "type": "aws_secretsmanager_secret_version",
                "change": {"actions": ["no-op"], "before": transition["before"], "after": transition["before"]}}
        target = {"address": "module.platform.aws_secretsmanager_secret_version.tls", "type": "aws_secretsmanager_secret_version",
                  "change": {"actions": ["create"], "before": None, "after": transition["after"], "after_unknown": transition["after_unknown"]}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [seed, target]}), [])
        self.assertEqual(runner.unsafe_changes({"resource_changes": [target]}), [target["address"]])
        rotated = json.loads(json.dumps(target))
        rotated["change"]["after"]["secret_string"] = rotated["change"]["after"]["secret_string"].replace("auth-unchanged", "rotated")
        self.assertEqual(runner.unsafe_changes({"resource_changes": [seed, rotated]}), [target["address"]])
        unknown = json.loads(json.dumps(target))
        unknown["change"]["after_unknown"]["secret_string"] = True
        self.assertEqual(runner.unsafe_changes({"resource_changes": [seed, unknown]}), [target["address"]])
        fresh = {**seed, "change": {"actions": ["create"], "before": None, "after": None, "after_unknown": {"secret_string": True}}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [fresh, target]}), [target["address"]])
        parent = {"address": "module.platform.aws_secretsmanager_secret.app", "type": "aws_secretsmanager_secret",
                  "change": {"actions": ["create"], "before": None}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [parent, fresh, target]}), [])

    def test_forget_plan_is_not_a_protected_deletion(self):
        changes = [{"address": "module.platform.aws_ecs_task_definition." + name,
                    "type": "aws_ecs_task_definition", "change": {"actions": ["forget"], "before": {"skip_destroy": False}, "after": None}}
                   for name in ["api", "web"]]
        self.assertEqual(runner.unsafe_changes({"resource_changes": changes}), [])
        changes.append({"address": "module.platform.aws_db_instance.this[0]", "type": "aws_db_instance",
                        "change": {"actions": ["delete", "create"]}})
        self.assertEqual(runner.unsafe_changes({"resource_changes": changes}), ["module.platform.aws_db_instance.this[0]"])

    def test_real_terraform_forget_future_update_and_ordering_graph(self):
        terraform = shutil.which("terraform")
        if not terraform:
            self.skipTest("Terraform is installed by the managed-deployments workflow")
        tf_root = ROOT / "terraform"
        result = subprocess.run([terraform, "test", "-json", "-verbose", "-filter=tests/lifecycle.tftest.hcl"],
                                cwd=tf_root, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        plans = {row["@testrun"]: row["test_plan"] for row in map(json.loads, result.stdout.splitlines())
                 if row.get("type") == "test_plan"}
        upgrade = plans["upgrade_forgets_legacy_and_creates_retained_ca_revisions"]["resource_changes"]
        changes = {r["address"]: r["change"] for r in upgrade}
        for resource in upgrade:
            if resource["type"] in runner.PROTECTED_TYPES or resource["type"] in ("aws_lb", "aws_ecs_cluster"):
                self.assertNotIn("delete", resource["change"]["actions"], resource["address"])
                self.assertNotIn("forget", resource["change"]["actions"], resource["address"])
        for address in ("aws_db_instance.this[0]", "aws_db_subnet_group.this[0]", "aws_secretsmanager_secret.app", "aws_lb.this[0]", "aws_ecs_cluster.this[0]"):
            self.assertEqual(changes[address]["before"]["id"], changes[address]["after"]["id"], address)
        for address in ("aws_secretsmanager_secret_version.app", "aws_secretsmanager_secret_version.tls[0]"):
            self.assertEqual(changes[address]["actions"], ["no-op"], address)
            self.assertEqual(changes[address]["before"]["secret_string"], changes[address]["after"]["secret_string"], address)
        for name in ("better_auth", "db_encryption", "bootstrap_code"):
            resource = next(r for r in upgrade if r["address"] == f"random_password.{name}[0]")
            self.assertEqual(resource["previous_address"], f"random_password.{name}")
            self.assertEqual(resource["change"]["before"]["result"], resource["change"]["after"]["result"])
        self.assertEqual(next(r for r in upgrade if r["address"] == "aws_secretsmanager_secret_version.tls[0]")["previous_address"], "aws_secretsmanager_secret_version.tls")
        for name in ["api", "web"]:
            old = changes["aws_ecs_task_definition." + name]
            self.assertEqual(old["actions"], ["forget"])
            self.assertIs(old["before"]["skip_destroy"], False)
            self.assertIsNone(old["after"])
            retained = next(r for r in upgrade if r["address"] == f"aws_ecs_task_definition.{name}_v1")
            self.assertEqual(retained["previous_address"], f"aws_ecs_task_definition.{name}_ca")
            self.assertTrue(retained["change"]["before"]["skip_destroy"])
            self.assertTrue(retained["change"]["after"]["skip_destroy"])
        future = {r["address"]: r["change"] for r in plans["future_update_replaces_only_retained_ca_definitions"]["resource_changes"]}
        for name in ["api_v1", "web_v1"]:
            change = future["aws_ecs_task_definition." + name]
            self.assertEqual(set(change["actions"]), {"delete", "create"})
            self.assertIs(change["before"]["skip_destroy"], True)
            self.assertIs(change["after"]["skip_destroy"], True)
        with tempfile.TemporaryDirectory() as directory:
            wrapper = Path(directory)
            source = json.dumps(str(ROOT.parents[1] / "terraform/modules/openwork-aws-ecs"))
            (wrapper / "main.tf").write_text('''terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.69" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
    http = { source = "hashicorp/http", version = "= 3.6.2" }
  }
}
module "platform" {
  source = ''' + source + '''
  openwork_version = "0.18.58"
  write_only_secrets = false
  managed_legacy_secrets = true
  owner_emails = ["admin@example.com"]
  domain_name = "openwork.example.com"
  vpc_id = "vpc-test"
  alb_subnet_ids = ["subnet-a", "subnet-b"]
  service_subnet_ids = ["subnet-a", "subnet-b"]
  certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/test"
}
''')
            init = subprocess.run([terraform, "init", "-backend=false", "-input=false", "-no-color",
                                   "-plugin-dir=" + str(tf_root / ".terraform/providers")],
                                  cwd=wrapper, capture_output=True, text=True, timeout=120)
            self.assertEqual(init.returncode, 0, init.stderr)
            graph = subprocess.check_output([terraform, "graph", "-type=plan"], cwd=wrapper, text=True, timeout=60)
        edges = re.findall(r'"([^"]+)" -> "([^"]+)"', graph)
        nodes = {node for edge in edges for node in edge}
        def node(name):
            return next(n for n in nodes if n.endswith("module.platform." + name + " (expand)"))
        adjacency = {}
        for start, end in edges:
            adjacency.setdefault(start, set()).add(end)
        def reaches(start, end):
            pending, visited = [node(start)], set()
            while pending:
                current = pending.pop()
                if current == node(end):
                    return True
                if current not in visited:
                    visited.add(current)
                    pending.extend(adjacency.get(current, set()))
            return False
        self.assertTrue(reaches("aws_lambda_invocation.migrate", "aws_secretsmanager_secret_version.tls"))
        self.assertTrue(reaches("aws_secretsmanager_secret_version.tls", "aws_secretsmanager_secret_version.app"))
        for name in ["api", "web", "migrate"]:
            self.assertTrue(reaches("aws_secretsmanager_secret_version.tls", "aws_ecs_task_definition." + name + "_v1"))
        for name in ["api", "web"]:
            self.assertTrue(reaches("aws_ecs_service." + name, "terraform_data.migration_complete"))
            self.assertTrue(reaches("aws_ecs_service." + name, "aws_ecs_task_definition." + name + "_v1"))
            self.assertFalse(reaches("aws_secretsmanager_secret_version.tls", "aws_ecs_service." + name))

    def test_runtime_markers_validate_actual_uri_and_ca_without_leaking_values(self):
        source = (ROOT.parents[1] / "terraform/modules/openwork-aws-ecs/security.tf").read_text()
        script = re.search(r"tls_check = <<-JS\n(.*?)\n  JS", source, re.S).group(1)
        certificate = subprocess.check_output(["node", "-e", "process.stdout.write(require('node:tls').rootCertificates[0])"], text=True)
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "public-ca.pem"
            ca.write_text(certificate)
            for query, expected in [("sslaccept=accept", None), ("sslaccept=strict", "strict"),
                                    ("sslmode=verify-full", "strict"), ("sslaccept=strict&sslaccept=accept", None)]:
                env = {"PATH": os.environ["PATH"], "NODE_EXTRA_CA_CERTS": str(ca),
                       "DATABASE_URL": "mysql://unit:DO-NOT-PRINT@db.example.test:3306/app?" + query}
                result = subprocess.run(["node", "-e", script], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if expected else 1)
                if expected:
                    self.assertEqual(result.stdout.strip(), "OPENWORK_MANAGED_DB_TLS mode=" + expected + " ca=validated")
                self.assertNotIn("DO-NOT-PRINT", result.stdout + result.stderr)
                self.assertNotIn("db.example.test", result.stdout + result.stderr)
            ca.write_text("not a certificate")
            env["DATABASE_URL"] = "mysql://unit:DO-NOT-PRINT@db.example.test:3306/app?sslaccept=strict"
            result = subprocess.run(["node", "-e", script], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)


class NetworkTests(unittest.TestCase):
    VPC = {"VpcId": "vpc-1", "State": "available"}
    DNS = {"support": True, "hostnames": True}
    INPUTS = {"service_subnet_ids": ["subnet-p1", "subnet-p2"], "load_balancer_subnet_ids": ["subnet-a1", "subnet-a2"], "ecs_cluster_arn": ""}

    def subnets(self):
        return [{"SubnetId": sid, "VpcId": "vpc-1", "AvailabilityZone": az} for sid, az in
                (("subnet-p1", "a"), ("subnet-p2", "b"), ("subnet-a1", "a"), ("subnet-a2", "b"))]

    def tables(self, private_target=None):
        private_target = private_target or {"NatGatewayId": "nat-1"}
        return [
            {"Associations": [{"Main": True}], "Routes": []},
            {"Associations": [{"SubnetId": "subnet-a1"}, {"SubnetId": "subnet-a2"}], "Routes": [{"DestinationCidrBlock": "0.0.0.0/0", "GatewayId": "igw-1", "State": "active"}]},
            {"Associations": [{"SubnetId": "subnet-p1"}, {"SubnetId": "subnet-p2"}], "Routes": [{"DestinationCidrBlock": "0.0.0.0/0", "State": "active", **private_target}]},
        ]

    def test_a_ready_network_passes(self):
        self.assertEqual(runner.network_problems(self.VPC, self.DNS, self.subnets(), self.tables(), None, self.INPUTS), [])
        cluster = {"status": "ACTIVE"}
        self.assertEqual(runner.network_problems(self.VPC, self.DNS, self.subnets(), self.tables({"TransitGatewayId": "tgw-1"}), cluster, {**self.INPUTS, "ecs_cluster_arn": "arn"}), [])

    def test_explains_each_problem(self):
        self.assertIn("VPC was not found", runner.network_problems(None, {}, [], [], None, self.INPUTS)[0])
        self.assertIn("DNS", runner.network_problems(self.VPC, {"support": True, "hostnames": False}, self.subnets(), self.tables(), None, self.INPUTS)[0])
        one_zone = [{**subnet, "AvailabilityZone": "a"} for subnet in self.subnets()]
        self.assertTrue(any("two availability zones" in p for p in runner.network_problems(self.VPC, self.DNS, one_zone, self.tables(), None, self.INPUTS)))
        public_services = runner.network_problems(self.VPC, self.DNS, self.subnets(), self.tables({"GatewayId": "igw-1"}), None, self.INPUTS)
        self.assertTrue(any("needs outbound internet" in p for p in public_services))
        swapped = runner.network_problems(self.VPC, self.DNS, self.subnets(), self.tables(), None,
                                          {**self.INPUTS, "load_balancer_subnet_ids": ["subnet-p1", "subnet-p2"], "service_subnet_ids": ["subnet-a1", "subnet-a2"]})
        self.assertTrue(any("is not public" in p for p in swapped))
        other_vpc = [{**subnet, "VpcId": "vpc-2"} for subnet in self.subnets()]
        self.assertTrue(any("must exist in the VPC" in p for p in runner.network_problems(self.VPC, self.DNS, other_vpc, self.tables(), None, self.INPUTS)))
        inactive = runner.network_problems(self.VPC, self.DNS, self.subnets(), self.tables(), {"status": "INACTIVE"}, {**self.INPUTS, "ecs_cluster_arn": "arn"})
        self.assertTrue(any("ECS cluster" in p for p in inactive))

    def test_inputs_reach_terraform(self):
        env = {"NETWORK_MODE": "existing", "VPC_ID": "vpc-1", "SERVICE_SUBNET_IDS": "subnet-p1,subnet-p2",
               "LOAD_BALANCER_SUBNET_IDS": "subnet-a1,subnet-a2", "ECS_CLUSTER_ARN": ""}
        with patch.dict(os.environ, env):
            self.assertEqual(runner.network_inputs()["service_subnet_ids"], ["subnet-p1", "subnet-p2"])
        with patch.dict(os.environ, {"NETWORK_MODE": "dedicated"}):
            self.assertEqual(runner.network_inputs(), {"network_mode": "dedicated"})


class HealthAgentTests(unittest.TestCase):
    def test_reports_contain_only_allowlisted_fields(self):
        result = health.check("services_running", "failing", value=1, total=2, code="not_running")
        self.assertEqual(set(result), {"id", "status", "value", "total", "code"})
        self.assertEqual(health.check("api_health", "ok", value=5_000_000_000)["value"], 1_000_000_000)

    def test_service_counts(self):
        ecs = MagicMock()
        services = {"den_api": "den-api", "den_web": "den-web"}
        def described(web_running, web_desired):
            return {"services": [{"serviceName": "den-api", "status": "ACTIVE", "runningCount": 1, "desiredCount": 1},
                                 {"serviceName": "den-web", "status": "ACTIVE", "runningCount": web_running, "desiredCount": web_desired}]}
        ecs.describe_services.return_value = described(0, 1)
        result = health.services_check(ecs, "cluster", services)
        self.assertEqual((result["status"], result["value"], result["total"], result["code"]), ("failing", 1, 2, "not_running"))
        # Found live: a service scaled to zero must not count as healthy.
        ecs.describe_services.return_value = described(0, 0)
        self.assertEqual(health.services_check(ecs, "cluster", services)["status"], "failing")
        ecs.describe_services.return_value = described(1, 1)
        self.assertEqual(health.services_check(ecs, "cluster", services)["status"], "ok")

    def test_each_route_needs_a_healthy_target(self):
        elb = MagicMock()
        elb.describe_target_health.side_effect = lambda TargetGroupArn: {"TargetHealthDescriptions": [{"TargetHealth": {"State": "healthy"}}] if TargetGroupArn == "api" else []}
        result = health.targets_check(elb, {"den_api": "api", "den_web": "web"})
        self.assertEqual((result["status"], result["value"], result["total"]), ("warning", 1, 2))

    def test_certificate_expiry_warning(self):
        acm = MagicMock()
        now = datetime.datetime(2026, 10, 8, tzinfo=datetime.timezone.utc)
        acm.describe_certificate.return_value = {"Certificate": {"Status": "ISSUED", "NotAfter": now + datetime.timedelta(days=10)}}
        result = health.certificate_check(acm, "arn", now)
        self.assertEqual((result["status"], result["code"]), ("warning", "expiring"))

    def test_access_denied_is_unknown_not_healthy(self):
        error = Exception("denied")
        error.response = {"Error": {"Code": "AccessDeniedException"}}
        def fail():
            raise error
        self.assertEqual(health.guarded("certificate", fail), {"id": "certificate", "status": "unknown", "code": "permission_denied"})

    def test_signature_binds_body(self):
        credentials = MagicMock()
        credentials.get_frozen_credentials.return_value = type("C", (), {"access_key": "AKIDEXAMPLE", "secret_key": "secret", "token": "token"})()
        with patch.dict(os.environ, {"DEPLOYMENT_ID": "00000000-0000-4000-8000-000000000001"}), patch.object(health.boto3, "Session") as session:
            session.return_value.get_credentials.return_value = credentials
            headers = health.identity_headers(b'{"checks":[]}', "us-east-1")
        self.assertEqual(headers["X-OpenWork-Proof"], "heartbeat:00000000-0000-4000-8000-000000000001:" + hashlib.sha256(b'{"checks":[]}').hexdigest())
        self.assertIn("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof", headers["X-OpenWork-Aws-Authorization"])


def runner_statements(template, mode):
    """The runner policy as CloudFormation resolves it for one network mode."""
    conditions = {"IsDedicated": mode == "dedicated", "IsExisting": mode == "existing"}
    resolved = []
    for statement in template["Resources"]["RunnerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]:
        if "Fn::If" in statement:
            condition, then, otherwise = statement["Fn::If"]
            statement = then if conditions[condition] else otherwise
            if statement == {"Ref": "AWS::NoValue"}:
                continue
        resolved.append(statement)
    return resolved


def actions_of(statement):
    return statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]]


class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())

    def test_fits_inline_template_limit(self):
        self.assertLess(len((ROOT / "bootstrap/cloudformation.json").read_bytes()), 51_200)

    def test_existing_network_changes_only_this_deployments_resources(self):
        statements = [s for s in runner_statements(self.template, "existing") if s["Effect"] == "Allow"]
        actions = {action for statement in statements for action in actions_of(statement)}
        for network_action in ("ec2:CreateVpc", "ec2:CreateSubnet", "ec2:CreateNatGateway", "ec2:CreateRoute", "ec2:AllocateAddress"):
            self.assertNotIn(network_action, actions)
        for statement in statements:
            mutating = [a for a in actions_of(statement) if not a.split(":")[1].startswith(("Describe", "List", "Get"))]
            unscoped = statement["Resource"] == "*"
            allowed_unscoped = {"ecs:RegisterTaskDefinition", "acm:RequestCertificate", "acm:AddTagsToCertificate", "route53:CreateHostedZone",
                                "servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:CreateService", "servicediscovery:TagResource"}
            conditioned = any(key in json.dumps(statement.get("Condition", {})) for key in ("ResourceTag/Deployment", "ec2:CreateAction"))
            if unscoped and not conditioned:
                self.assertEqual(set(mutating) - allowed_unscoped, set(), statement["Sid"])
        security_groups = next(s for s in statements if s["Sid"] == "OwnSecurityGroups")
        self.assertIn("aws:ResourceTag/Deployment", security_groups["Condition"]["StringEquals"])
        new_groups = next(s for s in statements if s["Sid"] == "NewSecurityGroups")
        self.assertIn("aws:RequestTag/Deployment", new_groups["Condition"]["StringEquals"])

    def test_dedicated_account_can_build_its_network(self):
        actions = {a for s in runner_statements(self.template, "dedicated") for a in actions_of(s)}
        self.assertTrue({"ec2:CreateVpc", "ec2:CreateNatGateway", "ec2:CreateSecurityGroup"} <= actions)

    def test_customer_state_is_retained_encrypted_and_private(self):
        bucket = self.template["Resources"]["StateBucket"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["Properties"]["VersioningConfiguration"]["Status"], "Enabled")
        self.assertTrue(all(bucket["Properties"]["PublicAccessBlockConfiguration"].values()))

    def test_no_stored_keys_no_admin_and_no_destructive_actions(self):
        variables = self.template["Resources"]["Runner"]["Properties"]["Environment"]["EnvironmentVariables"]
        self.assertFalse(any(item["Name"] in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "RUNNER_TOKEN") for item in variables))
        self.assertFalse(self.template["Resources"]["Runner"]["Properties"]["Environment"]["PrivilegedMode"])
        statements = [s for mode in ("dedicated", "existing") for s in runner_statements(self.template, mode) if s["Effect"] == "Allow"]
        actions = [action for statement in statements for action in actions_of(statement)]
        self.assertNotIn("*", actions)
        self.assertFalse(any(action.endswith(":*") for action in actions))
        destructive = [action for action in actions if any(word in action.split(":")[1] for word in ("Delete", "Terminate", "Remove", "Detach"))]
        # Terraform's state lock file, and replacing a certificate ACM failed to issue.
        self.assertEqual(sorted(set(destructive)), ["acm:DeleteCertificate", "s3:DeleteObject"])
        self.assertNotIn("codebuild:StartBuild", actions)

    def test_buildspec_cannot_be_overridden_or_role_borrowed(self):
        resources = self.template["Resources"]
        trust = resources["RunnerRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Condition"]
        self.assertIn("aws:SourceArn", trust["ArnLike"])
        for mode in ("dedicated", "existing"):
            runner_policy = runner_statements(self.template, mode)
            self.assertTrue(any(s["Effect"] == "Deny" and "codebuild:StartBuild" in s["Action"] for s in runner_policy))
        launcher = resources["LauncherRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        denied = {key for s in launcher if s["Effect"] == "Deny" for key in s["Condition"]["Null"]}
        self.assertEqual(denied, {"codebuild:source.buildspec", "codebuild:environment.image", "codebuild:environment.privilegedMode"})


if __name__ == "__main__":
    unittest.main()
