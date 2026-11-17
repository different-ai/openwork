"""Opt-in AWS assistant metadata checks, packaged only for enabled assistants.

No agent requests, responses, files, credentials or provider error details enter
reports. The unchanged core health agent remains the default-off entrypoint.
"""
import datetime
import json
import os
import urllib.request

import boto3

import health_agent as core

check = core.check
guarded = core.guarded
http_check = core.http_check


def assistant_service_check(ecs, cluster, service_name, check_id):
    def run():
        response = ecs.describe_services(cluster=cluster, services=[service_name])
        services = response.get("services", [])
        if response.get("failures") or len(services) != 1:
            return check(check_id, "failing", code="not_running")
        service = services[0]
        desired = service.get("desiredCount", 0)
        running = service.get("runningCount", 0)
        deployments = service.get("deployments", [])
        ready = (service.get("serviceName") == service_name and service.get("status") == "ACTIVE"
                 and bool(service.get("taskDefinition")) and desired >= 1 and running >= desired
                 and service.get("pendingCount", 0) == 0 and len(deployments) == 1
                 and deployments[0].get("status") == "PRIMARY"
                 and deployments[0].get("rolloutState") == "COMPLETED"
                 and deployments[0].get("taskDefinition") == service.get("taskDefinition"))
        return check(check_id, "ok" if ready else "failing", value=running, total=desired,
                     code=None if ready else "not_running")
    return guarded(check_id, run)


def ai_gateway_check(ecs, cluster, service_name, url):
    result = assistant_service_check(ecs, cluster, service_name, "ai_gateway_available")
    if result["status"] != "ok":
        return result
    if not url:
        return check("ai_gateway_available", "unknown", code="unavailable")
    health, _ = http_check("ai_gateway_available", url.rstrip("/") + "/health", expect_service="gateway")
    if health["status"] not in ("ok", "warning"):
        return health
    ready, _ = http_check("ai_gateway_available", url.rstrip("/") + "/ready", expect_service="gateway")
    return ready if ready["status"] != "ok" else health


def runner_storage_check(efs, identifier):
    def run():
        filesystems = efs.describe_file_systems(FileSystemId=identifier).get("FileSystems", [])
        if len(filesystems) != 1:
            return check("runner_storage", "failing", code="unavailable")
        filesystem = filesystems[0]
        ready = (filesystem.get("LifeCycleState") == "available" and filesystem.get("Encrypted") is True
                 and filesystem.get("NumberOfMountTargets", 0) >= 1)
        used_bytes = filesystem.get("SizeInBytes", {}).get("Value")
        return check("runner_storage", "ok" if ready else "failing", value=used_bytes,
                     code=None if ready else "unhealthy")
    return guarded("runner_storage", run)


def runner_backups_check(backup, vault, filesystem_arn, now):
    def run():
        latest = None
        token = None
        # Seven daily retained backups normally fit on one page. Bound requests
        # even if an operator has added additional recovery points to this vault.
        for _ in range(10):
            arguments = {"BackupVaultName": vault, "ByResourceArn": filesystem_arn, "MaxResults": 100}
            if token:
                arguments["NextToken"] = token
            response = backup.list_recovery_points_by_backup_vault(**arguments)
            for point in response.get("RecoveryPoints", []):
                created = point.get("CreationDate")
                if (point.get("ResourceArn") == filesystem_arn and point.get("Status") == "COMPLETED"
                        and point.get("IsEncrypted") is True and isinstance(created, datetime.datetime)):
                    latest = max(latest, created) if latest else created
            token = response.get("NextToken")
            if not token:
                break
        if token:
            return check("runner_backups", "unknown", code="unavailable")
        if latest is None:
            # A fresh install is not protected until AWS completes its first
            # encrypted daily snapshot; never report the plan alone as healthy.
            return check("runner_backups", "warning", code="unavailable")
        hours = (now - latest).total_seconds() / 3600
        status = "ok" if 0 <= hours <= 30 else "warning"
        return check("runner_backups", status, value=hours, code=None if status == "ok" else "stale_backup")
    return guarded("runner_backups", run)


def collect():
    report = core.collect()
    region = os.environ["AWS_REGION"]
    now = datetime.datetime.now(datetime.timezone.utc)
    services = json.loads(os.environ["SERVICE_NAMES"])
    ecs = boto3.client("ecs", region_name=region)
    checks = report["checks"]
    if "headless_runner" in services:
        checks.append(assistant_service_check(ecs, os.environ["CLUSTER_NAME"], services["headless_runner"], "runner_service"))
    if "workbot" in services:
        workbot = assistant_service_check(ecs, os.environ["CLUSTER_NAME"], services["workbot"], "workbot_available")
        if workbot["status"] == "ok":
            if os.environ.get("WORKBOT_URL"):
                workbot, _ = http_check("workbot_available", os.environ["WORKBOT_URL"].rstrip("/") + "/healthz")
            else:
                workbot = check("workbot_available", "unknown", code="unavailable")
        checks.append(workbot)
    if "ai_gateway" in services:
        checks.append(ai_gateway_check(ecs, os.environ["CLUSTER_NAME"], services["ai_gateway"], os.environ.get("AI_GATEWAY_URL")))
    if "headless_runner" in services:
        checks.append(runner_storage_check(boto3.client("efs", region_name=region), os.environ["EFS_FILE_SYSTEM_ID"])
                      if os.environ.get("EFS_FILE_SYSTEM_ID") else check("runner_storage", "unknown", code="unavailable"))
        checks.append(runner_backups_check(boto3.client("backup", region_name=region), os.environ["RUNNER_BACKUP_VAULT_NAME"], os.environ["EFS_FILE_SYSTEM_ARN"], now)
                      if os.environ.get("RUNNER_BACKUP_VAULT_NAME") and os.environ.get("EFS_FILE_SYSTEM_ARN")
                      else check("runner_backups", "unknown", code="unavailable"))
    return report


def handler(event=None, context=None):
    region = os.environ["AWS_REGION"]
    body = json.dumps(collect(), separators=(",", ":")).encode()
    url = os.environ["CONTROL_PLANE_ORIGIN"].rstrip("/") + f'/v1/managed-deployments/{os.environ["DEPLOYMENT_ID"]}/heartbeat'
    request = urllib.request.Request(url, data=body, method="POST", headers=core.identity_headers(body, region))
    with urllib.request.urlopen(request, timeout=20) as response:
        accepted = json.load(response).get("ok") is True
    summary = {item["id"]: item["status"] for item in json.loads(body)["checks"]}
    print(json.dumps({"reported": accepted, "checks": summary}))
    return {"reported": accepted}
