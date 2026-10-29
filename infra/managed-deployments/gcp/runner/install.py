#!/usr/bin/env python3
"""Customer-approved Cloud Shell installer. Standard library only; no SA keys."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
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
        "dns.googleapis.com", "cloudscheduler.googleapis.com", "monitoring.googleapis.com"]
RUNNER_ROLES = ["roles/run.admin", "roles/cloudsql.admin", "roles/secretmanager.admin",
                "roles/compute.admin", "roles/dns.admin", "roles/artifactregistry.admin",
                "roles/cloudscheduler.admin", "roles/serviceusage.serviceUsageConsumer"]


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


def cloud(*args, project, impersonate=None):
    command = ["gcloud", *args, "--project=" + project, "--format=json", "--quiet"]
    if impersonate:
        command.append("--impersonate-service-account=" + impersonate)
    output = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    return json.loads(output) if output.strip() else {}


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
    allowed = ("infra/managed-deployments/gcp/", "infra/managed-deployments/contract/")
    for file, expected in files.items():
        if not file.startswith(allowed) or not (file.endswith(".py") or file.endswith(".tf") or file.endswith("/.terraform.lock.hcl")):
            raise ValueError("unexpected executable in bundle")
        if hashlib.sha256((destination / file).read_bytes()).hexdigest() != expected:
            raise ValueError("release file checksum mismatch")
    for required in ["runner/install.py", "runner/runner.py", "health/health_agent.py", "terraform/main.tf", "terraform/.terraform.lock.hcl"]:
        if "infra/managed-deployments/gcp/" + required not in files:
            raise ValueError("incomplete release bundle")


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


def bootstrap(args, prefix):
    cloud("services", "enable", *APIS, project=args.project_id)
    identities = {kind: ensure_sa(args, prefix + "-" + kind) for kind in ("runner", "runtime", "web", "health", "scheduler")}
    for role in RUNNER_ROLES:
        bind_project(args, identities["runner"], role)
    bind_project(args, identities["runtime"], "roles/cloudsql.client")
    # Read-only operational metadata, never secrets or state.
    for role in ["roles/run.viewer", "roles/cloudsql.viewer", "roles/compute.viewer", "roles/monitoring.viewer"]:
        bind_project(args, identities["health"], role)
    for kind in ("runtime", "web", "health", "scheduler"):
        bind_sa(args, identities[kind], "serviceAccount:" + identities["runner"], "roles/iam.serviceAccountUser")
    active = cloud("auth", "list", "--filter=status:ACTIVE", project=args.project_id)
    if len(active) != 1 or not active[0].get("account"):
        raise ValueError("one authenticated approving principal required")
    principal = active[0]["account"]
    member = ("serviceAccount:" if principal.endswith(".gserviceaccount.com") else "user:") + principal
    bind_sa(args, identities["runner"], member, "roles/iam.serviceAccountTokenCreator")
    bucket = f"{prefix}-{args.project_number}-state"
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-base64", required=True)
    encoded = parser.parse_args().config_base64
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
    verify_target(args)
    print(f"Install OpenWork {args.version} in project {args.project_id} ({args.project_number}), {args.region}.\n"
          "This enables APIs, grants installer permissions across this dedicated project, and creates billable Cloud SQL,\n"
          "Cloud Run, HTTPS load balancing, DNS, secrets, a health schedule and retained versioned Terraform state.\n"
          "OpenWork receives only progress and health checks, authenticated by service-account identity; no secrets or state.\n"
          "Deleting the installer does not remove state or the database. Use a dedicated project, not a shared production project.")
    if input("Type the exact project ID to approve: ").strip() != args.project_id:
        raise ValueError("installation not approved")
    with tempfile.TemporaryDirectory(prefix="openwork-gcp-") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        extract_verified(request(args.bundle_url), args.bundle_sha256, root, args.version)
        identities, bucket = bootstrap(args, prefix)
        # Explicit OAuth consent; never generate a long-lived service-account key.
        subprocess.run(["gcloud", "auth", "application-default", "login", "--no-launch-browser"], check=True)
        environment = {**os.environ, **{key.upper(): str(value) for key, value in vars(args).items()},
                       "STATE_BUCKET": bucket, "RUNNER_SERVICE_ACCOUNT": identities["runner"],
                       "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT": identities["runner"]}
        # No user credential override can make Terraform accidentally run as admin.
        for key in ["GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_BACKEND_CREDENTIALS"]:
            environment.pop(key, None)
        subprocess.run(["python3", str(root / "infra/managed-deployments/gcp/runner/runner.py")],
                       cwd=root, env=environment, check=True)


if __name__ == "__main__":
    main()
