import datetime
import hashlib
import importlib.util
import io
import json
import os
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


class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())

    def test_customer_state_is_retained_encrypted_and_private(self):
        bucket = self.template["Resources"]["StateBucket"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["Properties"]["VersioningConfiguration"]["Status"], "Enabled")
        self.assertTrue(all(bucket["Properties"]["PublicAccessBlockConfiguration"].values()))

    def test_no_stored_keys_no_admin_and_no_destructive_actions(self):
        variables = self.template["Resources"]["Runner"]["Properties"]["Environment"]["EnvironmentVariables"]
        self.assertFalse(any(item["Name"] in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "RUNNER_TOKEN") for item in variables))
        self.assertFalse(self.template["Resources"]["Runner"]["Properties"]["Environment"]["PrivilegedMode"])
        statements = [s for s in self.template["Resources"]["RunnerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"] if s["Effect"] == "Allow"]
        actions = [action for statement in statements for action in (statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]])]
        self.assertNotIn("*", actions)
        self.assertFalse(any(action.endswith(":*") for action in actions))
        destructive = [action for action in actions if any(word in action.split(":")[1] for word in ("Delete", "Terminate", "Remove", "Detach"))]
        # Terraform's state lock file, and replacing a certificate ACM failed to issue.
        self.assertEqual(sorted(destructive), ["acm:DeleteCertificate", "s3:DeleteObject"])
        self.assertNotIn("codebuild:StartBuild", actions)

    def test_buildspec_cannot_be_overridden_or_role_borrowed(self):
        resources = self.template["Resources"]
        trust = resources["RunnerRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Condition"]
        self.assertIn("aws:SourceArn", trust["ArnLike"])
        runner = resources["RunnerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertTrue(any(s["Effect"] == "Deny" and "codebuild:StartBuild" in s["Action"] for s in runner))
        launcher = resources["LauncherRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        denied = {key for s in launcher if s["Effect"] == "Deny" for key in s["Condition"]["Null"]}
        self.assertEqual(denied, {"codebuild:source.buildspec", "codebuild:environment.image", "codebuild:environment.privilegedMode"})


if __name__ == "__main__":
    unittest.main()
