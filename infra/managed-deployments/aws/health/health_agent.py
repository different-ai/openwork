"""OpenWork health agent for AWS installations.

Runs on a schedule inside the customer's account with a read-only role. It
sends only allowlisted check ids, states, numbers and codes; no logs, names,
addresses or secrets. The control plane authenticates the report by replaying
a signed STS GetCallerIdentity request bound to this exact report body.
"""
import datetime
import hashlib
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

VERSION_PATTERN = re.compile(r":(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")


def check(check_id, status, value=None, total=None, code=None):
    result = {"id": check_id, "status": status}
    if value is not None:
        result["value"] = round(max(0, min(value, 1_000_000_000)), 2)
    if total is not None:
        result["total"] = round(max(0, min(total, 1_000_000_000)), 2)
    if code:
        result["code"] = code
    return result


def http_check(check_id, url, expect_service=None):
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "openwork-health-agent"})
        with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
            latency = (time.monotonic() - started) * 1000
            body = response.read(65536)
            if response.status != 200:
                return check(check_id, "failing", code="http_error"), None
            payload = None
            if expect_service:
                payload = json.loads(body)
                if payload.get("service") != expect_service:
                    return check(check_id, "failing", code="http_error"), None
            return check(check_id, "warning" if latency > 3000 else "ok", value=latency, code="slow" if latency > 3000 else None), payload
    except urllib.error.HTTPError as error:
        payload = None
        try:
            payload = json.loads(error.read(65536))
        except Exception:
            pass
        return check(check_id, "failing", code="http_error"), payload
    except (TimeoutError, OSError):
        return check(check_id, "failing", code="unreachable"), None
    except Exception:
        return check(check_id, "failing", code="http_error"), None


def guarded(check_id, function):
    try:
        return function()
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        return check(check_id, "unknown", code="permission_denied" if "AccessDenied" in code else "unavailable")


def services_check(ecs, cluster, services):
    def run():
        response = ecs.describe_services(cluster=cluster, services=list(services.values()))
        running = sum(service["runningCount"] for service in response["services"])
        desired = sum(service["desiredCount"] for service in response["services"])
        missing = len(services) - len(response["services"])
        ok = not missing and desired > 0 and running >= desired
        return check("services_running", "ok" if ok else "failing", value=running, total=desired, code=None if ok else "not_running")
    return guarded("services_running", run)


def running_version(ecs, cluster, services):
    try:
        service = ecs.describe_services(cluster=cluster, services=[services["den_api"]])["services"][0]
        definition = ecs.describe_task_definition(taskDefinition=service["taskDefinition"])["taskDefinition"]
        for container in definition["containerDefinitions"]:
            match = VERSION_PATTERN.search(container.get("image", ""))
            if match:
                return match.group(1)
    except Exception:
        pass
    return None


def targets_check(elb, target_groups):
    def run():
        healthy = total = 0
        for arn in target_groups.values():
            for description in elb.describe_target_health(TargetGroupArn=arn)["TargetHealthDescriptions"]:
                total += 1
                healthy += description["TargetHealth"]["State"] == "healthy"
        status = "ok" if total and healthy == total else ("failing" if healthy == 0 else "warning")
        return check("load_balancer_targets", status, value=healthy, total=total, code=None if status == "ok" else "unhealthy")
    return guarded("load_balancer_targets", run)


def database_checks(rds, cloudwatch, identifier, now):
    results = []
    try:
        instance = rds.describe_db_instances(DBInstanceIdentifier=identifier)["DBInstances"][0]
    except Exception:
        return [check(name, "unknown", code="unavailable") for name in ("database_instance", "database_storage", "database_backups")]
    available = instance["DBInstanceStatus"] in ("available", "backing-up", "modifying", "configuring-enhanced-monitoring", "storage-optimization")
    results.append(check("database_instance", "ok" if available else "failing", code=None if available else "unavailable"))

    def storage():
        allocated = float(instance["AllocatedStorage"])
        points = cloudwatch.get_metric_statistics(
            Namespace="AWS/RDS", MetricName="FreeStorageSpace", Dimensions=[{"Name": "DBInstanceIdentifier", "Value": identifier}],
            StartTime=now - datetime.timedelta(minutes=30), EndTime=now, Period=300, Statistics=["Minimum"])["Datapoints"]
        if not points:
            return check("database_storage", "unknown", total=allocated, code="unavailable")
        free = min(point["Minimum"] for point in points) / (1024 ** 3)
        ratio = free / allocated if allocated else 0
        status = "failing" if ratio < 0.05 else "warning" if ratio < 0.2 else "ok"
        return check("database_storage", status, value=free, total=allocated, code=None if status == "ok" else "low_storage")
    results.append(guarded("database_storage", storage))

    retention = instance.get("BackupRetentionPeriod", 0)
    restorable = instance.get("LatestRestorableTime")
    if retention < 1:
        results.append(check("database_backups", "failing", code="backups_disabled"))
    elif not restorable:
        results.append(check("database_backups", "unknown", code="unavailable"))
    else:
        hours = (now - restorable).total_seconds() / 3600
        status = "ok" if hours <= 26 else "warning"
        results.append(check("database_backups", status, value=hours, code=None if status == "ok" else "stale_backup"))
    return results


def certificate_check(acm, arn, now):
    def run():
        certificate = acm.describe_certificate(CertificateArn=arn)["Certificate"]
        if certificate["Status"] != "ISSUED" or "NotAfter" not in certificate:
            return check("certificate", "failing", code="not_issued")
        days = (certificate["NotAfter"] - now).total_seconds() / 86400
        status = "failing" if days < 3 else "warning" if days < 21 else "ok"
        return check("certificate", status, value=days, code=None if status == "ok" else ("expired" if days <= 0 else "expiring"))
    return guarded("certificate", run)


def collect():
    region = os.environ["AWS_REGION"]
    now = datetime.datetime.now(datetime.timezone.utc)
    services = json.loads(os.environ["SERVICE_NAMES"])
    services = {key: services[key] for key in ("den_api", "den_web") if key in services}
    target_groups = json.loads(os.environ["TARGET_GROUP_ARNS"])
    ecs = boto3.client("ecs", region_name=region)
    checks = []
    api, _ = http_check("api_health", os.environ["API_URL"] + "/health", expect_service="den-api")
    checks.append(api)
    ready, payload = http_check("database_ready", os.environ["API_URL"] + "/ready", expect_service="den-api")
    if payload and payload.get("checks", {}).get("database") == "error":
        ready = check("database_ready", "failing", code="unhealthy")
    checks.append(ready)
    web, _ = http_check("web_available", os.environ["WEB_URL"] + "/")
    checks.append(web)
    checks.append(services_check(ecs, os.environ["CLUSTER_NAME"], services))
    checks.append(targets_check(boto3.client("elbv2", region_name=region), target_groups))
    checks.extend(database_checks(boto3.client("rds", region_name=region), boto3.client("cloudwatch", region_name=region), os.environ["DATABASE_IDENTIFIER"], now))
    checks.append(certificate_check(boto3.client("acm", region_name=region), os.environ["CERTIFICATE_ARN"], now))
    report = {"version": running_version(ecs, os.environ["CLUSTER_NAME"], services), "checks": checks}
    if report["version"] is None:
        report.pop("version")
    return report


def identity_headers(body, region):
    digest = hashlib.sha256(body).hexdigest()
    proof = f'heartbeat:{os.environ["DEPLOYMENT_ID"]}:{digest}'
    request = AWSRequest(method="POST", url=f"https://sts.{region}.amazonaws.com/",
                         data="Action=GetCallerIdentity&Version=2011-06-15",
                         headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "x-openwork-proof": proof})
    credentials = boto3.Session().get_credentials().get_frozen_credentials()
    SigV4Auth(credentials, "sts", region).add_auth(request)
    return {
        "Content-Type": "application/json",
        "X-OpenWork-Proof": proof,
        "X-OpenWork-Aws-Authorization": request.headers["Authorization"],
        "X-OpenWork-Aws-Date": request.headers["X-Amz-Date"],
        "X-OpenWork-Aws-Security-Token": request.headers["X-Amz-Security-Token"],
    }


def handler(event=None, context=None):
    region = os.environ["AWS_REGION"]
    body = json.dumps(collect(), separators=(",", ":")).encode()
    url = os.environ["CONTROL_PLANE_ORIGIN"].rstrip("/") + f'/v1/managed-deployments/{os.environ["DEPLOYMENT_ID"]}/heartbeat'
    request = urllib.request.Request(url, data=body, method="POST", headers=identity_headers(body, region))
    with urllib.request.urlopen(request, timeout=20) as response:
        accepted = json.load(response).get("ok") is True
    summary = {item["id"]: item["status"] for item in json.loads(body)["checks"]}
    print(json.dumps({"reported": accepted, "checks": summary}))
    return {"reported": accepted}
