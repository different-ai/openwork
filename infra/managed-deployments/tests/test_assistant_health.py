"""Content-free optional AWS assistant health checks (offline only)."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

HEALTH_DIRECTORY = Path(__file__).resolve().parents[1] / "aws/health"
CORE_SPEC = importlib.util.spec_from_file_location("health_agent", HEALTH_DIRECTORY / "health_agent.py")
core = importlib.util.module_from_spec(CORE_SPEC)
CORE_SPEC.loader.exec_module(core)
SPEC = importlib.util.spec_from_file_location("assistant_health", HEALTH_DIRECTORY / "assistant_health_agent.py")
health = importlib.util.module_from_spec(SPEC)
with patch.dict(sys.modules, {"health_agent": core}):
    SPEC.loader.exec_module(health)
NOW = datetime.datetime(2026, 11, 16, tzinfo=datetime.timezone.utc)
FILESYSTEM = "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-test"


def ready_service():
    return {
        "status": "ACTIVE", "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
        "taskDefinition": "revision:2", "serviceName": "private-service",
        "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": "revision:2"}],
    }


def point(hours=1, **overrides):
    return {
        "ResourceArn": FILESYSTEM, "Status": "COMPLETED", "IsEncrypted": True,
        "CreationDate": NOW - datetime.timedelta(hours=hours),
        **overrides,
    }


class AssistantHealthTests(unittest.TestCase):
    def test_runner_requires_completed_intended_service(self):
        ecs = MagicMock()
        ecs.describe_services.return_value = {"services": [ready_service()]}
        result = health.assistant_service_check(ecs, "cluster", "private-service", "runner_service")
        self.assertEqual(result, {"id": "runner_service", "status": "ok", "value": 1, "total": 1})
        for update in ({"desiredCount": 0}, {"runningCount": 0}, {"pendingCount": 1},
                       {"deployments": []}, {"deployments": [{"status": "PRIMARY", "rolloutState": "FAILED", "taskDefinition": "revision:2"}]},
                       {"deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": "revision:1"}]}):
            with self.subTest(update=update):
                ecs.describe_services.return_value = {"services": [{**ready_service(), **update}]}
                self.assertEqual(health.assistant_service_check(ecs, "cluster", "private-service", "runner_service")["status"], "failing")

    def test_gateway_health_and_readiness_require_gateway_identity_without_credentials(self):
        ecs = MagicMock()
        ecs.describe_services.return_value = {"services": [ready_service()]}
        with patch.object(health, "http_check", side_effect=[
                (health.check("ai_gateway_available", "ok", value=10), {"service": "gateway"}),
                (health.check("ai_gateway_available", "ok", value=20), {"service": "gateway"})]) as http:
            result = health.ai_gateway_check(ecs, "cluster", "private-service", "https://models.example.test")
        self.assertEqual(result, {"id": "ai_gateway_available", "status": "ok", "value": 10})
        self.assertEqual([call.args for call in http.call_args_list], [
            ("ai_gateway_available", "https://models.example.test/health"),
            ("ai_gateway_available", "https://models.example.test/ready")])
        self.assertTrue(all(call.kwargs == {"expect_service": "gateway"} for call in http.call_args_list))
        self.assertNotIn("private", json.dumps(result))

    def test_gateway_fails_closed_without_readiness_or_configuration(self):
        ecs = MagicMock()
        ecs.describe_services.return_value = {"services": [ready_service()]}
        with patch.object(health, "http_check") as http:
            result = health.ai_gateway_check(ecs, "cluster", "private-service", None)
            self.assertEqual(result["status"], "unknown")
            http.assert_not_called()
        with patch.object(health, "http_check", side_effect=[
                (health.check("ai_gateway_available", "ok"), {"service": "gateway"}),
                (health.check("ai_gateway_available", "failing", code="http_error"), {"private": "provider details"})]):
            result = health.ai_gateway_check(ecs, "cluster", "private-service", "https://models.example.test")
        self.assertEqual(result, {"id": "ai_gateway_available", "status": "failing", "code": "http_error"})
        self.assertNotIn("private", json.dumps(result))

    def test_storage_reads_metadata_only_and_fails_closed(self):
        efs = MagicMock()
        metadata = {"LifeCycleState": "available", "Encrypted": True, "NumberOfMountTargets": 2}
        efs.describe_file_systems.return_value = {"FileSystems": [metadata]}
        self.assertEqual(health.runner_storage_check(efs, "fs-test")["status"], "ok")
        efs.describe_file_systems.assert_called_once_with(FileSystemId="fs-test")
        for update in ({"LifeCycleState": "error"}, {"Encrypted": False}, {"NumberOfMountTargets": 0}):
            efs.describe_file_systems.return_value = {"FileSystems": [{**metadata, **update}]}
            self.assertEqual(health.runner_storage_check(efs, "fs-test")["status"], "failing")

    def test_backups_require_recent_completed_encrypted_owned_recovery_point(self):
        backup = MagicMock()
        for points, status in [([], "warning"), ([point(31)], "warning"), ([point(1)], "ok"),
                               ([point(Status="FAILED")], "warning"), ([point(IsEncrypted=False)], "warning"),
                               ([point(ResourceArn="another-filesystem")], "warning")]:
            with self.subTest(points=points):
                backup.list_recovery_points_by_backup_vault.return_value = {"RecoveryPoints": points}
                result = health.runner_backups_check(backup, "private-vault", FILESYSTEM, NOW)
                self.assertEqual(result["status"], status)
                self.assertNotIn("private-vault", json.dumps(result))
                self.assertNotIn(FILESYSTEM, json.dumps(result))
        backup.list_recovery_points_by_backup_vault.assert_called_with(
            BackupVaultName="private-vault", ByResourceArn=FILESYSTEM, MaxResults=100)

    def test_backup_pagination_does_not_false_warn_when_fresh_page_is_later(self):
        backup = MagicMock()
        backup.list_recovery_points_by_backup_vault.side_effect = [
            {"RecoveryPoints": [point(40)], "NextToken": "next"}, {"RecoveryPoints": [point(2)]}]
        self.assertEqual(health.runner_backups_check(backup, "vault", FILESYSTEM, NOW)["status"], "ok")
        self.assertEqual(backup.list_recovery_points_by_backup_vault.call_args.kwargs["NextToken"], "next")

    def test_permission_denied_does_not_report_provider_error_or_resource(self):
        for function, client, arguments in [
            (health.runner_storage_check, "describe_file_systems", ("fs-test",)),
            (health.runner_backups_check, "list_recovery_points_by_backup_vault", ("vault", FILESYSTEM, NOW)),
            (health.assistant_service_check, "describe_services", ("cluster", "service", "runner_service")),
        ]:
            with self.subTest(function=function.__name__):
                provider = MagicMock()
                getattr(provider, client).side_effect = ClientError(
                    {"Error": {"Code": "AccessDeniedException", "Message": "private resource details"}}, client)
                result = function(provider, *arguments)
                self.assertEqual(result["code"], "permission_denied")
                self.assertEqual(result["status"], "unknown")
                self.assertNotIn("private", json.dumps(result))

    def collect(self, optional):
        environment = {
            "AWS_REGION": "us-east-1", "SERVICE_NAMES": json.dumps({"den_api": "api", "den_web": "web", **optional.get("services", {})}),
            "TARGET_GROUP_ARNS": json.dumps({"den_api": "api-target", "den_web": "web-target", **optional.get("targets", {})}),
            "CLUSTER_NAME": "cluster", "API_URL": "https://api.example.test", "WEB_URL": "https://example.test",
            "DATABASE_IDENTIFIER": "database", "CERTIFICATE_ARN": "certificate", **optional.get("environment", {}),
        }
        http = MagicMock(side_effect=lambda check_id, *args, **kwargs: (health.check(check_id, "ok"), None))
        with patch.dict(os.environ, environment, clear=True), patch.object(health.boto3, "client"), \
                patch.object(health, "http_check", http), patch.object(core, "http_check", http), \
                patch.object(core, "services_check", return_value=health.check("services_running", "ok")), \
                patch.object(core, "targets_check", return_value=health.check("load_balancer_targets", "ok")) as targets, \
                patch.object(core, "database_checks", return_value=[]), \
                patch.object(core, "certificate_check", return_value=health.check("certificate", "ok")), \
                patch.object(core, "running_version", return_value=None), \
                patch.object(health, "assistant_service_check", side_effect=lambda ecs, cluster, service, check_id: health.check(check_id, "ok")) as service, \
                patch.object(health, "runner_storage_check", return_value=health.check("runner_storage", "ok")) as storage, \
                patch.object(health, "runner_backups_check", return_value=health.check("runner_backups", "ok")) as backups:
            result = health.collect()
        return result, http, service, storage, backups, targets

    def test_disabled_profile_has_no_optional_checks_or_provider_reads(self):
        report, _, service, storage, backups, _ = self.collect({})
        self.assertEqual([item["id"] for item in report["checks"]], [
            "api_health", "database_ready", "web_available", "services_running", "load_balancer_targets", "certificate"])
        service.assert_not_called()
        storage.assert_not_called()
        backups.assert_not_called()

    def test_gateway_profile_adds_only_gateway_availability_metadata(self):
        report, http, service, storage, backups, _ = self.collect({
            "services": {"ai_gateway": "private-gateway"},
            "environment": {"AI_GATEWAY_URL": "https://models.example.test"},
        })
        self.assertEqual(report["checks"][-1], {"id": "ai_gateway_available", "status": "ok"})
        self.assertEqual(http.call_args.args, ("ai_gateway_available", "https://models.example.test/ready"))
        self.assertEqual(http.call_args.kwargs, {"expect_service": "gateway"})
        self.assertEqual(service.call_args.args[-1], "ai_gateway_available")
        storage.assert_not_called()
        backups.assert_not_called()
        self.assertNotIn("private", json.dumps(report))

    def test_optional_profile_reports_only_allowlisted_content_free_checks(self):
        report, http, _, storage, backups, targets = self.collect({
            "services": {"headless_runner": "private-runner", "workbot": "private-workbot"},
            "environment": {"WORKBOT_URL": "https://chat.example.test", "EFS_FILE_SYSTEM_ID": "fs-private",
                            "EFS_FILE_SYSTEM_ARN": FILESYSTEM, "RUNNER_BACKUP_VAULT_NAME": "private-vault"},
        })
        self.assertEqual([item["id"] for item in report["checks"]][-4:],
                         ["runner_service", "workbot_available", "runner_storage", "runner_backups"])
        self.assertEqual(http.call_args.args, ("workbot_available", "https://chat.example.test/healthz"))
        self.assertEqual(targets.call_args.args[1], {"den_api": "api-target", "den_web": "web-target"})
        storage.assert_called_once()
        backups.assert_called_once()
        self.assertNotIn("private", json.dumps(report))
        self.assertNotIn(FILESYSTEM, json.dumps(report))


if __name__ == "__main__":
    unittest.main()
