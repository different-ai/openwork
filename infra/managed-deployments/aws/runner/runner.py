"""Install or update the verified OpenWork release in the customer's AWS account.

No Den database, deployment secrets or credentials are imported. Its only
control-plane dependency is the versioned identity/event HTTP protocol.
"""
import hashlib
import json
import os
from pathlib import Path
import re
from string import Template
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
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
    "random_password", "aws_backup_vault", "aws_backup_plan", "aws_backup_selection",
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
        "managed_runtime_profile": managed_runtime_profile(),
        **network_inputs(),
        **assistant_inputs(),
    }


def boolean_input(name):
    value = os.environ.get(name, "false")
    if value not in ("true", "false"):
        raise ValueError("invalid installer boolean: " + name)
    return value == "true"


def customer_secret_arn(name, required=False):
    """Accept a reference only. Neither Terraform nor this process reads its value."""
    value = os.environ.get(name, "")
    prefix = f'arn:aws:secretsmanager:{os.environ["AWS_REGION"]}:{os.environ["EXPECTED_ACCOUNT_ID"]}:secret:'
    if (required and not value) or (value and (
            not value.startswith(prefix) or not re.fullmatch(r"[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}", value[len(prefix):]))):
        raise ValueError("a same-account, same-region Secrets Manager ARN is required: " + name)
    return value


def managed_runtime_profile():
    profile = os.environ.get("MANAGED_RUNTIME_PROFILE", "legacy")
    if profile not in ("legacy", "gateway"):
        raise ValueError("unsupported managed runtime profile")
    return profile


def assistant_inputs():
    gateway = managed_runtime_profile() == "gateway"
    enabled = gateway or boolean_input("HEADLESS_RUNNER_ENABLED")
    workbot = gateway or boolean_input("WORKBOT_ENABLED")
    slack = gateway or boolean_input("SLACK_ASSISTANT_ENABLED")
    provider = os.environ.get("HEADLESS_COMPUTER_PROVIDER", "off")
    if provider not in ("off", "daytona", "freestyle"):
        raise ValueError("unsupported managed computer provider")
    if not enabled:
        if workbot or slack or provider != "off":
            raise ValueError("Workbot, Slack and computers require the managed runner")
        return {}
    computer_secret = customer_secret_arn("HEADLESS_COMPUTER_SECRET_ARN", required=provider != "off") if provider != "off" or not gateway else ""
    values = {
        "headless_runner": {"enabled": True},
        "workbot": {"enabled": workbot},
        "slack_assistant_enabled": slack,
        "headless_computer": {"provider": provider},
        "headless_computer_secret_arn": computer_secret,
    }
    if gateway:
        # Providers and member model access are configured in the customer's Den.
        # Legacy upstream fields never cross into Gateway-profile Terraform inputs.
        values["managed_runtime_profile"] = "gateway"
    else:
        protocol = os.environ.get("HEADLESS_MODEL_PROTOCOL", "anthropic")
        if protocol not in ("anthropic", "openai", "openai-responses"):
            raise ValueError("unsupported direct model protocol")
        base_url = os.environ.get("HEADLESS_MODEL_BASE_URL", "")
        parsed = urlsplit(base_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment):
            raise ValueError("the direct model endpoint must be an HTTPS URL without credentials or a query")
        model = os.environ.get("HEADLESS_MODEL", "")
        if not model or len(model) > 200 or any(ord(c) < 32 for c in model):
            raise ValueError("a direct model id is required")
        values["headless_runner"].update({"model_protocol": protocol, "model_base_url": base_url, "model": model})
        values["headless_model_secret_arn"] = customer_secret_arn("HEADLESS_MODEL_SECRET_ARN", required=True)
    if provider == "daytona":
        snapshot = os.environ.get("HEADLESS_COMPUTER_SNAPSHOT", "")
        if not snapshot or len(snapshot) > 512 or any(ord(c) < 32 for c in snapshot):
            raise ValueError("Daytona computers require a snapshot")
        api_url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")
        parsed_api = urlsplit(api_url)
        if (parsed_api.scheme != "https" or not parsed_api.hostname or parsed_api.username is not None
                or parsed_api.password is not None or parsed_api.query or parsed_api.fragment):
            raise ValueError("the Daytona API endpoint must use HTTPS without credentials or a query")
        target = os.environ.get("DAYTONA_TARGET", "us")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", target):
            raise ValueError("invalid Daytona target")
        values["headless_computer"]["snapshot"] = snapshot
        values["daytona"] = {"api_url": api_url, "target": target}
    return values


AWS_IMAGE_REPOSITORIES = {
    "den_api": "ghcr.io/different-ai/openwork-den-api",
    "den_web": "ghcr.io/different-ai/openwork-den-web",
    "headless_runner": "ghcr.io/different-ai/openwork-headless-runner",
    "workbot": "ghcr.io/different-ai/openwork-workbot",
    "ai_gateway": "ghcr.io/different-ai/openwork-inference",
}


def release_images(release, assistants_enabled=False, runtime_profile="legacy"):
    """Retain legacy inventories; Gateway requires the complete five pinned images."""
    if isinstance(assistants_enabled, str):
        runtime_profile = assistants_enabled
        assistants_enabled = runtime_profile == "gateway"
    if runtime_profile not in ("legacy", "gateway") or not isinstance(assistants_enabled, bool):
        raise ValueError("invalid AWS release runtime profile")
    images = release.get("images", {})
    core = {"den_api", "den_web"}
    legacy_assistants = core | {"headless_runner", "workbot"}
    complete = set(AWS_IMAGE_REPOSITORIES)
    if not isinstance(images, dict) or (images and set(images) not in (core, legacy_assistants, complete)):
        raise ValueError("invalid AWS release image inventory")
    if runtime_profile == "gateway" and set(images) != complete:
        raise ValueError("the Gateway runtime profile requires all five pinned images")
    if assistants_enabled and set(images) not in (legacy_assistants, complete):
        raise ValueError("this release does not pin the runner and Workbot images")
    for kind, image in images.items():
        if not isinstance(image, str) or not re.fullmatch(re.escape(AWS_IMAGE_REPOSITORIES[kind]) + r"@sha256:[a-f0-9]{64}", image):
            raise ValueError("invalid AWS release image pin: " + kind)
    return {kind + "_image": image for kind, image in images.items()}


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


# ---- Customer-owned objects next to the Terraform state ----
# deployments/<id>/overrides.json  optional tuning, validated against an allowlist
# deployments/<id>/ejected.json    the owner took the deployment over; refuse to run
# deployments/<id>/applied/        what the last successful apply used (no secrets)
STATE_OBJECT_LIMIT = 16 * 1024
# Memory (MiB) AWS Fargate offers for each task CPU value.
FARGATE_MEMORY = {256: (512, 1024, 2048), 512: tuple(range(1024, 4097, 1024)), 1024: tuple(range(2048, 8193, 1024)),
                  2048: tuple(range(4096, 16385, 1024)), 4096: tuple(range(8192, 30721, 1024))}
# What each size profile gives before tuning (aws/terraform/main.tf). Tuning never goes below it.
SIZE_BASELINE = {"small": {"api": {"cpu": 1024, "memory": 2048, "instances": 1}, "web": {"cpu": 512, "memory": 1024, "instances": 1},
                           "database": {"disk_size_gb": 20}}}
MAX_INSTANCES = 10
MAX_DISK_SIZE_GB = 4096
DATABASE_TIER = re.compile(r"db\.(t4g\.(micro|small|medium|large|xlarge|2xlarge)|(m6g|m7g|r6g|r7g)\.(large|xlarge|2xlarge|4xlarge))")
OTEL_NAME = re.compile(r"OTEL_[A-Z0-9_]{1,120}")
CREDENTIAL_NAME = re.compile(r"(?i)(secret|password|passwd|token|api_key|private_key|encryption_key|credential|authorization|headers)")
URL_CREDENTIAL = re.compile(r"://[^/@\s]*@")
LOG_RETENTION_DAYS = (7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653)


def deployment_key(name):
    return "deployments/" + os.environ["DEPLOYMENT_ID"] + "/" + name


def state_object(name):
    """Describe a customer-owned object beside the state, or None when it is absent.

    Absence comes from a listing, never from a failed read: a denied or broken
    request stops the run instead of being read as "not there".
    """
    key = deployment_key(name)
    try:
        listed = aws("s3api", "list-objects-v2", "--bucket", os.environ["STATE_BUCKET"], "--prefix", key, "--max-keys", "1", "--no-paginate")
    except subprocess.CalledProcessError:
        print(f"Could not look for {name} in the deployment's state bucket; nothing was changed.")
        raise StepFailure("infrastructure_failed") from None
    return next((item for item in listed.get("Contents") or [] if item.get("Key") == key), None)


def refuse_if_ejected():
    if state_object("ejected.json") is None:
        return
    print(f'This deployment was taken over by its owner: s3://{os.environ["STATE_BUCKET"]}/{deployment_key("ejected.json")} exists. '
          "The installer changes nothing while that marker is present. Keep managing the deployment with your own Terraform, "
          "or delete the marker to hand it back to the installer.")
    raise StepFailure("infrastructure_failed")


def whole_number(value):
    return isinstance(value, int) and not isinstance(value, bool)


def override_problems(document, size="small"):
    """Check overrides.json against the allowlist. Returns (overrides, problems).

    Problems name settings, never values: a mistyped credential must not reach the logs.
    """
    problems, overrides = [], {}
    baseline = SIZE_BASELINE[size]
    if not isinstance(document, dict):
        return {}, ["the file must be a JSON object"]

    def section(name, allowed):
        value = document.get(name)
        if name not in document:
            return None
        if not isinstance(value, dict):
            problems.append(f"{name} must be an object")
            return None
        for key in sorted(set(value) - set(allowed), key=str):
            problems.append(f"{name}.{str(key)[:64]} cannot be tuned")
        return value

    for key in sorted(set(document) - {"api", "web", "database", "extra_environment", "log_retention_days"}, key=str):
        problems.append(f"{str(key)[:64]} cannot be tuned")

    for service in ("api", "web"):
        given = section(service, ("cpu", "memory", "min_instances", "max_instances"))
        if given is None:
            continue
        tuned = {}
        for field in ("cpu", "memory", "min_instances", "max_instances"):
            if field in given:
                if whole_number(given[field]):
                    tuned[field] = given[field]
                else:
                    problems.append(f"{service}.{field} must be a whole number")
        cpu, memory = tuned.get("cpu", baseline[service]["cpu"]), tuned.get("memory", baseline[service]["memory"])
        sized = [field for field in ("cpu", "memory") if field in given]
        if sized and all(field in tuned for field in sized):
            if memory not in FARGATE_MEMORY.get(cpu, ()):
                problems.append(f"{service}.cpu and {service}.memory must be a Fargate size together "
                                f"(cpu {cpu} allows memory {', '.join(map(str, FARGATE_MEMORY.get(cpu, ()))) or 'nothing; use 256, 512, 1024, 2048 or 4096'})")
            elif cpu < baseline[service]["cpu"] or memory < baseline[service]["memory"]:
                problems.append(f"{service}.cpu and {service}.memory cannot be below the {size} size "
                                f"(cpu {baseline[service]['cpu']}, memory {baseline[service]['memory']})")
        if "min_instances" in tuned and not 1 <= tuned["min_instances"] <= MAX_INSTANCES:
            problems.append(f"{service}.min_instances must be from 1 to {MAX_INSTANCES}")
        if "max_instances" in tuned and tuned["max_instances"] != tuned.get("min_instances", baseline[service]["instances"]):
            problems.append(f"{service}.max_instances must equal {service}.min_instances: AWS runs a fixed number of tasks")
        if tuned:
            overrides[service] = tuned

    given = section("database", ("tier", "disk_size_gb", "high_availability"))
    if given is not None:
        tuned = {}
        if "tier" in given:
            if isinstance(given["tier"], str) and DATABASE_TIER.fullmatch(given["tier"]):
                tuned["tier"] = given["tier"]
            else:
                problems.append("database.tier must be a db.t4g, db.m6g, db.m7g, db.r6g or db.r7g instance class")
        if "disk_size_gb" in given:
            if whole_number(given["disk_size_gb"]) and baseline["database"]["disk_size_gb"] <= given["disk_size_gb"] <= MAX_DISK_SIZE_GB:
                tuned["disk_size_gb"] = given["disk_size_gb"]
            else:
                problems.append(f"database.disk_size_gb must be a whole number from {baseline['database']['disk_size_gb']} to {MAX_DISK_SIZE_GB}")
        if "high_availability" in given:
            if isinstance(given["high_availability"], bool):
                tuned["high_availability"] = given["high_availability"]
            else:
                problems.append("database.high_availability must be true or false")
        if tuned:
            overrides["database"] = tuned

    if "extra_environment" in document:
        given = document["extra_environment"]
        refused = []
        if not isinstance(given, dict) or len(given) > 32:
            refused.append("extra_environment must be an object with at most 32 variables")
        else:
            for name, value in given.items():
                if not OTEL_NAME.fullmatch(str(name)):
                    refused.append(f"extra_environment.{str(name)[:64]} is not allowed: only OTEL_ variables can be added")
                elif CREDENTIAL_NAME.search(name):
                    refused.append(f"extra_environment.{name} is not allowed: it carries a credential, and overrides never hold secrets")
                elif not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                    refused.append(f"extra_environment.{name} must be a single-line string of at most 2048 characters")
                elif URL_CREDENTIAL.search(value):
                    refused.append(f"extra_environment.{name} must not contain a user name or password in a URL")
        problems.extend(refused)
        if given and not refused:
            overrides["extra_environment"] = dict(given)

    if "log_retention_days" in document:
        if whole_number(document["log_retention_days"]) and document["log_retention_days"] in LOG_RETENTION_DAYS:
            overrides["log_retention_days"] = document["log_retention_days"]
        else:
            problems.append("log_retention_days must be one of " + ", ".join(map(str, LOG_RETENTION_DAYS)))
    return overrides, problems


def customer_overrides():
    """Read and validate the optional overrides.json. None when the owner wrote none."""
    entry = state_object("overrides.json")
    if entry is None:
        return None
    problems = []
    overrides = {}
    if not whole_number(entry.get("Size")) or entry["Size"] > STATE_OBJECT_LIMIT:
        problems.append(f"the file must be at most {STATE_OBJECT_LIMIT} bytes")
    else:
        with tempfile.TemporaryDirectory(prefix="openwork-overrides-") as directory:
            target = Path(directory) / "overrides.json"
            try:
                aws("s3api", "get-object", "--bucket", os.environ["STATE_BUCKET"], "--key", deployment_key("overrides.json"), str(target))
                data = target.read_bytes()
            except (subprocess.CalledProcessError, OSError):
                print("Could not read overrides.json from the deployment's state bucket; nothing was changed.")
                raise StepFailure("infrastructure_failed") from None
        def unique(pairs):
            keys = [key for key, _ in pairs]
            if len(keys) != len(set(keys)):
                raise ValueError("duplicate key")
            return dict(pairs)
        def constant(_):
            raise ValueError("not a JSON number")
        try:
            if len(data) > STATE_OBJECT_LIMIT:
                raise ValueError("too large")
            document = json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)
        except (ValueError, RecursionError):
            problems.append("the file must be valid JSON without repeated keys")
        else:
            overrides, problems = override_problems(document, os.environ.get("SIZE", "small"))
    if problems:
        print("overrides.json was refused; nothing was changed. Fix these settings, or delete the file, then run again:")
        for problem in problems:
            print("  - " + problem)
        raise StepFailure("infrastructure_failed")
    print("Tuning from overrides.json: " + (", ".join(sorted(overrides)) or "nothing"))
    return overrides


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
    if managed_runtime_profile() == "gateway" or boolean_input("HEADLESS_RUNNER_ENABLED"):
        service_zones = [subnet.get("AvailabilityZone") for subnet in subnets if subnet.get("SubnetId") in inputs["service_subnet_ids"]]
        if len(set(service_zones)) != len(inputs["service_subnet_ids"]):
            problems.append("the runner needs exactly one private service subnet per availability zone for EFS mount targets")
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


def storage_limit_below_disk(plan):
    """Databases whose storage limit would be moved to or below the disk they already have.

    RDS never shrinks a disk and refuses such a limit during apply. It can only be
    planned by lowering or removing database.disk_size_gb in overrides.json.
    """
    refused = []
    for resource in plan.get("resource_changes", []):
        change = resource.get("change", {})
        before, after = change.get("before") or {}, change.get("after") or {}
        disk, limit = before.get("allocated_storage"), after.get("max_allocated_storage")
        if (resource.get("type") == "aws_db_instance" and whole_number(disk) and whole_number(limit)
                and limit != before.get("max_allocated_storage") and 0 < limit <= disk):
            refused.append(resource["address"])
    return refused


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


def apply(root, tf_root, overrides=None, record=None):
    binary = terraform_binary(root)
    state_key = deployment_key("terraform.tfstate")
    inputs = tf_root / "managed.auto.tfvars.json"
    values = terraform_inputs()
    if overrides is not None:
        # One typed root variable; the Terraform root merges it over the size profile.
        values["overrides"] = overrides
    release = root / "release.json"
    profile = values.get("managed_runtime_profile", "legacy")
    assistants_enabled = profile == "gateway" or values.get("headless_runner", {}).get("enabled", False)
    if release.exists():
        values.update(release_images(json.loads(release.read_text()), assistants_enabled, profile))
    elif assistants_enabled:
        raise ValueError("the managed runner requires a pinned release inventory")
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
    if storage_limit_below_disk(planned):
        print("The database disk cannot shrink. Set database.disk_size_gb in overrides.json to at least the current disk size; nothing was changed.")
        raise StepFailure("infrastructure_failed")
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
    raw = json.loads(subprocess.check_output([binary, "output", "-json"], cwd=tf_root))
    outputs = {key: value["value"] for key, value in raw.items()}
    # TLS adoption concerns only Den API/web, never restart the single SQLite
    # runner a second time after Terraform has already rolled it out.
    expected = {name: outputs["task_definition_arns"][key] for key, name in outputs["service_names"].items()
                if key in ("den_api", "den_web")}
    tls_redeploy(cluster=outputs["cluster_name"], expected=expected)
    if record is not None:
        record(binary, root, tf_root, values, raw)
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
    if managed_runtime_profile() == "gateway" and set(outputs["service_names"]) != set(AWS_IMAGE_REPOSITORIES):
        raise ValueError("the Gateway runtime profile requires all five services")
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
    if {service.get("serviceName") for service in status["services"]} != set(services):
        raise ValueError("unexpected service inventory")
    optional = {name: outputs.get("task_definition_arns", {}).get(key)
                for key, name in outputs["service_names"].items() if key in ("headless_runner", "workbot", "ai_gateway")}
    for service in status["services"]:
        if service["runningCount"] < service["desiredCount"] or service["desiredCount"] < 1:
            raise ValueError("services not running")
        if service["serviceName"] in optional:
            intended = optional[service["serviceName"]]
            deployments = service.get("deployments", [])
            if (not intended or service.get("taskDefinition") != intended
                    or service["runningCount"] != service["desiredCount"]
                    or service.get("pendingCount") != 0 or len(deployments) != 1
                    or deployments[0].get("status") != "PRIMARY"
                    or deployments[0].get("taskDefinition") != intended
                    or deployments[0].get("rolloutState") != "COMPLETED"):
                raise ValueError("assistant service has not completed its intended rollout")


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def verify_health(outputs, attempts=20, delay=15):
    expected_web = "https://" + os.environ["DOMAIN_NAME"]
    expected_api = "https://api." + os.environ["DOMAIN_NAME"]
    if outputs["web_url"] != expected_web or outputs["api_url"] != expected_api:
        raise ValueError("unexpected service origin")
    gateway = managed_runtime_profile() == "gateway"
    workbot_url = outputs.get("workbot_url")
    expected_workbot = "https://chat." + os.environ["DOMAIN_NAME"]
    if (gateway and workbot_url != expected_workbot) or (workbot_url is not None and workbot_url != expected_workbot):
        raise ValueError("unexpected Workbot origin")
    gateway_url = outputs.get("ai_gateway_url")
    expected_gateway = "https://models." + os.environ["DOMAIN_NAME"]
    if (gateway and gateway_url != expected_gateway) or (gateway_url is not None and gateway_url != expected_gateway):
        raise ValueError("unexpected AI Gateway origin")
    # New DNS records and certificates can take a few minutes to become visible.
    for attempt in range(attempts):
        try:
            health = fetch_json(expected_api + "/health")
            ready = fetch_json(expected_api + "/ready")
            with urllib.request.urlopen(expected_web + "/setup", timeout=30) as response:
                web_ok = response.status == 200
            workbot_ok = True
            if workbot_url:
                with urllib.request.urlopen(workbot_url + "/healthz", timeout=30) as response:
                    workbot_ok = response.status == 200
            gateway_ok = True
            if gateway_url:
                gateway_health = fetch_json(gateway_url + "/health")
                gateway_ok = gateway_health.get("ok") is True and gateway_health.get("service") == "gateway"
            if health.get("ok") is True and health.get("service") == "den-api" and ready.get("ok") is True and web_ok and workbot_ok and gateway_ok:
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


# ---- applied/: what a customer needs to run this Terraform themselves ----
RDS_CA_ADDRESS = "module.platform.data.http.rds_ca[0]"
# Logical ids in bootstrap/template.mjs. The stack is not in the Terraform state.
BOOTSTRAP_RESOURCES = (
    ("StateBucket", "AWS::S3::Bucket"), ("StateBucketPolicy", "AWS::S3::BucketPolicy"),
    ("RunnerCoreSupportPolicy", "AWS::IAM::ManagedPolicy"), ("RunnerSupplementalPolicy", "AWS::IAM::ManagedPolicy"),
    ("RunnerRole", "AWS::IAM::Role"), ("Runner", "AWS::CodeBuild::Project"), ("LauncherRole", "AWS::IAM::Role"),
    ("Launcher", "AWS::Lambda::Function"), ("StartRunner", "Custom::OpenWorkLaunch"),
)
TAKEOVER_README = Template('''# OpenWork deployment $deployment_id

Written by the OpenWork installer after its last successful apply (OpenWork
$version, run $run_id) in AWS account $account_id, region $region. This folder
describes that apply. It holds no secrets, no Terraform state and no installer
credentials.

| File | Contents |
| --- | --- |
| `release.json` | The installer release that was applied: version, bundle URL and SHA-256 |
| `inputs.auto.tfvars.json` | Every Terraform input of that apply, your overrides included |
| `backend.tf.json` | Where this deployment's Terraform state lives |
| `terraform-version.json` | The exact Terraform version, with the Linux download checksum |
| `outputs.json` | The non-sensitive Terraform outputs |
| `unmanaged.json` | Resources that exist outside the Terraform state |

## Tune it and stay managed

Write `s3://$bucket/$prefix/overrides.json`. The next installer run you
approve from OpenWork (an update, a retry or a configuration change) applies
it. The installer checks the file before it changes anything and refuses the
run when a setting is not allowed.

```json
{
  "api": { "cpu": 2048, "memory": 4096, "min_instances": 2, "max_instances": 2 },
  "web": { "min_instances": 2, "max_instances": 2 },
  "database": { "tier": "db.t4g.small", "disk_size_gb": 50, "high_availability": true },
  "extra_environment": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318" },
  "log_retention_days": 90
}
```

Every key is optional and nothing else can be set: not the database version,
deletion protection, backups, secrets or the network. AWS runs a fixed number
of tasks, so `max_instances` must equal `min_instances`. Sizes cannot go below
the installed size. The database disk only grows: once you raise
`disk_size_gb`, keep it at or above the current disk, or the run is refused.
Changing the database tier restarts the database. The file is applied by the
next installer run and every run after it; delete a setting to return it to
its default.

## Take it over

Take over only when no installer run is in progress and the last run reached
"Infrastructure installed". After a run that failed before that step, this
folder still describes the apply before it: finish or retry that run first.

1. Stop the installer by writing the marker (its content is up to you):

   ```sh
   echo '{"reason":"managed by our platform team"}' > ejected.json
   aws s3api put-object --bucket $bucket --key $prefix/ejected.json --body ejected.json
   ```

   While it exists the installer refuses every run for this deployment. Health
   reports to OpenWork continue.
2. Download the bundle named in `release.json`, check it, and unpack it with
   the default file mode. The migration function is packaged from these files,
   and another file mode changes its checksum:

   ```sh
   curl -fsSLo bundle.tar.gz '$bundle_url'
   echo '$bundle_sha256  bundle.tar.gz' | shasum -a 256 -c -
   umask 022 && mkdir openwork && tar -xzf bundle.tar.gz -C openwork
   ```
3. Install Terraform $terraform_version, exactly that version.
4. Copy two files from this folder into
   `openwork/infra/managed-deployments/aws/terraform/`:
   `inputs.auto.tfvars.json` under the same name, and `backend.tf.json` as
   `backend_override.tf.json`.
5. In that directory:

   ```sh
   terraform init -lockfile=readonly
   terraform plan -lock-timeout=120s
   ```

   The plan must end with "No changes". If it lists changes, do not apply:
   something was changed outside Terraform, the files are not from the last
   apply, or the bundle was unpacked with another file mode.

From here the deployment is yours: edit the inputs or the Terraform and apply
with your own review. The installer's safeguard against deleting or replacing
the database, secrets, storage and network no longer runs for you; read every
plan for those resources.

`inputs.auto.tfvars.json` records the AWS RDS certificate bundle this apply
downloaded (`database_ca_bundle`), so a plan does not depend on a download. To
move to a newer AWS bundle, replace it, or set it to "" to download the current
one; that restarts the services.

### Credentials

Use your own identity in account $account_id. The installer's role
(`$runner_role`) can be used only by the installer and cannot delete resources.

- `terraform plan`: read and write on `s3://$bucket/$prefix/*` (the state and
  its lock file), read access to the deployment's resources (AWS's
  `ReadOnlyAccess` policy is the expected fit), and
  `secretsmanager:GetSecretValue` on the secrets named `$name-*`, which
  Terraform refreshes.
- `terraform apply` and `terraform destroy`: also create, change and delete
  those resources. An administrator of a dedicated account is the simple choice.

The state holds the database password and the application keys. Anyone who can
read it can administer this deployment.

### Hand it back

Delete `ejected.json`. The next installer run applies the installer's inputs
again and reverts what you changed, except that it refuses to delete or replace
the database, secrets, storage or network. Hand back only a deployment whose
state you have not moved to another Terraform or provider version.

## Remove it

1. Take it over (steps 1 to 5) and get a plan with no changes.
2. Keep what you need. `terraform destroy` takes a final database snapshot named
   `$name-den-final`. It deletes the managed runner's file system, which holds
   its conversation history, when that runner is installed.
3. Turn off deletion protection on the RDS instance whose identifier starts
   with `$name-den-`:
   `aws rds modify-db-instance --db-instance-identifier <identifier> --no-deletion-protection --apply-immediately`
4. If a backup vault named `$name-runner` exists, it holds the recovery points
   of that file system and cannot be deleted while it holds any. Delete them
   once you no longer need them.
5. Run `terraform destroy` and read the plan before you confirm it.
6. Remove what Terraform does not own, listed in `unmanaged.json`: deregister
   the retained task definition revisions, delete the CloudFormation stack
   `$stack` and its two log groups, and delete the final snapshot when you no
   longer need it. Secrets disappear after their 7-day recovery window.
7. Empty and delete the bucket `$bucket` last. It is the only copy of the
   Terraform state.

A network you supplied (your VPC, subnets and ECS cluster) is never removed.
''')


def applied_ca_bundle(binary, tf_root, values):
    """The public RDS trust roots this apply used, so a later plan needs no download."""
    bundle = values.get("database_ca_bundle")
    if not bundle:
        state = json.loads(subprocess.check_output([binary, "show", "-json"], cwd=tf_root))
        def resources(module):
            yield from module.get("resources", [])
            for child in module.get("child_modules", []):
                yield from resources(child)
        bundle = next((resource.get("values", {}).get("response_body")
                       for resource in resources(state.get("values", {}).get("root_module", {}))
                       if resource.get("address") == RDS_CA_ADDRESS and resource.get("mode") == "data"), None)
    if not isinstance(bundle, str) or "-----BEGIN CERTIFICATE-----" not in bundle or "PRIVATE KEY" in bundle:
        raise ValueError("the database trust roots used by this apply are not available")
    return bundle


def recordable_bundle_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("the release URL cannot be recorded")
    # An object version is part of the release identity; a signed query is a credential.
    if re.search(r"(?i)(signature|credential|token|x-amz-security|x-goog-)", parsed.query):
        return parsed._replace(query="", fragment="").geturl()
    return parsed._replace(fragment="").geturl()


def eject_kit(root, values, raw_outputs, ca_bundle):
    """The applied/ files: everything needed to plan this deployment without OpenWork."""
    deployment_id, bucket, region = os.environ["DEPLOYMENT_ID"], os.environ["STATE_BUCKET"], os.environ["AWS_REGION"]
    compact = deployment_id.replace("-", "")
    name = "ow-" + compact[:12]  # contract/main.tf
    runner_role = f"openwork-{compact}-runner"
    project = os.environ.get("CODEBUILD_BUILD_ID", "").split(":")[0]
    stack = project[:-len("-runner")] if project.endswith("-runner") else "openwork-" + compact
    manifest_path = root / "release.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    release = {"provider": "aws", "version": os.environ["OPENWORK_VERSION"]}
    revision = manifest.get("installerRevision")
    if whole_number(revision) and revision >= 1:
        release["installerRevision"] = revision
    release.update({"bundleUrl": recordable_bundle_url(os.environ["BUNDLE_URL"]), "bundleSha256": os.environ["BUNDLE_SHA256"],
                    "deploymentId": deployment_id, "runId": os.environ["RUN_ID"]})
    outputs = {key: item["value"] for key, item in raw_outputs.items() if isinstance(item, dict) and item.get("sensitive") is False}
    families = sorted({arn.split(":task-definition/", 1)[1].rsplit(":", 1)[0]
                       for arn in (outputs.get("task_definition_arns") or {}).values()
                       if isinstance(arn, str) and ":task-definition/" in arn} | {name + "-migrate"})
    named = {"StateBucket": bucket, "RunnerRole": runner_role, "Runner": stack + "-runner", "Launcher": stack + "-launcher"}
    unmanaged = {
        "bootstrapStack": {
            "type": "AWS::CloudFormation::Stack", "name": stack, "accountId": os.environ["EXPECTED_ACCOUNT_ID"], "region": region,
            "note": "The installer. Deleting the stack removes the installer only; the state bucket is retained and holds the Terraform state.",
            "resources": [{"logicalId": logical, "type": kind, **({"name": named[logical]} if logical in named else {}),
                           **({"retainedOnStackDelete": True} if logical == "StateBucket" else {}),
                           **({"condition": "present only with the managed runner"} if logical == "RunnerSupplementalPolicy" else {})}
                          for logical, kind in BOOTSTRAP_RESOURCES],
            "logGroups": [f"/aws/codebuild/{stack}-runner", f"/aws/lambda/{stack}-launcher"],
        },
        "retainedTaskDefinitions": {
            "families": families,
            "note": "Terraform registers revisions and never deregisters them. After terraform destroy every revision in these families is still ACTIVE.",
        },
        "leftByTerraformDestroy": [
            f"The final RDS snapshot {name}-den-final",
            "Secrets Manager secrets in their 7-day recovery window",
            f"Recovery points in the AWS Backup vault {name}-runner, when the managed runner is installed; the vault cannot be deleted while it holds any",
        ],
        "sharedWithTheAccount": ["Service-linked roles for ECS, Elastic Load Balancing and RDS. Other workloads may use them; leave them in place."],
    }
    readme = TAKEOVER_README.substitute(
        deployment_id=deployment_id, version=release["version"], run_id=release["runId"], account_id=os.environ["EXPECTED_ACCOUNT_ID"],
        region=region, bucket=bucket, prefix="deployments/" + deployment_id, bundle_url=release["bundleUrl"], bundle_sha256=release["bundleSha256"],
        terraform_version=TERRAFORM_VERSION, runner_role=runner_role, name=name, stack=stack)
    def document(value):
        return json.dumps(value, indent=2, sort_keys=True) + "\n"
    # release.json is written last: its presence means the whole folder is from this run.
    return {
        "inputs.auto.tfvars.json": document({**values, "database_ca_bundle": ca_bundle}),
        "backend.tf.json": document({"terraform": {"backend": {"s3": {
            "bucket": bucket, "key": deployment_key("terraform.tfstate"), "region": region, "encrypt": True, "use_lockfile": True}}}}),
        "terraform-version.json": document({
            "version": TERRAFORM_VERSION, "sha256": TERRAFORM_LINUX_SHA256, "platform": "linux_amd64",
            "url": f"https://releases.hashicorp.com/terraform/{TERRAFORM_VERSION}/terraform_{TERRAFORM_VERSION}_linux_amd64.zip"}),
        "outputs.json": document(outputs),
        "unmanaged.json": document(unmanaged),
        "README.md": readme,
        "release.json": document(release),
    }


def write_eject_kit(binary, root, tf_root, values, raw_outputs):
    """Record the apply under deployments/<id>/applied/ in the customer's state bucket."""
    files = eject_kit(root, values, raw_outputs, applied_ca_bundle(binary, tf_root, values))
    # The run's credentials never belong in the record, whatever an input contained.
    credentials = [os.environ.get("CHALLENGE", ""), Path(os.environ["RUNNER_TOKEN_FILE"]).read_text().strip()]
    if any(credential and credential in content for credential in credentials for content in files.values()):
        raise ValueError("refusing to record a run credential")
    with tempfile.TemporaryDirectory(prefix="openwork-applied-") as directory:
        for name, content in files.items():
            body = Path(directory) / name
            body.write_text(content)
            aws("s3api", "put-object", "--bucket", os.environ["STATE_BUCKET"], "--key", deployment_key("applied/" + name),
                "--body", str(body), "--content-type", "text/markdown; charset=utf-8" if name.endswith(".md") else "application/json")
    print(f'Recorded this apply in s3://{os.environ["STATE_BUCKET"]}/{deployment_key("applied/")}')


def main():
    root = Path.cwd()
    tf_root = root / "infra/managed-deployments/aws/terraform"
    current = STEPS[0]
    try:
        verify_account()
        refuse_if_ejected()
        overrides = customer_overrides()
        verify_network()
        report(3, "account_verified")
        current = STEPS[1]
        # "Infrastructure installed" is reported only after applied/ was written.
        outputs = apply(root, tf_root, overrides, write_eject_kit)
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
