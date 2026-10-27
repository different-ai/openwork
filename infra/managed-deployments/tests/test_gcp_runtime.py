"""Offline runtime regressions; no cloud credentials or provisioned resources."""
import argparse
from contextlib import contextmanager
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
GCP = ROOT / "infra/managed-deployments/gcp"
sys.path.insert(0, str(GCP / "runner"))
import install
import runner

spec = importlib.util.spec_from_file_location("gcp_runtime_health", GCP / "health/health_agent.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

ENV = {
    "DEPLOYMENT_ID": "12345678-1234-1234-1234-123456789012",
    "RUN_ID": "87654321-1234-1234-1234-123456789012",
    "PROJECT_ID": "test-project", "PROJECT_NUMBER": "123456789012", "REGION": "us-central1",
    "DOMAIN_NAME": "openwork.example.com", "DNS_ZONE_NAME": "zone", "OWNER_EMAIL": "admin@example.com",
    "CONTROL_PLANE_ORIGIN": "https://control.example.com", "VERSION": "0.18.0",
    "STATE_BUCKET": "ow-123456781234-123456789012-state",
    "RUNNER_SERVICE_ACCOUNT": "ow-123456781234-runner@test-project.iam.gserviceaccount.com",
}


class RuntimeIsolationTests(unittest.TestCase):
    def test_web_identity_has_no_project_grants_but_runner_can_deploy_it(self):
        args = argparse.Namespace(**{key.lower(): value for key, value in ENV.items()})
        calls = []

        def cloud(*arguments, **kwargs):
            calls.append(arguments)
            if arguments[:2] == ("auth", "list"):
                return [{"account": "admin@example.com"}]
            if arguments[:3] == ("storage", "buckets", "list"):
                return [{"name": ENV["STATE_BUCKET"]}]
            if arguments[:3] == ("storage", "buckets", "describe"):
                return {"projectNumber": ENV["PROJECT_NUMBER"], "versioning": {"enabled": True},
                        "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True},
                                             "publicAccessPrevention": "enforced"}}
            return {}

        with patch.object(install, "cloud", side_effect=cloud), patch.object(install, "ensure_sa", side_effect=lambda a, account: account + "@test-project.iam.gserviceaccount.com"):
            identities, _ = install.bootstrap(args, install.name(ENV["DEPLOYMENT_ID"]))
        web = identities["web"]
        self.assertNotEqual(web, identities["runtime"])
        self.assertFalse(any(call[:2] == ("projects", "add-iam-policy-binding") and
                             "--member=serviceAccount:" + web in call for call in calls))
        self.assertTrue(any(call[:3] == ("iam", "service-accounts", "add-iam-policy-binding") and web in call and
                            "--member=serviceAccount:" + identities["runner"] in call and
                            "--role=roles/iam.serviceAccountUser" in call for call in calls))

    def test_terraform_discards_debug_credentials_and_dev_overrides(self):
        inherited = {**ENV, "TF_LOG": "TRACE", "TF_LOG_PATH": "public.log", "TF_DATA_DIR": "/shared/state",
                     "TF_CLI_CONFIG_FILE": "/unverified/dev-overrides.rc", "TF_CLI_ARGS_plan": "-destroy",
                     "TF_VAR_project_id": "wrong-project", "GOOGLE_BACKEND_CREDENTIALS": "private-credential",
                     "GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT": "admin@example.com",
                     "GOOGLE_CREDENTIALS": "private-credential", "GOOGLE_APPLICATION_CREDENTIALS": "/admin.json",
                     "GOOGLE_OAUTH_ACCESS_TOKEN": "private-token", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT": "admin@example.com"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, inherited, clear=True):
            root = Path(directory)
            result = runner.terraform_environment(root)
            self.assertEqual({key for key in result if key.startswith("TF_")}, {"TF_CLI_CONFIG_FILE", "TF_IN_AUTOMATION"})
            self.assertFalse(any(key.startswith("GOOGLE_BACKEND_") for key in result))
            for key in ("GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN"):
                self.assertNotIn(key, result)
            self.assertEqual(result["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"], ENV["RUNNER_SERVICE_ACCOUNT"])
            config = Path(result["TF_CLI_CONFIG_FILE"])
            self.assertEqual(config.parent, root)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("dev_overrides", config.read_text())

    def test_every_terraform_command_uses_private_configuration(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {**ENV, "TF_LOG": "TRACE"}, clear=True):
            root = Path(directory)
            (root / "infra/managed-deployments/gcp/terraform").mkdir(parents=True)
            with patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "gcloud"), patch.object(subprocess, "run", return_value=Mock()) as execute, \
                    patch.object(subprocess, "check_output", side_effect=lambda command, **kwargs: b'{"resource_changes":[]}' if command[1] == "show" else b'{}') as query:
                runner.apply(root, {})
            for call in execute.call_args_list + query.call_args_list:
                self.assertNotIn("TF_LOG", call.kwargs["env"])
                self.assertEqual(call.kwargs["env"]["TF_CLI_CONFIG_FILE"], str(root / "terraform.rc"))


class ImagePinTests(unittest.TestCase):
    def inventory(self):
        return {"provider": "gcp", "version": ENV["VERSION"], "protocolVersion": 1,
                "images": {kind: repository + "@sha256:" + character * 64 for (kind, repository), character in
                           zip(install.IMAGE_REPOSITORIES.items(), "abc")}}

    def mirror(self, manifest, destination_mismatch=False, bad_local=False, docker_hub_alias=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if manifest is not None:
                (root / "release.json").write_text(json.dumps(manifest))
            calls = []
            def execute(command, **kwargs):
                calls.append(command)
                if command[0] == "docker":
                    self.assertNotIn("DOCKER_HOST", kwargs["env"])
                    self.assertEqual(kwargs["env"]["DOCKER_CONFIG"], str(root / "docker-config"))
                if command[:3] == ["docker", "image", "inspect"]:
                    return Mock(stdout=json.dumps([{"Id": "sha256:" + "d" * 64,
                        "Os": "linux", "Architecture": "arm64" if bad_local else "amd64",
                        "RepoDigests": [command[-1].removeprefix("docker.io/library/") if docker_hub_alias and command[-1].startswith("docker.io/library/") else command[-1]]}]))
                return Mock(stdout="private-token")
            def cloud(*arguments):
                if arguments[:4] == ("artifacts", "docker", "images", "describe"):
                    kind = arguments[-1].rsplit("/", 1)[1].split(":", 1)[0]
                    digest = "sha256:" + "e" * 64 if destination_mismatch else manifest["images"][kind].split("@")[1]
                    return {"image_summary": {"digest": digest}}
                return [{"name": "repositories/" + install.name(ENV["DEPLOYMENT_ID"])}]
            inherited = {**ENV, "DEN_API_IMAGE": "evil.test/api:latest", "HEALTH_IMAGE": "evil.test/python:latest",
                         "DOCKER_HOST": "tcp://evil.test:2375"}
            with patch.dict(os.environ, inherited, clear=True), patch.object(runner, "__file__", str(root / "infra/managed-deployments/gcp/runner/runner.py")), \
                    patch.object(Path, "cwd", return_value=root), patch.object(runner, "gcloud", side_effect=cloud) as remote, \
                    patch.object(subprocess, "run", side_effect=execute):
                if manifest is None or manifest.get("images") is None:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        runner.mirror_images()
                    remote.assert_not_called()
                    self.assertEqual(calls, [])
                elif destination_mismatch or bad_local:
                    with self.assertRaises(ValueError):
                        runner.mirror_images()
                    if bad_local:
                        self.assertFalse(any(command[:2] in (["docker", "tag"], ["docker", "push"]) for command in calls))
                else:
                    result = runner.mirror_images()
                    self.assertEqual(set(result), set(install.IMAGE_REPOSITORIES))
                    pulls = [command[-1] for command in calls if command[:2] == ["docker", "pull"]]
                    self.assertEqual(pulls, list(manifest["images"].values()))
                    for kind, ref in result.items():
                        self.assertEqual(ref.split("@")[1], manifest["images"][kind].split("@")[1])
                    self.assertTrue(all(command[2] == "sha256:" + "d" * 64 for command in calls if command[:2] == ["docker", "tag"]))

    def test_docker_hub_familiar_health_digest_survives_actual_mirror_guard(self):
        self.mirror(self.inventory(), docker_hub_alias=True)

    def test_docker_hub_reference_aliases_keep_the_exact_repository_and_digest(self):
        digest = "@sha256:" + "c" * 64
        for full, familiar in [("docker.io/library/x", "x"), ("index.docker.io/library/x", "library/x"),
                               ("docker.io/user/x", "user/x"), ("index.docker.io/user/x", "docker.io/user/x")]:
            with self.subTest(full=full, familiar=familiar):
                self.assertTrue(runner.image_source_matches(full + digest, [familiar + digest]))
        ghcr = "ghcr.io/different-ai/x" + digest
        self.assertEqual(runner.canonical_image_reference(ghcr), ghcr)
        self.assertFalse(runner.image_source_matches(ghcr, ["different-ai/x" + digest]))
        self.assertFalse(runner.image_source_matches("docker.io/library/x" + digest, ["x@sha256:" + "e" * 64]))
        self.assertFalse(runner.image_source_matches("docker.io/library/x" + digest, ["other/x" + digest]))
        self.assertFalse(runner.image_source_matches("docker.io/library/x" + digest, ["evil.example/library/x" + digest]))
        for observed in (None, [], [None], ["x:latest"], ["x@sha256:bad"]):
            self.assertFalse(runner.image_source_matches("docker.io/library/x" + digest, observed))

    def test_reads_release_inventory_and_ignores_source_env_overrides(self):
        self.mirror(self.inventory())

    def test_missing_release_or_pins_rejected_before_cloud(self):
        self.mirror(None)
        self.mirror({"provider": "gcp", "version": ENV["VERSION"], "protocolVersion": 1})

    def test_destination_digest_must_match_source_manifest(self):
        self.mirror(self.inventory(), destination_mismatch=True)

    def test_wrong_local_platform_rejected_before_tag_push(self):
        self.mirror(self.inventory(), bad_local=True)
        self.mirror(self.inventory(), bad_local=True, docker_hub_alias=True)

    def test_mutable_wrong_repo_or_wrong_version_inventory_rejected(self):
        variants = []
        for pin in ["ghcr.io/different-ai/openwork-den-api:0.18.0", "evil.test/api@sha256:" + "a" * 64]:
            inventory = self.inventory()
            inventory["images"]["den_api"] = pin
            variants.append(inventory)
        wrong_version = self.inventory()
        wrong_version["version"] = "0.19.0"
        variants.append(wrong_version)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV, clear=True), \
                patch.object(runner, "__file__", str(Path(directory) / "infra/managed-deployments/gcp/runner/runner.py")), \
                patch.object(runner, "gcloud") as remote, patch.object(subprocess, "run") as execute:
            for inventory in variants:
                (Path(directory) / "release.json").write_text(json.dumps(inventory))
                with self.assertRaises(ValueError):
                    runner.mirror_images()
            remote.assert_not_called()
            execute.assert_not_called()


class OrchestrationMutexTests(unittest.TestCase):
    def test_atomic_contention_does_not_release_another_owner(self):
        live = None
        calls = []

        def storage(url, data=None, headers=None, **kwargs):
            nonlocal live
            calls.append((url, data, kwargs))
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            if kwargs.get("method") == "DELETE":
                self.assertEqual(query, {"ifGenerationMatch": ["17"]})
                self.assertEqual(live, "17")
                live = None
                return b""
            self.assertEqual(query["ifGenerationMatch"], ["0"])
            self.assertEqual(json.loads(data), {"runId": ENV["RUN_ID"]})
            if live is not None:
                raise urllib.error.HTTPError(url, 412, "Precondition Failed", {}, None)
            live = "17"
            return b'{"generation":"17"}'

        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request", side_effect=storage), patch.object(runner, "storage_headers", return_value={}) as tokens:
            with runner.orchestration_mutex():
                with self.assertRaisesRegex(ValueError, "another orchestration"):
                    with runner.orchestration_mutex():
                        self.fail("competing runner entered critical section")
                self.assertEqual(live, "17")
                self.assertFalse(any(kwargs.get("method") == "DELETE" for _, _, kwargs in calls))
            self.assertIsNone(live)
            self.assertEqual(tokens.call_count, 3)  # two acquisitions and a fresh release token

    def test_failed_rollout_releases_exact_acquired_generation(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request", side_effect=[b'{"generation":"23"}', b""]) as request, patch.object(runner, "storage_headers", return_value={}):
            with self.assertRaisesRegex(ValueError, "rollout failed"):
                with runner.orchestration_mutex():
                    raise ValueError("rollout failed")
        release = request.call_args_list[-1]
        self.assertTrue(release.args[0].endswith("?ifGenerationMatch=23"))
        self.assertIn("deployments%2F" + ENV["DEPLOYMENT_ID"] + "%2Forchestration.lock", release.args[0])
        self.assertEqual(release.kwargs["method"], "DELETE")

    def test_replaced_lock_is_never_deleted_or_stolen(self):
        error = urllib.error.HTTPError("https://storage.googleapis.com/lock", 412, "Precondition Failed", {}, None)
        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request", side_effect=[b'{"generation":"23"}', error]) as request, patch.object(runner, "storage_headers", return_value={}):
            with self.assertRaises(urllib.error.HTTPError):
                with runner.orchestration_mutex():
                    pass
        self.assertEqual(request.call_count, 2)
        self.assertTrue(request.call_args.args[0].endswith("?ifGenerationMatch=23"))
        self.assertEqual(request.call_args.kwargs["method"], "DELETE")

    def test_uncertain_acquisition_leaves_lock_for_manual_recovery(self):
        for result in (b'{}', b'{"generation":"0"}', b'{"generation":23}', OSError("receipt lost")):
            with self.subTest(result=result), patch.dict(os.environ, ENV, clear=True), patch.object(runner, "storage_headers", return_value={}):
                with patch.object(runner, "request", side_effect=[result]) as request:
                    with self.assertRaises((ValueError, OSError)):
                        with runner.orchestration_mutex():
                            self.fail("entered without lock receipt")
                    self.assertEqual(request.call_count, 1)

    def test_mutex_spans_mirror_migration_rollout_and_signed_health_receipt(self):
        order = []

        @contextmanager
        def mutex():
            order.append("acquire")
            try:
                yield
            finally:
                order.append("release")

        with patch.dict(os.environ, ENV, clear=True), patch.object(runner, "enroll", return_value="run-token"), \
                patch.object(runner, "report", side_effect=lambda token, seq, *args: order.append("report-" + str(seq))), \
                patch.object(runner, "verify_target"), patch.object(runner, "orchestration_mutex", side_effect=mutex), \
                patch.object(runner, "mirror_images", side_effect=lambda: order.append("mirror") or {}), \
                patch.object(runner, "apply", side_effect=lambda *args: order.append("migration-and-rollout") or {"health_agent": "health"}), \
                patch.object(runner, "verify_services", side_effect=lambda *args: order.append("services")), \
                patch.object(runner, "verify_health", side_effect=lambda *args: order.append("https")), \
                patch.object(runner, "gcloud", side_effect=lambda *args: order.append("signed-health-receipt")), patch("builtins.print"):
            runner.main()
        self.assertEqual(order, ["report-1", "report-2", "report-3", "acquire", "mirror", "migration-and-rollout", "report-4", "services", "report-5", "https", "signed-health-receipt", "release", "report-6"])


class TrafficAttributionTests(unittest.TestCase):
    def service(self):
        revision = "projects/test-project/locations/us-central1/services/ow-api/revisions/ow-api-00002"
        return {"generation": "2", "observedGeneration": "2", "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
                "template": {"containers": [{"image": "expected@sha256:abc"}]},
                "latestCreatedRevision": revision, "latestReadyRevision": revision,
                "trafficStatuses": [{"percent": 100, "revision": "ow-api-00002"}]}

    def tagged_service(self):
        # Neutralized selected live wire: the old tagged target omits its
        # proto3 int32 default percent=0; this is not explicit null.
        service = self.service()
        current = "ow-api-expcurrent"
        old = "ow-api-00001-old"
        service.update(generation="3", observedGeneration="3", latestCreatedRevision=current, latestReadyRevision=current)
        service["traffic"] = [
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100},
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", "revision": old, "tag": "exp-test-old"},
        ]
        service["trafficStatuses"] = [
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", "revision": old, "tag": "exp-test-old"},
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": current, "percent": 100},
        ]
        return service

    def test_tagged_zero_percent_omitted_by_protojson_is_healthy(self):
        service = self.tagged_service()
        self.assertNotIn("percent", service["trafficStatuses"][0])
        self.assertTrue(health.serving_expected_revision(service, "expected@sha256:abc"))
        service["trafficStatuses"][0]["percent"] = 0
        self.assertTrue(health.serving_expected_revision(service, "expected@sha256:abc"))

    def test_explicit_malformed_traffic_percent_is_never_defaulted(self):
        for percent in (None, True, False, "0", "100", 0.0, 100.0, -1, 101):
            for target in (0, 1):
                service = self.tagged_service()
                service["trafficStatuses"][target]["percent"] = percent
                with self.subTest(percent=percent, target=target):
                    self.assertFalse(health.serving_expected_revision(service, "expected@sha256:abc"))

    def test_omitted_zero_does_not_relax_totals_or_ready_revision_attribution(self):
        for old_percent, current_percent in [(None, 99), (1, 100), (1, 99), (100, 0)]:
            service = self.tagged_service()
            if old_percent is not None:
                service["trafficStatuses"][0]["percent"] = old_percent
            service["trafficStatuses"][1]["percent"] = current_percent
            with self.subTest(old=old_percent, current=current_percent):
                self.assertFalse(health.serving_expected_revision(service, "expected@sha256:abc"))
        service = self.tagged_service()
        service["trafficStatuses"][1].pop("percent")
        self.assertFalse(health.serving_expected_revision(service, "expected@sha256:abc"))
        service = self.tagged_service()
        service["trafficStatuses"][1]["revision"] = "ow-api-00001-old"
        self.assertFalse(health.serving_expected_revision(service, "expected@sha256:abc"))

    def test_actual_latest_ready_revision_must_serve_all_traffic(self):
        good = self.service()
        self.assertTrue(health.serving_expected_revision(good, "expected@sha256:abc"))
        bad = []
        for traffic in ([], [{"percent": 100, "revision": "ow-api-00001"}],
                        [{"percent": 90, "revision": "ow-api-00002"}, {"percent": 10, "revision": "ow-api-00001"}],
                        [{"percent": "100", "revision": "ow-api-00002"}],
                        [{"percent": 101, "revision": "ow-api-00002"}]):
            candidate = copy.deepcopy(good)
            candidate["trafficStatuses"] = traffic
            bad.append(candidate)
        for field in ("latestCreatedRevision", "latestReadyRevision", "trafficStatuses"):
            candidate = copy.deepcopy(good)
            candidate.pop(field)
            bad.append(candidate)
        candidate = copy.deepcopy(good)
        candidate["latestCreatedRevision"] = "new-but-not-ready"
        bad.append(candidate)
        for candidate in bad:
            with self.subTest(candidate=candidate):
                self.assertFalse(health.serving_expected_revision(candidate, "expected@sha256:abc"))
        self.assertFalse(health.serving_expected_revision(good, "unexpected-image"))
        good["trafficStatuses"][0]["revision"] = good["latestReadyRevision"]
        self.assertTrue(health.serving_expected_revision(good, "expected@sha256:abc"))

    def test_stale_actual_traffic_cannot_claim_installed_version(self):
        env = {**ENV, "API_URL": "https://api.openwork.example.com", "WEB_URL": "https://openwork.example.com",
               "SERVICE_NAMES": json.dumps({"den_api": "ow-api", "den_web": "ow-web"}), "DATABASE_INSTANCE": "mysql",
               "CERTIFICATE_NAME": "certificate", "OPENWORK_VERSION": "0.18.0",
               "EXPECTED_IMAGES": json.dumps({"den_api": "expected@sha256:abc", "den_web": "expected@sha256:abc"})}
        for percent, accepted in [(100, True), (0, False), (50, False)]:
            service = self.service()
            service["trafficStatuses"] = [{"percent": percent, "revision": "ow-api-00002"}, {"percent": 100 - percent, "revision": "ow-api-00001"}]
            with self.subTest(percent=percent), patch.dict(os.environ, env, clear=True), patch.object(health, "api", side_effect=lambda url: service if urllib.parse.urlparse(url).hostname == "run.googleapis.com" else {}), patch.object(health, "http_check", side_effect=lambda identifier, *args: health.check(identifier, "ok")):
                report = health.collect()
            self.assertEqual("version" in report, accepted)
            self.assertEqual(next(check["status"] for check in report["checks"] if check["id"] == "services_running"), "ok" if accepted else "failing")


class RuntimeReadinessTests(unittest.TestCase):
    def test_old_ready_generation_is_not_latest_revision_ready(self):
        for generation, observed, accepted in [(2, 1, False), (2, "2", True), (None, None, False)]:
            status = {"metadata": {"generation": generation},
                      "status": {"observedGeneration": observed, "conditions": [{"type": "Ready", "status": "True"}]}}
            with self.subTest(generation=generation, observed=observed), patch.dict(os.environ, ENV, clear=True), patch.object(runner, "gcloud", return_value=status):
                if accepted:
                    runner.verify_services({"service_names": {"den_api": "ow-api"}})
                else:
                    with self.assertRaises(ValueError):
                        runner.verify_services({"service_names": {"den_api": "ow-api"}})

    def test_html_and_api_health_are_not_web_upstream_readiness(self):
        outputs = {"web_url": "https://openwork.example.com", "api_url": "https://api.openwork.example.com"}
        for web_service, web_ok, api_service, accepted in [("den-web", True, "den-api", True),
                ("den-web", False, "den-api", False), ("other", True, "den-api", False),
                ("den-web", True, "other", False)]:
            def response(url, **kwargs):
                if url.endswith("/api/ready"):
                    return json.dumps({"ok": web_ok, "service": web_service}).encode()
                if url.endswith("/ready"):
                    return json.dumps({"ok": True, "service": api_service}).encode()
                if url.endswith("/health"):
                    return b'{"ok":true,"service":"den-api"}'
                return b"<html>Setup</html>"

            with self.subTest(web_service=web_service, web_ok=web_ok, api_service=api_service), patch.dict(os.environ, ENV, clear=True), patch.object(runner, "request", side_effect=response) as request:
                if accepted:
                    runner.verify_health(outputs, attempts=1, delay=0)
                else:
                    with self.assertRaises(ValueError):
                        runner.verify_health(outputs, attempts=1, delay=0)
                self.assertIn(outputs["web_url"] + "/api/ready", [call.args[0] for call in request.call_args_list])

    def test_repeated_snapshot_gets_fresh_body_bound_metadata_audience(self):
        bodies = []
        audiences = []

        def response(url, headers=None, data=None):
            bodies.append(data)
            return b'{"ok":true}'

        def metadata(path):
            audiences.append(path)
            return b"signed-token"

        with patch.dict(os.environ, ENV, clear=True), patch.object(health, "collect", side_effect=lambda: {"checks": [{"id": "api_health", "status": "failing"}]}), \
                patch.object(health, "metadata", side_effect=metadata), patch.object(health, "fetch", side_effect=response), patch("builtins.print") as output:
            health.main()
            health.main()
        self.assertNotEqual(bodies[0], bodies[1])
        self.assertNotEqual(audiences[0], audiences[1])
        for body in bodies:
            report = json.loads(body)
            self.assertRegex(report["nonce"], r"^[a-f0-9]{32}$")
            self.assertNotIn(report["nonce"], str(output.call_args_list))
        self.assertNotIn("signed-token", str(output.call_args_list))

    def test_periodic_web_check_requires_web_upstream_readiness(self):
        source = (GCP / "health/health_agent.py").read_text()
        self.assertIn('http_check("web_available", os.environ["WEB_URL"] + "/api/ready", "den-web")', source)
        with patch.object(health, "fetch", return_value=b'{"ok":false,"service":"den-web"}'):
            self.assertEqual(health.http_check("web_available", "https://openwork.example.com/api/ready", "den-web")["status"], "failing")


if __name__ == "__main__":
    unittest.main()
