"""Gateway managed-runtime boundaries; no cloud, model or sandbox calls."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gateway_profile_runner", ROOT / "aws/runner/runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

GATEWAY_ENV = {"MANAGED_RUNTIME_PROFILE": "gateway", "AWS_REGION": "us-east-1", "EXPECTED_ACCOUNT_ID": "123456789012"}
CORE_KINDS = {"den_api", "den_web"}
LEGACY_KINDS = CORE_KINDS | {"headless_runner", "workbot"}
GATEWAY_KINDS = LEGACY_KINDS | {"ai_gateway"}


def pins(kinds=GATEWAY_KINDS):
    repositories = {
        "den_api": "ghcr.io/different-ai/openwork-den-api", "den_web": "ghcr.io/different-ai/openwork-den-web",
        "headless_runner": "ghcr.io/different-ai/openwork-headless-runner", "workbot": "ghcr.io/different-ai/openwork-workbot",
        "ai_gateway": "ghcr.io/different-ai/openwork-inference",
    }
    return {kind: repositories[kind] + "@sha256:" + "a" * 64 for kind in sorted(kinds)}


def outputs():
    return {
        "cluster_name": "owned", "service_names": {key: "owned-" + key for key in sorted(GATEWAY_KINDS)},
        "task_definition_arns": {key: "arn:aws:ecs:us-east-1:123456789012:task-definition/owned-" + key + ":2" for key in sorted(GATEWAY_KINDS)},
        "web_url": "https://openwork.example.test", "api_url": "https://api.openwork.example.test",
        "workbot_url": "https://chat.openwork.example.test", "ai_gateway_url": "https://models.openwork.example.test",
    }


def services(values):
    return [{"serviceName": name, "taskDefinition": values["task_definition_arns"][kind], "runningCount": 1, "desiredCount": 1, "pendingCount": 0,
             "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": values["task_definition_arns"][kind]}]}
            for kind, name in values["service_names"].items()]


class GatewayProfileTests(unittest.TestCase):
    def test_legacy_default_and_disabled_inputs_remain_unchanged(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runner.managed_runtime_profile(), "legacy")
            self.assertEqual(runner.assistant_inputs(), {})
        with patch.dict(os.environ, {"MANAGED_RUNTIME_PROFILE": "unknown"}, clear=True), self.assertRaises(ValueError):
            runner.assistant_inputs()

    def test_gateway_derives_required_features_without_any_model_or_sandbox_configuration(self):
        with patch.dict(os.environ, GATEWAY_ENV, clear=True), patch.object(runner, "aws") as aws:
            values = runner.assistant_inputs()
        self.assertEqual(values, {"managed_runtime_profile": "gateway", "headless_runner": {"enabled": True},
                                 "workbot": {"enabled": True}, "slack_assistant_enabled": True,
                                 "headless_computer": {"provider": "off"}, "headless_computer_secret_arn": ""})
        aws.assert_not_called()

    def test_gateway_ignores_all_legacy_model_values_and_legacy_feature_toggles(self):
        legacy = {"HEADLESS_RUNNER_ENABLED": "false", "WORKBOT_ENABLED": "false", "SLACK_ASSISTANT_ENABLED": "false",
                  "HEADLESS_MODEL_PROTOCOL": "ignored", "HEADLESS_MODEL_BASE_URL": "not-an-endpoint",
                  "HEADLESS_MODEL": "", "HEADLESS_MODEL_SECRET_ARN": "not-a-secret-reference",
                  "HEADLESS_MODEL_API_KEY": "not-used", "HEADLESS_COMPUTER_SECRET_ARN": "ignored-while-computers-off",
                  "DAYTONA_API_URL": "ignored-while-computers-off"}
        with patch.dict(os.environ, {**GATEWAY_ENV, **legacy}, clear=True), patch.object(runner, "customer_secret_arn") as secret, patch.object(runner, "aws") as aws:
            values = runner.assistant_inputs()
        secret.assert_not_called()
        aws.assert_not_called()
        self.assertEqual(values["headless_runner"], {"enabled": True})
        self.assertTrue(values["workbot"]["enabled"])
        self.assertTrue(values["slack_assistant_enabled"])
        self.assertNotIn("headless_model_secret_arn", values)
        self.assertNotIn("not-used", json.dumps(values))
        self.assertNotIn("model_protocol", json.dumps(values))

    def test_terraform_receives_the_explicit_profile_with_legacy_as_the_default(self):
        env = {**GATEWAY_ENV, "DEPLOYMENT_ID": "test", "DOMAIN_NAME": "openwork.example.test", "OWNER_EMAIL": "owner@example.test",
               "OPENWORK_VERSION": "0.18.67", "CONTROL_PLANE_ORIGIN": "https://control.example.test", "ROUTE53_ZONE_ID": "ZTEST"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(runner.terraform_inputs()["managed_runtime_profile"], "gateway")
        with patch.dict(os.environ, {**env, "MANAGED_RUNTIME_PROFILE": "legacy"}, clear=True):
            values = runner.terraform_inputs()
        self.assertEqual(values["managed_runtime_profile"], "legacy")
        self.assertNotIn("headless_runner", values)

    def test_only_selected_sandboxes_need_customer_key_refs_and_daytona_needs_a_snapshot(self):
        key = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-Ab1234"
        for provider in ("daytona", "freestyle"):
            with patch.dict(os.environ, {**GATEWAY_ENV, "HEADLESS_COMPUTER_PROVIDER": provider}, clear=True), self.assertRaises(ValueError):
                runner.assistant_inputs()
        with patch.dict(os.environ, {**GATEWAY_ENV, "HEADLESS_COMPUTER_PROVIDER": "daytona", "HEADLESS_COMPUTER_SECRET_ARN": key}, clear=True), self.assertRaises(ValueError):
            runner.assistant_inputs()
        for provider in ("daytona", "freestyle"):
            with patch.dict(os.environ, {**GATEWAY_ENV, "HEADLESS_COMPUTER_PROVIDER": provider, "HEADLESS_COMPUTER_SECRET_ARN": key,
                                        "HEADLESS_COMPUTER_SNAPSHOT": "computer-fixture"}, clear=True), patch.object(runner, "aws") as aws:
                values = runner.assistant_inputs()
            self.assertEqual(values["headless_computer_secret_arn"], key)
            self.assertNotIn("daytona_api_key", values)
            self.assertNotIn("headless_model_secret_arn", values)
            aws.assert_not_called()

    def test_legacy_core_and_four_pins_still_work_but_gateway_always_requires_five(self):
        for kinds in (CORE_KINDS, LEGACY_KINDS, GATEWAY_KINDS):
            images = pins(kinds)
            for profile in (False, "legacy"):
                self.assertEqual(runner.release_images({"images": images}, profile), {key + "_image": value for key, value in images.items()})
            if kinds != GATEWAY_KINDS:
                for args, kwargs in [(("gateway",), {}), ((), {"runtime_profile": "gateway"}), ((True, "gateway"), {})]:
                    with self.assertRaises(ValueError):
                        runner.release_images({"images": images}, *args, **kwargs)
        self.assertEqual(runner.release_images({"images": pins(LEGACY_KINDS)}, True), {key + "_image": value for key, value in pins(LEGACY_KINDS).items()})
        self.assertEqual(runner.release_images({"images": pins()}, "gateway")["ai_gateway_image"], pins()["ai_gateway"])
        self.assertEqual(runner.release_images({"images": pins()}, True, "gateway")["ai_gateway_image"], pins()["ai_gateway"])
        for images in ({}, {key: value for key, value in pins().items() if key != "workbot"}, {**pins(), "ai_gateway": "ghcr.io/different-ai/openwork-inference:0.18.67"},
                       {**pins(), "ai_gateway": pins()["den_api"]}, {**pins(), "extra": "bad"}):
            with self.assertRaises(ValueError):
                runner.release_images({"images": images}, "gateway")

    def test_apply_passes_five_pins_without_model_values_and_forces_only_the_two_core_tls_services(self):
        result = outputs()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release.json").write_text(json.dumps({"images": pins()}))
            env = {**GATEWAY_ENV, "DEPLOYMENT_ID": "test", "STATE_BUCKET": "owned"}
            with patch.dict(os.environ, env, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "terraform_inputs", side_effect=runner.assistant_inputs), patch.object(runner, "certificate_states", return_value={}), \
                    patch.object(runner, "legacy_fence", return_value=False), patch.object(runner.subprocess, "run"), \
                    patch.object(runner.subprocess, "check_output", side_effect=["{}", json.dumps({key: {"value": value} for key, value in result.items()})]), \
                    patch.object(runner, "tls_redeploy") as tls:
                runner.apply(root, root)
            values = json.loads((root / "managed.auto.tfvars.json").read_text())
        self.assertEqual(values["ai_gateway_image"], pins()["ai_gateway"])
        self.assertNotIn("headless_model_secret_arn", values)
        self.assertEqual(values["headless_runner"], {"enabled": True})
        tls.assert_called_once_with(cluster="owned", expected={result["service_names"][key]: result["task_definition_arns"][key] for key in CORE_KINDS})

    def test_gateway_rejects_missing_pin_inventory_before_terraform_init(self):
        for images in (None, pins(CORE_KINDS), pins(LEGACY_KINDS)):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if images is not None:
                    (root / "release.json").write_text(json.dumps({"images": images}))
                with patch.dict(os.environ, {**GATEWAY_ENV, "DEPLOYMENT_ID": "test"}, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                        patch.object(runner, "terraform_inputs", side_effect=runner.assistant_inputs), patch.object(runner.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        runner.apply(root, root)
                run.assert_not_called()

    def test_gateway_checks_all_five_services_and_the_intended_completed_inference_revision(self):
        result = outputs()
        current = services(result)
        with patch.dict(os.environ, GATEWAY_ENV, clear=True), patch.object(runner, "aws", return_value={"services": current}):
            runner.verify_services(result)
        for mutation in ("missing", "old-revision", "pending", "failed", "extra-deployment", "extra-replica"):
            changed = copy.deepcopy(current)
            gateway = next(service for service in changed if service["serviceName"] == result["service_names"]["ai_gateway"])
            if mutation == "missing":
                changed.remove(gateway)
            elif mutation == "old-revision":
                gateway["taskDefinition"] = "old"
            elif mutation == "pending":
                gateway["pendingCount"] = 1
            elif mutation == "failed":
                gateway["deployments"][0]["rolloutState"] = "FAILED"
            elif mutation == "extra-deployment":
                gateway["deployments"].append({"status": "ACTIVE"})
            elif mutation == "extra-replica":
                gateway["runningCount"] = 2
            with self.subTest(mutation=mutation), patch.dict(os.environ, GATEWAY_ENV, clear=True), patch.object(runner, "aws", return_value={"services": changed}), self.assertRaises(ValueError):
                runner.verify_services(result)
        result["service_names"].pop("ai_gateway")
        with patch.dict(os.environ, GATEWAY_ENV, clear=True), patch.object(runner, "aws") as aws, self.assertRaises(ValueError):
            runner.verify_services(result)
        aws.assert_not_called()

    def test_health_requires_the_approved_models_origin_and_a_gateway_health_body(self):
        result = outputs()
        env = {**GATEWAY_ENV, "DOMAIN_NAME": "openwork.example.test"}
        for bad in (None, "https://foreign.example.test", "http://models.openwork.example.test", "https://models.openwork.example.test/path"):
            with patch.dict(os.environ, env, clear=True), patch.object(runner, "fetch_json") as fetch, patch.object(runner.urllib.request, "urlopen") as request, self.assertRaises(ValueError):
                runner.verify_health({**result, "ai_gateway_url": bad}, attempts=1, delay=0)
            fetch.assert_not_called()
            request.assert_not_called()
        for gateway_body in ({"ok": True, "service": "gateway"}, {"ok": False, "service": "gateway"}, {"ok": True, "service": "den-api"}):
            response = MagicMock()
            response.__enter__.return_value.status = 200
            def fetch(url):
                return gateway_body if url.endswith("models.openwork.example.test/health") else {"ok": True, "service": "den-api"}
            with patch.dict(os.environ, env, clear=True), patch.object(runner, "fetch_json", side_effect=fetch) as calls, patch.object(runner.urllib.request, "urlopen", return_value=response):
                if gateway_body == {"ok": True, "service": "gateway"}:
                    runner.verify_health(result, attempts=1, delay=0)
                else:
                    with self.assertRaises(ValueError):
                        runner.verify_health(result, attempts=1, delay=0)
            self.assertTrue(any(call.args == (result["ai_gateway_url"] + "/health",) for call in calls.call_args_list))


if __name__ == "__main__":
    unittest.main()
