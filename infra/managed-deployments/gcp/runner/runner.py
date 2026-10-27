"""Verified runner, executed with customer-approved short-lived impersonation."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess
import re
import time
import urllib.error
import urllib.parse
import zipfile

from install import cloud, name, request, release_images, verify_target

TERRAFORM_VERSION = "1.16.5"
TERRAFORM_SHA256 = "2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4"
PROTECTED_TYPES = {"google_sql_database_instance", "google_sql_database", "google_sql_user",
                   "google_secret_manager_secret", "google_secret_manager_secret_version",
                   "google_storage_bucket", "google_kms_crypto_key", "google_compute_network", "random_password"}


def gcloud(*args):
    return cloud(*args, project=os.environ["PROJECT_ID"], impersonate=os.environ["RUNNER_SERVICE_ACCOUNT"])


def id_token(audience):
    # gcloud's JSON formatter does not apply to token output.
    return subprocess.run(["gcloud", "auth", "print-identity-token", "--include-email",
        "--audiences=" + audience, "--impersonate-service-account=" + os.environ["RUNNER_SERVICE_ACCOUNT"]],
        check=True, capture_output=True, text=True).stdout.strip()


def endpoint(suffix):
    return os.environ["CONTROL_PLANE_ORIGIN"] + "/v1/managed-deployments/" + os.environ["DEPLOYMENT_ID"] + suffix


def enroll():
    url = endpoint("/runs/" + os.environ["RUN_ID"] + "/enroll")
    token = id_token(url + "#" + os.environ["CHALLENGE"])
    reply = json.loads(request(url, json.dumps({"provider": "gcp", "idToken": token}).encode(),
                               {"Content-Type": "application/json"}, limit=65536))
    if not isinstance(reply.get("token"), str) or not reply["token"]:
        raise ValueError("enrollment rejected")
    return reply["token"]


def report(token, sequence, step, outcome="succeeded", code=None):
    body = {"sequence": sequence, "step": step, "outcome": outcome}
    if code:
        body["errorCode"] = code
    url = endpoint("/runs/" + os.environ["RUN_ID"] + "/events")
    for attempt in range(3):
        try:
            reply = json.loads(request(url, json.dumps(body).encode(),
                {"Content-Type": "application/json", "Authorization": "Bearer " + token}, limit=65536))
            if reply.get("ok") is not True:
                raise ValueError("event rejected")
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def unsafe_changes(plan):
    return [r["address"] for r in plan.get("resource_changes", [])
            if r.get("type") in PROTECTED_TYPES and "delete" in r.get("change", {}).get("actions", [])]


def terraform_binary(root):
    url = f"https://releases.hashicorp.com/terraform/{TERRAFORM_VERSION}/terraform_{TERRAFORM_VERSION}_linux_amd64.zip"
    data = request(url, limit=150 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != TERRAFORM_SHA256:
        raise ValueError("Terraform checksum mismatch")
    archive = root / "terraform.zip"
    archive.write_bytes(data)
    with zipfile.ZipFile(archive) as zipped:
        binary = root / "terraform-bin"
        binary.write_bytes(zipped.read("terraform"))
    binary.chmod(0o700)
    return str(binary)


def load_release_images():
    # This file is inside the bundle whose SHA-256 install.py checked before
    # bootstrap. Runtime environment variables can never select source images.
    manifest = json.loads((Path(__file__).resolve().parents[4] / "release.json").read_text())
    return release_images(manifest, os.environ["VERSION"])


def canonical_image_reference(reference):
    if not isinstance(reference, str):
        return None
    repository, separator, digest = reference.partition("@")
    if not separator or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        return None
    parts = repository.split("/")
    if parts[0] in ("docker.io", "index.docker.io"):
        parts = parts[1:]
    elif "." in parts[0] or ":" in parts[0] or parts[0] == "localhost":
        # Other registries must match verbatim, including their namespace.
        return reference
    if len(parts) == 1:
        parts = ["library", parts[0]]
    if len(parts) != 2 or not all(parts):
        return None
    return "docker.io/" + "/".join(parts) + "@" + digest


def image_source_matches(source, repo_digests):
    expected = canonical_image_reference(source)
    return (expected is not None and isinstance(repo_digests, list)
            and any(canonical_image_reference(observed) == expected for observed in repo_digests))


def mirror_images():
    pinned = load_release_images()  # reject missing/invalid pins before cloud writes
    project, region = os.environ["PROJECT_ID"], os.environ["REGION"]
    repository = name(os.environ["DEPLOYMENT_ID"])
    existing = gcloud("artifacts", "repositories", "list", "--location=" + region)
    if not any(r.get("name", "").endswith("/" + repository) for r in existing):
        gcloud("artifacts", "repositories", "create", repository, "--repository-format=docker", "--location=" + region)
    token = subprocess.run(["gcloud", "auth", "print-access-token", "--impersonate-service-account=" + os.environ["RUNNER_SERVICE_ACCOUNT"]],
                           check=True, capture_output=True, text=True).stdout.strip()
    # Credentials live only in the run's private temporary directory.
    docker_config = Path.cwd() / "docker-config"
    docker_config.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")}
    environment["DOCKER_CONFIG"] = str(docker_config)
    registry = region + "-docker.pkg.dev"
    subprocess.run(["docker", "login", "-u", "oauth2accesstoken", "--password-stdin", registry],
                   input=token, text=True, env=environment, check=True, stdout=subprocess.DEVNULL)
    images = {}
    for kind, source in pinned.items():
        destination = f"{registry}/{project}/{repository}/{kind}:" + os.environ["VERSION"]
        subprocess.run(["docker", "pull", "--platform=linux/amd64", source], env=environment, check=True)
        local = json.loads(subprocess.run(["docker", "image", "inspect", source], env=environment,
                           check=True, capture_output=True, text=True).stdout)
        if (not isinstance(local, list) or len(local) != 1 or local[0].get("Os") != "linux"
                or local[0].get("Architecture") != "amd64" or not image_source_matches(source, local[0].get("RepoDigests"))
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", local[0].get("Id", ""))):
            raise ValueError("pulled image does not match release pin/platform")
        # Tag the inspected immutable local config ID, not any mutable source tag.
        subprocess.run(["docker", "tag", local[0]["Id"], destination], env=environment, check=True)
        subprocess.run(["docker", "push", destination], env=environment, check=True)
        image = gcloud("artifacts", "docker", "images", "describe", destination)
        digest = image.get("image_summary", {}).get("digest")
        if digest != source.split("@", 1)[1]:
            raise ValueError("mirrored image digest differs from release pin")
        images[kind] = destination.split(":" , 1)[0] + "@" + digest
    return images


def storage_headers():
    # Mint again for release: certificate/health verification may outlast the
    # access token used to acquire the lock. Never print or persist this token.
    token = subprocess.run(["gcloud", "auth", "print-access-token",
        "--impersonate-service-account=" + os.environ["RUNNER_SERVICE_ACCOUNT"]],
        check=True, capture_output=True, text=True).stdout.strip()
    if not token:
        raise ValueError("storage identity unavailable")
    return {"Authorization": "Bearer " + token, "Content-Type": "application/json"}


@contextmanager
def orchestration_mutex():
    # Terraform's state lock covers individual commands, not the interval between
    # the targeted apply, migration execution and full apply. A retained GCS
    # object serializes the whole orchestration; no expiration or auto-stealing.
    bucket = urllib.parse.quote(os.environ["STATE_BUCKET"], safe="")
    object_name = "deployments/" + os.environ["DEPLOYMENT_ID"] + "/orchestration.lock"
    query = urllib.parse.urlencode({"uploadType": "media", "name": object_name, "ifGenerationMatch": "0"})
    url = "https://storage.googleapis.com/upload/storage/v1/b/" + bucket + "/o?" + query
    owner = json.dumps({"runId": os.environ["RUN_ID"]}, separators=(",", ":")).encode()
    try:
        receipt = json.loads(request(url, owner, storage_headers(), limit=65536))
    except urllib.error.HTTPError as error:
        if error.code == 412:
            raise ValueError("another orchestration holds the deployment lock; never auto-steal it") from None
        raise
    generation = receipt.get("generation")
    if not isinstance(generation, str) or not generation.isascii() or not generation.isdecimal() or int(generation) <= 0:
        # Creation may have succeeded. Without an exact receipt, leaving the
        # lock for reviewed manual recovery is safer than deleting somebody's lock.
        raise ValueError("lock generation unavailable; manual recovery required")
    release_url = ("https://storage.googleapis.com/storage/v1/b/" + bucket + "/o/"
                   + urllib.parse.quote(object_name, safe="") + "?ifGenerationMatch=" + generation)
    try:
        yield
    finally:
        # This only deletes the live object if its generation is still ours.
        # A crashed process leaves its lock retained; a replacement owner cannot
        # accidentally be unlocked by this process's finally block.
        request(release_url, headers=storage_headers(), limit=65536, method="DELETE")


def inputs(images):
    return {"deployment_id": os.environ["DEPLOYMENT_ID"], "domain_name": os.environ["DOMAIN_NAME"],
        "owner_email": os.environ["OWNER_EMAIL"], "openwork_version": os.environ["VERSION"],
        "control_plane_origin": os.environ["CONTROL_PLANE_ORIGIN"], "size": "small",
        "project_id": os.environ["PROJECT_ID"], "project_number": os.environ["PROJECT_NUMBER"],
        "region": os.environ["REGION"], "dns_zone_name": os.environ["DNS_ZONE_NAME"], "images": images}


def terraform_environment(root):
    # Cloud Shell may already have debug logging, CLI arguments, a different
    # backend, or provider dev_overrides configured. None belongs to this run:
    # TF_LOG can print credentials and dev_overrides bypass provider lock hashes.
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("TF_", "GOOGLE_BACKEND_")) and key not in
                   ("GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN")}
    config = root / "terraform.rc"
    config.write_text("# Verified providers from the release lock file only.\n")
    config.chmod(0o600)
    environment.update(TF_CLI_CONFIG_FILE=str(config), TF_IN_AUTOMATION="1",
                       GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=os.environ["RUNNER_SERVICE_ACCOUNT"])
    return environment


def apply(root, images):
    tf_root = root / "infra/managed-deployments/gcp/terraform"
    binary = terraform_binary(root)
    environment = terraform_environment(root)
    variables = tf_root / "managed.auto.tfvars.json"
    variables.write_text(json.dumps(inputs(images)))
    variables.chmod(0o600)
    subprocess.run([binary, "init", "-input=false", "-lockfile=readonly",
        "-backend-config=bucket=" + os.environ["STATE_BUCKET"],
        "-backend-config=prefix=deployments/" + os.environ["DEPLOYMENT_ID"],
        "-backend-config=impersonate_service_account=" + os.environ["RUNNER_SERVICE_ACCOUNT"]], cwd=tf_root, env=environment, check=True)

    def approved_plan(label, extra=()):
        plan = tf_root / (label + ".tfplan")
        subprocess.run([binary, "plan", "-input=false", "-lock-timeout=120s", *extra, "-out=" + str(plan)], cwd=tf_root, env=environment, check=True)
        raw = subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root, env=environment)
        if unsafe_changes(json.loads(raw)):
            raise ValueError("refusing deletion/replacement of data-bearing resources")
        subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, env=environment, check=True)
    # Deliberate two-phase deployment: schema migration must complete before
    # Terraform starts new service revisions. Both phases use saved, inspected plans.
    approved_plan("migration", ["-target=google_cloud_run_v2_job.migrate"])
    gcloud("run", "jobs", "execute", name(os.environ["DEPLOYMENT_ID"]) + "-migrate",
           "--region=" + os.environ["REGION"], "--wait")
    approved_plan("platform")
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root, env=environment)
    return {key: value["value"] for key, value in json.loads(raw).items()}


def verify_services(outputs):
    for service in outputs["service_names"].values():
        status = gcloud("run", "services", "describe", service, "--region=" + os.environ["REGION"])
        observed = status.get("status", {})
        generation = status.get("metadata", {}).get("generation")
        if (generation is None or str(observed.get("observedGeneration")) != str(generation)
                or not any(c.get("type") == "Ready" and c.get("status") == "True" for c in observed.get("conditions", []))):
            raise ValueError("latest service revision not ready")


def verify_health(outputs, attempts=120, delay=30):
    web, api = "https://" + os.environ["DOMAIN_NAME"], "https://api." + os.environ["DOMAIN_NAME"]
    if outputs["web_url"] != web or outputs["api_url"] != api:
        raise ValueError("unexpected service origin")
    for attempt in range(attempts):
        try:
            health = json.loads(request(api + "/health", limit=65536))
            ready = json.loads(request(api + "/ready", limit=65536))
            web_ready = json.loads(request(web + "/api/ready", limit=65536))
            request(web + "/setup", limit=1024 * 1024, same_origin_redirects=True)
            if (all(check.get("ok") is True and check.get("service") == "den-api" for check in (health, ready))
                    and web_ready.get("ok") is True and web_ready.get("service") == "den-web"):
                return
        except Exception:
            pass
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise ValueError("HTTPS health not verified; check public DNS and CAA, then retry")


def main():
    token = enroll()
    current = (1, "runner_connected", "runner_failed")
    try:
        report(token, 1, "runner_connected")
        # install.py verifies the pinned bundle and its entire inventory before
        # bootstrap and execution; this milestone cannot precede that check.
        current = (2, "release_verified", "release_verification_failed")
        report(token, 2, "release_verified")
        current = (3, "account_verified", "runner_failed")
        from argparse import Namespace
        verify_target(Namespace(**{key.lower(): os.environ[key] for key in
            ("PROJECT_ID", "PROJECT_NUMBER", "DNS_ZONE_NAME", "DOMAIN_NAME")}))
        report(token, 3, "account_verified")
        current = (4, "infrastructure_applied", "infrastructure_failed")
        with orchestration_mutex():
            outputs = apply(Path.cwd(), mirror_images())
            report(token, 4, "infrastructure_applied")
            current = (5, "services_ready", "service_unhealthy")
            verify_services(outputs)
            report(token, 5, "services_ready")
            current = (6, "health_verified", "health_check_failed")
            verify_health(outputs)
            # First report must be accepted, not just queued. The health job exits
            # nonzero when the control plane rejects its signed report.
            gcloud("run", "jobs", "execute", outputs["health_agent"], "--region=" + os.environ["REGION"], "--wait")
        report(token, 6, "health_verified")
        print("OpenWork is ready. Retrieve the administrator setup code from this deployment's Secret Manager bootstrap secret.")
    except Exception:
        sequence, step, code = current
        report(token, sequence, step, "failed", code)
        raise


if __name__ == "__main__":
    main()
