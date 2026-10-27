"""Offline GCP installer, identity protocol and release security tests."""
import argparse
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[3]
GCP = ROOT / "infra/managed-deployments/gcp"
sys.path.insert(0, str(GCP / "runner"))
import install
import runner
spec = importlib.util.spec_from_file_location("gcp_health", GCP / "health/health_agent.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

DEPLOYMENT = "12345678-1234-1234-1234-123456789012"
RUN = "87654321-1234-1234-1234-123456789012"
ENV = {"PROJECT_ID": "test-project", "PROJECT_NUMBER": "123456789012", "REGION": "us-central1",
       "DOMAIN_NAME": "openwork.example.com", "DNS_ZONE_NAME": "zone", "OWNER_EMAIL": "admin@example.com",
       "CONTROL_PLANE_ORIGIN": "https://api.example.com", "DEPLOYMENT_ID": DEPLOYMENT, "RUN_ID": RUN,
       "CHALLENGE": "a" * 64, "VERSION": "0.18.0", "STATE_BUCKET": "ow-123456781234-123456789012-state",
       "RUNNER_SERVICE_ACCOUNT": "ow-123456781234-runner@test-project.iam.gserviceaccount.com"}


PINS = {"den_api": install.IMAGE_REPOSITORIES["den_api"] + "@sha256:" + "a" * 64,
        "den_web": install.IMAGE_REPOSITORIES["den_web"] + "@sha256:" + "b" * 64,
        "health": install.IMAGE_REPOSITORIES["health"] + "@sha256:" + "c" * 64}


def args():
    return argparse.Namespace(**{key.lower(): value for key, value in ENV.items() if key not in ("STATE_BUCKET", "RUNNER_SERVICE_ACCOUNT")},
                              bundle_url="https://storage.googleapis.com/releases/gcp/0.18.0/bundle.tar.gz?generation=123",
                              bundle_sha256="a" * 64)


def bundle(extra=None, manifest_change=None):
    files = {"infra/managed-deployments/gcp/" + path: b"# fixture\n" for path in
             ["runner/install.py", "runner/runner.py", "health/health_agent.py", "terraform/main.tf", "terraform/.terraform.lock.hcl"]}
    manifest = {"provider": "gcp", "version": "0.18.0", "protocolVersion": 1, "images": dict(PINS),
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    if manifest_change:
        manifest_change(manifest)
    files["release.json"] = json.dumps(manifest).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        if extra:
            archive.addfile(extra)
    return buffer.getvalue()


class BootstrapTests(unittest.TestCase):
    def test_bootstrap_enables_exact_provider_and_runtime_apis_before_iam(self):
        required = ["iam.googleapis.com", "iamcredentials.googleapis.com", "serviceusage.googleapis.com",
                    "cloudresourcemanager.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "sqladmin.googleapis.com",
                    "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "compute.googleapis.com",
                    "dns.googleapis.com", "cloudscheduler.googleapis.com", "monitoring.googleapis.com"]
        self.assertEqual(install.APIS, required)
        with patch.object(install, "cloud", side_effect=RuntimeError("stop after API enablement")) as cloud:
            with self.assertRaisesRegex(RuntimeError, "stop after API enablement"):
                install.bootstrap(args(), install.name(DEPLOYMENT))
        cloud.assert_called_once_with("services", "enable", *required, project=ENV["PROJECT_ID"])

    def test_validation_and_names_match_api(self):
        self.assertEqual(install.validate(args()), "ow-123456781234")
        self.assertEqual(install.name(DEPLOYMENT) + "-runner@test-project.iam.gserviceaccount.com", ENV["RUNNER_SERVICE_ACCOUNT"])

    def test_invalid_launch_values(self):
        for field, value in [("deployment_id", "../../x"), ("project_id", "test-project;rm"),
                             ("project_number", "123;rm"), ("region", "us-central1;rm"),
                             ("dns_zone_name", "zone/../x"), ("domain_name", "example.com/redirect"),
                             ("control_plane_origin", "https://api.example.com/path"),
                             ("challenge", "secret\nheader"), ("version", "latest"),
                             ("bundle_sha256", "0"), ("owner_email", "invalid")]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                value_args = args()
                setattr(value_args, field, value)
                install.validate(value_args)

    def test_only_immutable_fixed_host_bundle_urls(self):
        good = args().bundle_url
        self.assertEqual(install.immutable_url(good), good)
        for bad in [good.replace("https:", "http:"), good.replace("storage.googleapis.com", "evil.test"),
                    good.replace("generation=123", "generation=0"), good.replace("generation=123", "generation=123&generation=456"),
                    good + "&token=secret", good + "#fragment", good.split("?")[0],
                    good.replace("storage.googleapis.com", "user@storage.googleapis.com")]:
            with self.subTest(url=bad), self.assertRaises(ValueError):
                install.immutable_url(bad)

    def test_redirects_refused(self):
        with self.assertRaises(ValueError):
            install.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test")
        with self.assertRaises(ValueError):
            health.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test")

    def test_target_project_number_mismatch(self):
        with patch.object(install, "cloud", return_value={"projectNumber": "999", "lifecycleState": "ACTIVE"}) as cloud:
            with self.assertRaises(ValueError):
                install.verify_target(args())
            self.assertEqual(cloud.call_count, 1)

    def test_target_private_and_unrelated_dns_refused(self):
        for zone in [{"dnsName": "example.com.", "visibility": "private"}, {"dnsName": "unrelated.test."}]:
            with patch.object(install, "cloud", side_effect=[{"projectNumber": ENV["PROJECT_NUMBER"], "lifecycleState": "ACTIVE"}, zone]):
                with self.assertRaises(ValueError):
                    install.verify_target(args())

    def test_target_dns_suffix_boundary(self):
        value_args = args()
        value_args.domain_name = "evil-example.com"
        with patch.object(install, "cloud", side_effect=[{"projectNumber": ENV["PROJECT_NUMBER"], "lifecycleState": "ACTIVE"}, {"dnsName": "example.com."}]):
            with self.assertRaises(ValueError):
                install.verify_target(value_args)

    def test_valid_bundle_inventory(self):
        data = bundle()
        with tempfile.TemporaryDirectory() as directory:
            install.extract_verified(data, hashlib.sha256(data).hexdigest(), Path(directory), "0.18.0")
            self.assertTrue((Path(directory) / "infra/managed-deployments/gcp/runner/runner.py").exists())

    def test_hash_checked_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                install.extract_verified(bundle(), "b" * 64, Path(directory), "0.18.0")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_path_traversal_links_and_special_files_refused(self):
        for path, kind in [("../outside", tarfile.REGTYPE), ("/outside", tarfile.REGTYPE),
                           ("infra/link", tarfile.SYMTYPE), ("infra/link", tarfile.LNKTYPE),
                           ("infra/fifo", tarfile.FIFOTYPE), ("infra\\evil", tarfile.REGTYPE),
                           ("release.json", tarfile.REGTYPE), ("unrelated/file", tarfile.REGTYPE)]:
            with self.subTest(path=path, kind=kind), tempfile.TemporaryDirectory() as directory:
                member = tarfile.TarInfo(path)
                member.type = kind
                member.linkname = "../../outside"
                data = bundle(extra=member)
                with self.assertRaises(ValueError):
                    install.extract_verified(data, hashlib.sha256(data).hexdigest(), Path(directory), "0.18.0")

    def test_manifest_provider_version_protocol_and_hash(self):
        changes = [lambda m: m.update(provider="aws"), lambda m: m.update(version="0.19.0"),
                   lambda m: m.update(protocolVersion=2), lambda m: m["files"].clear(),
                   lambda m: m["files"].update({"infra/managed-deployments/gcp/runner/runner.py": "b" * 64})]
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                data = bundle(manifest_change=change)
                with self.assertRaises(ValueError):
                    install.extract_verified(data, hashlib.sha256(data).hexdigest(), Path(directory), "0.18.0")

    def test_image_pins_required_and_allowlisted_before_bootstrap(self):
        changes = [lambda m: m.pop("images"), lambda m: m.update(images=None),
                   lambda m: m.update(images=[]), lambda m: m["images"].pop("health"),
                   lambda m: m["images"].update(extra=PINS["den_api"])]
        for value in ["ghcr.io/different-ai/openwork-den-api:0.18.0", "ghcr.io/different-ai/openwork-den-api:latest",
                      "evil.test/api@sha256:" + "a" * 64, PINS["den_web"], PINS["den_api"].upper(),
                      PINS["den_api"] + "\n", PINS["den_api"][:-1], None]:
            changes.append(lambda m, value=value: m["images"].update(den_api=value))
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                data = bundle(manifest_change=change)
                with self.assertRaisesRegex(ValueError, "image"):
                    install.extract_verified(data, hashlib.sha256(data).hexdigest(), Path(directory), "0.18.0")

    def test_expansion_limit(self):
        with patch.object(install, "MAX_EXTRACTED", 1), tempfile.TemporaryDirectory() as directory:
            data = bundle()
            with self.assertRaises(ValueError):
                install.extract_verified(data, hashlib.sha256(data).hexdigest(), Path(directory), "0.18.0")

    def test_refused_approval_causes_no_writes(self):
        launch = {"deploymentId": DEPLOYMENT, "runId": RUN, "challenge": ENV["CHALLENGE"], "size": "small",
                  "target": {"projectId": ENV["PROJECT_ID"], "projectNumber": ENV["PROJECT_NUMBER"], "region": ENV["REGION"], "dnsZoneName": "zone"},
                  "domainName": ENV["DOMAIN_NAME"], "ownerEmail": ENV["OWNER_EMAIL"],
                  "release": {"apiOrigin": ENV["CONTROL_PLANE_ORIGIN"], "version": ENV["VERSION"], "bundleUrl": args().bundle_url, "bundleSha256": "a" * 64}}
        encoded = base64.b64encode(json.dumps(launch).encode()).decode()
        with patch.object(sys, "argv", ["install.py", "--config-base64", encoded]), patch.object(install, "verify_target"), \
                patch("builtins.input", return_value="wrong-project"), patch.object(install, "bootstrap") as writes, patch.object(install, "request") as fetch:
            with self.assertRaises(ValueError):
                install.main()
            writes.assert_not_called()
            fetch.assert_not_called()

    def test_existing_state_bucket_security_and_ownership_are_required(self):
        secure = {"projectNumber": ENV["PROJECT_NUMBER"], "versioning": {"enabled": True},
                  "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"}}
        import copy
        variants = [secure]
        for field, value in [("projectNumber", "999"), ("versioning", {"enabled": False}),
                             ("iamConfiguration", {"uniformBucketLevelAccess": {"enabled": False}, "publicAccessPrevention": "enforced"}),
                             ("iamConfiguration", {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "inherited"})]:
            invalid = copy.deepcopy(secure)
            invalid[field] = value
            variants.append(invalid)
        for index, state in enumerate(variants):
            with self.subTest(index=index):
                calls = []
                def cloud(*arguments, **kwargs):
                    calls.append(arguments)
                    if arguments[:3] == ("auth", "list", "--filter=status:ACTIVE"):
                        return [{"account": "admin@example.com"}]
                    if arguments[:3] == ("storage", "buckets", "list"):
                        return [{"name": ENV["STATE_BUCKET"]}]
                    if arguments[:3] == ("storage", "buckets", "describe"):
                        return state
                    return {}
                with patch.object(install, "cloud", side_effect=cloud), patch.object(install, "ensure_sa", side_effect=lambda a, name: name + "@test-project.iam.gserviceaccount.com"):
                    if index == 0:
                        identities, bucket = install.bootstrap(args(), install.name(DEPLOYMENT))
                        self.assertEqual(bucket, ENV["STATE_BUCKET"])
                        self.assertEqual(identities["runner"], ENV["RUNNER_SERVICE_ACCOUNT"])
                    else:
                        with self.assertRaises(ValueError):
                            install.bootstrap(args(), install.name(DEPLOYMENT))
                self.assertFalse(any(c[:3] == ("storage", "buckets", "create") for c in calls))
                health_grants = [c for c in calls if "--member=serviceAccount:ow-123456781234-health@test-project.iam.gserviceaccount.com" in c and c[:2] == ("projects", "add-iam-policy-binding")]
                self.assertTrue(health_grants)
                self.assertTrue(all(any(flag.endswith(".viewer") for flag in c) for c in health_grants))

    def test_bootstrap_roles_never_owner_editor_or_project_iam_admin(self):
        self.assertNotIn("roles/owner", install.RUNNER_ROLES)
        self.assertNotIn("roles/editor", install.RUNNER_ROLES)
        self.assertNotIn("roles/resourcemanager.projectIamAdmin", install.RUNNER_ROLES)
        source = (GCP / "runner/install.py").read_text()
        self.assertNotIn('"keys", "create"', source)
        self.assertNotIn('"buckets", "delete"', source)
        self.assertIn('"--uniform-bucket-level-access"', source)
        self.assertIn('"--public-access-prevention"', source)
        self.assertIn('"--versioning"', source)


class RunnerTests(unittest.TestCase):
    def test_enrollment_uses_exact_audience_and_identity(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "id_token", return_value="google-jwt") as identity, \
                patch.object(runner, "request", return_value=b'{"token":"run-token"}') as request:
            self.assertEqual(runner.enroll(), "run-token")
            expected = ENV["CONTROL_PLANE_ORIGIN"] + f"/v1/managed-deployments/{DEPLOYMENT}/runs/{RUN}/enroll"
            identity.assert_called_once_with(expected + "#" + ENV["CHALLENGE"])
            self.assertEqual(json.loads(request.call_args.args[1]), {"provider": "gcp", "idToken": "google-jwt"})

    def test_identity_token_impersonates_runner_and_includes_email(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(subprocess, "run", return_value=Mock(stdout="jwt\n")) as run:
            self.assertEqual(runner.id_token("https://api.example.com/audience"), "jwt")
            self.assertIn("--include-email", run.call_args.args[0])
            self.assertIn("--impersonate-service-account=" + ENV["RUNNER_SERVICE_ACCOUNT"], run.call_args.args[0])

    def test_rejects_enrollment_without_token(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "id_token", return_value="jwt"), patch.object(runner, "request", return_value=b'{"ok":true}'):
            with self.assertRaises(ValueError):
                runner.enroll()

    def test_data_deletion_and_replacement_refused_but_stateless_update_allowed(self):
        for resource in runner.PROTECTED_TYPES:
            for actions in [["delete"], ["delete", "create"], ["create", "delete"]]:
                with self.subTest(resource=resource, actions=actions):
                    self.assertEqual(runner.unsafe_changes({"resource_changes": [{"address": "protected", "type": resource, "change": {"actions": actions}}]}), ["protected"])
        self.assertEqual(runner.unsafe_changes({"resource_changes": [{"address": "service", "type": "google_cloud_run_v2_job", "change": {"actions": ["delete", "create"]}}]}), [])
        self.assertEqual(runner.unsafe_changes({"resource_changes": [{"address": "db", "type": "google_sql_database_instance", "change": {"actions": ["update"]}}]}), [])

    def test_event_retries_identical_body_until_receipt(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request", side_effect=[OSError(), b'{"ok":true}']) as request, patch.object(runner.time, "sleep"):
            runner.report("private-run-token", 3, "account_verified")
            first, second = request.call_args_list
            self.assertEqual(first.args, second.args)
            self.assertEqual(first.args[2]["Authorization"], "Bearer private-run-token")

    def test_all_six_milestones_and_first_signed_health_receipt(self):
        outputs = {"health_agent": "ow-health"}
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "enroll", return_value="run-token"), \
                patch.object(runner, "orchestration_mutex", side_effect=contextlib.nullcontext), \
                patch.object(runner, "report") as report, patch.object(runner, "verify_target"), \
                patch.object(runner, "mirror_images", return_value={}), patch.object(runner, "apply", return_value=outputs), \
                patch.object(runner, "verify_services"), patch.object(runner, "verify_health"), patch.object(runner, "gcloud") as cloud:
            runner.main()
            self.assertEqual([c.args[1:3] for c in report.call_args_list], [(1, "runner_connected"), (2, "release_verified"),
                (3, "account_verified"), (4, "infrastructure_applied"), (5, "services_ready"), (6, "health_verified")])
            self.assertIn("--wait", cloud.call_args.args)

    def test_first_health_rejection_does_not_mark_ready(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "enroll", return_value="run-token"), \
                patch.object(runner, "orchestration_mutex", side_effect=contextlib.nullcontext), \
                patch.object(runner, "report") as report, patch.object(runner, "verify_target"), \
                patch.object(runner, "mirror_images", return_value={}), patch.object(runner, "apply", return_value={"health_agent": "job"}), \
                patch.object(runner, "verify_services"), patch.object(runner, "verify_health"), patch.object(runner, "gcloud", side_effect=ValueError("rejected")):
            with self.assertRaises(ValueError):
                runner.main()
            self.assertEqual(report.call_args.args, ("run-token", 6, "health_verified", "failed", "health_check_failed"))

    def test_wrong_origin_fails_before_any_request(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request") as request:
            with self.assertRaises(ValueError):
                runner.verify_health({"web_url": "https://evil.test", "api_url": "https://api.evil.test"})
            request.assert_not_called()

    def test_apply_uses_impersonated_locked_backend_and_migrates_before_services(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "infra/managed-deployments/gcp/terraform").mkdir(parents=True)
            calls = []
            def execute(command, **kwargs):
                calls.append(command)
                return Mock(stdout="")
            def query(command, **kwargs):
                if command[1] == "show":
                    return b'{"resource_changes":[]}'
                return b'{"web_url":{"value":"https://openwork.example.com"}}'
            with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(subprocess, "run", side_effect=execute), patch.object(subprocess, "check_output", side_effect=query), \
                    patch.object(runner, "gcloud", side_effect=lambda *a: calls.append(list(a))):
                runner.apply(root, {})
            self.assertIn("-lockfile=readonly", calls[0])
            self.assertIn("-backend-config=impersonate_service_account=" + ENV["RUNNER_SERVICE_ACCOUNT"], calls[0])
            self.assertEqual([c[1] for c in calls], ["init", "plan", "apply", "jobs", "plan", "apply"])
            self.assertIn("-target=google_cloud_run_v2_job.migrate", calls[1])
            self.assertIn("--wait", calls[3])
            self.assertTrue(all("-lock-timeout=120s" in c for c in calls if c[1] in ("plan", "apply")))

    def test_apply_rejects_data_destruction_before_any_apply(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "infra/managed-deployments/gcp/terraform").mkdir(parents=True)
            plan = json.dumps({"resource_changes": [{"address": "db", "type": "google_sql_database_instance", "change": {"actions": ["delete", "create"]}}]}).encode()
            with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(subprocess, "run", return_value=Mock()) as execute, patch.object(subprocess, "check_output", return_value=plan), patch.object(runner, "gcloud") as cloud:
                with self.assertRaises(ValueError):
                    runner.apply(root, {})
                self.assertNotIn("apply", [call.args[0][1] for call in execute.call_args_list])
                cloud.assert_not_called()

    def test_terraform_checksum_failure_no_execution(self):
        with patch.object(runner, "request", return_value=b"untrusted"), tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                runner.terraform_binary(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])


class HealthTests(unittest.TestCase):
    def test_signed_audience_binds_exact_raw_body(self):
        env = {**ENV, "API_URL": "https://api.openwork.example.com", "WEB_URL": "https://openwork.example.com"}
        with patch.dict(os.environ, env, clear=True), patch.object(health, "metadata", return_value=b"signed-jwt") as metadata:
            body = b'{"checks":[{"id":"api_health","status":"ok"}]}'
            headers = health.identity_headers(body)
            query = metadata.call_args.args[0]
            expected = ENV["CONTROL_PLANE_ORIGIN"] + f"/v1/managed-deployments/{DEPLOYMENT}/heartbeat#" + hashlib.sha256(body).hexdigest()
            from urllib.parse import parse_qs
            self.assertEqual(parse_qs(query.split("?", 1)[1]), {"audience": [expected], "format": ["full"]})
            self.assertEqual(headers, {"Content-Type": "application/json", "Authorization": "Bearer signed-jwt"})
            health.identity_headers(body + b" ")
            self.assertNotEqual(query, metadata.call_args.args[0])

    def test_health_does_not_print_tokens_or_payloads(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(health, "collect", return_value={"checks": [{"id": "api_health", "status": "ok"}]}), \
                patch.object(health, "identity_headers", return_value={"Authorization": "Bearer secret-jwt"}), \
                patch.object(health, "fetch", return_value=b'{"ok":true}'), patch("builtins.print") as output:
            health.main()
            self.assertNotIn("secret-jwt", str(output.call_args))
            self.assertNotIn(ENV["PROJECT_ID"], str(output.call_args))

    def test_rejected_heartbeat_fails_job(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(health, "collect", return_value={"checks": []}), \
                patch.object(health, "identity_headers", return_value={}), patch.object(health, "fetch", return_value=b'{"ok":false}'):
            with self.assertRaises(ValueError):
                health.main()

    def test_http_readiness_checks_actual_ok_and_service(self):
        for response in [b'{"ok":false,"service":"den-api"}', b'{"ok":true,"service":"other"}', b'not-json']:
            with patch.object(health, "fetch", return_value=response):
                self.assertEqual(health.http_check("database_ready", "https://example.com/ready", "den-api")["status"], "failing")
        with patch.object(health, "fetch", return_value=b'{"ok":true,"service":"den-api"}'):
            self.assertEqual(health.http_check("database_ready", "https://example.com/ready", "den-api")["status"], "ok")

    def test_ready_requires_latest_observed_generation(self):
        self.assertFalse(health.service_ready({"terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "generation": "2", "observedGeneration": "1"}))
        self.assertTrue(health.service_ready({"terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "generation": "2", "observedGeneration": "2"}))
        self.assertFalse(health.service_ready({}))

    def test_readonly_rest_metadata_no_secret_access(self):
        source = (GCP / "health/health_agent.py").read_text()
        self.assertNotIn("secretmanager.googleapis.com", source)
        self.assertNotIn("terraform.tfstate", source)
        self.assertNotIn("gcloud", source)
        self.assertIn('"database_storage", "unknown"', source)
        self.assertNotIn('check("load_balancer_targets", "ok"', source)
        self.assertIn("monitoring.googleapis.com", source)

    def test_numeric_allowlist_bounds(self):
        item = health.check("database_storage", "warning", value=-1, total=1e30)
        self.assertEqual(item["value"], 0)
        self.assertEqual(item["total"], 1_000_000_000)
        self.assertEqual(set(item), {"id", "status", "value", "total"})


class HealthCollectionTests(unittest.TestCase):
    def collect(self, utilization=0.25, backup_enabled=True, backup_age=1, services_ready=True):
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc)
        environment = {**ENV, "API_URL": "https://api.openwork.example.com", "WEB_URL": "https://openwork.example.com",
            "SERVICE_NAMES": json.dumps({"den_api": "ow-api", "den_web": "ow-web"}), "DATABASE_INSTANCE": "ow-mysql",
            "CERTIFICATE_NAME": "ow-tls", "OPENWORK_VERSION": "0.18.0", "EXPECTED_IMAGES": json.dumps({"den_api": "api@sha256:abc", "den_web": "web@sha256:def"})}
        def response(url):
            hostname = urllib.parse.urlparse(url).hostname
            if hostname == "run.googleapis.com":
                return {"generation": "2", "observedGeneration": "2" if services_ready else "1",
                        "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
                        "latestCreatedRevision": "revision-2", "latestReadyRevision": "revision-2",
                        "trafficStatuses": [{"revision": "revision-2", "percent": 100}],
                        "template": {"containers": [{"image": "api@sha256:abc" if url.endswith("ow-api") else "web@sha256:def"}]}}
            if hostname == "monitoring.googleapis.com":
                return {"timeSeries": [{"points": [{"value": {"doubleValue": utilization}}]}]}
            if url.endswith("/backupRuns"):
                return {"items": [{"status": "SUCCESSFUL", "endTime": (now - datetime.timedelta(hours=backup_age)).isoformat()}]}
            if hostname == "sqladmin.googleapis.com":
                return {"state": "RUNNABLE", "settings": {"dataDiskSizeGb": "20", "backupConfiguration": {"enabled": backup_enabled}}}
            if hostname == "compute.googleapis.com":
                return {"managed": {"status": "ACTIVE"}, "expireTime": (now + datetime.timedelta(days=60)).isoformat()}
            raise AssertionError("unexpected API")
        with patch.dict(os.environ, environment, clear=True), patch.object(health, "api", side_effect=response), \
                patch.object(health, "http_check", side_effect=lambda identifier, *a: health.check(identifier, "ok")):
            return health.collect()

    def test_healthy_report_contains_only_allowlist_and_observed_version(self):
        report = self.collect()
        self.assertEqual(report["version"], "0.18.0")
        self.assertEqual(len(report["checks"]), 8)
        self.assertTrue(all(c["status"] == "ok" for c in report["checks"]))
        for item in report["checks"]:
            self.assertTrue(set(item) <= {"id", "status", "code", "value", "total"})
        serialized = json.dumps(report)
        for forbidden in [ENV["PROJECT_ID"], "ow-mysql", "ow-api", "sha256", "example.com"]:
            self.assertNotIn(forbidden, serialized)

    def test_disk_metrics_thresholds(self):
        for utilization, status in [(0.25, "ok"), (0.85, "warning"), (0.99, "failing"), (2, "unknown")]:
            with self.subTest(utilization=utilization):
                report = self.collect(utilization=utilization)
                check = next(c for c in report["checks"] if c["id"] == "database_storage")
                self.assertEqual(check["status"], status)

    def test_disabled_and_stale_backups(self):
        report = self.collect(backup_enabled=False)
        check = next(c for c in report["checks"] if c["id"] == "database_backups")
        self.assertEqual(check, {"id": "database_backups", "status": "failing", "code": "backups_disabled"})
        report = self.collect(backup_age=30)
        check = next(c for c in report["checks"] if c["id"] == "database_backups")
        self.assertEqual(check["code"], "stale_backup")

    def test_unobserved_service_revision_cannot_claim_version(self):
        report = self.collect(services_ready=False)
        self.assertNotIn("version", report)
        self.assertEqual(next(c for c in report["checks"] if c["id"] == "services_running")["status"], "failing")

    def test_same_origin_get_redirects_only(self):
        import urllib.request
        for handler in [install.SameOriginRedirect(), health.SameOriginRedirect()]:
            req = urllib.request.Request("https://openwork.example.com/setup")
            redirected = handler.redirect_request(req, None, 302, "", {}, "https://openwork.example.com/login")
            self.assertEqual(redirected.full_url, "https://openwork.example.com/login")
            for destination in ["https://evil.test/login", "http://openwork.example.com/login", "https://user@openwork.example.com/login"]:
                with self.assertRaises(ValueError):
                    handler.redirect_request(req, None, 302, "", {}, destination)
            authenticated = urllib.request.Request(req.full_url, headers={"Authorization": "Bearer secret"})
            with self.assertRaises(ValueError):
                handler.redirect_request(authenticated, None, 302, "", {}, "https://openwork.example.com/login")


class ReleaseTests(unittest.TestCase):
    def test_release_build_verified_inventory_and_template(self):
        with tempfile.TemporaryDirectory() as directory:
            # Separate mocked Docker executable: the real builder still performs
            # registry verification, including when explicit approved pins are used.
            path = Path(directory)
            bin_path = path / "bin"
            bin_path.mkdir()
            docker = bin_path / "docker"
            docker.write_text("#!" + sys.executable + "\n" + '''import json, sys
ref = sys.argv[-1]
digest = "sha256:" + ("a" if "openwork-den-api" in ref else "b" if "openwork-den-web" in ref else "c") * 64
print(json.dumps({"Descriptor": {"digest": digest, "platform": {"os": "linux", "architecture": "amd64"}},
                  "SchemaV2Manifest": {"config": {"digest": "sha256:" + "d" * 64}}}))
''')
            docker.chmod(0o700)
            pins = path / "approved-pins.json"
            pins.write_text(json.dumps({kind: PINS[kind] for kind in ("den_api", "den_web")}))
            subprocess.run(["node", str(ROOT / "infra/managed-deployments/tools/build-release.mjs"), "gcp", "0.18.0", directory,
                            "--image-pins", str(pins)], env={**os.environ, "PATH": str(bin_path) + os.pathsep + os.environ["PATH"]},
                           check=True, capture_output=True)
            path = Path(directory)
            manifest = json.loads((path / "manifest.json").read_text())
            data = (path / "bundle.tar.gz").read_bytes()
            self.assertEqual(manifest["provider"], "gcp")
            self.assertEqual(hashlib.sha256(data).hexdigest(), manifest["bundleSha256"])
            self.assertEqual(hashlib.sha256((path / "tutorial.md").read_bytes()).hexdigest(), manifest["templateSha256"])
            extracted = path / "verified"
            extracted.mkdir()
            install.extract_verified(data, manifest["bundleSha256"], extracted, "0.18.0")
            self.assertEqual(json.loads((extracted / "release.json").read_text())["images"], PINS)
            for file in extracted.rglob("*"):
                self.assertFalse(file.name.endswith((".tfstate", ".tfvars", ".tfplan")))
                self.assertNotIn(".terraform/", str(file.relative_to(extracted)))


if __name__ == "__main__":
    unittest.main()
