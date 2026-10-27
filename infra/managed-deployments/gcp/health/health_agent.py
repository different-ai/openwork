"""Read-only GCP health job. Standard library only; reports no names or secrets."""
import datetime
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect refused")


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        before, after = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (req.get_method() != "GET" or req.has_header("Authorization") or req.has_header("Cookie")
                or before.scheme != "https" or after.scheme != "https"
                or before.netloc != after.netloc or after.username or after.password):
            raise ValueError("cross-origin redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, headers=None, data=None, same_origin_redirects=False):
    req = urllib.request.Request(url, headers=headers or {}, data=data)
    redirect = SameOriginRedirect() if same_origin_redirects else NoRedirect()
    with urllib.request.build_opener(redirect).open(req, timeout=20) as response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError("response too large")
        return body


def metadata(path):
    return fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/" + path,
                 {"Metadata-Flavor": "Google"})


def api(url):
    token = json.loads(metadata("token"))["access_token"]
    return json.loads(fetch(url, {"Authorization": "Bearer " + token}))


def check(identifier, status, code=None, value=None, total=None):
    item = {"id": identifier, "status": status}
    if code:
        item["code"] = code
    for key, number in [("value", value), ("total", total)]:
        if number is not None:
            item[key] = round(min(1_000_000_000, max(0, number)), 2)
    return item


def guarded(identifier, call):
    try:
        return call()
    except urllib.error.HTTPError as error:
        return check(identifier, "unknown", "permission_denied" if error.code == 403 else "unavailable")
    except Exception:
        return check(identifier, "unknown", "unavailable")


def http_check(identifier, url, expected_service=None):
    started = time.monotonic()
    try:
        body = fetch(url, same_origin_redirects=expected_service is None)
        if expected_service:
            result = json.loads(body)
            if result.get("ok") is not True or result.get("service") != expected_service:
                return check(identifier, "failing", "unhealthy")
        ms = (time.monotonic() - started) * 1000
        return check(identifier, "warning" if ms > 3000 else "ok", "slow" if ms > 3000 else None, ms)
    except urllib.error.HTTPError:
        return check(identifier, "failing", "http_error")
    except Exception:
        return check(identifier, "failing", "unreachable")


def service_ready(service):
    # v2 terminalCondition succeeds only after the new revision is ready.
    return (service.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED"
            and service.get("generation") is not None
            and str(service.get("observedGeneration")) == str(service.get("generation")))


def serving_expected_revision(service, expected_image):
    if not service_ready(service) or not expected_image:
        return False
    containers = service.get("template", {}).get("containers", [])
    if not containers or containers[0].get("image") != expected_image:
        return False
    created, ready = service.get("latestCreatedRevision"), service.get("latestReadyRevision")
    if not isinstance(created, str) or not isinstance(ready, str) or not created or not ready or created != ready:
        return False
    traffic = service.get("trafficStatuses", [])
    # ProtoJSON omits int32's default zero. Default only an absent field;
    # explicit null, bool, string, float and out-of-range values stay invalid.
    if not traffic or any(type(target.get("percent", 0)) is not int or not 0 <= target.get("percent", 0) <= 100 for target in traffic):
        return False
    # API versions can return either a full revision resource name or its ID in
    # traffic status. Both are reported by the same service, not customer input.
    revision = ready.rsplit("/", 1)[-1]
    return (sum(target.get("percent", 0) for target in traffic) == 100
            and sum(target.get("percent", 0) for target in traffic
                    if isinstance(target.get("revision"), str)
                    and target["revision"].rsplit("/", 1)[-1] == revision) == 100)


def collect():
    project, region = os.environ["PROJECT_ID"], os.environ["REGION"]
    checks = [http_check("api_health", os.environ["API_URL"] + "/health", "den-api"),
              http_check("database_ready", os.environ["API_URL"] + "/ready", "den-api"),
              http_check("web_available", os.environ["WEB_URL"] + "/api/ready", "den-web")]
    services = {}
    expected = json.loads(os.environ["EXPECTED_IMAGES"])
    def running():
        for kind, service in json.loads(os.environ["SERVICE_NAMES"]).items():
            services[kind] = api(f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/services/{service}")
        ready = sum(serving_expected_revision(service, expected.get(kind)) for kind, service in services.items())
        return check("services_running", "ok" if ready == 2 and len(services) == 2 else "failing",
                     None if ready == 2 and len(services) == 2 else "not_running", ready, 2)
    checks.append(guarded("services_running", running))
    # Serverless NEGs do not expose target health. Omit this inapplicable check;
    # HTTPS API/readiness/web checks above prove the load-balancer routes.
    instance_url = f'https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/instances/{os.environ["DATABASE_INSTANCE"]}'
    def database():
        instance = api(instance_url)
        return check("database_instance", "ok" if instance.get("state") == "RUNNABLE" else "failing",
                     None if instance.get("state") == "RUNNABLE" else "unavailable")
    checks.append(guarded("database_instance", database))
    def storage():
        instance = api(instance_url)
        allocated = float(instance.get("settings", {}).get("dataDiskSizeGb", 0))
        now = datetime.datetime.now(datetime.timezone.utc)
        params = urllib.parse.urlencode({
            "filter": 'resource.type="cloudsql_database" AND resource.labels.database_id="' + project + ':' + os.environ["DATABASE_INSTANCE"] + '" AND metric.type="cloudsql.googleapis.com/database/disk/utilization"',
            "interval.startTime": (now - datetime.timedelta(minutes=30)).isoformat(),
            "interval.endTime": now.isoformat(), "view": "FULL"})
        series = api(f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?" + params)
        ratios = [float(point["value"]["doubleValue"]) for item in series.get("timeSeries", [])
                  for point in item.get("points", []) if "doubleValue" in point.get("value", {})]
        if not ratios or allocated <= 0:
            return check("database_storage", "unknown", "unavailable")
        used = max(ratios)
        if not 0 <= used <= 1:
            return check("database_storage", "unknown", "unavailable")
        free = 1 - used
        status = "failing" if free < 0.05 else "warning" if free < 0.2 else "ok"
        return check("database_storage", status, None if status == "ok" else "low_storage", free * allocated, allocated)
    checks.append(guarded("database_storage", storage))
    def backups():
        instance = api(instance_url)
        if not instance.get("settings", {}).get("backupConfiguration", {}).get("enabled"):
            return check("database_backups", "failing", "backups_disabled")
        completed = [item for item in api(instance_url + "/backupRuns").get("items", [])
                     if item.get("status") == "SUCCESSFUL" and item.get("endTime")]
        if not completed:
            return check("database_backups", "unknown", "unavailable")
        latest = max(datetime.datetime.fromisoformat(item["endTime"].replace("Z", "+00:00")) for item in completed)
        hours = (datetime.datetime.now(datetime.timezone.utc) - latest).total_seconds() / 3600
        return check("database_backups", "ok" if hours <= 26 else "warning", None if hours <= 26 else "stale_backup", hours)
    checks.append(guarded("database_backups", backups))
    def certificate():
        cert = api(f'https://compute.googleapis.com/compute/v1/projects/{project}/global/sslCertificates/{os.environ["CERTIFICATE_NAME"]}')
        if cert.get("managed", {}).get("status") != "ACTIVE":
            return check("certificate", "failing", "not_issued")
        expires = cert.get("expireTime")
        if not expires:
            return check("certificate", "unknown", "unavailable")
        days = (datetime.datetime.fromisoformat(expires.replace("Z", "+00:00")) - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 86400
        return check("certificate", "ok" if days >= 21 else "warning" if days > 3 else "failing",
                     None if days >= 21 else "expired" if days <= 0 else "expiring", days)
    checks.append(guarded("certificate", certificate))
    report = {"checks": checks}
    if set(services) == {"den_api", "den_web"} and all(serving_expected_revision(s, expected.get(kind)) for kind, s in services.items()):
        report["version"] = os.environ["OPENWORK_VERSION"]
    return report


def identity_headers(body):
    url = os.environ["CONTROL_PLANE_ORIGIN"] + "/v1/managed-deployments/" + os.environ["DEPLOYMENT_ID"] + "/heartbeat"
    audience = url + "#" + hashlib.sha256(body).hexdigest()
    token = metadata("identity?" + urllib.parse.urlencode({"audience": audience, "format": "full"})).decode()
    return {"Content-Type": "application/json", "Authorization": "Bearer " + token}


def main():
    report = collect()
    # Metadata identity tokens may be cached for an audience. Even an unchanged
    # health snapshot needs a fresh audience; the API binds it to this exact body
    # and still enforces strict JWT freshness and monotonic issued-at replay checks.
    report["nonce"] = secrets.token_hex(16)
    body = json.dumps(report, separators=(",", ":"), allow_nan=False).encode()
    url = os.environ["CONTROL_PLANE_ORIGIN"] + "/v1/managed-deployments/" + os.environ["DEPLOYMENT_ID"] + "/heartbeat"
    response = json.loads(fetch(url, identity_headers(body), body))
    if response.get("ok") is not True:
        raise ValueError("health report rejected")
    print(json.dumps({"reported": True, "checks": {c["id"]: c["status"] for c in json.loads(body)["checks"]}}))


if __name__ == "__main__":
    main()
