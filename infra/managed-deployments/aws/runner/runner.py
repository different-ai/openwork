"""Install or update the verified OpenWork release in the customer's AWS account.

No Den database, deployment secrets or credentials are imported. Its only
control-plane dependency is the versioned identity/event HTTP protocol.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
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
        **network_inputs(),
    }


def id_list(name):
    return [item for item in os.environ.get(name, "").split(",") if item]


def network_inputs():
    if os.environ.get("NETWORK_MODE", "dedicated") != "existing":
        return {"network_mode": "dedicated"}
    return {
        "network_mode": "existing", "vpc_id": os.environ["VPC_ID"],
        "service_subnet_ids": id_list("SERVICE_SUBNET_IDS"),
        "load_balancer_subnet_ids": id_list("LOAD_BALANCER_SUBNET_IDS"),
        "ecs_cluster_arn": os.environ.get("ECS_CLUSTER_ARN", ""),
    }


class StepFailure(Exception):
    """A failure with a specific, allowlisted code for the control plane."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def default_route(table):
    for route in table.get("Routes", []):
        if route.get("DestinationCidrBlock") == "0.0.0.0/0" and route.get("State") == "active":
            return route
    return None


def network_problems(vpc, dns, subnets, route_tables, cluster, inputs):
    """Explain why an existing network cannot host OpenWork; empty when it can."""
    problems = []
    if not vpc or vpc.get("State") != "available":
        return ["the VPC was not found in this account and region"]
    if not (dns.get("support") and dns.get("hostnames")):
        problems.append("the VPC needs DNS resolution and DNS hostnames turned on")
    by_id = {subnet["SubnetId"]: subnet for subnet in subnets}
    main = next((table for table in route_tables if any(a.get("Main") for a in table.get("Associations", []))), None)
    def table_for(subnet_id):
        for table in route_tables:
            if any(a.get("SubnetId") == subnet_id for a in table.get("Associations", [])):
                return table
        return main
    for role, ids in (("service", inputs["service_subnet_ids"]), ("load balancer", inputs["load_balancer_subnet_ids"])):
        found = [by_id[i] for i in ids if i in by_id and by_id[i].get("VpcId") == vpc["VpcId"]]
        if len(found) != len(ids):
            problems.append(f"every {role} subnet must exist in the VPC")
            continue
        if len({subnet["AvailabilityZone"] for subnet in found}) < 2:
            problems.append(f"the {role} subnets must span at least two availability zones")
        for subnet in found:
            route = default_route(table_for(subnet["SubnetId"]) or {})
            through_internet_gateway = bool(route and str(route.get("GatewayId", "")).startswith("igw-"))
            if role == "load balancer" and not through_internet_gateway:
                problems.append(f"load balancer subnet {subnet['SubnetId']} is not public (no route to an internet gateway)")
            if role == "service" and (not route or through_internet_gateway):
                problems.append(f"service subnet {subnet['SubnetId']} needs outbound internet through a NAT gateway or similar")
    if inputs.get("ecs_cluster_arn") and (not cluster or cluster.get("status") != "ACTIVE"):
        problems.append("the ECS cluster was not found or is not active")
    return problems


def verify_network():
    inputs = network_inputs()
    if inputs["network_mode"] != "existing":
        return
    vpc_id = inputs["vpc_id"]
    vpcs = aws("ec2", "describe-vpcs", "--filters", f"Name=vpc-id,Values={vpc_id}").get("Vpcs", [])
    dns = {
        "support": aws("ec2", "describe-vpc-attribute", "--vpc-id", vpc_id, "--attribute", "enableDnsSupport")["EnableDnsSupport"]["Value"],
        "hostnames": aws("ec2", "describe-vpc-attribute", "--vpc-id", vpc_id, "--attribute", "enableDnsHostnames")["EnableDnsHostnames"]["Value"],
    } if vpcs else {}
    subnet_ids = inputs["service_subnet_ids"] + inputs["load_balancer_subnet_ids"]
    subnets = aws("ec2", "describe-subnets", "--filters", "Name=subnet-id,Values=" + ",".join(subnet_ids)).get("Subnets", [])
    tables = aws("ec2", "describe-route-tables", "--filters", f"Name=vpc-id,Values={vpc_id}").get("RouteTables", [])
    cluster = None
    if inputs["ecs_cluster_arn"]:
        clusters = aws("ecs", "describe-clusters", "--clusters", inputs["ecs_cluster_arn"]).get("clusters", [])
        cluster = clusters[0] if clusters else None
    problems = network_problems(vpcs[0] if vpcs else None, dns, subnets, tables, cluster, inputs)
    if problems:
        print("The existing network cannot host OpenWork: " + "; ".join(problems) + ".")
        raise StepFailure("network_check_failed")


def verify_account():
    if aws("sts", "get-caller-identity")["Account"] != os.environ["EXPECTED_ACCOUNT_ID"]:
        raise ValueError("wrong AWS account")
    zone = aws("route53", "get-hosted-zone", "--id", os.environ["ROUTE53_ZONE_ID"])["HostedZone"]
    zone_name = zone["Name"].rstrip(".")
    domain = os.environ["DOMAIN_NAME"]
    if zone.get("Config", {}).get("PrivateZone") or not (domain == zone_name or domain.endswith("." + zone_name)):
        raise ValueError("domain must belong to a public hosted zone")




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


def tls_only_secret_upgrade(resource):
    """Allow only the known app-secret version's accept-to-strict promotion.

    Compare plan values only in memory. Never print secret JSON or URLs.
    Unknown values, key rotation, other labels and other resources fail closed.
    """
    change = resource.get("change", {})
    if (resource.get("address") != "module.platform.aws_secretsmanager_secret_version.app"
            or resource.get("type") != "aws_secretsmanager_secret_version"
            or change.get("actions") != ["delete", "create"]):
        return False
    return tls_secret_values_preserved(change)


def tls_secret_values_preserved(change):
    """Compare known existing/current values with a TLS-only target version."""
    before, after = change.get("before"), change.get("after")
    unknown = change.get("after_unknown", {})
    if not isinstance(before, dict) or not isinstance(after, dict) or not isinstance(unknown, dict):
        return False
    if (unknown.get("secret_id", False) is not False or unknown.get("secret_string", False) is not False
            or unknown.get("secret_binary", False) is not False
            or not isinstance(before.get("secret_id"), str) or not before["secret_id"]
            or before["secret_id"] != after.get("secret_id")
            or before.get("version_stages") != ["AWSCURRENT"]
            or after.get("version_stages") not in (None, ["AWSCURRENT"])
            or before.get("secret_binary") not in (None, "") or after.get("secret_binary") not in (None, "")
            or before.get("has_secret_string_wo") or after.get("has_secret_string_wo")):
        return False
    try:
        old, new = json.loads(before["secret_string"]), json.loads(after["secret_string"])
    except (KeyError, TypeError, ValueError):
        return False
    required = {"DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"}
    if not isinstance(old, dict) or not isinstance(new, dict) or not required <= old.keys():
        return False
    url = old["DATABASE_URL"]
    if not isinstance(url, str) or not url.startswith("mysql://") or not url.endswith("?sslaccept=accept"):
        return False
    expected = {**old, "DATABASE_URL": url.removesuffix("sslaccept=accept") + "sslaccept=strict"}
    return new == expected


def unsafe_changes(plan):
    """Return data-bearing deletions/replacements, except the exact TLS upgrade."""
    unsafe = []
    changes = plan.get("resource_changes", [])
    for change in changes:
        if (change.get("address") in ("module.platform.aws_secretsmanager_secret_version.tls", "module.platform.aws_secretsmanager_secret_version.tls[0]")
                and change.get("change", {}).get("actions") == ["create"]):
            seed = next((item.get("change", {}) for item in changes
                         if item.get("address") == "module.platform.aws_secretsmanager_secret_version.app"), None)
            parent = next((item.get("change", {}) for item in changes
                           if item.get("address") == "module.platform.aws_secretsmanager_secret.app"), None)
            fresh = (seed is not None and seed.get("before") is None and seed.get("actions") == ["create"]
                     and parent is not None and parent.get("before") is None and parent.get("actions") == ["create"])
            target = change["change"]
            if not fresh and (seed is None or not tls_secret_values_preserved({
                    "before": seed.get("before"), "after": target.get("after"),
                    "after_unknown": target.get("after_unknown", {})})):
                unsafe.append(change["address"])
        if change.get("type") in PROTECTED_TYPES and "delete" in change.get("change", {}).get("actions", []):
            if not tls_only_secret_upgrade(change):
                unsafe.append(change["address"])
    return unsafe


def legacy_fence(plan):
    """Drain installed migration-capable services before Terraform can migrate.

    Inspect live definitions as well as state: a failed adoption may already have
    forgotten the old definition while the service still uses it. No credentials
    are rotated and no unrelated service/task in a shared cluster is mutated.
    A failed fence leaves maintenance in place; never resurrect a legacy writer.
    """
    def resources(module):
        yield from module.get("resources", [])
        for child in module.get("child_modules", []):
            yield from resources(child)

    old = list(resources(plan.get("prior_state", {}).get("values", {}).get("root_module", {})))
    owned = [r for r in old if r.get("address") in (
        "module.platform.aws_ecs_service.api", "module.platform.aws_ecs_service.web")]
    if not owned:
        return False
    if len(owned) != 2:
        raise ValueError("incomplete installed service state; maintenance requires inspection")
    cluster = owned[0]["values"]["cluster"]
    names = {r["values"]["name"] for r in owned}
    if len(names) != 2 or any(r["values"]["cluster"] != cluster for r in owned):
        raise ValueError("invalid installed service ownership")
    status = aws("ecs", "describe-services", "--cluster", cluster, "--services", *sorted(names))
    services = status.get("services", [])
    if status.get("failures") or {s.get("serviceName") for s in services} != names:
        raise ValueError("installed services unavailable")
    legacy = False
    families = set()
    for service in services:
        # Inspect every rollback/deployment target, not just the current primary.
        definitions = {service["taskDefinition"]} | {d["taskDefinition"] for d in service.get("deployments", [])}
        for arn in definitions:
            definition = aws("ecs", "describe-task-definition", "--task-definition", arn)["taskDefinition"]
            families.add(definition["family"])
            for container in definition["containerDefinitions"]:
                legacy |= container.get("name") == "migrate" or "bootstrap.js" in json.dumps(container.get("command", []))
    if not legacy:
        return False
    for name in sorted(names):
        aws("ecs", "update-service", "--cluster", cluster, "--service", name,
            "--desired-count", "0", "--deployment-configuration",
            json.dumps({"deploymentCircuitBreaker": {"enable": True, "rollback": False}}))
    aws("ecs", "wait", "services-stable", "--cluster", cluster, "--services", *sorted(names))
    deadline = time.monotonic() + 600
    while True:
        status = aws("ecs", "describe-services", "--cluster", cluster, "--services", *sorted(names))
        current = status.get("services", [])
        if status.get("failures") or {s.get("serviceName") for s in current} != names:
            raise ValueError("maintenance services unavailable")
        if any(s.get("desiredCount") != 0 for s in current):
            raise ValueError("legacy service resumed during maintenance")
        pending = any(s.get("runningCount") != 0 or s.get("pendingCount") != 0 for s in current)
        for family in sorted(families):
            # STOPPED desired status includes tasks still draining. RUNNING also
            # includes pending tasks; inspect actual terminal status for both.
            tasks = set()
            for desired in ("RUNNING", "STOPPED"):
                tasks.update(aws("ecs", "list-tasks", "--cluster", cluster, "--family", family,
                                 "--desired-status", desired).get("taskArns", []))
            ordered = sorted(tasks)
            for offset in range(0, len(ordered), 100):
                result = aws("ecs", "describe-tasks", "--cluster", cluster, "--tasks", *ordered[offset:offset + 100])
                if result.get("failures") or len(result.get("tasks", [])) != len(ordered[offset:offset + 100]):
                    raise ValueError("legacy task terminal state unknown")
                pending |= any(t.get("lastStatus") != "STOPPED" for t in result["tasks"])
        if not pending:
            return True
        if time.monotonic() >= deadline:
            raise ValueError("legacy tasks did not stop; migration is fenced")
        time.sleep(3)


def apply(root, tf_root):
    binary = terraform_binary(root)
    state_key = "deployments/" + os.environ["DEPLOYMENT_ID"] + "/terraform.tfstate"
    inputs = tf_root / "managed.auto.tfvars.json"
    values = terraform_inputs()
    release = root / "release.json"
    if release.exists():
        images = json.loads(release.read_text()).get("images", {})
        if images:
            if set(images) != {"den_api", "den_web"}:
                raise ValueError("invalid AWS release image inventory")
            values.update(den_api_image=images["den_api"], den_web_image=images["den_web"])
    inputs.write_text(json.dumps(values))
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
    if legacy_fence(planned):
        # Scaling is deliberately outside Terraform's graph, before its native
        # migration gate. Refresh/replan so desired counts are restored only by
        # the API-only rollout after migration, not left at maintenance zero.
        subprocess.run([binary, "plan", "-input=false", "-lock-timeout=120s", *replace, "-out=" + str(plan)], cwd=tf_root, check=True)
        planned = json.loads(subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root))
        if unsafe_changes(planned):
            raise ValueError("post-fence plan requires manual review; maintenance retained")
    try:
        subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, check=True)
    except subprocess.CalledProcessError:
        if any(status in UNRECOVERABLE_CERTIFICATE_STATES for status in certificate_states(binary, tf_root).values()):
            raise StepFailure("certificate_failed")
        raise
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root)
    outputs = {key: value["value"] for key, value in json.loads(raw).items()}
    expected = {name: outputs["task_definition_arns"][key] for key, name in outputs["service_names"].items()}
    tls_redeploy(cluster=outputs["cluster_name"], expected=expected)
    return outputs


def tls_redeploy(force=True, cluster=None, expected=None):
    """Complete the strict phase after Terraform has settled both CA services.

    Only existing ECS UpdateService/Describe permissions are used. Never
    deregister a revision, roll back a secret, or hide a failed waiter.
    """
    if cluster is None:
        cluster = os.environ["TLS_CLUSTER"]
    if expected is None:
        expected = json.loads(os.environ["TLS_TASK_DEFINITIONS"])
    if (not isinstance(expected, dict) or len(expected) != 2
            or not all(isinstance(name, str) and name and isinstance(arn, str)
                       and arn.startswith("arn:") and ":task-definition/" in arn
                       for name, arn in expected.items())):
        raise ValueError("invalid managed TLS deployment targets")
    names = list(expected)

    class DeploymentPending(ValueError):
        pass

    def require_completed():
        status = aws("ecs", "describe-services", "--cluster", cluster, "--services", *names)
        services = status.get("services", [])
        if status.get("failures") or len(services) != 2 or {s.get("serviceName") for s in services} != set(names):
            raise ValueError("managed TLS services unavailable")
        for service in services:
            deployments = service.get("deployments", [])
            primary = [d for d in deployments if d.get("status") == "PRIMARY"]
            if (service.get("taskDefinition") != expected[service["serviceName"]]
                    or len(primary) != 1
                    or primary[0].get("taskDefinition") != expected[service["serviceName"]]
                    or primary[0].get("rolloutState") == "FAILED"):
                raise ValueError("managed TLS deployment left its expected CA revision")
            if (service.get("desiredCount", 0) < 1
                    or service.get("runningCount") != service["desiredCount"]
                    or service.get("pendingCount") != 0
                    or len(deployments) != 1
                    or primary[0].get("rolloutState") != "COMPLETED"):
                raise DeploymentPending("managed TLS deployment is not complete")

    def wait_completed():
        deadline = time.monotonic() + 120
        while True:
            try:
                require_completed()
                return
            except DeploymentPending:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(3)

    if force:
        # Provider steady-state can precede ECS's COMPLETED rollout marker.
        # Wait before forcing too; wrong revisions/FAILED still fail immediately.
        wait_completed()
        for name in names:
            aws("ecs", "update-service", "--cluster", cluster, "--service", name, "--force-new-deployment")
    # Failed waiters propagate. Also require the completed rollout state, not
    # merely runningCount==desiredCount while an old rollback target survives.
    aws("ecs", "wait", "services-stable", "--cluster", cluster, "--services", *names)
    wait_completed()


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
        verify_network()
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
    if sys.argv[1:] == ["tls-redeploy"]:
        tls_redeploy()
    elif sys.argv[1:] == ["tls-ready"]:
        tls_redeploy(force=False)
    else:
        main()
