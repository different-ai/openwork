"""Installer assistant boundaries. These tests make no cloud or model calls."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("assistant_runner", ROOT / "aws/runner/runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class AssistantInputTests(unittest.TestCase):
    ENV = {
        "AWS_REGION": "us-east-1", "EXPECTED_ACCOUNT_ID": "123456789012",
        "HEADLESS_RUNNER_ENABLED": "true", "WORKBOT_ENABLED": "true", "SLACK_ASSISTANT_ENABLED": "true",
        "HEADLESS_MODEL_PROTOCOL": "openai-responses", "HEADLESS_MODEL_BASE_URL": "https://models.example.test/v1",
        "HEADLESS_MODEL": "test-model",
        "HEADLESS_MODEL_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:exp-model-Ab1234",
        "HEADLESS_COMPUTER_PROVIDER": "freestyle",
        "HEADLESS_COMPUTER_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:exp-computer-Cd5678",
    }

    def test_defaults_preserve_the_existing_installer_inputs(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runner.assistant_inputs(), {})

    def test_approved_references_and_direct_model_settings_reach_terraform(self):
        with patch.dict(os.environ, self.ENV, clear=True), patch.object(runner, "aws") as aws:
            values = runner.assistant_inputs()
        self.assertEqual(values["headless_runner"], {
            "enabled": True, "model_protocol": "openai-responses",
            "model_base_url": "https://models.example.test/v1", "model": "test-model",
        })
        self.assertEqual(values["workbot"], {"enabled": True})
        self.assertTrue(values["slack_assistant_enabled"])
        self.assertEqual(values["headless_computer"], {"provider": "freestyle"})
        self.assertEqual(values["headless_model_secret_arn"], self.ENV["HEADLESS_MODEL_SECRET_ARN"])
        self.assertEqual(values["headless_computer_secret_arn"], self.ENV["HEADLESS_COMPUTER_SECRET_ARN"])
        self.assertFalse(any(key.endswith("api_key") for key in values))
        aws.assert_not_called()

    def test_dangling_features_and_invalid_booleans_fail_closed(self):
        for overrides in [
            {"HEADLESS_RUNNER_ENABLED": "false"}, {"HEADLESS_RUNNER_ENABLED": "yes"},
            {"WORKBOT_ENABLED": "1"}, {"SLACK_ASSISTANT_ENABLED": "enabled"},
            {"HEADLESS_COMPUTER_PROVIDER": "daytona"},
        ]:
            with self.subTest(overrides=overrides), patch.dict(os.environ, {**self.ENV, **overrides}, clear=True):
                with self.assertRaises(ValueError):
                    runner.assistant_inputs()

    def test_endpoint_rejects_embedded_credentials_and_non_https(self):
        for endpoint in ["http://models.example.test", "https://key@models.example.test", "https://u:key@models.example.test",
                         "https://models.example.test?key=hidden", "https://models.example.test#key", "not a URL"]:
            with self.subTest(endpoint=endpoint), patch.dict(os.environ, {**self.ENV, "HEADLESS_MODEL_BASE_URL": endpoint}, clear=True):
                with self.assertRaises(ValueError):
                    runner.assistant_inputs()

    def test_protocol_model_and_customer_secret_identity_are_required(self):
        for overrides in [
            {"HEADLESS_MODEL_PROTOCOL": "gateway"}, {"HEADLESS_MODEL": ""}, {"HEADLESS_MODEL": "model\n"},
            {"HEADLESS_MODEL_SECRET_ARN": ""}, {"HEADLESS_COMPUTER_SECRET_ARN": ""},
            {"HEADLESS_MODEL_SECRET_ARN": self.ENV["HEADLESS_MODEL_SECRET_ARN"].replace("us-east-1", "us-west-2")},
            {"HEADLESS_MODEL_SECRET_ARN": self.ENV["HEADLESS_MODEL_SECRET_ARN"].replace("123456789012", "999999999999")},
            {"HEADLESS_MODEL_SECRET_ARN": self.ENV["HEADLESS_MODEL_SECRET_ARN"] + ":json-key::"},
        ]:
            with self.subTest(fields=list(overrides)), patch.dict(os.environ, {**self.ENV, **overrides}, clear=True):
                with self.assertRaises(ValueError):
                    runner.assistant_inputs()

    def test_runner_rejects_duplicate_mount_target_zones_before_apply(self):
        inputs = {"network_mode": "existing", "vpc_id": "vpc-test", "service_subnet_ids": ["private-a", "private-b"],
                  "load_balancer_subnet_ids": ["public-a", "public-b"], "ecs_cluster_arn": ""}
        def aws(*args):
            if args[:2] == ("ec2", "describe-subnets"):
                return {"Subnets": [{"SubnetId": name, "AvailabilityZone": "zone-a"} for name in inputs["service_subnet_ids"]]}
            if args[:2] == ("ec2", "describe-vpc-attribute"):
                return {"EnableDnsSupport": {"Value": True}, "EnableDnsHostnames": {"Value": True}}
            return {"Vpcs": [{"VpcId": "vpc-test"}]}
        with patch.dict(os.environ, self.ENV, clear=True), patch.object(runner, "network_inputs", return_value=inputs), \
                patch.object(runner, "network_problems", return_value=[]), patch.object(runner, "aws", side_effect=aws):
            with self.assertRaises(runner.StepFailure):
                runner.verify_network()


class AssistantReleaseTests(unittest.TestCase):
    def pins(self):
        return {kind: repository + "@sha256:" + "a" * 64 for kind, repository in runner.AWS_IMAGE_REPOSITORIES.items()}

    def test_core_only_releases_stay_valid_when_assistants_are_off(self):
        images = {key: value for key, value in self.pins().items() if key in ("den_api", "den_web")}
        self.assertEqual(runner.release_images({"images": images}), {key + "_image": value for key, value in images.items()})
        self.assertEqual(runner.release_images({}), {})
        with self.assertRaises(ValueError):
            runner.release_images({"images": images}, assistants_enabled=True)

    def test_all_four_digest_pins_are_passed_without_registry_resolution(self):
        images = self.pins()
        with patch.object(runner, "aws") as aws:
            self.assertEqual(runner.release_images({"images": images}, True), {key + "_image": value for key, value in images.items()})
        aws.assert_not_called()

    def test_partial_unknown_foreign_or_mutable_pins_are_rejected(self):
        for images in [
            {**self.pins(), "extra": "bad"},
            {key: value for key, value in self.pins().items() if key != "workbot"},
            {**self.pins(), "workbot": "ghcr.io/different-ai/openwork-workbot:dev"},
            {**self.pins(), "workbot": "ghcr.io/example/workbot@sha256:" + "a" * 64},
            [], "invalid",
        ]:
            with self.subTest(inventory=type(images).__name__), self.assertRaises(ValueError):
                runner.release_images({"images": images}, True)

    def test_real_apply_writes_only_refs_and_does_not_force_restart_the_runner(self):
        outputs = {
            "cluster_name": "owned", "service_names": {"den_api": "api", "den_web": "web", "headless_runner": "runner", "workbot": "chat"},
            "task_definition_arns": {"den_api": "arn:api", "den_web": "arn:web", "headless_runner": "arn:runner", "workbot": "arn:chat"},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release.json").write_text(json.dumps({"images": self.pins()}))
            env = {**AssistantInputTests.ENV, "DEPLOYMENT_ID": "test", "STATE_BUCKET": "owned"}
            with patch.dict(os.environ, env, clear=True), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "terraform_inputs", side_effect=runner.assistant_inputs), \
                    patch.object(runner, "certificate_states", return_value={}), patch.object(runner, "legacy_fence", return_value=False), \
                    patch.object(runner.subprocess, "run"), patch.object(runner.subprocess, "check_output", side_effect=["{}", json.dumps({key: {"value": value} for key, value in outputs.items()})]), \
                    patch.object(runner, "tls_redeploy") as tls:
                runner.apply(root, root)
            values = json.loads((root / "managed.auto.tfvars.json").read_text())
            self.assertEqual(values["headless_runner_image"], self.pins()["headless_runner"])
            self.assertEqual(values["workbot_image"], self.pins()["workbot"])
            self.assertEqual(values["headless_model_secret_arn"], env["HEADLESS_MODEL_SECRET_ARN"])
            self.assertEqual((root / "managed.auto.tfvars.json").stat().st_mode & 0o777, 0o600)
            tls.assert_called_once_with(cluster="owned", expected={"api": "arn:api", "web": "arn:web"})


class AssistantSafetyTests(unittest.TestCase):
    def test_efs_and_backup_removal_remain_protected(self):
        for kind in ["aws_efs_file_system", "aws_backup_vault", "aws_backup_plan", "aws_backup_selection"]:
            for actions in [["delete"], ["delete", "create"]]:
                address = "module.platform." + kind + ".runner[0]"
                change = {"address": address, "type": kind, "change": {"actions": actions}}
                self.assertEqual(runner.unsafe_changes({"resource_changes": [change]}), [address])

    def test_healthy_certificate_is_not_force_replaced_on_workbot_enable(self):
        # Adding chat's SAN is Terraform's create-before-destroy operation, not
        # the retry escape hatch for a dead ACM certificate.
        self.assertNotIn("ISSUED", runner.UNRECOVERABLE_CERTIFICATE_STATES)
        change = {"address": "module.platform.aws_acm_certificate.this[0]", "type": "aws_acm_certificate",
                  "change": {"actions": ["create", "delete"]}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [change]}), [])

    def test_running_old_rollback_is_not_assistant_readiness(self):
        outputs = {"cluster_name": "owned", "service_names": {"headless_runner": "runner"},
                   "task_definition_arns": {"headless_runner": "arn:runner:2"}}
        service = {"serviceName": "runner", "runningCount": 1, "desiredCount": 1, "pendingCount": 0,
                   "taskDefinition": "arn:runner:1", "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": "arn:runner:1"}]}
        with patch.object(runner, "aws", return_value={"services": [service]}):
            with self.assertRaisesRegex(ValueError, "intended rollout"):
                runner.verify_services(outputs)
        service["taskDefinition"] = "arn:runner:2"
        service["deployments"][0]["taskDefinition"] = "arn:runner:2"
        with patch.object(runner, "aws", return_value={"services": [service]}):
            runner.verify_services(outputs)

    def test_workbot_health_cannot_probe_an_unapproved_origin(self):
        with patch.dict(os.environ, {"DOMAIN_NAME": "openwork.example.test"}, clear=True), patch.object(runner.urllib.request, "urlopen") as request:
            with self.assertRaises(ValueError):
                runner.verify_health({"web_url": "https://openwork.example.test", "api_url": "https://api.openwork.example.test", "workbot_url": "https://foreign.example.test"}, attempts=1)
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
