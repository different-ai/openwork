"""Offline checks for tuning (overrides.json), taking over (ejected.json) and the
applied record a customer runs Terraform from. Same contract as the AWS runner
(test_aws_eject_overrides.py) except where Google Cloud differs. No cloud credentials."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch

from test_gcp_installer import DEPLOYMENT, ENV, GCP, PINS, ROOT, RUN, bundle, install, runner
from test_gcp_cloud_build import launch

IMAGES = {kind: f"us-central1-docker.pkg.dev/test-project/ow-123456781234/{kind}@sha256:" + character * 64
          for kind, character in zip(("den_api", "den_web", "health"), "abc")}
OUTPUTS = {"web_url": "https://openwork.example.com", "api_url": "https://api.openwork.example.com",
           "setup_url": "https://openwork.example.com/setup", "health_agent": "ow-123456781234-health",
           "service_names": {"den_api": "ow-123456781234-api", "den_web": "ow-123456781234-web"}}
TUNED = {"api": {"cpu": 4096, "memory": 8192, "min_instances": 2, "max_instances": 20}, "web": {"memory": 2048},
         "database": {"tier": "db-custom-2-7680", "disk_size_gb": 50, "high_availability": True},
         "extra_environment": {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.com", "OTEL_SERVICE_NAME": "openwork"}}
# The shared fixture challenge equals a fixture image digest; a distinct one
# lets the record be searched for it.
RUN_ENV = {**ENV, "CHALLENGE": "f" * 64}
RUN_TOKEN = "run-token-" + "t" * 32


def http_error(code):
    return urllib.error.HTTPError("https://storage.googleapis.com/object", code, "refused", {}, None)


@contextlib.contextmanager
def state_bucket(objects):
    """The customer's deployment folder: name -> bytes, or an exception to raise."""
    read = []
    def fetch(url, data=None, headers=None, **kwargs):
        object_name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.split("/o/", 1)[1])
        read.append(object_name)
        value = objects.get(object_name.rsplit("/", 1)[1], http_error(404))
        if isinstance(value, Exception):
            raise value
        if len(value) > kwargs.get("limit", 0):
            raise ValueError("response too large")
        return value
    with patch.dict(os.environ, RUN_ENV, clear=True), patch.object(runner, "storage_headers", return_value={"Authorization": "Bearer t"}), \
            patch.object(install, "request", side_effect=fetch):
        yield read


def printed(output):
    return "\n".join(str(call.args[0]) for call in output.call_args_list)


class OverrideAllowlistTests(unittest.TestCase):
    def problems(self, document):
        return runner.override_problems(document)[1]

    def test_every_allowed_setting_is_accepted_unchanged(self):
        self.assertEqual(runner.override_problems(TUNED), (TUNED, []))
        self.assertEqual(runner.override_problems({}), ({}, []))
        self.assertEqual(runner.override_problems({"api": {}, "database": {}, "extra_environment": {}}), ({}, []))
        for cpu, memory in ((1024, 4096), (2048, 8192), (4096, 2048), (4096, 16384), (8192, 4096), (8192, 32768)):
            self.assertEqual(self.problems({"web": {"cpu": cpu, "memory": memory}}), [], (cpu, memory))
        for tier in ("db-custom-1-3840", "db-custom-2-7680", "db-custom-4-15360", "db-custom-8-52224"):
            self.assertEqual(self.problems({"database": {"tier": tier}}), [], tier)

    def test_same_keys_as_the_aws_contract(self):
        aws = (ROOT / "infra/managed-deployments/aws/runner/runner.py").read_text()
        if "def override_problems" not in aws:
            self.skipTest("the AWS runner in this checkout has no overrides yet")
        for shared in ('{"api", "web", "database", "extra_environment", "log_retention_days"}',
                       '("cpu", "memory", "min_instances", "max_instances")', '("tier", "disk_size_gb", "high_availability")',
                       'OTEL_NAME = re.compile(r"OTEL_[A-Z0-9_]{1,120}")', 'URL_CREDENTIAL = re.compile(r"://[^/@\\s]*@")',
                       "STATE_OBJECT_LIMIT = 16 * 1024", "MAX_DISK_SIZE_GB = 4096"):
            self.assertIn(shared, aws)
            self.assertIn(shared, (GCP / "runner/runner.py").read_text())

    def test_database_version_protection_secrets_and_other_inputs_are_never_tunable(self):
        for refused, named in [
            ({"database": {"database_version": "MYSQL_8_4"}}, "database.database_version cannot be tuned"),
            ({"database": {"deletion_protection": False}}, "database.deletion_protection cannot be tuned"),
            ({"database": {"backup_enabled": False}}, "database.backup_enabled cannot be tuned"),
            ({"database": {"backup_location": "us"}}, "database.backup_location cannot be tuned"),
            ({"deletion_protection": False}, "deletion_protection cannot be tuned"),
            ({"allow_destroy": True}, "allow_destroy cannot be tuned"),
            ({"images": {"den_api": "evil.test/api:latest"}}, "images cannot be tuned"),
            ({"managed_maintenance": True}, "managed_maintenance cannot be tuned"),
            ({"domain_name": "evil.test"}, "domain_name cannot be tuned"),
            ({"extra_secrets": {"X": "projects/p/secrets/s"}}, "extra_secrets cannot be tuned"),
            ({"den_api": {"cpu": 4096}}, "den_api cannot be tuned"),
            ({"api": {"image": "evil.test/api"}}, "api.image cannot be tuned"),
            ({"api": {"service_account": "x"}}, "api.service_account cannot be tuned"),
        ]:
            with self.subTest(refused=refused):
                self.assertEqual(runner.override_problems(refused), ({}, [named]))

    def test_log_retention_is_refused_with_the_reason_never_silently_ignored(self):
        overrides, problems = runner.override_problems({"log_retention_days": 90, "web": {"memory": 2048}})
        self.assertEqual(problems, ["log_retention_days cannot be tuned on Google Cloud: set retention on the project's Cloud Logging bucket instead"])
        self.assertNotIn("log_retention_days", overrides)
        self.assertNotIn("log_retention_days", (GCP / "terraform/overrides.tf").read_text().split("variable")[1].split("validation")[0])

    def test_sizes_never_go_below_the_small_profile_or_outside_cloud_run(self):
        for refused in [
            {"api": []}, {"api": {"cpu": "2"}}, {"api": {"cpu": 2}}, {"api": {"cpu": 3072}}, {"api": {"cpu": 2048.0}},
            {"api": {"memory": "2Gi"}}, {"api": {"memory": 3000}}, {"api": {"memory": 65536}}, {"api": {"memory": True}},
            {"api": {"cpu": 1024}}, {"api": {"memory": 1024}}, {"api": {"cpu": 2048, "memory": 1024}}, {"web": {"cpu": 512}},
            {"api": {"memory": 16384}}, {"web": {"cpu": 1024, "memory": 8192}}, {"web": {"cpu": 8192, "memory": 2048}},
            {"web": {"min_instances": 0}}, {"web": {"min_instances": 11}}, {"web": {"min_instances": True}},
            {"web": {"max_instances": 0}}, {"web": {"max_instances": 101}}, {"web": {"max_instances": 2.5}}, {"web": {"max_instances": "3"}},
            {"web": {"min_instances": 5, "max_instances": 2}}, {"web": {"min_instances": 10, "max_instances": 9}},
            {"database": {"tier": "db-f1-micro"}}, {"database": {"tier": "db.t4g.small"}}, {"database": {"tier": "db-custom-3-7680"}},
            {"database": {"tier": "db-custom-2-7000"}}, {"database": {"tier": "db-custom-2-3840x"}}, {"database": {"tier": "db-custom-1-13312"}},
            {"database": {"tier": "db-custom-8-3840"}}, {"database": {"tier": 7}},
            {"database": {"disk_size_gb": 10}}, {"database": {"disk_size_gb": 19}}, {"database": {"disk_size_gb": 5000}},
            {"database": {"disk_size_gb": "50"}}, {"database": {"disk_size_gb": True}},
            {"database": {"high_availability": "yes"}}, {"database": {"high_availability": 1}},
        ]:
            with self.subTest(refused=refused):
                self.assertTrue(self.problems(refused))
        for document in ([], "api", None, 7):
            self.assertEqual(runner.override_problems(document), ({}, ["the file must be a JSON object"]))

    def test_cloud_run_scales_between_minimum_and_maximum(self):
        # AWS runs a fixed count and requires max_instances == min_instances.
        for accepted in ({"min_instances": 2, "max_instances": 20}, {"min_instances": 10}, {"max_instances": 100}, {"max_instances": 1},
                         {"min_instances": 3, "max_instances": 3}):
            self.assertEqual(self.problems({"api": accepted}), [], accepted)
        self.assertEqual(self.problems({"api": {"max_instances": 1, "min_instances": 2}}), ["api.max_instances cannot be below api.min_instances (2)"])

    def test_environment_accepts_only_credential_free_otel_names(self):
        for name, value in [
            ("DEN_BETTER_AUTH_URL", "https://evil.test"), ("DATABASE_URL", "mysql://x"), ("otel_service_name", "x"), ("OTEL_", "x"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x=y"), ("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x=y"), ("OTEL_API_KEY", "x"),
            ("OTEL_AUTH_TOKEN", "x"), ("OTEL_EXPORTER_OTLP_CLIENT_PRIVATE_KEY", "x"), ("OTEL_AUTHORIZATION", "x"),
            ("OTEL_BOOTSTRAP_CODE_X", "x"), ("OTEL_DATABASE_URL", "x"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "https://user:placeholder@otel.example.com"),
            ("OTEL_SERVICE_NAME", "line\nbreak"), ("OTEL_SERVICE_NAME", "x" * 2049), ("OTEL_SERVICE_NAME", 7),
        ]:
            with self.subTest(name=name):
                overrides, problems = runner.override_problems({"extra_environment": {name: value}})
                self.assertEqual(len(problems), 1)
                self.assertNotIn("extra_environment", overrides)
                # Problems name the setting, never its value.
                if isinstance(value, str) and len(value) > 3:
                    self.assertNotIn(value, problems[0])
        self.assertTrue(self.problems({"extra_environment": {f"OTEL_VARIABLE_{index}": "x" for index in range(33)}}))
        self.assertTrue(self.problems({"extra_environment": ["OTEL_SERVICE_NAME=x"]}))

    def test_baseline_matches_the_terraform_profile_and_variable(self):
        root = (GCP / "terraform/main.tf").read_text()
        self.assertIn("den_api  = { cpu = 2048, memory = 2048, min_instances = 1, max_instances = 10 }", root)
        self.assertIn("den_web  = { cpu = 1024, memory = 1024, min_instances = 1, max_instances = 10 }", root)
        self.assertIn('database_version = "MYSQL_8_0"', root)
        self.assertIn("disk_size_gb     = 20", root)
        self.assertIn("deletion_protection               = !var.allow_destroy", root)
        self.assertEqual(runner.SIZE_BASELINE["small"], {"api": {"cpu": 2048, "memory": 2048, "min_instances": 1, "max_instances": 10},
                                                         "web": {"cpu": 1024, "memory": 1024, "min_instances": 1, "max_instances": 10},
                                                         "database": {"disk_size_gb": 20}})
        variable = (GCP / "terraform/overrides.tf").read_text()
        declared = variable[variable.index("type = object("):variable.index("default  = {}")]
        for never in ("database_version", "deletion_protection", "backup", "secret", "image", "log_retention_days"):
            self.assertNotIn(never, declared)


class OverrideFileTests(unittest.TestCase):
    def read(self, objects):
        with state_bucket(objects) as fetched, patch("builtins.print") as output:
            try:
                return runner.customer_overrides(), printed(output)
            finally:
                self.fetched, self.output = fetched, printed(output)

    def refused(self, body):
        with self.assertRaises(runner.StepFailure) as failure:
            self.read({"overrides.json": body})
        self.assertEqual(failure.exception.code, "infrastructure_failed")
        self.assertIn("overrides.json was refused; nothing was changed", self.output)
        return self.output

    def test_no_file_means_no_overrides_variable_at_all(self):
        overrides, _ = self.read({})
        self.assertIsNone(overrides)
        self.assertEqual(self.fetched, ["deployments/" + DEPLOYMENT + "/overrides.json"])
        with patch.dict(os.environ, ENV, clear=True):
            self.assertNotIn("overrides", runner.inputs(IMAGES, overrides))
            self.assertEqual(runner.inputs(IMAGES, {})["overrides"], {})

    def test_customer_file_is_validated_and_reported_by_setting_name(self):
        overrides, output = self.read({"overrides.json": json.dumps(TUNED).encode()})
        self.assertEqual(overrides, TUNED)
        self.assertIn("Tuning from overrides.json: api, database, extra_environment, web", output)
        output = self.refused(json.dumps({"database": {"database_version": "MYSQL_8_4"}, "log_retention_days": 30,
                                          "extra_environment": {"OTEL_EXPORTER_OTLP_HEADERS": "authorization=placeholder-value"}}).encode())
        self.assertIn("  - database.database_version cannot be tuned", output)
        self.assertIn("  - log_retention_days cannot be tuned on Google Cloud", output)
        self.assertIn("  - extra_environment.OTEL_EXPORTER_OTLP_HEADERS is not allowed", output)
        self.assertNotIn("placeholder-value", output)

    def test_malformed_repeated_or_oversized_files_are_refused(self):
        for body in (b"not json", b"\xff\xfe", b'{"api": {"cpu": 4096}, "api": {"cpu": 2048}}', b'{"database": {"disk_size_gb": NaN}}',
                     b'{"database": {"disk_size_gb": Infinity}}', b"[" * 100000):
            with self.subTest(body=body[:20]):
                self.refused(body)
        self.assertIn("at most 16384 bytes", self.refused(b" " * (runner.STATE_OBJECT_LIMIT + 1)))

    def test_denied_or_failed_read_is_never_treated_as_no_overrides(self):
        for failure in (http_error(403), http_error(503), OSError("network")):
            with self.subTest(failure=failure), self.assertRaises(runner.StepFailure) as refused:
                self.read({"overrides.json": failure})
            self.assertEqual(refused.exception.code, "infrastructure_failed")
            self.assertIn("Could not look for overrides.json", self.output)


class RunBoundaryTests(unittest.TestCase):
    """Where runner.main() stops, and what it tells OpenWork."""
    def run_main(self, objects, apply=None, kit=None):
        self.calls = calls = []
        with state_bucket(objects), patch.object(runner, "enroll", return_value=RUN_TOKEN), patch.object(runner, "report") as report, \
                patch.object(runner, "verify_target", side_effect=lambda *a: calls.append("target")), \
                patch.object(runner, "orchestration_mutex", side_effect=lambda: calls.append("lock") or contextlib.nullcontext()), \
                patch.object(runner, "mirror_images", side_effect=lambda: calls.append("mirror") or IMAGES), \
                patch.object(runner, "apply", side_effect=apply or (lambda *a: calls.append(("apply", a[1:])) or OUTPUTS)), \
                patch.object(runner, "write_applied", side_effect=kit or (lambda *a: calls.append(("record", a)))), \
                patch.object(runner, "verify_services"), patch.object(runner, "verify_health"), patch.object(runner, "verify_health_job"), \
                patch("builtins.print") as output:
            try:
                runner.main()
            finally:
                self.reports = [call.args[1:] for call in report.call_args_list]
                self.output = printed(output)

    def test_marker_refuses_after_the_project_check_and_reports_infrastructure_failed(self):
        for marker in (b"", b'{"reason":"ours"}', b"not json", b"x" * (runner.STATE_OBJECT_LIMIT + 1)):
            with self.subTest(marker=marker[:10]), self.assertRaises(runner.StepFailure):
                self.run_main({"ejected.json": marker, "overrides.json": json.dumps(TUNED).encode()})
            self.assertEqual(self.calls, ["target"])  # no lock, no mirroring, no Terraform, no record
            self.assertEqual(self.reports, [(1, "runner_connected"), (2, "release_verified"),
                                            (3, "account_verified", "failed", "infrastructure_failed")])
            self.assertIn("taken over by its owner: gs://" + ENV["STATE_BUCKET"] + "/deployments/" + DEPLOYMENT + "/ejected.json exists", self.output)

    def test_unreadable_marker_is_never_treated_as_absent(self):
        for failure in (http_error(403), http_error(500), OSError("network")):
            with self.subTest(failure=failure), self.assertRaises(runner.StepFailure):
                self.run_main({"ejected.json": failure})
            self.assertEqual(self.calls, ["target"])
            self.assertEqual(self.reports[-1], (3, "account_verified", "failed", "infrastructure_failed"))
            self.assertIn("Could not look for ejected.json", self.output)

    def test_refused_overrides_stop_before_the_lock_with_infrastructure_failed(self):
        with self.assertRaises(runner.StepFailure):
            self.run_main({"overrides.json": json.dumps({"database": {"deletion_protection": False}}).encode()})
        self.assertEqual(self.calls, ["target"])
        self.assertEqual(self.reports[-1], (3, "account_verified", "failed", "infrastructure_failed"))

    def test_valid_overrides_reach_terraform_and_the_record(self):
        self.run_main({"overrides.json": json.dumps(TUNED).encode()})
        self.assertEqual(self.calls, ["target", "lock", "mirror", ("apply", (IMAGES, TUNED)), ("record", (IMAGES, TUNED, OUTPUTS, RUN_TOKEN))])
        self.assertEqual(self.reports, [(1, "runner_connected"), (2, "release_verified"), (3, "account_verified"),
                                        (4, "infrastructure_applied"), (5, "services_ready"), (6, "health_verified")])
        self.run_main({})
        self.assertEqual(self.calls[3:], [("apply", (IMAGES, None)), ("record", (IMAGES, None, OUTPUTS, RUN_TOKEN))])

    def test_infrastructure_installed_always_means_the_record_is_current(self):
        def unwritable(*args):
            raise OSError("bucket unavailable")
        with self.assertRaises(OSError):
            self.run_main({}, kit=unwritable)
        self.assertEqual(self.reports[-1], (4, "infrastructure_applied", "failed", "infrastructure_failed"))
        self.assertNotIn((4, "infrastructure_applied"), self.reports)
        def failed(*args):
            raise ValueError("apply failed")
        with self.assertRaises(ValueError):
            self.run_main({}, apply=failed)
        self.assertEqual(self.calls, ["target", "lock", "mirror"])  # nothing recorded for an apply that did not finish

    def test_approving_terminal_refuses_before_the_prompt_bootstrap_or_build(self):
        data = bundle()
        for marker, message in ((b"{}", "self-managed"), (http_error(403), "cannot tell whether this deployment is self-managed.*HTTP 403")):
            with self.subTest(message=message), patch.object(sys, "argv", ["install.py", "--config-base64", launch(data)]), \
                    patch.object(install, "verify_target"), patch.object(install, "access_token", return_value="person-token"), \
                    patch.object(install, "request", side_effect=[marker]) as fetch, patch("builtins.input") as prompt, \
                    patch.object(install, "bootstrap") as bootstrap, patch.object(install, "submit_build") as build, patch("builtins.print"):
                with self.assertRaisesRegex(ValueError, message):
                    install.main()
                self.assertIn(urllib.parse.quote("deployments/" + DEPLOYMENT + "/ejected.json", safe=""), fetch.call_args.args[0])
                self.assertEqual(fetch.call_args.kwargs["headers"], {"Authorization": "Bearer person-token"})
                for untouched in (prompt, bootstrap, build):
                    untouched.assert_not_called()


class OverrideApplyTests(unittest.TestCase):
    def apply(self, overrides, plan=b"{}", maintained=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tf_root = root / "infra/managed-deployments/gcp/terraform"
            tf_root.mkdir(parents=True)
            self.written = written = []
            def execute(command, **kwargs):
                if command[1] in ("plan", "apply"):
                    written.append((command[1], json.loads((tf_root / "managed.auto.tfvars.json").read_text())))
            with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "maintenance_fence", return_value=maintained) as fence, patch.object(runner, "verify_maintained_revisions"), \
                    patch.object(subprocess, "run", side_effect=execute), \
                    patch.object(subprocess, "check_output", side_effect=lambda command, **kwargs: plan if command[1] == "show" else b"{}"), \
                    patch("builtins.print") as output:
                try:
                    runner.apply(root, IMAGES, overrides)
                finally:
                    self.fence, self.output = fence, printed(output)
                    self.files = sorted(path.name for path in tf_root.glob("*tfvars*"))

    def test_overrides_are_one_typed_variable_in_the_existing_input_file(self):
        self.apply(TUNED)
        # Maintenance and resume plans carry the same overrides; nothing is dropped mid-update.
        self.assertEqual([stage for stage, _ in self.written], ["plan", "plan", "apply", "plan", "apply"])
        self.assertTrue(all(variables["overrides"] == TUNED for _, variables in self.written))
        self.assertEqual(self.files, ["managed.auto.tfvars.json"])
        self.apply(None)
        self.assertTrue(all("overrides" not in variables for _, variables in self.written))

    def shrink(self, before, after, actions):
        return json.dumps({"resource_changes": [{"address": "module.platform.google_sql_database_instance.this[0]",
            "type": "google_sql_database_instance", "change": {"actions": actions,
            "before": {"database_version": "MYSQL_8_0", "settings": [{"disk_size": before}]},
            "after": {"database_version": "MYSQL_8_0", "settings": [{"disk_size": after}]}}}]}).encode()

    def test_plan_that_shrinks_the_database_disk_is_refused_before_maintenance_or_apply(self):
        # Lowering or removing database.disk_size_gb, or a disk Cloud SQL grew by
        # itself: Cloud SQL never shrinks, whether Terraform plans an update or a replacement.
        for actions in (["update"], ["delete", "create"]):
            with self.subTest(actions=actions), self.assertRaises(runner.StepFailure) as refused:
                self.apply({"database": {"disk_size_gb": 20}}, plan=self.shrink(50, 20, actions))
            self.assertEqual(refused.exception.code, "infrastructure_failed")
            self.assertEqual([stage for stage, _ in self.written], ["plan"])
            self.fence.assert_not_called()
            self.assertIn("The database disk is 50 GB and cannot shrink. Set database.disk_size_gb in overrides.json to at least that size", self.output)
        self.assertEqual(runner.storage_below_disk(json.loads(self.shrink(50, 20, ["update"]))),
                         {"module.platform.google_sql_database_instance.this[0]": 50})
        for before, after in ((20, 50), (50, 50), (None, 20), (50, None)):
            self.assertEqual(runner.storage_below_disk(json.loads(self.shrink(before, after, ["update"]))), {})
        self.assertEqual(runner.storage_below_disk({"resource_changes": [{"type": "google_sql_database_instance", "change": {"before": None, "after": {"settings": [{"disk_size": 20}]}}}]}), {})

    def test_growing_the_disk_is_applied_and_the_plan_guard_still_runs(self):
        self.apply({"database": {"disk_size_gb": 50}}, plan=self.shrink(20, 50, ["update"]), maintained=False)
        self.assertEqual([stage for stage, _ in self.written], ["plan", "apply"])
        with self.assertRaisesRegex(ValueError, "refusing protected replacement"):
            self.apply({"database": {"tier": "db-custom-2-7680"}}, plan=self.shrink(50, 50, ["delete", "create"]))
        self.assertEqual([stage for stage, _ in self.written], ["plan"])


class TerraformTuningTests(unittest.TestCase):
    """Planned values from the mocked-provider root, so sizing claims are checked, not read."""
    @classmethod
    def setUpClass(cls):
        binary = shutil.which("terraform")
        assert binary, "terraform is required"
        cls.plans = {}
        for file in ("overrides", "eject"):
            result = subprocess.run([binary, "test", f"-filter=tests/{file}.tftest.hcl", "-json", "-verbose"],
                                    cwd=GCP / "terraform", capture_output=True, text=True, timeout=300)
            assert result.returncode == 0, result.stderr + result.stdout
            cls.plans.update({row["@testrun"]: {resource["address"]: resource["change"]["after"] for resource in row["test_plan"].get("resource_changes", [])}
                              for row in map(json.loads, result.stdout.splitlines()) if row.get("type") == "test_plan"})

    def sizing(self, run):
        plan = self.plans[run]
        services = {}
        for key in ("api", "web"):
            template = plan["module.platform.google_cloud_run_v2_service." + key]["template"][0]
            container = template["containers"][0]
            services[key] = {**container["resources"][0]["limits"], "min": template["scaling"][0]["min_instance_count"],
                             "max": template["scaling"][0]["max_instance_count"],
                             "otel": {entry["name"]: entry["value"] for entry in container["env"] if entry["name"].startswith("OTEL_")}}
        database = plan["module.platform.google_sql_database_instance.this[0]"]
        settings = database["settings"][0]
        return services, {"version": database["database_version"], "protected": database["deletion_protection"],
                          "protected_by_api": settings["deletion_protection_enabled"], "tier": settings["tier"], "disk": settings["disk_size"],
                          "availability": settings["availability_type"], "backups": settings["backup_configuration"][0]["enabled"]}

    def test_small_profile_is_what_installed_deployments_already_run(self):
        services, database = self.sizing("profile_without_overrides")
        self.assertEqual(services["api"], {"cpu": "2", "memory": "2Gi", "min": 1, "max": 10, "otel": {}})
        self.assertEqual(services["web"], {"cpu": "1", "memory": "1Gi", "min": 1, "max": 10, "otel": {}})
        self.assertEqual(database, {"version": "MYSQL_8_0", "protected": True, "protected_by_api": True, "tier": "db-custom-1-3840",
                                    "disk": 20, "availability": "ZONAL", "backups": True})

    def test_overrides_change_only_what_they_name(self):
        services, database = self.sizing("overrides_within_allowlist_are_applied")
        otel = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.com", "OTEL_SERVICE_NAME": "openwork"}
        self.assertEqual(services["api"], {"cpu": "4", "memory": "8Gi", "min": 2, "max": 20, "otel": otel})
        self.assertEqual(services["web"], {"cpu": "1", "memory": "2Gi", "min": 1, "max": 10, "otel": otel})
        self.assertEqual(database, {"version": "MYSQL_8_0", "protected": True, "protected_by_api": True, "tier": "db-custom-2-7680",
                                    "disk": 50, "availability": "REGIONAL", "backups": True})

    def test_hand_edited_input_cannot_reach_version_protection_or_backups(self):
        self.assertEqual(self.sizing("unlisted_settings_never_reach_the_platform"), self.sizing("profile_without_overrides"))

    def test_protection_comes_off_only_through_the_removal_switch_the_installer_never_sets(self):
        _, database = self.sizing("removal_turns_protection_off_only_when_asked")
        self.assertEqual((database["protected"], database["protected_by_api"], database["version"]), (False, False, "MYSQL_8_0"))
        for run in ("managed_run_keeps_deletion_protection", "overrides_within_allowlist_are_applied"):
            _, database = self.sizing(run)
            self.assertEqual((database["protected"], database["protected_by_api"]), (True, True))
        with patch.dict(os.environ, ENV, clear=True):
            self.assertNotIn("allow_destroy", runner.inputs(IMAGES, TUNED))
        # TF_VAR_* from the environment cannot set it either.
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {**ENV, "TF_VAR_allow_destroy": "true"}, clear=True):
            self.assertNotIn("TF_VAR_allow_destroy", runner.terraform_environment(Path(directory)))


class AppliedRecordTests(unittest.TestCase):
    FILES = ["inputs.auto.tfvars.json", "backend.tf.json", "terraform-version.json", "outputs.json", "unmanaged.json", "README.md", "release.json"]

    @contextlib.contextmanager
    def release(self, change=None, environment=None):
        with tempfile.TemporaryDirectory() as directory:
            manifest = {"provider": "gcp", "version": ENV["VERSION"], "protocolVersion": 1, "images": dict(PINS)}
            if change:
                change(manifest)
            (Path(directory) / "release.json").write_text(json.dumps(manifest))
            with patch.dict(os.environ, {**RUN_ENV, **(environment or {})}, clear=True), \
                    patch.object(runner, "__file__", str(Path(directory) / "infra/managed-deployments/gcp/runner/runner.py")):
                yield

    def kit(self, overrides=TUNED, outputs=None, change=None):
        with self.release(change):
            return runner.applied_kit(IMAGES, overrides, OUTPUTS if outputs is None else outputs)

    def test_record_is_exactly_the_shared_layout_with_release_written_last(self):
        kit = self.kit()
        self.assertEqual(list(kit), self.FILES)
        for file, content in kit.items():
            self.assertIsInstance(content, str)
            if file.endswith(".json"):
                json.loads(content)

    def test_release_has_exactly_the_shared_keys(self):
        expected = {"provider": "gcp", "version": ENV["VERSION"], "bundleUrl": ENV["BUNDLE_URL"], "bundleSha256": ENV["BUNDLE_SHA256"],
                    "deploymentId": DEPLOYMENT, "runId": RUN}
        self.assertEqual(json.loads(self.kit()["release.json"]), expected)  # revision 1 is not written
        self.assertEqual(json.loads(self.kit(change=lambda m: m.update(installerRevision=3))["release.json"]), {**expected, "installerRevision": 3})
        for invalid in (0, -1, "2", True, 1.5, None):
            with self.subTest(revision=invalid):
                self.assertEqual(json.loads(self.kit(change=lambda m, invalid=invalid: m.update(installerRevision=invalid))["release.json"]), expected)

    def test_inputs_backend_and_terraform_version_reproduce_the_apply(self):
        kit = self.kit()
        with patch.dict(os.environ, ENV, clear=True):
            self.assertEqual(json.loads(kit["inputs.auto.tfvars.json"]), runner.inputs(IMAGES, TUNED))
            self.assertEqual(runner.backend_settings(), {"bucket": ENV["STATE_BUCKET"], "prefix": "deployments/" + DEPLOYMENT})
        # A deployment without overrides.json records none.
        self.assertNotIn("overrides", json.loads(self.kit(overrides=None)["inputs.auto.tfvars.json"]))
        # A valid Terraform JSON file: the customer saves it as backend_override.tf.json.
        self.assertEqual(json.loads(kit["backend.tf.json"]), {"terraform": {"backend": {"gcs": {
            "bucket": ENV["STATE_BUCKET"], "prefix": "deployments/" + DEPLOYMENT}}}})
        self.assertNotIn("impersonate", kit["backend.tf.json"])
        self.assertEqual(json.loads(kit["terraform-version.json"]), {
            "version": runner.TERRAFORM_VERSION, "sha256": runner.TERRAFORM_SHA256, "platform": "linux_amd64",
            "url": "https://releases.hashicorp.com/terraform/1.16.5/terraform_1.16.5_linux_amd64.zip"})
        self.assertIn("required_version = \"= " + runner.TERRAFORM_VERSION + "\"", (GCP / "terraform/main.tf").read_text())

    def test_record_holds_no_secret_or_state(self):
        outputs = {**OUTPUTS, "bootstrap_code": "one-time-setup-code", "database_url": "mysql://openwork:generated-password@localhost/db"}
        kit = self.kit(outputs=outputs)
        self.assertEqual(json.loads(kit["outputs.json"]), OUTPUTS)  # explicit list of public outputs
        everything = "\n".join(kit.values())
        for secret in (RUN_ENV["CHALLENGE"], RUN_TOKEN, "one-time-setup-code", "generated-password", "Bearer ", "private_key", "tfstate"):
            self.assertNotIn(secret, everything)
        variables = json.loads(kit["inputs.auto.tfvars.json"])
        self.assertFalse(any(word in key.lower() for key in variables for word in ("secret", "password", "token", "challenge", "key")))

    def test_unmanaged_lists_what_bootstrap_and_the_runner_created_outside_state(self):
        unmanaged = json.loads(self.kit()["unmanaged.json"])
        bootstrap = unmanaged["bootstrap"]
        self.assertEqual(bootstrap["enabledApis"], install.APIS)
        self.assertEqual(set(bootstrap["serviceAccounts"]), {"runner", "runtime", "web", "health", "scheduler"})
        self.assertEqual(bootstrap["serviceAccounts"]["runner"], ENV["RUNNER_SERVICE_ACCOUNT"])
        self.assertEqual(bootstrap["customRole"], "projects/test-project/roles/ow_123456781234_drain")
        self.assertEqual(bootstrap["projectRoles"]["runner"], install.RUNNER_ROLES + [bootstrap["customRole"]])
        self.assertEqual(bootstrap["projectRoles"]["health"], install.HEALTH_ROLES)
        self.assertEqual(bootstrap["stateBucket"]["name"], ENV["STATE_BUCKET"])
        self.assertIn({"on": ENV["RUNNER_SERVICE_ACCOUNT"], "member": "serviceAccount:" + ENV["RUNNER_SERVICE_ACCOUNT"],
                       "role": "roles/iam.serviceAccountOpenIdTokenCreator"}, bootstrap["serviceAccountRoles"])
        self.assertIn("projects/test-project/locations/us-central1/repositories/ow-123456781234", unmanaged["createdByTheInstaller"][0])

    def test_readme_gives_this_deployments_exact_commands(self):
        text = self.kit()["README.md"]
        for expected in ("gs://" + ENV["STATE_BUCKET"] + "/deployments/" + DEPLOYMENT + "/ejected.json",
                         "gs://" + ENV["STATE_BUCKET"] + "/deployments/" + DEPLOYMENT + "/overrides.json",
                         "curl -fsSLo bundle.tar.gz '" + ENV["BUNDLE_URL"] + "'", ENV["BUNDLE_SHA256"] + "  bundle.tar.gz",
                         "`backend_override.tf.json`", "terraform init -lockfile=readonly", "Install Terraform 1.16.5",
                         "terraform destroy -var allow_destroy=true", ENV["RUNNER_SERVICE_ACCOUNT"]):
            self.assertIn(expected, text)
        self.assertNotIn("$", text.replace("$ ", ""))  # every placeholder was filled
        # The example is a file this runner accepts.
        example = json.loads(text.split("```json\n", 1)[1].split("```", 1)[0])
        self.assertEqual(runner.override_problems(example), (example, []))

    def store(self, token=RUN_TOKEN, environment=None, reply=None):
        self.stored = stored = []
        def upload(url, data=None, headers=None, **kwargs):
            parsed = urllib.parse.urlsplit(url)
            object_name = urllib.parse.parse_qs(parsed.query)["name"][0]
            self.assertEqual(parsed.path, "/upload/storage/v1/b/" + ENV["STATE_BUCKET"] + "/o")
            self.assertEqual(headers["Authorization"], "Bearer runner-token")
            stored.append((object_name, data, headers["Content-Type"]))
            return reply or json.dumps({"name": object_name}).encode()
        with self.release(environment=environment), patch.object(runner, "storage_headers", return_value={"Authorization": "Bearer runner-token"}), \
                patch.object(runner, "request", side_effect=upload), patch("builtins.print"):
            runner.write_applied(IMAGES, TUNED, OUTPUTS, token)

    def test_record_is_stored_under_applied_in_the_state_bucket(self):
        self.store()
        self.assertEqual([name for name, _, _ in self.stored], ["deployments/" + DEPLOYMENT + "/applied/" + file for file in self.FILES])
        self.assertEqual({kind for _, _, kind in self.stored}, {"application/json", "text/markdown; charset=utf-8"})
        with self.assertRaisesRegex(ValueError, "not stored"):
            self.store(reply=b"{}")

    def test_nothing_is_written_when_any_file_would_hold_the_run_token_or_challenge(self):
        for label, token, environment in (("challenge", RUN_TOKEN, {"OWNER_EMAIL": "x" + RUN_ENV["CHALLENGE"] + "@example.com"}),
                                          ("token", RUN_TOKEN, {"DOMAIN_NAME": RUN_TOKEN + ".example.com"}),
                                          ("token in bundle url", RUN_TOKEN, {"BUNDLE_URL": ENV["BUNDLE_URL"] + "&x=" + RUN_TOKEN})):
            with self.subTest(case=label):
                with self.assertRaisesRegex(ValueError, "refusing to record a run credential"):
                    self.store(token=token, environment=environment)
                self.assertEqual(self.stored, [])

    def test_customer_can_initialise_the_bundled_root_with_the_record(self):
        # The release root declares an empty backend; the recorded backend file must
        # replace it rather than collide with it, and the inputs must satisfy the
        # typed variables. Reaching the real state bucket needs live credentials.
        binary = shutil.which("terraform")
        self.assertIsNotNone(binary)
        kit = self.kit()
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for relative in ("infra/managed-deployments/gcp/terraform", "infra/managed-deployments/gcp/health",
                             "infra/managed-deployments/contract", "infra/terraform/modules/openwork-gcp-cloud-run"):
                shutil.copytree(ROOT / relative, work / relative, ignore=shutil.ignore_patterns(".terraform", "tests", "examples", "*.tfvars*"))
            tf_root = work / "infra/managed-deployments/gcp/terraform"
            (tf_root / "inputs.auto.tfvars.json").write_text(kit["inputs.auto.tfvars.json"])
            (tf_root / "backend_override.tf.json").write_text(kit["backend.tf.json"])
            environment = {**os.environ, "TF_CLI_CONFIG_FILE": os.devnull}
            for command in (["init", "-backend=false", "-input=false", "-lockfile=readonly",
                             "-plugin-dir=" + str(GCP / "terraform/.terraform/providers")], ["validate", "-no-color"]):
                checked = subprocess.run([binary, *command], cwd=tf_root, env=environment, capture_output=True, text=True, timeout=180)
                self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            # The same file under its recorded name would be a second backend block.
            (tf_root / "backend_override.tf.json").rename(tf_root / "backend.tf.json")
            collided = subprocess.run([binary, "validate", "-no-color"], cwd=tf_root, env=environment, capture_output=True, text=True, timeout=180)
            self.assertNotEqual(collided.returncode, 0)
            self.assertIn("backend", (collided.stdout + collided.stderr).lower())


if __name__ == "__main__":
    unittest.main()
