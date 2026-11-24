"""A configuration change re-runs the installed release with changed parameters; no cloud calls."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("configuration_change_runner", ROOT / "aws/runner/runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

INSTALLED = {
    "DEPLOYMENT_ID": "test", "DOMAIN_NAME": "openwork.example.com", "OWNER_EMAIL": "admin@example.com", "OPENWORK_VERSION": "1.0.2",
    "CONTROL_PLANE_ORIGIN": "https://control.example.com", "ROUTE53_ZONE_ID": "ZTEST", "AWS_REGION": "us-east-1",
    "EXPECTED_ACCOUNT_ID": "123456789012", "RUN_ID": "00000000-0000-4000-8000-000000000001",
}
COMPUTER_KEY = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-Ab1234"
FIXED = ("deployment_id", "domain_name", "region", "account_id", "route53_zone_id", "network_mode", "size", "openwork_version")


def planned(resource_type, actions):
    return {"address": "module.platform." + resource_type + ".fixture", "type": resource_type, "change": {"actions": actions}}


class ConfigurationChangeTests(unittest.TestCase):
    def inputs(self, **changes):
        with patch.dict(os.environ, {**INSTALLED, **changes}, clear=True), patch.object(runner, "aws") as aws:
            values = runner.terraform_inputs()
        aws.assert_not_called()
        return values

    def test_a_new_run_of_the_same_version_carries_only_the_changed_administrator_email(self):
        before = self.inputs()
        after = self.inputs(OWNER_EMAIL="first.admin@example.com", RUN_ID="00000000-0000-4000-8000-000000000002")
        self.assertEqual(after["openwork_version"], "1.0.2")
        self.assertEqual(after["owner_email"], "first.admin@example.com")
        self.assertEqual({key for key in after if after[key] != before.get(key)}, {"owner_email"})
        self.assertEqual(set(after), set(before))

    def test_the_same_version_can_add_the_gateway_runtime_and_daytona_computers(self):
        before = self.inputs()
        after = self.inputs(MANAGED_RUNTIME_PROFILE="gateway", HEADLESS_COMPUTER_PROVIDER="daytona", HEADLESS_COMPUTER_SECRET_ARN=COMPUTER_KEY,
                            HEADLESS_COMPUTER_SNAPSHOT="computer-snapshot", RUN_ID="00000000-0000-4000-8000-000000000002")
        self.assertEqual(before["managed_runtime_profile"], "legacy")
        self.assertNotIn("headless_runner", before)
        self.assertEqual(after["managed_runtime_profile"], "gateway")
        self.assertEqual(after["headless_runner"], {"enabled": True})
        self.assertEqual(after["headless_computer"], {"provider": "daytona", "snapshot": "computer-snapshot"})
        self.assertEqual(after["headless_computer_secret_arn"], COMPUTER_KEY)
        self.assertEqual(after["daytona"], {"api_url": "https://app.daytona.io/api", "target": "us"})
        for key in FIXED + ("owner_email",):
            self.assertEqual(after[key], before[key], key)

    def test_computers_can_change_or_be_turned_off_on_an_installed_gateway_runtime(self):
        gateway = {"MANAGED_RUNTIME_PROFILE": "gateway"}
        freestyle = self.inputs(**gateway, HEADLESS_COMPUTER_PROVIDER="freestyle", HEADLESS_COMPUTER_SECRET_ARN=COMPUTER_KEY)
        self.assertEqual(freestyle["headless_computer"], {"provider": "freestyle"})
        off = self.inputs(**gateway)
        self.assertEqual(off["headless_computer"], {"provider": "off"})
        self.assertEqual(off["headless_computer_secret_arn"], "")
        self.assertNotIn("daytona", off)

    def test_a_plan_that_removes_runner_storage_backups_or_secrets_is_refused_whatever_was_requested(self):
        for resource_type in ("aws_efs_file_system", "aws_backup_vault", "aws_backup_plan", "aws_secretsmanager_secret", "aws_db_instance", "aws_vpc"):
            for actions in (["delete"], ["delete", "create"], ["create", "delete"]):
                change = planned(resource_type, actions)
                with self.subTest(resource=resource_type, actions=actions):
                    self.assertEqual(runner.unsafe_changes({"resource_changes": [change]}), [change["address"]])

    def test_what_a_configuration_change_plans_is_allowed(self):
        plan = {"resource_changes": [
            planned("aws_ecs_task_definition", ["delete", "create"]), planned("aws_ecs_service", ["update"]),
            planned("aws_efs_file_system", ["create"]), planned("aws_backup_vault", ["create"]),
            planned("aws_secretsmanager_secret", ["create"]), planned("aws_secretsmanager_secret", ["update"]), planned("aws_db_instance", ["no-op"]),
        ]}
        self.assertEqual(runner.unsafe_changes(plan), [])


if __name__ == "__main__":
    unittest.main()
