"""Install or update the verified OpenWork release in the customer's AWS account.

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

# No third-party Python packages: AWS calls go through the AWS CLI that ships
# in AWS's CodeBuild image, so nothing is fetched from a package index while
# this process holds the installer's credentials.


def aws(*args):
    output = subprocess.run(["aws", *args, "--region", os.environ["AWS_REGION"], "--output", "json"],
                            check=True, capture_output=True, text=True).stdout
    return json.loads(output) if output.strip() else {}

TERRAFORM_VERSION = "1.16.5"
TERRAFORM_LINUX_SHA256 = "2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4"
STEPS = [(3, "account_verified", "runner_failed"), (4, "infrastructure_applied", "infrastructure_failed"),
         (5, "services_ready", "service_unhealthy"), (6, "health_verified", "health_check_failed")]
# Data-bearing resources are never destroyed or replaced by an automated run.
# Replacing stateless resources (task definitions, functions) is a normal update.
PROTECTED_TYPES = {
    "aws_db_instance", "aws_db_subnet_group", "aws_secretsmanager_secret", "aws_secretsmanager_secret_version",
    "aws_elasticache_replication_group", "aws_efs_file_system", "aws_s3_bucket", "aws_kms_key", "aws_vpc",
    "random_password",
}


def report(sequence, step, outcome="succeeded", error_code=None):
    payload = {"sequence": sequence, "step": step, "outcome": outcome}
    if error_code:
        payload["errorCode"] = error_code
    token = Path(os.environ["RUNNER_TOKEN_FILE"]).read_text()
    url = os.environ["CONTROL_PLANE_ORIGIN"].rstrip("/") + f'/v1/managed-deployments/{os.environ["DEPLOYMENT_ID"]}/runs/{os.environ["RUN_ID"]}/events'
    # Exact repeats are idempotent. Never advance a sequence without a receipt.
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
    url = f"https://releases.hashicorp.com/terraform/{TERRAFORM_VERSION}/terraform_{TERRAFORM_VERSION}_linux_amd64.zip"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(150 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != TERRAFORM_LINUX_SHA256:
        raise ValueError("Terraform checksum mismatch")
    archive = root / "terraform.zip"
    archive.write_bytes(data)
    with zipfile.ZipFile(archive) as zipped:
        binary = root / "terraform-bin"
        binary.write_bytes(zipped.read("terraform"))
    binary.chmod(0o700)
    return str(binary)


def terraform_inputs():
    return {
        "deployment_id": os.environ["DEPLOYMENT_ID"], "domain_name": os.environ["DOMAIN_NAME"],
        "owner_email": os.environ["OWNER_EMAIL"], "openwork_version": os.environ["OPENWORK_VERSION"],
        "control_plane_origin": os.environ["CONTROL_PLANE_ORIGIN"], "size": os.environ.get("SIZE", "small"),
        "region": os.environ["AWS_REGION"], "account_id": os.environ["EXPECTED_ACCOUNT_ID"],
        "route53_zone_id": os.environ["ROUTE53_ZONE_ID"],
    }


def verify_account():
    if aws("sts", "get-caller-identity")["Account"] != os.environ["EXPECTED_ACCOUNT_ID"]:
        raise ValueError("wrong AWS account")
    zone = aws("route53", "get-hosted-zone", "--id", os.environ["ROUTE53_ZONE_ID"])["HostedZone"]
    zone_name = zone["Name"].rstrip(".")
    domain = os.environ["DOMAIN_NAME"]
    if zone.get("Config", {}).get("PrivateZone") or not (domain == zone_name or domain.endswith("." + zone_name)):
        raise ValueError("domain must belong to a public hosted zone")


class StepFailure(Exception):
    """A failure with a specific, allowlisted code for the control plane."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ACM never recovers a certificate that failed validation (for example a CAA
# record that does not allow amazon.com). After the customer fixes DNS, a retry
# must request a new certificate instead of waiting on the dead one.
UNRECOVERABLE_CERTIFICATE_STATES = {"FAILED", "VALIDATION_TIMED_OUT", "REVOKED", "EXPIRED"}


def certificate_states(binary, tf_root):
    """Map each managed ACM certificate address to its live status."""
    try:
        state = json.loads(subprocess.check_output([binary, "show", "-json"], cwd=tf_root))
    except subprocess.CalledProcessError:
        return {}
    found = {}
    def walk(module):
        for resource in module.get("resources", []):
            if resource.get("type") == "aws_acm_certificate" and resource.get("mode") == "managed":
                arn = resource.get("values", {}).get("arn")
                if arn:
                    found[resource["address"]] = aws("acm", "describe-certificate", "--certificate-arn", arn)["Certificate"]["Status"]
        for child in module.get("child_modules", []):
            walk(child)
    walk(state.get("values", {}).get("root_module", {}))
    return found


def unsafe_changes(plan):
    """Return planned deletions/replacements of data-bearing resources."""
    unsafe = []
    for change in plan.get("resource_changes", []):
        if change.get("type") in PROTECTED_TYPES and "delete" in change.get("change", {}).get("actions", []):
            unsafe.append(change["address"])
    return unsafe


def apply(root, tf_root):
    binary = terraform_binary(root)
    state_key = "deployments/" + os.environ["DEPLOYMENT_ID"] + "/terraform.tfstate"
    inputs = tf_root / "managed.auto.tfvars.json"
    inputs.write_text(json.dumps(terraform_inputs()))
    inputs.chmod(0o600)
    subprocess.run([binary, "init", "-input=false", "-lockfile=readonly",
                    "-backend-config=bucket=" + os.environ["STATE_BUCKET"],
                    "-backend-config=key=" + state_key, "-backend-config=encrypt=true",
                    "-backend-config=use_lockfile=true",
                    "-backend-config=region=" + os.environ["AWS_REGION"]], cwd=tf_root, check=True)
    plan = tf_root / "approved.tfplan"
    replace = [f"-replace={address}" for address, status in certificate_states(binary, tf_root).items() if status in UNRECOVERABLE_CERTIFICATE_STATES]
    if replace:
        print("Requesting new certificates for: " + ", ".join(item.split("=", 1)[1] for item in replace))
    subprocess.run([binary, "plan", "-input=false", "-lock-timeout=120s", *replace, "-out=" + str(plan)], cwd=tf_root, check=True)
    planned = json.loads(subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root))
    unsafe = unsafe_changes(planned)
    if unsafe:
        print("Refusing to delete or replace data-bearing resources: " + ", ".join(unsafe))
        raise ValueError("data-bearing resource replacement requires manual review")
    try:
        subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, check=True)
    except subprocess.CalledProcessError:
        if any(status in UNRECOVERABLE_CERTIFICATE_STATES for status in certificate_states(binary, tf_root).values()):
            raise StepFailure("certificate_failed")
        raise
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root)
    return {key: value["value"] for key, value in json.loads(raw).items()}


def verify_services(outputs):
    services = list(outputs["service_names"].values())
    for _ in range(2):  # each CLI wait polls for up to 10 minutes
        try:
            aws("ecs", "wait", "services-stable", "--cluster", outputs["cluster_name"], "--services", *services)
            break
        except subprocess.CalledProcessError:
            continue
    status = aws("ecs", "describe-services", "--cluster", outputs["cluster_name"], "--services", *services)
    if status.get("failures") or len(status["services"]) != len(services):
        raise ValueError("services unavailable")
    for service in status["services"]:
        if service["runningCount"] < service["desiredCount"] or service["desiredCount"] < 1:
            raise ValueError("services not running")


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def verify_health(outputs, attempts=20, delay=15):
    expected_web = "https://" + os.environ["DOMAIN_NAME"]
    expected_api = "https://api." + os.environ["DOMAIN_NAME"]
    if outputs["web_url"] != expected_web or outputs["api_url"] != expected_api:
        raise ValueError("unexpected service origin")
    # New DNS records and certificates can take a few minutes to become visible.
    for attempt in range(attempts):
        try:
            health = fetch_json(expected_api + "/health")
            ready = fetch_json(expected_api + "/ready")
            with urllib.request.urlopen(expected_web + "/setup", timeout=30) as response:
                web_ok = response.status == 200
            if health.get("ok") is True and health.get("service") == "den-api" and ready.get("ok") is True and web_ok:
                return
        except Exception:
            pass
        if attempt < attempts - 1:
            time.sleep(delay)
    raise ValueError("HTTPS health not verified")


def first_report(outputs):
    """Send the first status report immediately instead of waiting for the schedule."""
    try:
        aws("lambda", "invoke", "--function-name", outputs["health_agent"], "--invocation-type", "Event", "/dev/null")
    except Exception:
        print("The health agent will report on its schedule.")


def main():
    root = Path.cwd()
    tf_root = root / "infra/managed-deployments/aws/terraform"
    current = STEPS[0]
    try:
        verify_account()
        report(3, "account_verified")
        current = STEPS[1]
        outputs = apply(root, tf_root)
        report(4, "infrastructure_applied")
        current = STEPS[2]
        verify_services(outputs)
        report(5, "services_ready")
        current = STEPS[3]
        verify_health(outputs)
        report(6, "health_verified")
        first_report(outputs)
        print("OpenWork is ready. The setup code is in the deployment's AWS Secrets Manager secret.")
    except Exception as error:
        sequence, step, code = current
        report(sequence, step, "failed", error.code if isinstance(error, StepFailure) else code)
        raise


if __name__ == "__main__":
    main()
