"""Offline checks for the Cloud Build hand-off: the approving terminal bootstraps
and submits one build; the build runs as the runner account. No cloud calls."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_gcp_installer import DEPLOYMENT, ENV, GCP, RUN, args, bundle, install, runner

PREFIX = "ow-123456781234"
RUNNER = ENV["RUNNER_SERVICE_ACCOUNT"]
APPROVER = "admin@example.com"
SECURE_BUCKET = {"projectNumber": ENV["PROJECT_NUMBER"], "versioning": {"enabled": True},
                 "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"}}


def launch(data):
    config = {"deploymentId": DEPLOYMENT, "runId": RUN, "challenge": ENV["CHALLENGE"], "size": "small",
              "target": {"projectId": ENV["PROJECT_ID"], "projectNumber": ENV["PROJECT_NUMBER"], "region": ENV["REGION"], "dnsZoneName": "zone"},
              "domainName": ENV["DOMAIN_NAME"], "ownerEmail": ENV["OWNER_EMAIL"],
              "release": {"apiOrigin": ENV["CONTROL_PLANE_ORIGIN"], "version": ENV["VERSION"], "bundleUrl": ENV["BUNDLE_URL"],
                          "bundleSha256": hashlib.sha256(data).hexdigest()}}
    return base64.b64encode(json.dumps(config).encode()).decode()


class Project:
    """Records gcloud calls the way install.cloud receives them."""
    def __init__(self, runner_policy=None, build=None, active=APPROVER):
        self.calls, self.config = [], None
        self.runner_policy = runner_policy or {}
        self.build = {"id": ENV["BUILD_ID"], "logUrl": "https://console.cloud.google.com/cloud-build/builds/" + ENV["BUILD_ID"]} if build is None else build
        self.active = active

    def cloud(self, *arguments, **kwargs):
        self.calls.append(arguments)
        if arguments[:2] == ("auth", "list"):
            return [{"account": self.active}]
        if arguments[:3] == ("iam", "service-accounts", "get-iam-policy"):
            return self.runner_policy
        if arguments[:3] == ("storage", "buckets", "list"):
            return [{"name": ENV["STATE_BUCKET"]}]
        if arguments[:3] == ("storage", "buckets", "describe"):
            return SECURE_BUCKET
        if arguments[:2] == ("builds", "submit"):
            path = next(argument.split("=", 1)[1] for argument in arguments if argument.startswith("--config="))
            self.config = json.loads(Path(path).read_text())
            return self.build
        return {}

    def named(self, *prefix):
        return [call for call in self.calls if call[:len(prefix)] == prefix]

    def bootstrap(self):
        with patch.object(install, "cloud", side_effect=self.cloud), patch("builtins.print") as output, \
                patch.object(install, "ensure_sa", side_effect=lambda a, account: account + "@test-project.iam.gserviceaccount.com"):
            install.bootstrap(args(), PREFIX)
        return output


class ApprovalTests(unittest.TestCase):
    def approve(self, project, data=None):
        data = bundle() if data is None else data
        with patch.object(sys, "argv", ["install.py", "--config-base64", launch(data)]), patch.object(install, "verify_target") as target, \
                patch.object(install, "access_token", return_value="person-token"), patch.object(install, "refuse_if_ejected") as ejected, \
                patch("builtins.input", return_value=ENV["PROJECT_ID"]), patch.object(install, "request", return_value=data), \
                patch.object(install, "cloud", side_effect=project.cloud), \
                patch.object(install, "ensure_sa", side_effect=lambda a, account: account + "@test-project.iam.gserviceaccount.com"), \
                patch.object(subprocess, "run") as execute, patch("builtins.print") as output:
            install.main()
        return target, ejected, execute, " ".join(str(call.args[0]) for call in output.call_args_list)

    def test_approval_bootstraps_submits_one_asynchronous_build_and_exits(self):
        project = Project()
        target, ejected, execute, printed = self.approve(project)
        target.assert_called_once()
        ejected.assert_called_once_with(ENV["STATE_BUCKET"], DEPLOYMENT, {"Authorization": "Bearer person-token"})
        # The terminal runs no Terraform, no runner and no Google sign-in of any kind.
        execute.assert_not_called()
        self.assertEqual(project.named("auth"), [("auth", "list", "--filter=status:ACTIVE")])
        submitted = project.named("builds", "submit")
        self.assertEqual(len(submitted), 1)
        self.assertEqual(project.calls[-1], submitted[0])  # bootstrap finishes before the build starts
        self.assertIn("--no-source", submitted[0])
        self.assertIn("--async", submitted[0])
        self.assertIn(ENV["BUILD_ID"], printed)
        self.assertIn("https://console.cloud.google.com/cloud-build/builds/" + ENV["BUILD_ID"], printed)
        self.assertIn("close this terminal", printed)
        self.assertNotIn(ENV["CHALLENGE"], printed)

    def test_build_runs_as_the_runner_with_logs_and_time_it_can_use(self):
        project = Project()
        self.approve(project)
        config = project.config
        self.assertEqual(config["serviceAccount"], "projects/" + ENV["PROJECT_ID"] + "/serviceAccounts/" + RUNNER)
        # A user-specified service account cannot write to the default logs bucket.
        self.assertEqual(config["options"], {"logging": "CLOUD_LOGGING_ONLY"})
        seconds = int(config["timeout"].removesuffix("s"))
        self.assertGreaterEqual(seconds, 2 * 60 * 60)
        self.assertLess(seconds, 3 * 60 * 60)  # inside Den's run lifetime, renewed at enrolment
        self.assertEqual(len(config["steps"]), 1)
        step = config["steps"][0]
        self.assertEqual(step["timeout"], config["timeout"])
        self.assertRegex(step["name"], r"^gcr\.io/google\.com/cloudsdktool/google-cloud-cli@sha256:[a-f0-9]{64}$")
        self.assertEqual(step["entrypoint"], install.BUILD_PYTHON)
        self.assertIn("BUILD_ID=$BUILD_ID", step["env"])
        self.assertNotIn("source", config)
        self.assertNotIn("images", config)
        self.assertNotIn("secrets", json.dumps(config).lower())

    def test_build_region_is_not_the_deployment_region(self):
        for target_region in ("us-central1", "asia-east2"):
            project = Project()
            with patch.object(install, "cloud", side_effect=project.cloud), tempfile.TemporaryDirectory() as directory:
                value = args()
                value.region = target_region
                install.submit_build(value, PREFIX, "config", Path(directory))
            self.assertIn("--region=global", project.calls[0])
            self.assertNotIn("--region=" + target_region, project.calls[0])
        with patch.dict(os.environ, {install.BUILD_REGION_VARIABLE: "europe-west1"}):
            self.assertEqual(install.build_region(), "europe-west1")
        for invalid in ("", "europe-west1;rm", "--async", "EUROPE"):
            with self.subTest(region=invalid), patch.dict(os.environ, {install.BUILD_REGION_VARIABLE: invalid}):
                with self.assertRaises(ValueError):
                    install.build_region()

    def test_only_the_build_id_is_substituted(self):
        value = args()
        value.bundle_url = "https://storage.googleapis.com/releases/a$PROJECT_ID/bundle.tar.gz?generation=123"
        step = install.build_config(value, PREFIX, "Y29uZmln")["steps"][0]
        self.assertEqual(step["args"][0], "-c")
        self.assertEqual(step["args"][1], install.BUILD_ENTRY)
        self.assertNotIn("$", install.BUILD_ENTRY)
        self.assertEqual(step["args"][2], value.bundle_url.replace("$", "$$"))
        self.assertEqual(step["args"][3:], [value.bundle_sha256, "Y29uZmln"])
        self.assertEqual([entry for entry in step["env"] if "$" in entry], ["BUILD_ID=$BUILD_ID"])
        with self.assertRaisesRegex(ValueError, "too large"):
            install.build_config(value, PREFIX, "a" * 8001)

    def test_unverified_release_changes_nothing_in_the_project(self):
        project = Project()
        good = bundle()
        with patch.object(sys, "argv", ["install.py", "--config-base64", launch(good)]), patch.object(install, "verify_target"), \
                patch.object(install, "access_token", return_value="person-token"), patch.object(install, "refuse_if_ejected"), \
                patch("builtins.input", return_value=ENV["PROJECT_ID"]), patch.object(install, "request", return_value=good + b"tampered"), \
                patch.object(install, "cloud", side_effect=project.cloud), patch("builtins.print"):
            with self.assertRaisesRegex(ValueError, "checksum"):
                install.main()
        self.assertEqual(project.calls, [])

    def test_uncertain_build_receipt_is_never_resubmitted(self):
        for receipt in ({}, [], {"id": "not a build"}, {"id": 7}):
            project = Project(build=receipt)
            with self.subTest(receipt=receipt), patch.object(install, "cloud", side_effect=project.cloud), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, "before running the command again"):
                    install.submit_build(args(), PREFIX, "config", Path(directory))
            self.assertEqual(len(project.named("builds", "submit")), 1)

    def test_only_a_definite_permission_refusal_is_submitted_again(self):
        # "Act as" and the Cloud Build API are seconds old on a first install.
        def refusal(text):
            return subprocess.CalledProcessError(1, ["gcloud"], stderr=text)
        receipt = {"id": ENV["BUILD_ID"], "logUrl": "https://console.cloud.google.com/cloud-build/builds/" + ENV["BUILD_ID"]}
        denied = refusal("ERROR: (gcloud.builds.submit) PERMISSION_DENIED: caller does not have permission to act as service account")
        with patch.object(install, "cloud", side_effect=[denied, denied, receipt]) as cloud, patch.object(install.time, "sleep") as wait, \
                patch("builtins.print"), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(install.submit_build(args(), PREFIX, "config", Path(directory))[0], ENV["BUILD_ID"])
        self.assertEqual(cloud.call_count, 3)
        self.assertEqual(wait.call_count, 2)
        with patch.object(install, "cloud", side_effect=denied) as cloud, patch.object(install.time, "sleep"), \
                patch("builtins.print"), tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(subprocess.CalledProcessError):
                install.submit_build(args(), PREFIX, "config", Path(directory))
        self.assertEqual(cloud.call_count, install.BUILD_SUBMIT_ATTEMPTS)
        for uncertain in (refusal("ERROR: INVALID_ARGUMENT: invalid build"), refusal("ERROR: DEADLINE_EXCEEDED"), refusal(None),
                          subprocess.TimeoutExpired("gcloud", 30), OSError("network")):
            with self.subTest(failure=uncertain), patch.object(install, "cloud", side_effect=uncertain) as cloud, \
                    patch.object(install.time, "sleep") as wait, tempfile.TemporaryDirectory() as directory:
                with self.assertRaises((subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError)):
                    install.submit_build(args(), PREFIX, "config", Path(directory))
            cloud.assert_called_once()
            wait.assert_not_called()

    def test_missing_log_link_falls_back_to_the_console_address(self):
        project = Project(build={"id": ENV["BUILD_ID"], "logUrl": "http://evil.test/log"})
        with patch.object(install, "cloud", side_effect=project.cloud), tempfile.TemporaryDirectory() as directory:
            identifier, link = install.submit_build(args(), PREFIX, "config", Path(directory))
        self.assertEqual(identifier, ENV["BUILD_ID"])
        self.assertEqual(link, "https://console.cloud.google.com/cloud-build/builds;region=global/" + ENV["BUILD_ID"]
                         + "?project=" + ENV["PROJECT_NUMBER"])


class BootstrapGrantTests(unittest.TestCase):
    def test_runner_project_roles_are_exactly_the_reviewed_set(self):
        self.assertEqual(install.RUNNER_ROLES, ["roles/run.admin", "roles/cloudsql.admin", "roles/secretmanager.admin",
                                                "roles/compute.admin", "roles/dns.admin", "roles/artifactregistry.admin",
                                                "roles/cloudscheduler.admin", "roles/serviceusage.serviceUsageConsumer",
                                                "roles/logging.logWriter"])
        project = Project()
        project.bootstrap()
        granted = [next(flag for flag in call if flag.startswith("--role=")).removeprefix("--role=")
                   for call in project.named("projects", "add-iam-policy-binding") if "--member=serviceAccount:" + RUNNER in call]
        self.assertEqual(granted, install.RUNNER_ROLES + ["projects/test-project/roles/ow_123456781234_drain"])
        for role in granted:
            for forbidden in ("owner", "editor", "projectIamAdmin", "serviceAccountAdmin", "serviceAccountTokenCreator",
                              "serviceAccountKeyAdmin", "roleAdmin", "cloudbuild", "storage.admin", "logging.admin", "logging.viewer"):
                self.assertNotIn(forbidden, role)

    def test_runner_mints_only_its_own_identity_token_and_the_approver_only_acts_as_it(self):
        project = Project()
        project.bootstrap()
        on_runner = [(next(flag for flag in call if flag.startswith("--member=")).removeprefix("--member="),
                      next(flag for flag in call if flag.startswith("--role=")).removeprefix("--role="))
                     for call in project.named("iam", "service-accounts", "add-iam-policy-binding") if call[3] == RUNNER]
        self.assertEqual(on_runner, [("serviceAccount:" + RUNNER, "roles/iam.serviceAccountOpenIdTokenCreator"),
                                     ("user:" + APPROVER, "roles/iam.serviceAccountUser")])
        self.assertFalse(any("roles/iam.serviceAccountTokenCreator" in flag for call in project.calls
                             if "add-iam-policy-binding" in call for flag in call))
        # The approving person receives nothing on the project itself.
        self.assertFalse(any("--member=user:" + APPROVER in call for call in project.named("projects")))
        self.assertEqual(project.named("iam", "service-accounts", "remove-iam-policy-binding"), [])
        self.assertEqual(project.named("iam", "service-accounts", "keys"), [])

    def test_cloud_shell_era_token_grant_is_retired_for_the_approver_only(self):
        role = "roles/iam.serviceAccountTokenCreator"
        policy = {"bindings": [
            {"role": role, "members": ["user:" + APPROVER, "user:earlier@example.com"]},
            {"role": role, "members": ["user:" + APPROVER], "condition": {"title": "customer condition"}},
            {"role": "roles/iam.serviceAccountUser", "members": ["user:" + APPROVER]}]}
        project = Project(runner_policy=policy)
        output = project.bootstrap()
        self.assertEqual(project.named("iam", "service-accounts", "remove-iam-policy-binding"),
                         [("iam", "service-accounts", "remove-iam-policy-binding", RUNNER, "--member=user:" + APPROVER,
                           "--role=" + role, "--condition=None")])
        printed = " ".join(str(call.args[0]) for call in output.call_args_list)
        self.assertIn("user:earlier@example.com", printed)
        self.assertNotIn("user:" + APPROVER, printed)

    def test_same_bucket_and_identities_are_reused_on_migration(self):
        project = Project()
        with patch.object(install, "cloud", side_effect=project.cloud), patch("builtins.print"), \
                patch.object(install, "ensure_sa", side_effect=lambda a, account: account + "@test-project.iam.gserviceaccount.com"):
            identities, bucket = install.bootstrap(args(), PREFIX)
        self.assertEqual(bucket, ENV["STATE_BUCKET"])
        self.assertEqual(identities["runner"], RUNNER)
        self.assertEqual(project.named("storage", "buckets", "create"), [])
        self.assertEqual(install.runner_account(args(), PREFIX), RUNNER)
        self.assertEqual(install.state_bucket(args(), PREFIX), ENV["STATE_BUCKET"])


class CloudShellMigrationTests(unittest.TestCase):
    def test_cloud_shell_era_state_plans_no_change_under_the_cloud_build_root(self):
        # tests/cloud-shell-root is the root as Cloud Shell installers applied it:
        # the provider impersonated the runner and sizing was literal. Migrating a
        # deployment to the build runner must not change one resource or output.
        frozen = (GCP / "terraform/tests/cloud-shell-root/main.tf").read_text()
        self.assertIn("impersonate_service_account", frozen)
        self.assertNotIn("overrides", frozen)
        binary = shutil.which("terraform")
        self.assertIsNotNone(binary)
        result = subprocess.run([binary, "test", "-filter=tests/adoption.tftest.hcl", "-json", "-verbose"],
                                cwd=GCP / "terraform", capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        plans = {row["@testrun"]: row["test_plan"] for row in map(json.loads, result.stdout.splitlines())
                 if row.get("type") == "test_plan"}
        plan = plans["cloud_build_root_changes_nothing"]
        changes = {resource["address"]: resource["change"]["actions"] for resource in plan["resource_changes"]}
        self.assertGreaterEqual(len(changes), 40)  # the whole platform, not an empty state
        for address in ("module.platform.google_sql_database_instance.this[0]", "module.platform.google_cloud_run_v2_service.api",
                        "module.platform.google_cloud_run_v2_service.web", "google_cloud_run_v2_job.health"):
            self.assertIn(address, changes)
        self.assertEqual({address: actions for address, actions in changes.items() if actions != ["no-op"]}, {})
        self.assertFalse(any(resource.get("previous_address") for resource in plan["resource_changes"]))
        self.assertTrue(all(output["actions"] == ["no-op"] for output in plan["output_changes"].values()))
        self.assertEqual(runner.unsafe_changes(plan), [])


class BuildEntryTests(unittest.TestCase):
    """The first code in the build: the string Cloud Build passes to python -c."""
    def enter(self, data, digest):
        self.ran = ran = []
        def execute(command, **kwargs):
            ran.append((command, Path(command[1]).read_bytes(), kwargs))
        opener = Mock()
        opener.open.return_value.__enter__ = lambda context: Mock(read=lambda limit: data[:limit])
        opener.open.return_value.__exit__ = lambda *details: False
        with patch.object(sys, "argv", ["-c", ENV["BUNDLE_URL"], digest, "Y29uZmln"]), \
                patch("urllib.request.build_opener", return_value=opener) as build_opener, patch.object(subprocess, "run", side_effect=execute):
            exec(compile(install.BUILD_ENTRY, "build-entry", "exec"), {"__name__": "__main__"})
        return ran, opener, build_opener

    def archive(self, source=b"print('installer')\n", kind=tarfile.REGTYPE):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo(install.INSTALLER_PATH)
            member.type, member.size = kind, len(source) if kind == tarfile.REGTYPE else 0
            member.linkname = "/etc/passwd"
            archive.addfile(member, io.BytesIO(source) if kind == tarfile.REGTYPE else None)
        return buffer.getvalue()

    def test_runs_only_the_installer_from_the_archive_that_matches_the_approved_digest(self):
        data = self.archive()
        ran, opener, build_opener = self.enter(data, hashlib.sha256(data).hexdigest())
        self.assertEqual(opener.open.call_args.args[0], ENV["BUNDLE_URL"])
        self.assertEqual(type(build_opener.call_args.args[0]).__name__, "NoRedirect")
        self.assertEqual(len(ran), 1)
        command, source, kwargs = ran[0]
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(command[2:], ["--config-base64", "Y29uZmln", "--cloud-build"])
        self.assertEqual(source, b"print('installer')\n")
        self.assertEqual(kwargs, {"check": True})

    def test_wrong_digest_oversize_or_linked_installer_runs_nothing(self):
        data = self.archive()
        linked = self.archive(kind=tarfile.SYMTYPE)
        # A verified archive without the installer path (other provider, other layout).
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo("release.json")
            member.size = 2
            archive.addfile(member, io.BytesIO(b"{}"))
        other = buffer.getvalue()
        for label, body, digest in [("digest", data, "b" * 64), ("truncated", data[:-1], hashlib.sha256(data).hexdigest()),
                                    ("link", linked, hashlib.sha256(linked).hexdigest()),
                                    ("missing", other, hashlib.sha256(other).hexdigest())]:
            with self.subTest(case=label):
                with self.assertRaises((ValueError, KeyError)):
                    self.enter(body, digest)
                self.assertEqual(self.ran, [])

    def test_real_release_bundle_enters_through_its_own_installer(self):
        data = bundle()
        ran, _, _ = self.enter(data, hashlib.sha256(data).hexdigest())
        self.assertEqual(ran[0][1], b"# fixture\n")


class InBuildTests(unittest.TestCase):
    def start(self, environment=None, active=RUNNER, data=None, home=None):
        data = bundle() if data is None else data
        project = Project(active=active)
        self.ran = ran = []
        def execute(command, **kwargs):
            ran.append((command, kwargs, Path(command[1]).exists()))
        with tempfile.TemporaryDirectory() as fallback:
            inherited = {"BUILD_ID": ENV["BUILD_ID"], "HOME": home or fallback, "PATH": os.environ["PATH"], **(environment or {})}
            with patch.dict(os.environ, inherited, clear=True), patch.object(sys, "argv", ["install.py", "--config-base64", launch(data), "--cloud-build"]), \
                    patch.object(install, "cloud", side_effect=project.cloud), patch.object(install, "request", return_value=data), \
                    patch.object(install, "verify_target") as target, patch.object(install, "bootstrap") as bootstrap, \
                    patch.object(install, "submit_build") as submit, patch("builtins.input") as prompt, \
                    patch.object(subprocess, "run", side_effect=execute):
                try:
                    install.main()
                finally:
                    # The build never prompts, bootstraps or submits another build.
                    for unused in (target, bootstrap, submit, prompt):
                        unused.assert_not_called()
        return ran, project

    def test_build_verifies_the_bundle_then_runs_the_runner_as_itself(self):
        ran, project = self.start()
        self.assertEqual(project.calls, [("auth", "list", "--filter=status:ACTIVE")])
        self.assertEqual(len(ran), 1)
        command, kwargs, existed = ran[0]
        self.assertEqual(command[0], sys.executable)  # the image has no python3 on PATH
        self.assertTrue(command[1].endswith("infra/managed-deployments/gcp/runner/runner.py"))
        self.assertTrue(existed)
        environment = kwargs["env"]
        for key in ("STATE_BUCKET", "RUNNER_SERVICE_ACCOUNT", "BUILD_ID", "DEPLOYMENT_ID", "RUN_ID", "CHALLENGE", "PROJECT_ID",
                    "PROJECT_NUMBER", "REGION", "DNS_ZONE_NAME", "DOMAIN_NAME", "OWNER_EMAIL", "VERSION", "CONTROL_PLANE_ORIGIN", "BUNDLE_URL"):
            self.assertEqual(environment[key], ENV[key], key)
        self.assertEqual(environment["BUNDLE_SHA256"], hashlib.sha256(bundle()).hexdigest())
        self.assertEqual(kwargs["cwd"], Path(command[1]).parents[4])

    def test_any_identity_other_than_the_runner_is_refused(self):
        for active in (APPROVER, "ow-123456781234-runtime@test-project.iam.gserviceaccount.com",
                       "ow-123456781234-runner@other-project.iam.gserviceaccount.com"):
            with self.subTest(active=active):
                with self.assertRaisesRegex(ValueError, "runner service account"):
                    self.start(active=active)
                self.assertEqual(self.ran, [])

    def test_runner_does_not_start_outside_a_build_or_with_local_credentials(self):
        with self.assertRaisesRegex(ValueError, "inside its Cloud Build build"):
            self.start(environment={"BUILD_ID": ""})
        self.assertEqual(self.ran, [])
        with tempfile.TemporaryDirectory() as home:
            credentials = Path(home) / ".config/gcloud/application_default_credentials.json"
            credentials.parent.mkdir(parents=True)
            credentials.write_text("{}")
            with self.assertRaisesRegex(ValueError, "application-default credentials"):
                self.start(home=home)
            self.assertEqual(self.ran, [])

    def test_inherited_credential_selectors_never_reach_the_runner(self):
        selectors = {"GOOGLE_CREDENTIALS": "x", "GOOGLE_APPLICATION_CREDENTIALS": "/admin.json", "GOOGLE_OAUTH_ACCESS_TOKEN": "x",
                     "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT": APPROVER, "GOOGLE_BACKEND_CREDENTIALS": "x",
                     "GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT": APPROVER, "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT": APPROVER,
                     "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE": "/token"}
        ran, _ = self.start(environment=selectors)
        for key in selectors:
            self.assertNotIn(key, ran[0][1]["env"])

    def test_tampered_bundle_never_runs(self):
        good = bundle()
        project = Project(active=RUNNER)
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"BUILD_ID": ENV["BUILD_ID"], "HOME": home}, clear=True), \
                patch.object(sys, "argv", ["install.py", "--config-base64", launch(good), "--cloud-build"]), \
                patch.object(install, "cloud", side_effect=project.cloud), patch.object(install, "request", return_value=good + b"x"), \
                patch.object(subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "checksum"):
                install.main()
            execute.assert_not_called()


class BuildToolTests(unittest.TestCase):
    def test_docker_client_is_checksum_pinned_before_use(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for path, body in (("docker/dockerd", b"daemon"), ("docker/docker", b"client")):
                member = tarfile.TarInfo(path)
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
        data = buffer.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(runner, "request", return_value=data) as fetch:
                with self.assertRaisesRegex(ValueError, "checksum"):
                    runner.docker_binary(Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])
                with patch.object(runner, "DOCKER_SHA256", hashlib.sha256(data).hexdigest()):
                    binary = Path(runner.docker_binary(Path(directory)))
            self.assertEqual(fetch.call_args.args[0], "https://download.docker.com/linux/static/stable/x86_64/docker-"
                             + runner.DOCKER_VERSION + ".tgz")
            self.assertEqual(binary.read_bytes(), b"client")  # the client only, never the daemon
            self.assertEqual(binary.stat().st_mode & 0o777, 0o700)
            self.assertEqual([path.name for path in Path(directory).iterdir()], ["docker-bin"])
        self.assertRegex(runner.DOCKER_SHA256, r"^[a-f0-9]{64}$")

    def test_mirroring_uses_the_pinned_client_and_the_build_identity(self):
        source = (GCP / "runner/runner.py").read_text()
        mirror = source[source.index("def mirror_images("):source.index("def storage_headers(")]
        self.assertIn("docker = docker_binary(Path.cwd())", mirror)
        self.assertNotIn('["docker"', mirror)
        self.assertIn("token = access_token()", mirror)

    def test_access_token_is_the_callers_own_and_never_empty(self):
        with patch.object(subprocess, "run", return_value=Mock(stdout="token\n")) as execute:
            self.assertEqual(install.access_token(), "token")
        self.assertEqual(execute.call_args.args[0], ["gcloud", "auth", "print-access-token"])
        with patch.object(subprocess, "run", return_value=Mock(stdout="\n")):
            with self.assertRaises(ValueError):
                install.access_token()


if __name__ == "__main__":
    unittest.main()
