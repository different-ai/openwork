"""Install the verified OpenWork release inside the customer's AWS account.

No Den database, deployment secrets or credentials are imported. Its only
control-plane dependency is the versioned identity/event HTTP protocol.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import zipfile

import boto3

TERRAFORM_VERSION = "1.9.8"
TERRAFORM_LINUX_SHA256 = "186e0145f5e5f2eb97cbd785bc78f21bae4ef15119349f6ad4fa535b83b10df8"
STEPS = [(3, "account_verified", "runner_failed"), (4, "infrastructure_applied", "infrastructure_failed"),
         (5, "services_ready", "service_unhealthy"), (6, "health_verified", "health_check_failed")]


def report(sequence, step, outcome="succeeded", error_code=None):
    payload = {"sequence": sequence, "step": step, "outcome": outcome}
    if error_code:
        payload["errorCode"] = error_code
    token = Path(os.environ["RUNNER_TOKEN_FILE"]).read_text()
    url = os.environ["CONTROL_PLANE_ORIGIN"].rstrip("/") + f'/v1/aws-deployments/{os.environ["DEPLOYMENT_ID"]}/runs/{os.environ["RUN_ID"]}/events'
    # Exact repeats are idempotent. Do not advance a sequence without a receipt.
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=30) as response:
                if json.load(response).get("ok") is not True:
                    raise ValueError("progress not accepted")
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def terraform_binary(root):
    archive = root / "terraform.zip"
    url = f"https://releases.hashicorp.com/terraform/{TERRAFORM_VERSION}/terraform_{TERRAFORM_VERSION}_linux_amd64.zip"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(100 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != TERRAFORM_LINUX_SHA256:
        raise ValueError("Terraform checksum mismatch")
    archive.write_bytes(data)
    with zipfile.ZipFile(archive) as zipped:
        binary = root / "terraform"
        binary.write_bytes(zipped.read("terraform"))
    binary.chmod(0o700)
    return str(binary)


def terraform_inputs():
    return {"region": os.environ["AWS_REGION"], "account_id": os.environ["EXPECTED_ACCOUNT_ID"],
            "deployment_id": os.environ["DEPLOYMENT_ID"], "domain_name": os.environ["DOMAIN_NAME"],
            "route53_zone_id": os.environ["ROUTE53_ZONE_ID"], "owner_email": os.environ["OWNER_EMAIL"],
            "openwork_version": os.environ["OPENWORK_VERSION"]}


def verify_account(session):
    if session.client("sts").get_caller_identity()["Account"] != os.environ["EXPECTED_ACCOUNT_ID"]:
        raise ValueError("wrong AWS account")
    zone = session.client("route53").get_hosted_zone(Id=os.environ["ROUTE53_ZONE_ID"])["HostedZone"]
    zone_name = zone["Name"].rstrip(".")
    domain = os.environ["DOMAIN_NAME"]
    if zone.get("Config", {}).get("PrivateZone") or not (domain == zone_name or domain.endswith("." + zone_name)):
        raise ValueError("domain must belong to a public hosted zone")


def apply(root, tf_root):
    binary = terraform_binary(root)
    state_key = "deployments/" + os.environ["DEPLOYMENT_ID"] + "/terraform.tfstate"
    inputs = tf_root / "managed.auto.tfvars.json"
    inputs.write_text(json.dumps(terraform_inputs()))
    inputs.chmod(0o600)
    subprocess.run([binary, "init", "-input=false", "-lockfile=readonly",
                    "-backend-config=bucket=" + os.environ["STATE_BUCKET"],
                    "-backend-config=key=" + state_key, "-backend-config=encrypt=true",
                    "-backend-config=dynamodb_table=" + os.environ["LOCK_TABLE"],
                    "-backend-config=region=" + os.environ["AWS_REGION"]], cwd=tf_root, check=True)
    plan = tf_root / "approved.tfplan"
    subprocess.run([binary, "plan", "-input=false", "-lock-timeout=60s", "-out=" + str(plan)], cwd=tf_root, check=True)
    # The initial plan is approved by the customer in the CloudFormation flow.
    # Never silently apply deletions/replacements to an existing installation.
    planned = json.loads(subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root))
    if any("delete" in change.get("change", {}).get("actions", []) for change in planned.get("resource_changes", [])):
        raise ValueError("infrastructure deletion requires separate approval")
    subprocess.run([binary, "apply", "-input=false", "-lock-timeout=60s", str(plan)], cwd=tf_root, check=True)
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root)
    return {key: value["value"] for key, value in json.loads(raw).items()}


def verify_services(session, outputs):
    ecs = session.client("ecs")
    services = list(outputs["service_names"].values())
    ecs.get_waiter("services_stable").wait(cluster=outputs["cluster_name"], services=services,
                                         WaiterConfig={"Delay": 15, "MaxAttempts": 40})
    status = ecs.describe_services(cluster=outputs["cluster_name"], services=services)
    if status.get("failures") or len(status["services"]) != len(services):
        raise ValueError("services unavailable")
    for service in status["services"]:
        if service["runningCount"] < service["desiredCount"] or service["desiredCount"] < 1:
            raise ValueError("services not running")


def verify_health(outputs):
    expected_web = "https://" + os.environ["DOMAIN_NAME"]
    expected_api = "https://api." + os.environ["DOMAIN_NAME"]
    if outputs["web_url"] != expected_web or outputs["api_url"] != expected_api:
        raise ValueError("unexpected service origin")
    for path in ["/health", "/ready"]:
        with urllib.request.urlopen(expected_api + path, timeout=30) as response:
            health = json.load(response)
        if health.get("ok") is not True or health.get("service") != "den-api":
            raise ValueError("API health failed")
    with urllib.request.urlopen(expected_web + "/setup", timeout=30) as response:
        if response.status != 200:
            raise ValueError("setup unavailable")


def main():
    root = Path.cwd()
    tf_root = root / "infra/aws-managed/terraform"
    session = boto3.Session(region_name=os.environ["AWS_REGION"])
    current = STEPS[0]
    try:
        verify_account(session)
        report(3, "account_verified")
        current = STEPS[1]
        outputs = apply(root, tf_root)
        report(4, "infrastructure_applied")
        current = STEPS[2]
        verify_services(session, outputs)
        report(5, "services_ready")
        current = STEPS[3]
        verify_health(outputs)
        report(6, "health_verified")
        print("OpenWork is ready. Bootstrap credentials remain in AWS Secrets Manager.")
    except Exception:
        sequence, step, code = current
        report(sequence, step, "failed", code)
        raise


if __name__ == "__main__":
    main()
