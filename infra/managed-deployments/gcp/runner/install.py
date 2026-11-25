#!/usr/bin/env python3
"""Customer-approved installer. Standard library only; no SA keys.

In the approving person's terminal this verifies the target, asks for the
project ID, runs the idempotent bootstrap with that person's own gcloud
credentials and submits one Cloud Build build that runs as the deployment's
runner service account. Inside that build (--cloud-build) it verifies the
pinned bundle again and starts runner.py. Nothing impersonates anything.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BUNDLE = 32 * 1024 * 1024
MAX_EXTRACTED = 64 * 1024 * 1024
IMAGE_REPOSITORIES = {"den_api": "ghcr.io/different-ai/openwork-den-api",
                      "den_web": "ghcr.io/different-ai/openwork-den-web",
                      "health": "docker.io/library/python"}


def release_images(manifest, version):
    if (not isinstance(manifest, dict) or manifest.get("provider") != "gcp"
            or manifest.get("version") != version or manifest.get("protocolVersion") != 1):
        raise ValueError("wrong release manifest")
    images = manifest.get("images")
    if not isinstance(images, dict) or set(images) != set(IMAGE_REPOSITORIES):
        raise ValueError("release image inventory mismatch")
    for kind, repository in IMAGE_REPOSITORIES.items():
        if not isinstance(images[kind], str) or not re.fullmatch(re.escape(repository) + r"@sha256:[a-f0-9]{64}", images[kind]):
            raise ValueError("invalid release image pin: " + kind)
    return dict(images)

APIS = ["iam.googleapis.com", "iamcredentials.googleapis.com", "serviceusage.googleapis.com",
        "cloudresourcemanager.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "sqladmin.googleapis.com",
        "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "compute.googleapis.com",
        "dns.googleapis.com", "cloudscheduler.googleapis.com", "monitoring.googleapis.com",
        "cloudbuild.googleapis.com", "logging.googleapis.com"]
# logging.logWriter only lets the build write its own log entries; it reads nothing.
RUNNER_ROLES = ["roles/run.admin", "roles/cloudsql.admin", "roles/secretmanager.admin",
                "roles/compute.admin", "roles/dns.admin", "roles/artifactregistry.admin",
                "roles/cloudscheduler.admin", "roles/serviceusage.serviceUsageConsumer",
                "roles/logging.logWriter"]
# Read-only operational metadata, never secrets or state.
HEALTH_ROLES = ["roles/run.viewer", "roles/cloudsql.viewer", "roles/compute.viewer", "roles/monitoring.viewer"]

# The build runs in Cloud Build's non-regional default pool unless the approving
# person exports OPENWORK_CLOUD_BUILD_REGION. It is never derived from the
# deployment region: Cloud Build and Cloud Run do not offer the same regions.
BUILD_REGION = "global"
BUILD_REGION_VARIABLE = "OPENWORK_CLOUD_BUILD_REGION"
# Below Den's three-hour run lifetime (renewed at enrolment), so a failing build
# can still report. Certificate issuance alone may take an hour.
BUILD_TIMEOUT_SECONDS = 10200
BUILD_SUBMIT_ATTEMPTS = 8
# Google's Cloud CLI image (594.0.1-slim), pinned by index digest. It has gcloud
# and CA certificates. It has no python3 on PATH, so the step names the bundled
# interpreter that Google's own image build asserts. Google deletes image
# versions after one year: refresh this pin in a new installer before then.
BUILD_IMAGE = ("gcr.io/google.com/cloudsdktool/google-cloud-cli"
               "@sha256:934bb306bc5a5e103baaf1f95d39d2ccc7e8bf0c778f6450ad7574783203df3b")
BUILD_PYTHON = "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3"
INSTALLER_PATH = "infra/managed-deployments/gcp/runner/install.py"
# First code in the build. It runs nothing from the download until the whole
# archive matches the approved SHA-256; install.py then repeats the complete
# inventory verification. No dollar sign: Cloud Build would substitute it.
BUILD_ENTRY = '''import hashlib, io, os, subprocess, sys, tarfile, tempfile, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *details):
        raise ValueError("redirect refused")
url, digest, config = sys.argv[1:4]
limit = 32 * 1024 * 1024
with urllib.request.build_opener(NoRedirect()).open(url, timeout=120) as response:
    data = response.read(limit + 1)
if len(data) > limit or hashlib.sha256(data).hexdigest() != digest:
    raise ValueError("release checksum mismatch")
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    member = archive.getmember("''' + INSTALLER_PATH + '''")
    if not member.isfile() or member.size > 1024 * 1024:
        raise ValueError("unexpected installer entry")
    source = archive.extractfile(member).read()
with tempfile.TemporaryDirectory(prefix="openwork-gcp-entry-") as directory:
    os.chmod(directory, 0o700)
    path = os.path.join(directory, "install.py")
    with open(path, "xb") as output:
        output.write(source)
    os.chmod(path, 0o600)
    subprocess.run([sys.executable, path, "--config-base64", config, "--cloud-build"], check=True)
'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect refused")


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        before, after = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (req.get_method() != "GET" or req.has_header("Authorization") or req.has_header("Cookie")
                or before.scheme != "https" or after.scheme != "https"
                or before.netloc != after.netloc or after.username or after.password):
            raise ValueError("cross-origin or authenticated redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request(url, data=None, headers=None, limit=MAX_BUNDLE, same_origin_redirects=False, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    redirect = SameOriginRedirect() if same_origin_redirects else NoRedirect()
    with urllib.request.build_opener(redirect).open(req, timeout=60) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("response too large")
        return body


def cloud(*args, project, timeout=None):
    # Always the caller's own identity: the approving person in their terminal,
    # the runner service account inside the build. Never an impersonated one.
    command = ["gcloud", *args, "--project=" + project, "--format=json", "--quiet"]
    output = subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout).stdout
    return json.loads(output) if output.strip() else {}


def access_token(timeout=30):
    # gcloud's JSON formatter does not apply to token output. Never printed or stored.
    token = subprocess.run(["gcloud", "auth", "print-access-token"], check=True, capture_output=True,
                           text=True, timeout=timeout).stdout.strip()
    if not token:
        raise ValueError("cloud identity unavailable")
    return token


def state_bucket(args, prefix):
    return f"{prefix}-{args.project_number}-state"


def runner_account(args, prefix):
    return f"{prefix}-runner@{args.project_id}.iam.gserviceaccount.com"


def read_object(bucket, object_name, headers, limit=65536):
    """Object bytes, or None only for a definite 404. Denials and outages raise."""
    url = ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(bucket, safe="")
           + "/o/" + urllib.parse.quote(object_name, safe="") + "?alt=media")
    try:
        return request(url, headers=headers, limit=limit)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def refuse_if_ejected(bucket, deployment_id, headers):
    # The customer writes this marker when they take over the deployment. Its
    # content is never interpreted: its existence alone stops every managed run.
    marker = "deployments/" + deployment_id + "/ejected.json"
    try:
        found = read_object(bucket, marker, headers) is not None
    except urllib.error.HTTPError as error:
        # Unknown is not "absent". Nothing has been changed at this point.
        raise ValueError(f"cannot tell whether this deployment is self-managed: reading gs://{bucket}/{marker} "
                         f"returned HTTP {error.code}. The signed-in account needs storage.objects.get on that bucket.") from None
    if found:
        raise ValueError("this deployment is self-managed: gs://" + bucket + "/" + marker + " exists, so the OpenWork "
                         "installer will not run. Remove that object only if you want OpenWork-managed installs, "
                         "updates and retries again.")


def name(deployment_id):
    if str(uuid.UUID(deployment_id)) != deployment_id:
        raise ValueError("invalid deployment UUID")
    return "ow-" + deployment_id.replace("-", "")[:12]


def immutable_url(url):
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
    if (parsed.scheme != "https" or parsed.netloc != "storage.googleapis.com" or parsed.fragment
            or not re.fullmatch(r"/[a-z0-9][a-z0-9._-]{1,221}/[^\\\s]+", parsed.path)
            or set(query) != {"generation"} or len(query["generation"]) != 1
            or not re.fullmatch(r"[1-9][0-9]*", query["generation"][0])):
        raise ValueError("bundle must be an immutable GCS generation URL")
    return url


def validate(args):
    prefix = name(args.deployment_id)
    name(args.run_id)
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args.project_id):
        raise ValueError("invalid project ID")
    if not re.fullmatch(r"[1-9][0-9]{0,29}", args.project_number):
        raise ValueError("invalid project number")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", args.region):
        raise ValueError("invalid region")
    if not re.fullmatch(r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", args.dns_zone_name):
        raise ValueError("invalid DNS zone name")
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", args.domain_name) or len(args.domain_name) > 200:
        raise ValueError("invalid domain")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", args.owner_email):
        raise ValueError("invalid email")
    if not re.fullmatch(r"https://[a-z0-9.-]+(?::[0-9]+)?", args.control_plane_origin):
        raise ValueError("invalid control plane origin")
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", args.challenge):
        raise ValueError("invalid enrollment challenge")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", args.version):
        raise ValueError("exact published version required")
    if not re.fullmatch(r"[a-f0-9]{64}", args.bundle_sha256):
        raise ValueError("invalid checksum")
    immutable_url(args.bundle_url)
    return prefix


def verify_target(args):
    project = cloud("projects", "describe", args.project_id, project=args.project_id)
    if str(project.get("projectNumber")) != args.project_number or project.get("lifecycleState") != "ACTIVE":
        raise ValueError("wrong or inactive GCP project")
    zone = cloud("dns", "managed-zones", "describe", args.dns_zone_name, project=args.project_id)
    domain = zone.get("dnsName", "").rstrip(".")
    if zone.get("visibility", "public") != "public" or not domain or not (args.domain_name == domain or args.domain_name.endswith("." + domain)):
        raise ValueError("domain must belong to the project's public DNS zone")


def extract_verified(data, digest, destination, version):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("release checksum mismatch")
    archive = destination / "bundle.tar.gz"
    archive.write_bytes(data)
    # Never extract links, devices, absolute paths, duplicate files or traversal.
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        seen = set()
        total = 0
        for member in members:
            path = Path(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or path.as_posix() != member.name.rstrip("/")
                    or member.name in seen or not (member.isdir() or member.isfile())
                    or not (member.name == "release.json" or (member.name == "infra" and member.isdir()) or member.name.startswith("infra/"))):
                raise ValueError("unsafe bundle archive")
            seen.add(member.name)
            total += member.size
            if total > MAX_EXTRACTED or len(seen) > 2000:
                raise ValueError("bundle expansion limit")
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source:
                    target.write_bytes(source.read())
                target.chmod(0o600)
    manifest = json.loads((destination / "release.json").read_text())
    release_images(manifest, version)
    files = manifest.get("files")
    actual = {m.name for m in members if m.isfile() and m.name != "release.json"}
    if not isinstance(files, dict) or set(files) != actual:
        raise ValueError("release file inventory mismatch")
    allowed = ("infra/managed-deployments/gcp/", "infra/managed-deployments/contract/",
               "infra/terraform/modules/openwork-gcp-cloud-run/")
    for file, expected in files.items():
        if (not file.startswith(allowed) or "/tests/" in file or "/examples/" in file
                or not (file.endswith(".py") or file.endswith(".tf") or file.endswith("/.terraform.lock.hcl"))
                or (file.startswith(allowed[2]) and (len(Path(file).parts) != 5 or not file.endswith(".tf")))):
            raise ValueError("unexpected executable in bundle")
        if hashlib.sha256((destination / file).read_bytes()).hexdigest() != expected:
            raise ValueError("release file checksum mismatch")
    for required in ["runner/install.py", "runner/runner.py", "health/health_agent.py", "terraform/main.tf", "terraform/.terraform.lock.hcl"]:
        if "infra/managed-deployments/gcp/" + required not in files:
            raise ValueError("incomplete release bundle")
    for required in ("main.tf", "cloudrun.tf", "database.tf", "lb.tf", "variables.tf", "versions.tf", "outputs.tf"):
        if allowed[2] + required not in files:
            raise ValueError("incomplete shared GCP module")


def ensure_sa(args, account):
    email = f"{account}@{args.project_id}.iam.gserviceaccount.com"
    # List before creating; do not treat a permission/network failure as absence.
    accounts = cloud("iam", "service-accounts", "list", project=args.project_id)
    if not any(a.get("email") == email for a in accounts):
        cloud("iam", "service-accounts", "create", account, "--display-name=OpenWork " + account, project=args.project_id)
    return email


def bind_project(args, email, role):
    cloud("projects", "add-iam-policy-binding", args.project_id, "--member=serviceAccount:" + email,
          "--role=" + role, "--condition=None", project=args.project_id)


def bind_sa(args, email, member, role):
    cloud("iam", "service-accounts", "add-iam-policy-binding", email, "--member=" + member,
          "--role=" + role, "--condition=None", project=args.project_id)


def retire_token_creator(args, runner, member):
    # Installers that ran Terraform from Cloud Shell let the approving person
    # mint tokens for the runner. Nothing impersonates it any more, so remove
    # that person's own grant. Other members are reported, never changed.
    policy = cloud("iam", "service-accounts", "get-iam-policy", runner, project=args.project_id)
    role = "roles/iam.serviceAccountTokenCreator"
    for binding in policy.get("bindings", []) if isinstance(policy, dict) else []:
        if binding.get("role") != role or binding.get("condition"):
            continue
        members = binding.get("members", [])
        if member in members:
            cloud("iam", "service-accounts", "remove-iam-policy-binding", runner, "--member=" + member,
                  "--role=" + role, "--condition=None", project=args.project_id)
        others = sorted(other for other in members if other != member)
        if others:
            print("Review: these members can still mint tokens for the installer account, which OpenWork "
                  "no longer needs: " + ", ".join(others))


def active_account(args):
    active = cloud("auth", "list", "--filter=status:ACTIVE", project=args.project_id)
    if not isinstance(active, list) or len(active) != 1 or not active[0].get("account"):
        raise ValueError("one authenticated principal required")
    return active[0]["account"]


def bootstrap(args, prefix):
    cloud("services", "enable", *APIS, project=args.project_id)
    identities = {kind: ensure_sa(args, prefix + "-" + kind) for kind in ("runner", "runtime", "web", "health", "scheduler")}
    for role in RUNNER_ROLES:
        bind_project(args, identities["runner"], role)
    # A custom role avoids granting monitoring.viewer merely to observe the
    # maintenance drain. Customer re-approval includes creating this exact role.
    role_id = prefix.replace("-", "_") + "_drain"
    role_name = "projects/" + args.project_id + "/roles/" + role_id
    roles = cloud("iam", "roles", "list", project=args.project_id)
    existing_role = next((role for role in roles if role.get("name") == role_name), None)
    if existing_role is None:
        cloud("iam", "roles", "create", role_id, "--title=OpenWork maintenance observation",
              "--permissions=monitoring.timeSeries.list", "--stage=GA", project=args.project_id)
    else:
        details = cloud("iam", "roles", "describe", role_id, project=args.project_id)
        if details.get("includedPermissions") != ["monitoring.timeSeries.list"] or details.get("deleted"):
            raise ValueError("unexpected maintenance role permissions; owner review required")
    bind_project(args, identities["runner"], role_name)
    bind_project(args, identities["runtime"], "roles/cloudsql.client")
    for role in HEALTH_ROLES:
        bind_project(args, identities["health"], role)
    for kind in ("runtime", "web", "health", "scheduler"):
        bind_sa(args, identities[kind], "serviceAccount:" + identities["runner"], "roles/iam.serviceAccountUser")
    # Den requires an email-bearing identity token. The runner may mint one for
    # itself only: this role has no access-token, key or signing permission.
    bind_sa(args, identities["runner"], "serviceAccount:" + identities["runner"], "roles/iam.serviceAccountOpenIdTokenCreator")
    principal = active_account(args)
    member = ("serviceAccount:" if principal.endswith(".gserviceaccount.com") else "user:") + principal
    # "Act as" lets this person start the build as the runner. It cannot mint
    # the runner's tokens or keys for use outside that build.
    bind_sa(args, identities["runner"], member, "roles/iam.serviceAccountUser")
    retire_token_creator(args, identities["runner"], member)
    bucket = state_bucket(args, prefix)
    buckets = cloud("storage", "buckets", "list", "--raw", project=args.project_id)
    existing = next((b for b in buckets if b.get("name") in (bucket, "gs://" + bucket)), None)
    if existing is None:
        cloud("storage", "buckets", "create", "gs://" + bucket, "--location=" + args.region,
              "--uniform-bucket-level-access", "--public-access-prevention", project=args.project_id)
        cloud("storage", "buckets", "update", "gs://" + bucket, "--versioning", project=args.project_id)
    details = cloud("storage", "buckets", "describe", "gs://" + bucket, "--raw", project=args.project_id)
    if (str(details.get("projectNumber")) != args.project_number
            or details.get("versioning", {}).get("enabled") is not True
            or details.get("iamConfiguration", {}).get("uniformBucketLevelAccess", {}).get("enabled") is not True
            or details.get("iamConfiguration", {}).get("publicAccessPrevention") != "enforced"):
        raise ValueError("state bucket ownership/security check failed")
    cloud("storage", "buckets", "add-iam-policy-binding", "gs://" + bucket,
          "--member=serviceAccount:" + identities["runner"], "--role=roles/storage.objectAdmin", project=args.project_id)
    return identities, bucket


def literal(value):
    # Cloud Build substitutes $NAME in every step field; $$ is a literal dollar.
    return value.replace("$", "$$")


def build_region():
    region = os.environ.get(BUILD_REGION_VARIABLE, BUILD_REGION)
    if region != "global" and not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", region):
        raise ValueError("invalid " + BUILD_REGION_VARIABLE)
    return region


def build_config(args, prefix, encoded):
    """One step, run as the runner account. Generated here so the bundle stays .py/.tf only."""
    arguments = ["-c", BUILD_ENTRY, args.bundle_url, args.bundle_sha256, encoded]
    if any(len(argument) > 8000 for argument in arguments):
        raise ValueError("build argument too large")
    timeout = str(BUILD_TIMEOUT_SECONDS) + "s"
    return {
        "steps": [{
            "id": "openwork-install",
            "name": BUILD_IMAGE,
            "entrypoint": BUILD_PYTHON,
            "args": [literal(argument) for argument in arguments],
            # $BUILD_ID is the one deliberate substitution: the runner records
            # it in the orchestration lock so an interrupted owner can be found.
            "env": ["BUILD_ID=$BUILD_ID", "PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1",
                    "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"],
            "timeout": timeout,
        }],
        "serviceAccount": "projects/" + args.project_id + "/serviceAccounts/" + runner_account(args, prefix),
        # A user-specified service account cannot use the default logs bucket.
        # Logs stay in this project's Cloud Logging; OpenWork never receives them.
        "options": {"logging": "CLOUD_LOGGING_ONLY"},
        "timeout": timeout,
        "tags": ["openwork", prefix, "run-" + args.run_id],
    }


def submit_build(args, prefix, encoded, directory):
    config = directory / "cloudbuild.json"
    config.write_text(json.dumps(build_config(args, prefix, encoded)))
    config.chmod(0o600)
    region = build_region()
    for attempt in range(BUILD_SUBMIT_ATTEMPTS):
        try:
            # --no-source: nothing is uploaded and no source bucket is created.
            # --async: the terminal is not part of the installation after this call.
            build = cloud("builds", "submit", "--no-source", "--async", "--config=" + str(config),
                          "--region=" + region, project=args.project_id)
            break
        except subprocess.CalledProcessError as failure:
            # Bootstrap granted "act as" and enabled Cloud Build seconds ago; both
            # take a moment to apply. A permission refusal created no build, so
            # asking again is safe. Any other failure is not retried.
            refused = isinstance(failure.stderr, str) and "PERMISSION_DENIED" in failure.stderr
            if not refused or attempt + 1 == BUILD_SUBMIT_ATTEMPTS:
                raise
            print("Waiting for the new permissions to take effect...")
            time.sleep(15)
    identifier = build.get("id") if isinstance(build, dict) else None
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9-]{36}", identifier):
        # The build may exist. Starting another one blindly could contend with it.
        raise ValueError("build receipt unavailable; check Cloud Build history in this project before running the command again")
    link = build.get("logUrl")
    if not isinstance(link, str) or not link.startswith("https://console.cloud.google.com/"):
        link = ("https://console.cloud.google.com/cloud-build/builds;region=" + region + "/" + identifier
                + "?project=" + args.project_number)
    return identifier, link


def run_in_build(args, prefix):
    """Inside Cloud Build, as the runner account. Refuses any other identity."""
    # Nothing in the environment may select other credentials for gcloud,
    # Terraform or its backend. The metadata server is the only identity source.
    for key in list(os.environ):
        if key in ("GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN",
                   "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") or key.startswith(("GOOGLE_BACKEND_", "CLOUDSDK_AUTH_")):
            os.environ.pop(key)
    if not re.fullmatch(r"[a-f0-9-]{36}", os.environ.get("BUILD_ID", "")):
        raise ValueError("the runner only starts inside its Cloud Build build")
    configuration = Path(os.environ.get("CLOUDSDK_CONFIG") or Path.home() / ".config/gcloud")
    if (configuration / "application_default_credentials.json").exists():
        raise ValueError("local application-default credentials found; the runner only uses its own build identity")
    account = runner_account(args, prefix)
    if active_account(args) != account:
        # Terraform must never run as a person, including the approving person.
        raise ValueError("the build is not running as this deployment's runner service account")
    with tempfile.TemporaryDirectory(prefix="openwork-gcp-") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        extract_verified(request(args.bundle_url), args.bundle_sha256, root, args.version)
        environment = {**os.environ, **{key.upper(): str(value) for key, value in vars(args).items()},
                       "STATE_BUCKET": state_bucket(args, prefix), "RUNNER_SERVICE_ACCOUNT": account}
        subprocess.run([sys.executable, str(root / "infra/managed-deployments/gcp/runner/runner.py")],
                       cwd=root, env=environment, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-base64", required=True)
    # Set only by the build step this installer generates, never by a person.
    parser.add_argument("--cloud-build", action="store_true", help=argparse.SUPPRESS)
    options = parser.parse_args()
    encoded = options.config_base64
    if len(encoded) > 20000:
        raise ValueError("configuration too large")
    config = json.loads(base64.b64decode(encoded, validate=True))
    if config.get("size") != "small":
        raise ValueError("unsupported capacity profile")
    target, release = config["target"], config["release"]
    args = argparse.Namespace(deployment_id=config["deploymentId"], run_id=config["runId"],
        challenge=config["challenge"], control_plane_origin=release["apiOrigin"], project_id=target["projectId"],
        project_number=target["projectNumber"], region=target["region"], dns_zone_name=target["dnsZoneName"],
        domain_name=config["domainName"], owner_email=config["ownerEmail"], version=release["version"],
        bundle_url=release["bundleUrl"], bundle_sha256=release["bundleSha256"])
    prefix = validate(args)
    if options.cloud_build:
        return run_in_build(args, prefix)
    verify_target(args)
    refuse_if_ejected(state_bucket(args, prefix), args.deployment_id, {"Authorization": "Bearer " + access_token()})
    print(f"Install OpenWork {args.version} in project {args.project_id} ({args.project_number}), {args.region}.\n"
          "Approval includes a deployment-specific role with only monitoring.timeSeries.list for safe maintenance observation.\n"
          "Existing services enter maintenance before migration; uncertain drain or migration leaves them disabled.\n"
          "This enables APIs, grants installer permissions across this dedicated project, and creates billable Cloud SQL,\n"
          "Cloud Run, HTTPS load balancing, DNS, secrets, a health schedule and retained versioned Terraform state.\n"
          "The installation runs as a Cloud Build build in this project, as the deployment's installer service account.\n"
          "You are granted permission to start builds as that account. Build logs stay in this project's Cloud Logging.\n"
          "OpenWork receives only progress and health checks, authenticated by service-account identity; no secrets or state.\n"
          "Deleting the installer does not remove state or the database. Use a dedicated project, not a shared production project.")
    if input("Type the exact project ID to approve: ").strip() != args.project_id:
        raise ValueError("installation not approved")
    with tempfile.TemporaryDirectory(prefix="openwork-gcp-") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        # A release that fails verification changes nothing in the project.
        extract_verified(request(args.bundle_url), args.bundle_sha256, root, args.version)
        bootstrap(args, prefix)
        identifier, link = submit_build(args, prefix, encoded, root)
    print(f"\nBuild {identifier} is installing OpenWork in project {args.project_id}. You can close this terminal.\n"
          f"Build log: {link}\n"
          "OpenWork shows the six installation steps as they finish. Run the approval command again only if\n"
          "OpenWork offers Retry; a build that is still running keeps the deployment locked.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as failure:
        # In the person's own terminal, show why gcloud refused. The build's
        # runner prints only fixed diagnostics, never provider output.
        if "--cloud-build" not in sys.argv[1:] and isinstance(failure.stderr, str) and failure.stderr.strip():
            sys.stderr.write(failure.stderr[-4000:].rstrip() + "\n")
        raise
