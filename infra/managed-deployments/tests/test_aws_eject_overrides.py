"""Tune (overrides.json), take over (applied/ and ejected.json) on AWS; no cloud calls."""
import contextlib
import functools
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
SPEC = importlib.util.spec_from_file_location("eject_overrides_runner", ROOT / "aws/runner/runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

DEPLOYMENT = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
COMPACT = DEPLOYMENT.replace("-", "")
PREFIX = "deployments/" + DEPLOYMENT + "/"
CHALLENGE = "c" * 64
TOKEN = "run-scoped-token-never-recorded"
STATE_SECRET = "database-password-from-state"
CA = "-----BEGIN CERTIFICATE-----\nMIIBpublic\n-----END CERTIFICATE-----\n"
ENV = {
    "DEPLOYMENT_ID": DEPLOYMENT, "RUN_ID": "00000000-0000-4000-8000-000000000001", "CHALLENGE": CHALLENGE,
    "DOMAIN_NAME": "openwork.example.com", "OWNER_EMAIL": "admin@example.com", "OPENWORK_VERSION": "1.0.2",
    "CONTROL_PLANE_ORIGIN": "https://control.example.com", "ROUTE53_ZONE_ID": "ZTEST", "AWS_REGION": "us-east-1",
    "EXPECTED_ACCOUNT_ID": "123456789012", "STATE_BUCKET": "customer-state", "SIZE": "small",
    "BUNDLE_URL": "https://release.example.com/releases/aws/1.0.2/bundle.tar.gz?versionId=immutable-version",
    "BUNDLE_SHA256": "b" * 64, "CODEBUILD_BUILD_ID": "openwork-" + COMPACT + "-runner:11111111-2222-3333-4444-555555555555",
}
ALLOWED = {
    "api": {"cpu": 2048, "memory": 4096, "min_instances": 2, "max_instances": 2},
    "web": {"cpu": 1024, "memory": 2048, "min_instances": 3},
    "database": {"tier": "db.m7g.large", "disk_size_gb": 200, "high_availability": True},
    "extra_environment": {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318", "OTEL_SERVICE_NAME": "openwork"},
    "log_retention_days": 90,
}
RAW_OUTPUTS = {
    "web_url": {"sensitive": False, "value": "https://openwork.example.com"},
    "api_url": {"sensitive": False, "value": "https://api.openwork.example.com"},
    "cluster_name": {"sensitive": False, "value": "ow-0cf7aa5c4c1a-den"},
    "service_names": {"sensitive": False, "value": {"den_api": "den-api", "den_web": "den-web"}},
    "secret_arn": {"sensitive": False, "value": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ow-0cf7aa5c4c1a-den-Ab1234"},
    "task_definition_arns": {"sensitive": False, "value": {
        "den_api": "arn:aws:ecs:us-east-1:123456789012:task-definition/ow-0cf7aa5c4c1a-den-api:7",
        "den_web": "arn:aws:ecs:us-east-1:123456789012:task-definition/ow-0cf7aa5c4c1a-den-web:7"}},
    "future_sensitive_output": {"sensitive": True, "value": "sensitive-output-value"},
}
STATE = {"values": {"root_module": {"child_modules": [{"address": "module.platform", "resources": [
    {"address": "module.platform.data.http.rds_ca[0]", "mode": "data", "type": "http", "values": {"response_body": CA, "status_code": 200}},
    {"address": "module.platform.random_password.db[0]", "mode": "managed", "type": "random_password", "values": {"result": STATE_SECRET}},
]}]}}}


class Bucket:
    """The deployment's state bucket as the runner's AWS CLI calls see it."""

    def __init__(self, objects=None, deny=()):
        self.objects, self.deny, self.calls, self.put = dict(objects or {}), set(deny), [], {}

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] in self.deny:
            raise subprocess.CalledProcessError(254, ["aws", *args], stderr="An error occurred (AccessDenied)")
        option = lambda name: args[args.index(name) + 1]
        if args[:2] == ("s3api", "list-objects-v2"):
            matches = sorted(key for key in self.objects if key.startswith(option("--prefix")))
            return {"Contents": [{"Key": key, "Size": len(self.objects[key])} for key in matches[:1]]} if matches else {}
        if args[:2] == ("s3api", "get-object"):
            Path(args[-1]).write_bytes(self.objects[option("--key")])
            return {}
        if args[:2] == ("s3api", "put-object"):
            self.put[option("--key")] = Path(option("--body")).read_text()
            return {}
        raise AssertionError("unexpected AWS call: " + " ".join(args[:2]))


@contextlib.contextmanager
def environment(**changes):
    with tempfile.TemporaryDirectory() as directory:
        token = Path(directory) / ".runner-token"
        token.write_text(TOKEN)
        with patch.dict(os.environ, {**ENV, "RUNNER_TOKEN_FILE": str(token), **changes}, clear=True):
            yield Path(directory)


def quiet(call, *args, **kwargs):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            return call(*args, **kwargs), output.getvalue()
        except BaseException as error:
            error.printed = output.getvalue()
            raise


class OverridesAllowlistTests(unittest.TestCase):
    def test_every_allowlisted_setting_is_accepted_unchanged(self):
        self.assertEqual(runner.override_problems(ALLOWED), (ALLOWED, []))
        self.assertEqual(runner.override_problems({}), ({}, []))
        self.assertEqual(runner.override_problems({"api": {}, "database": {}, "extra_environment": {}}), ({}, []))

    def test_settings_outside_the_allowlist_are_refused(self):
        refused = {
            "engine version": {"database": {"engine_version": "5.7"}},
            "deletion protection": {"database": {"deletion_protection": False}},
            "final snapshot": {"database": {"skip_final_snapshot": True}},
            "backups": {"database": {"backup_retention_days": 0}},
            "secrets": {"extra_secrets": {"OTEL_KEY": "arn:aws:secretsmanager:us-east-1:123456789012:secret:x-Ab1234"}},
            "network": {"vpc_id": "vpc-0123456789abcdef0"},
            "network mode": {"network_mode": "existing"},
            "images": {"den_api_image": "ghcr.io/example/api@sha256:" + "a" * 64},
            "test switch": {"test_disposable": True},
            "trust roots": {"database_ca_bundle": CA},
            "other services": {"workbot": {"cpu": 256}},
            "service image": {"api": {"image": "example"}},
            "environment outside OTEL_": {"extra_environment": {"DATABASE_URL": "mysql://elsewhere"}},
            "lowercase environment": {"extra_environment": {"otel_service_name": "x"}},
            "credential header": {"extra_environment": {"OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer abc"}},
            "credential name": {"extra_environment": {"OTEL_EXPORTER_API_KEY": "abc"}},
            "credential in a URL": {"extra_environment": {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://user:pass@collector.example.com"}},
            "multi-line value": {"extra_environment": {"OTEL_SERVICE_NAME": "a\nb"}},
            "non-string value": {"extra_environment": {"OTEL_SERVICE_NAME": 1}},
            "environment list": {"extra_environment": ["OTEL_SERVICE_NAME=x"]},
            "cpu without its memory": {"api": {"cpu": 2048}},
            "memory Fargate does not offer": {"web": {"cpu": 512, "memory": 8192}},
            "cpu Fargate does not offer": {"api": {"cpu": 3000, "memory": 4096}},
            "below the profile": {"web": {"cpu": 256, "memory": 512}},
            "api below the profile": {"api": {"cpu": 512, "memory": 1024}},
            "zero instances": {"web": {"min_instances": 0}},
            "too many instances": {"api": {"min_instances": 11}},
            "fractional instances": {"api": {"min_instances": 1.5}},
            "boolean instances": {"api": {"min_instances": True}},
            "a count range": {"api": {"min_instances": 1, "max_instances": 4}},
            "a maximum alone": {"web": {"max_instances": 3}},
            "unknown tier": {"database": {"tier": "db.x2g.16xlarge"}},
            "tier with a suffix": {"database": {"tier": "db.t4g.small; drop"}},
            "disk below the profile": {"database": {"disk_size_gb": 10}},
            "disk above the limit": {"database": {"disk_size_gb": 5000}},
            "fractional disk": {"database": {"disk_size_gb": 50.5}},
            "high availability as text": {"database": {"high_availability": "yes"}},
            "retention AWS does not offer": {"log_retention_days": 45},
            "retention below a week": {"log_retention_days": 1},
            "null": {"log_retention_days": None},
            "section as a list": {"api": [1024]},
            "not an object": ["api"],
            "a string": "api",
        }
        for label, document in refused.items():
            with self.subTest(label):
                overrides, problems = runner.override_problems(document)
                self.assertTrue(problems, label)
                self.assertNotIn("extra_environment", overrides)

    def test_messages_name_settings_and_never_repeat_values(self):
        mistaken = "sk-live-value-pasted-by-mistake"
        _, problems = runner.override_problems({
            "extra_environment": {"OTEL_EXPORTER_OTLP_HEADERS": mistaken, "OTEL_EXPORTER_OTLP_ENDPOINT": "https://user:" + mistaken + "@example.com"},
            "database": {"tier": mistaken}, "log_retention_days": mistaken})
        self.assertEqual(len(problems), 4)
        self.assertNotIn(mistaken, json.dumps(problems))
        self.assertIn("OTEL_EXPORTER_OTLP_HEADERS", json.dumps(problems))

    def test_the_runner_and_terraform_share_one_allowlist(self):
        terraform = (ROOT / "aws/terraform/overrides.tf").read_text()
        main = (ROOT / "aws/terraform/main.tf").read_text()
        hcl = lambda pattern: pattern.replace("\\", "\\\\")
        self.assertIn('"^' + hcl(runner.DATABASE_TIER.pattern) + '$"', terraform)
        self.assertIn('"^' + hcl(runner.OTEL_NAME.pattern) + '$"', terraform)
        self.assertIn('"' + hcl(runner.CREDENTIAL_NAME.pattern) + '"', terraform)
        self.assertIn("[" + ", ".join(map(str, runner.LOG_RETENTION_DAYS)) + "]", terraform)
        self.assertIn(f"<= {runner.MAX_INSTANCES} ", terraform)
        self.assertIn(f"<= {runner.MAX_DISK_SIZE_GB} ", terraform)
        for cpu, memory in runner.FARGATE_MEMORY.items():
            listed = re.search(rf'"{cpu}"\s*=\s*(\[[^\]]+\]|range\((\d+), (\d+), (\d+)\))', terraform)
            values = tuple(json.loads(listed[1])) if listed[1].startswith("[") else tuple(range(int(listed[2]), int(listed[3]), int(listed[4])))
            self.assertEqual(values, memory, cpu)
        profile = re.search(r"small = \{\s+database\s+= \{ instance_class = \"[^\"]+\", allocated_storage_gb = (\d+), max_allocated_storage = \d+ \}\s+"
                            r"den_api\s+= \{ cpu = (\d+), memory = (\d+), desired_count = (\d+) \}\s+den_web\s+= \{ cpu = (\d+), memory = (\d+), desired_count = (\d+) \}", main)
        disk, *sizes = map(int, profile.groups())
        self.assertEqual(runner.SIZE_BASELINE, {"small": {
            "api": dict(zip(("cpu", "memory", "instances"), sizes[:3])), "web": dict(zip(("cpu", "memory", "instances"), sizes[3:])),
            "database": {"disk_size_gb": disk}}})
        # The variable's type is the allowlist: nothing else can reach the platform module.
        declared = set(re.findall(r"^\s+([a-z_]+)\s+= optional\(", terraform, re.M))
        self.assertEqual(declared, {"api", "web", "database", "extra_environment", "log_retention_days", "cpu", "memory",
                                    "min_instances", "max_instances", "tier", "disk_size_gb", "high_availability"})


class OverridesFileTests(unittest.TestCase):
    def read(self, objects=None, deny=()):
        bucket = Bucket(objects, deny)
        with environment(), patch.object(runner, "aws", side_effect=bucket):
            try:
                value, printed = quiet(runner.customer_overrides)
            finally:
                self.bucket = bucket
        return value, printed

    def refused(self, objects=None, deny=()):
        with self.assertRaises(runner.StepFailure) as failure:
            self.read(objects, deny)
        self.assertEqual(failure.exception.code, "infrastructure_failed")
        return failure.exception.printed

    def test_no_file_means_no_overrides_and_only_a_listing(self):
        value, printed = self.read({PREFIX + "terraform.tfstate": b"{}", PREFIX + "overrides.json.bak": b"{}"})
        self.assertIsNone(value)
        self.assertEqual(printed, "")
        self.assertEqual([call[:2] for call in self.bucket.calls], [("s3api", "list-objects-v2")])
        self.assertIn(PREFIX + "overrides.json", self.bucket.calls[0])

    def test_a_valid_file_is_read_from_this_deployments_prefix(self):
        value, printed = self.read({PREFIX + "overrides.json": json.dumps(ALLOWED).encode()})
        self.assertEqual(value, ALLOWED)
        self.assertIn("api, database, extra_environment, log_retention_days, web", printed)
        self.assertIn(PREFIX + "overrides.json", self.bucket.calls[1])

    def test_an_invalid_file_stops_the_run_with_a_clear_reason(self):
        printed = self.refused({PREFIX + "overrides.json": json.dumps({"database": {"engine_version": "5.7"}, "vpc_id": "vpc-1"}).encode()})
        self.assertIn("overrides.json was refused; nothing was changed", printed)
        self.assertIn("database.engine_version cannot be tuned", printed)
        self.assertIn("vpc_id cannot be tuned", printed)

    def test_malformed_repeated_or_oversized_files_are_refused(self):
        for label, body in {"not JSON": b"{", "repeated key": b'{"log_retention_days": 30, "log_retention_days": 90}',
                            "not a number": b'{"log_retention_days": NaN}', "not UTF-8": b"\xff\xfe"}.items():
            with self.subTest(label):
                self.assertIn("valid JSON", self.refused({PREFIX + "overrides.json": body}))
        printed = self.refused({PREFIX + "overrides.json": b" " * (runner.STATE_OBJECT_LIMIT + 1)})
        self.assertIn("at most", printed)
        self.assertEqual([call[:2] for call in self.bucket.calls], [("s3api", "list-objects-v2")])

    def test_a_failed_read_is_never_treated_as_no_file(self):
        self.assertIn("nothing was changed", self.refused(deny={("s3api", "list-objects-v2")}))
        self.assertIn("nothing was changed", self.refused({PREFIX + "overrides.json": b"{}"}, deny={("s3api", "get-object")}))


class RunTests(unittest.TestCase):
    """main(): the marker and the overrides are checked before anything is changed."""

    def run_main(self, objects=None):
        bucket = Bucket(objects)
        outputs = {key: item["value"] for key, item in RAW_OUTPUTS.items()}
        with environment() as directory, contextlib.ExitStack() as stack:
            mocks = {name: stack.enter_context(patch.object(runner, name)) for name in (
                "verify_account", "verify_network", "report", "apply", "verify_services", "verify_health", "first_report")}
            mocks["apply"].return_value = outputs
            stack.enter_context(patch.object(runner, "aws", side_effect=bucket))
            stack.enter_context(patch.object(runner.Path, "cwd", return_value=directory))
            try:
                _, printed = quiet(runner.main)
            except runner.StepFailure as failure:
                printed = failure.printed
        return mocks, bucket, printed

    def test_without_a_marker_or_overrides_the_run_is_the_same_as_before(self):
        mocks, bucket, _ = self.run_main({PREFIX + "terraform.tfstate": b"{}"})
        self.assertEqual([call.args for call in mocks["report"].call_args_list], [
            (3, "account_verified"), (4, "infrastructure_applied"), (5, "services_ready"), (6, "health_verified")])
        root, tf_root, overrides, record = mocks["apply"].call_args.args
        self.assertIsNone(overrides)
        self.assertIs(record, runner.write_eject_kit)
        self.assertEqual(tf_root, root / "infra/managed-deployments/aws/terraform")
        # Two listings, nothing downloaded or written before the apply.
        self.assertEqual([call[:2] for call in bucket.calls], [("s3api", "list-objects-v2")] * 2)

    def test_an_ejected_deployment_is_refused_before_anything_else(self):
        mocks, bucket, printed = self.run_main({PREFIX + "ejected.json": b"", PREFIX + "overrides.json": json.dumps(ALLOWED).encode()})
        mocks["verify_account"].assert_called_once()
        for untouched in ("verify_network", "apply", "verify_services", "verify_health", "first_report"):
            mocks[untouched].assert_not_called()
        self.assertEqual([call.args for call in mocks["report"].call_args_list], [(3, "account_verified", "failed", "infrastructure_failed")])
        self.assertIn("taken over by its owner", printed)
        self.assertIn("s3://customer-state/" + PREFIX + "ejected.json", printed)
        self.assertEqual([call[:2] for call in bucket.calls], [("s3api", "list-objects-v2")])

    def test_a_marker_for_another_deployment_or_name_does_not_stop_this_one(self):
        mocks, _, _ = self.run_main({"deployments/other/ejected.json": b"{}", PREFIX + "ejected.json.old": b"{}"})
        mocks["apply"].assert_called_once()

    def test_invalid_overrides_fail_the_run_before_any_change(self):
        mocks, _, printed = self.run_main({PREFIX + "overrides.json": json.dumps({"database": {"deletion_protection": False}}).encode()})
        for untouched in ("verify_network", "apply", "verify_services", "verify_health"):
            mocks[untouched].assert_not_called()
        self.assertEqual([call.args for call in mocks["report"].call_args_list], [(3, "account_verified", "failed", "infrastructure_failed")])
        self.assertIn("database.deletion_protection cannot be tuned", printed)

    def test_valid_overrides_reach_the_apply(self):
        mocks, _, _ = self.run_main({PREFIX + "overrides.json": json.dumps(ALLOWED).encode()})
        self.assertEqual(mocks["apply"].call_args.args[2], ALLOWED)
        self.assertEqual(mocks["report"].call_args_list[-1].args, (6, "health_verified"))

    def test_the_refusal_code_is_one_the_control_plane_accepts(self):
        schema = (REPOSITORY / "packages/managed-deployments/src/schema.ts").read_text()
        codes = json.loads(re.search(r"errorCode: z\.enum\((\[[^\]]+\])\)", schema)[1])
        self.assertIn("infrastructure_failed", codes)


class ApplyTests(unittest.TestCase):
    def apply(self, overrides=None, plan=None, record=None):
        with environment() as directory, contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(runner, "terraform_binary", return_value="terraform"))
            stack.enter_context(patch.object(runner, "certificate_states", return_value={}))
            stack.enter_context(patch.object(runner, "legacy_fence", return_value=False))
            stack.enter_context(patch.object(runner, "tls_redeploy", side_effect=lambda **_: order.append("tls_redeploy")))
            run = stack.enter_context(patch.object(runner.subprocess, "run"))
            stack.enter_context(patch.object(runner.subprocess, "check_output", side_effect=[json.dumps(plan or {}), json.dumps(RAW_OUTPUTS)]))
            order = []
            recorder = (lambda *args: (order.append("record"), record.append(args))) if record is not None else None
            try:
                runner.apply(directory, directory, overrides, recorder)
            finally:
                self.commands = [call.args[0][1] for call in run.call_args_list]
                self.order = order
                self.variable_files = sorted(path.name for path in directory.iterdir() if "tfvars" in path.name)
            return json.loads((directory / "managed.auto.tfvars.json").read_text())

    def test_no_overrides_gives_terraform_exactly_the_inputs_it_had_before(self):
        values = self.apply()
        with environment():
            self.assertEqual(values, runner.terraform_inputs())
        self.assertNotIn("overrides", values)
        self.assertNotIn("database_ca_bundle", values)
        self.assertEqual(self.commands, ["init", "plan", "apply"])

    def test_overrides_travel_as_one_typed_variable_in_the_same_file(self):
        values = self.apply(ALLOWED)
        self.assertEqual(self.variable_files, ["managed.auto.tfvars.json"])
        self.assertEqual(values.pop("overrides"), ALLOWED)
        with environment():
            self.assertEqual(values, runner.terraform_inputs())

    def test_the_plan_guard_still_refuses_data_bearing_replacement_with_overrides(self):
        plan = {"resource_changes": [{"address": "module.platform.aws_db_instance.this[0]", "type": "aws_db_instance",
                                      "change": {"actions": ["delete", "create"]}}]}
        record = []
        with self.assertRaisesRegex(ValueError, "manual review"):
            quiet(self.apply, ALLOWED, plan, record)
        self.assertEqual(self.commands, ["init", "plan"])
        self.assertEqual(record, [])

    def test_a_storage_limit_at_or_below_the_current_disk_is_refused_before_apply(self):
        def database(disk, limit_before, limit_after):
            return {"resource_changes": [{"address": "module.platform.aws_db_instance.this[0]", "type": "aws_db_instance", "change": {
                "actions": ["update"], "before": {"allocated_storage": disk, "max_allocated_storage": limit_before},
                "after": {"allocated_storage": disk, "max_allocated_storage": limit_after}}}]}
        # Removing or lowering disk_size_gb after the disk grew to 200 GiB.
        for limit in (100, 200):
            self.assertEqual(runner.storage_limit_below_disk(database(200, 400, limit)), ["module.platform.aws_db_instance.this[0]"])
        # Growing, an unchanged limit (a disk that autoscaled up to it) and a new database are not refused.
        for plan in (database(200, 400, 800), database(100, 100, 100), database(20, 100, 100),
                     {"resource_changes": [{"address": "x", "type": "aws_db_instance", "change": {"actions": ["create"], "before": None, "after": {"max_allocated_storage": 100}}}]},
                     {"resource_changes": [{"address": "x", "type": "aws_ecs_service", "change": {"before": {"allocated_storage": 200, "max_allocated_storage": 400}, "after": {"max_allocated_storage": 100}}}]}):
            self.assertEqual(runner.storage_limit_below_disk(plan), [])
        with self.assertRaises(runner.StepFailure) as failure:
            quiet(self.apply, {}, database(200, 400, 100), [])
        self.assertEqual(failure.exception.code, "infrastructure_failed")
        self.assertIn("database disk cannot shrink", failure.exception.printed)
        self.assertEqual(self.commands, ["init", "plan"])

    def test_the_apply_is_recorded_after_it_settled_with_what_terraform_was_given(self):
        record = []
        values = self.apply(ALLOWED, record=record)
        self.assertEqual(self.order, ["tls_redeploy", "record"])
        binary, root, tf_root, recorded, raw = record[0]
        self.assertEqual((binary, recorded, raw), ("terraform", values, RAW_OUTPUTS))


class EjectKitTests(unittest.TestCase):
    def write(self, values=None, state=STATE, manifest=None, raw=RAW_OUTPUTS, deny=(), **changes):
        bucket = Bucket(deny=deny)
        with environment(**changes) as directory, patch.object(runner, "aws", side_effect=bucket), \
                patch.object(runner.subprocess, "check_output", return_value=json.dumps(state)) as show:
            if manifest is not None:
                (directory / "release.json").write_text(json.dumps(manifest))
            self.values = {**runner.terraform_inputs(), "overrides": ALLOWED} if values is None else values
            self.bucket = bucket
            quiet(runner.write_eject_kit, "terraform", directory, directory / "tf", self.values, raw)
            self.shown = [call.args[0] for call in show.call_args_list]
        return {key[len(PREFIX + "applied/"):]: body for key, body in bucket.put.items()}

    def test_the_kit_is_exactly_the_contract_files_under_applied(self):
        files = self.write()
        self.assertEqual(list(files), ["inputs.auto.tfvars.json", "backend.tf.json", "terraform-version.json", "outputs.json",
                                       "unmanaged.json", "README.md", "release.json"])
        self.assertTrue(all(key.startswith(PREFIX + "applied/") for key in self.bucket.put))
        self.assertEqual({call[:2] for call in self.bucket.calls}, {("s3api", "put-object")})
        self.assertTrue(all("customer-state" in call for call in self.bucket.calls))
        self.assertEqual(self.shown, [["terraform", "show", "-json"]])

    def test_release_names_the_version_and_the_exact_bundle(self):
        release = json.loads(self.write(manifest={"provider": "aws", "version": "1.0.2", "protocolVersion": 1})["release.json"])
        self.assertEqual(release, {"provider": "aws", "version": "1.0.2", "bundleUrl": ENV["BUNDLE_URL"], "bundleSha256": "b" * 64,
                                   "deploymentId": DEPLOYMENT, "runId": ENV["RUN_ID"]})
        revised = json.loads(self.write(manifest={"version": "1.0.2", "installerRevision": 3})["release.json"])
        self.assertEqual(revised["installerRevision"], 3)
        for invalid in (True, "3", 0, 2.0):
            with self.subTest(invalid=invalid):
                self.assertNotIn("installerRevision", json.loads(self.write(manifest={"installerRevision": invalid})["release.json"]))

    def test_a_signed_release_url_is_recorded_without_its_signature(self):
        signed = "https://release.example.com/bundle.tar.gz?X-Amz-Credential=AKIA&X-Amz-Signature=abcdef"
        self.assertEqual(json.loads(self.write(BUNDLE_URL=signed)["release.json"])["bundleUrl"], "https://release.example.com/bundle.tar.gz")
        with self.assertRaises(ValueError):
            self.write(BUNDLE_URL="https://user:password@release.example.com/bundle.tar.gz")
        self.assertEqual(self.bucket.put, {})

    def test_inputs_are_what_terraform_was_given_plus_the_trust_roots_it_downloaded(self):
        inputs = json.loads(self.write()["inputs.auto.tfvars.json"])
        self.assertEqual(inputs.pop("database_ca_bundle"), CA)
        self.assertEqual(inputs, self.values)
        self.assertEqual(inputs["overrides"], ALLOWED)
        declared = set(re.findall(r'^variable "([a-z0-9_]+)"', "".join(path.read_text() for path in (ROOT / "aws/terraform").glob("*.tf")), re.M))
        self.assertLessEqual(set(inputs) | {"database_ca_bundle"}, declared)

    def test_trust_roots_come_from_the_applied_state_and_must_be_public_certificates(self):
        self.assertEqual(runner.RDS_CA_ADDRESS, "module.platform.data.http.rds_ca[0]")
        module = (REPOSITORY / "infra/terraform/modules/openwork-aws-ecs/security.tf").read_text()
        self.assertIn('data "http" "rds_ca" {\n  count    = var.database_ca_bundle == "" ? 1 : 0', module)
        self.assertIn('database_ca_bundle = var.database_ca_bundle != "" ? var.database_ca_bundle : data.http.rds_ca[0].response_body', module)
        root = (ROOT / "aws/terraform/main.tf").read_text()
        platform = root[root.index('module "platform" {'):root.index('module "health_agent" {')]
        self.assertIn("\n  database_ca_bundle = var.database_ca_bundle\n", platform)
        missing = {"values": {"root_module": {"child_modules": [{"resources": []}]}}}
        private = json.loads(json.dumps(STATE).replace("BEGIN CERTIFICATE", "BEGIN PRIVATE KEY"))
        managed_lookalike = json.loads(json.dumps(STATE).replace('"mode": "data"', '"mode": "managed"'))
        for label, state in {"missing": missing, "private key": private, "not the data source": managed_lookalike}.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, "trust roots"):
                self.write(state=state)
            self.assertEqual(self.bucket.put, {})
        # Roots already supplied as an input are recorded without reading the state.
        with environment():
            pinned = {**runner.terraform_inputs(), "database_ca_bundle": CA}
        self.assertEqual(json.loads(self.write(values=pinned)["inputs.auto.tfvars.json"])["database_ca_bundle"], CA)
        self.assertEqual(self.shown, [])

    def test_backend_and_terraform_version_match_what_the_runner_used(self):
        files = self.write()
        self.assertEqual(json.loads(files["backend.tf.json"]), {"terraform": {"backend": {"s3": {
            "bucket": "customer-state", "key": PREFIX + "terraform.tfstate", "region": "us-east-1", "encrypt": True, "use_lockfile": True}}}})
        source = (ROOT / "aws/runner/runner.py").read_text()
        for setting in ('"-backend-config=bucket=" + os.environ["STATE_BUCKET"]', '"-backend-config=key=" + state_key', '"-backend-config=encrypt=true"',
                        '"-backend-config=use_lockfile=true"', '"-backend-config=region=" + os.environ["AWS_REGION"]'):
            self.assertIn(setting, source)
        version = json.loads(files["terraform-version.json"])
        self.assertEqual((version["version"], version["sha256"], version["platform"]), (runner.TERRAFORM_VERSION, runner.TERRAFORM_LINUX_SHA256, "linux_amd64"))
        self.assertIn(f'required_version = "= {version["version"]}"', (ROOT / "aws/terraform/main.tf").read_text())

    def test_only_non_sensitive_outputs_are_recorded(self):
        outputs = json.loads(self.write()["outputs.json"])
        self.assertEqual(outputs, {key: item["value"] for key, item in RAW_OUTPUTS.items() if key != "future_sensitive_output"})
        unmarked = {"web_url": {"value": "https://openwork.example.com"}}
        self.assertEqual(json.loads(self.write(raw=unmarked)["outputs.json"]), {})

    def test_unmanaged_lists_the_whole_bootstrap_stack_and_retained_revisions(self):
        unmanaged = json.loads(self.write()["unmanaged.json"])
        stack = unmanaged["bootstrapStack"]
        template = json.loads((ROOT / "aws/bootstrap/cloudformation.json").read_text())
        self.assertEqual({item["logicalId"]: item["type"] for item in stack["resources"]},
                         {logical: resource["Type"] for logical, resource in template["Resources"].items()})
        names = {item["logicalId"]: item.get("name") for item in stack["resources"]}
        self.assertEqual(stack["name"], "openwork-" + COMPACT)
        self.assertEqual((names["StateBucket"], names["RunnerRole"], names["Runner"], names["Launcher"]),
                         ("customer-state", f"openwork-{COMPACT}-runner", f"openwork-{COMPACT}-runner", f"openwork-{COMPACT}-launcher"))
        retained = next(item for item in stack["resources"] if item["logicalId"] == "StateBucket")
        self.assertTrue(retained["retainedOnStackDelete"])
        self.assertEqual(template["Resources"]["StateBucket"]["DeletionPolicy"], "Retain")
        self.assertEqual(stack["logGroups"], [f"/aws/codebuild/openwork-{COMPACT}-runner", f"/aws/lambda/openwork-{COMPACT}-launcher"])
        self.assertEqual(unmanaged["retainedTaskDefinitions"]["families"], ["ow-0cf7aa5c4c1a-den-api", "ow-0cf7aa5c4c1a-den-web", "ow-0cf7aa5c4c1a-migrate"])
        # Without CodeBuild's build id the stack name falls back to the name hosted OpenWork gives it.
        self.assertEqual(json.loads(self.write(CODEBUILD_BUILD_ID="")["unmanaged.json"])["bootstrapStack"]["name"], "openwork-" + COMPACT)
        self.assertIn("return `openwork-${compactDeploymentId(deploymentId)}`", (REPOSITORY / "packages/managed-deployments/src/aws.ts").read_text())

    def test_the_readme_gives_the_takeover_steps_for_this_deployment(self):
        readme = self.write()["README.md"]
        self.assertNotIn("$", readme)
        for expected in (
                DEPLOYMENT, "aws s3api put-object --bucket customer-state --key " + PREFIX + "ejected.json",
                "curl -fsSLo bundle.tar.gz '" + ENV["BUNDLE_URL"] + "'", "b" * 64 + "  bundle.tar.gz", "umask 022",
                "Terraform " + runner.TERRAFORM_VERSION, "backend_override.tf.json", "inputs.auto.tfvars.json",
                "terraform init -lockfile=readonly", "terraform plan", 'must end with "No changes"',
                f"openwork-{COMPACT}-runner", "secretsmanager:GetSecretValue", "s3://customer-state/" + PREFIX + "overrides.json",
                "ow-0cf7aa5c4c1a-den-final", "--no-deletion-protection", "terraform destroy", "## Remove it"):
            self.assertIn(expected, readme)
        example = json.loads(re.search(r"```json\n(.*?)```", readme, re.S)[1])
        self.assertEqual(runner.override_problems(example), (example, []))

    def test_no_secret_state_token_or_enrolment_challenge_is_ever_written(self):
        files = self.write()
        written = "\n".join(self.bucket.put.values())
        for secret in (TOKEN, CHALLENGE, STATE_SECRET, "sensitive-output-value"):
            self.assertNotIn(secret, written)
        self.assertFalse(any("tfstate" in name or "token" in name for name in files))
        self.assertNotIn("CHALLENGE", written)
        self.assertNotIn("PRIVATE KEY", written)
        # Only references to customer secrets are inputs; their values are never read.
        with environment(HEADLESS_RUNNER_ENABLED="true", HEADLESS_MODEL="model", HEADLESS_MODEL_BASE_URL="https://api.example.com/v1",
                         HEADLESS_MODEL_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:model-Ab1234"):
            with_reference = runner.terraform_inputs()
        inputs = json.loads(self.write(values=with_reference)["inputs.auto.tfvars.json"])
        self.assertTrue(inputs["headless_model_secret_arn"].startswith("arn:aws:secretsmanager:"))

    def test_a_run_credential_inside_an_input_stops_the_record(self):
        for credential in (TOKEN, CHALLENGE):
            with environment():
                leaking = {**runner.terraform_inputs(), "overrides": {"extra_environment": {"OTEL_SERVICE_NAME": credential}}}
            with self.subTest(credential=credential[:4]), self.assertRaisesRegex(ValueError, "refusing to record"):
                self.write(values=leaking)
            self.assertEqual(self.bucket.put, {})

    def test_a_failed_write_fails_the_run_instead_of_leaving_a_stale_record_unnoticed(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.write(deny={("s3api", "put-object")})
        def failing_apply(root, tf_root, overrides, record):
            raise subprocess.CalledProcessError(254, ["aws", "s3api", "put-object"])
        with environment() as directory, patch.object(runner, "verify_account"), patch.object(runner, "verify_network"), \
                patch.object(runner, "report") as report, patch.object(runner, "apply", side_effect=failing_apply), \
                patch.object(runner, "aws", side_effect=Bucket()), patch.object(runner.Path, "cwd", return_value=directory):
            with self.assertRaises(subprocess.CalledProcessError):
                quiet(runner.main)
        self.assertEqual([call.args for call in report.call_args_list],
                         [(3, "account_verified"), (4, "infrastructure_applied", "failed", "infrastructure_failed")])


class RunnerPermissionTests(unittest.TestCase):
    """The approved role already reaches these objects; one stack and one build at a time serialize runs."""

    def setUp(self):
        self.template = json.loads((ROOT / "aws/bootstrap/cloudformation.json").read_text())
        self.statements = {statement.get("Sid"): statement for statement in
                           self.template["Resources"]["RunnerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
                           if isinstance(statement, dict) and "Sid" in statement}

    def test_the_runner_role_reads_and_writes_only_this_deployments_prefix(self):
        objects = self.statements["StateObjects"]
        self.assertEqual(objects["Resource"], {"Fn::Join": ["", [{"Fn::GetAtt": ["StateBucket", "Arn"]}, "/deployments/", {"Ref": "DeploymentId"}, "/*"]]})
        self.assertLessEqual({"s3:GetObject", "s3:PutObject"}, set(objects["Action"]))
        # Listing is what tells "no overrides.json / ejected.json" apart from a denied read.
        self.assertIn("s3:ListBucket", self.statements["StateBucket"]["Action"])
        self.assertEqual(self.statements["StateBucket"]["Resource"], {"Fn::GetAtt": ["StateBucket", "Arn"]})
        for name in ("overrides.json", "ejected.json", "applied/release.json", "terraform.tfstate"):
            with patch.dict(os.environ, {"DEPLOYMENT_ID": DEPLOYMENT}):
                self.assertEqual(runner.deployment_key(name), "deployments/" + DEPLOYMENT + "/" + name)

    def test_runs_of_one_deployment_cannot_overlap(self):
        resources = self.template["Resources"]
        # One build at a time for the only project that can use the runner role...
        self.assertEqual(resources["Runner"]["Properties"]["ConcurrentBuildLimit"], 1)
        trust = resources["RunnerRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(len(trust), 1)
        self.assertEqual(trust[0]["Principal"], {"Service": "codebuild.amazonaws.com"})
        self.assertEqual(trust[0]["Condition"]["ArnLike"]["aws:SourceArn"],
                         {"Fn::Sub": "arn:${AWS::Partition}:codebuild:${AWS::Region}:${AWS::AccountId}:project/${AWS::StackName}-runner"})
        self.assertEqual(resources["Runner"]["Properties"]["Name"], {"Fn::Sub": "${AWS::StackName}-runner"})
        # ...which cannot start or create builds itself...
        nested = self.statements["NoNestedBuilds"]
        self.assertEqual((nested["Effect"], nested["Resource"]), ("Deny", "*"))
        self.assertLessEqual({"codebuild:StartBuild", "codebuild:CreateProject", "codebuild:UpdateProject"}, set(nested["Action"]))
        # ...and whose role name is fixed by the deployment id, so a second stack for the same deployment cannot be created in the account.
        self.assertEqual(resources["RunnerRole"]["Properties"]["RoleName"],
                         {"Fn::Join": ["", ["openwork-", {"Fn::Join": ["", {"Fn::Split": ["-", {"Ref": "DeploymentId"}]}]}, "-runner"]]})
        # Each Terraform command also takes the S3-native state lock.
        source = (ROOT / "aws/runner/runner.py").read_text()
        self.assertIn('"-backend-config=use_lockfile=true"', source)
        self.assertEqual(source.count('"-lock-timeout=120s"'), 3)
        self.assertNotIn("orchestration.lock", source)


class PlanDeterminismTests(unittest.TestCase):
    """Real Terraform: recording the downloaded bytes as an input leaves nothing to change."""

    CONFIGURATION = '''
terraform {
  backend "s3" {}
  required_providers {
    http = { source = "hashicorp/http", version = "%s" }
  }
}
variable "database_ca_bundle" {
  type    = string
  default = ""
}
data "http" "rds_ca" {
  count = var.database_ca_bundle == "" ? 1 : 0
  url   = "%s"
}
locals {
  database_ca_bundle = var.database_ca_bundle != "" ? var.database_ca_bundle : data.http.rds_ca[0].response_body
}
resource "terraform_data" "task_definition" {
  input = "printf '%%s' '${base64encode(local.database_ca_bundle)}' | base64 -d > /tmp/openwork-db-ca.pem"
}
'''

    def test_a_plan_from_the_recorded_inputs_shows_no_changes_and_needs_no_download(self):
        terraform = shutil.which("terraform")
        self.assertIsNotNone(terraform, "Terraform is required by the managed workflow")
        tf_root = ROOT / "aws/terraform"
        constraint = re.search(r'provider "registry\.terraform\.io/hashicorp/http" \{\s+version\s*=\s*"[^"]+"\s+constraints\s*=\s*"([^"]+)"',
                               (tf_root / ".terraform.lock.hcl").read_text())[1]
        with tempfile.TemporaryDirectory() as directory:
            root, served = Path(directory) / "root", Path(directory) / "served"
            root.mkdir()
            served.mkdir()
            (served / "bundle.pem").write_text(CA)
            class Quiet(http.server.SimpleHTTPRequestHandler):
                def log_message(self, *args):
                    pass
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(served)))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            environment_ = {**os.environ, "TF_CLI_CONFIG_FILE": os.devnull, "TF_IN_AUTOMATION": "1"}
            def run(*arguments, expect=0):
                result = subprocess.run([terraform, *arguments], cwd=root, capture_output=True, text=True, timeout=120, env=environment_)
                self.assertEqual(result.returncode, expect, result.stdout + result.stderr)
                return result.stdout
            try:
                (root / "main.tf").write_text(self.CONFIGURATION % (constraint, f"http://127.0.0.1:{server.server_address[1]}/bundle.pem"))
                shutil.copyfile(tf_root / ".terraform.lock.hcl", root / ".terraform.lock.hcl")
                # The record's backend.tf.json is used as an override of the empty backend block.
                (root / "backend_override.tf.json").write_text(json.dumps({"terraform": {"backend": {"local": {"path": str(root / "state.tfstate")}}}}))
                run("init", "-input=false", "-no-color", "-plugin-dir=" + str(tf_root / ".terraform/providers"))
                run("plan", "-input=false", "-no-color", "-out=approved.tfplan")
                run("apply", "-input=false", "-no-color", "approved.tfplan")
                state = json.loads(run("show", "-json"))
            finally:
                server.shutdown()
                server.server_close()
            with patch.object(runner.subprocess, "check_output", return_value=json.dumps(
                    {"values": {"root_module": {"child_modules": [{"resources": [
                        {**resource, "address": "module.platform." + resource["address"]} for resource in state["values"]["root_module"]["resources"]]}]}}})):
                recorded = runner.applied_ca_bundle(terraform, root, {})
            self.assertEqual(recorded, CA)
            (root / "inputs.auto.tfvars.json").write_text(json.dumps({"database_ca_bundle": recorded}))
            # The server is gone: the plan cannot download, and exit code 0 means no changes (2 would mean changes).
            self.assertIn("No changes", run("plan", "-input=false", "-no-color", "-detailed-exitcode", expect=0))
            (root / "inputs.auto.tfvars.json").write_text(json.dumps({"database_ca_bundle": CA + "-----BEGIN CERTIFICATE-----\nnewer\n"}))
            run("plan", "-input=false", "-no-color", "-detailed-exitcode", expect=2)


if __name__ == "__main__":
    unittest.main()
