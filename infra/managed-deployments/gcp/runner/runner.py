"""Verified runner. Runs inside the customer's Cloud Build build as the deployment's
runner service account, using only that build's own identity."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import re
from string import Template
import tarfile
import time
import urllib.error
import urllib.parse
import zipfile

from install import APIS, HEALTH_ROLES, RUNNER_ROLES, access_token, cloud, name, read_object, request, release_images, verify_target

TERRAFORM_VERSION = "1.16.5"
TERRAFORM_SHA256 = "2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4"
# The build image has no Docker client. This is Docker's own static Linux/amd64
# client archive; only its client binary is used, against Cloud Build's daemon.
# 28.x negotiates with daemons from API 1.24 up, including ones that need 1.44.
DOCKER_VERSION = "28.5.2"
DOCKER_SHA256 = "ea90cfd12e1eeb12aa1c971741adb8bd4ed88e2a574eaac13f5029a1dbc6300d"
PROTECTED_TYPES = {"google_sql_database_instance", "google_sql_database", "google_sql_user",
                   "google_secret_manager_secret", "google_secret_manager_secret_version",
                   "google_storage_bucket", "google_kms_crypto_key", "google_compute_network", "random_password",
                   "google_cloud_run_v2_service", "google_compute_global_address", "google_compute_region_network_endpoint_group",
                   "google_compute_backend_service", "google_compute_managed_ssl_certificate", "google_compute_url_map",
                   "google_compute_target_https_proxy", "google_compute_global_forwarding_rule"}


def gcloud(*args, timeout=None):
    return cloud(*args, project=os.environ["PROJECT_ID"], timeout=timeout)


def id_token(audience):
    # Den needs email and email_verified claims and a token younger than a
    # minute. The runner asks IAM Credentials for a token for ITSELF, which is
    # the same API and token shape gcloud used when a person impersonated it.
    # Bootstrap grants only that self-binding; no other identity is involved.
    account = os.environ["RUNNER_SERVICE_ACCOUNT"]
    url = ("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
           + urllib.parse.quote(account, safe="@") + ":generateIdToken")
    body = json.dumps({"audience": audience, "includeEmail": True}).encode()
    for attempt in range(8):
        try:
            reply = json.loads(request(url, body, {"Authorization": "Bearer " + access_token(), "Content-Type": "application/json"}, limit=65536))
            break
        except urllib.error.HTTPError as error:
            # On a first install the self-binding may be seconds old. A 403 minted
            # nothing; every other failure, and a lasting 403, stops the run.
            if error.code != 403 or attempt == 7:
                raise
            time.sleep(15)
    token = reply.get("token")
    if not isinstance(token, str) or not token:
        raise ValueError("runner identity token unavailable")
    return token


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
    unsafe = []
    for resource in plan.get("resource_changes", []):
        kind, change = resource.get("type"), resource.get("change", {})
        actions = change.get("actions", [])
        before, after = change.get("before"), change.get("after")
        blocked = kind in PROTECTED_TYPES and "delete" in actions
        if before is not None and kind in {"random_password", "google_secret_manager_secret_version"}:
            # Existing secret versions/generators must remain byte-identical. No
            # write-only conversion or unknown-value exception is authorized.
            blocked |= actions != ["no-op"]
        if before is not None and kind == "google_sql_user":
            blocked |= after is None or before.get("password") != after.get("password") or bool(change.get("after_unknown", {}).get("password"))
        if before is not None and kind == "google_sql_database_instance":
            blocked |= after is None or before.get("database_version") != after.get("database_version")
        if blocked:
            unsafe.append(resource["address"])
    return unsafe


def wait_for_completion(check, message, timeout=600):
    # Only observe here: never replay an update, execution or SQL migration.
    deadline = time.monotonic() + timeout
    while True:
        if check():
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError(message)
        time.sleep(min(3, remaining))


@contextmanager
def maintenance_command():
    try:
        yield
    except subprocess.TimeoutExpired:
        # Provider writes may still finish remotely. Never replay them, echo
        # command output or resume traffic after an uncertain fence/read.
        print(json.dumps({"maintenanceCommand": {"errorCode": "command_deadline"}}))
        raise ValueError("maintenance command deadline exceeded; inspect before retry") from None


def maintenance_cloud(*args):
    with maintenance_command():
        return gcloud(*args, timeout=30)


def service_status(service):
    return maintenance_cloud("run", "services", "describe", service, "--region=" + os.environ["REGION"])


def disabled_service(status):
    metadata, observed = status.get("metadata", {}), status.get("status", {})
    annotations = metadata.get("annotations", {})
    traffic = status.get("spec", {}).get("traffic", [])
    return (str(observed.get("observedGeneration")) == str(metadata.get("generation"))
            and metadata.get("generation") is not None
            and annotations.get("run.googleapis.com/scalingMode") == "manual"
            and annotations.get("run.googleapis.com/manualInstanceCount") == "0"
            and isinstance(traffic, list) and bool(traffic)
            and all(not entry.get("tag") for entry in traffic)
            and all(not entry.get("tag") for entry in observed.get("traffic", [])))


def instance_observations(service, since):
    # One added read permission: monitoring.timeSeries.list, not monitoring.viewer.
    # Missing, stale or paginated results are UNKNOWN, never zero instances.
    now = datetime.now(timezone.utc)
    query = urllib.parse.urlencode({
        "filter": 'metric.type="run.googleapis.com/container/instance_count" AND resource.type="cloud_run_revision" '
                  'AND resource.labels.service_name="' + service + '" AND resource.labels.location="' + os.environ["REGION"] + '"',
        "interval.startTime": since.isoformat(), "interval.endTime": now.isoformat(), "view": "FULL",
    })
    url = "https://monitoring.googleapis.com/v3/projects/" + os.environ["PROJECT_ID"] + "/timeSeries?" + query
    return json.loads(request(url, headers=storage_headers(), limit=1024 * 1024))


def drained_instances(observations, since, required_revisions):
    if observations.get("nextPageToken") or not observations.get("timeSeries") or not required_revisions:
        return False
    observed_states = {(series.get("resource", {}).get("labels", {}).get("revision_name"),
                        series.get("metric", {}).get("labels", {}).get("state")) for series in observations["timeSeries"]}
    # Do not confuse zero active requests with zero idle instances. Both states
    # of every previously observed/routed revision must have explicit fresh zeroes.
    if not {(revision, state) for revision in required_revisions for state in ("active", "idle")}.issubset(observed_states):
        return False
    for series in observations["timeSeries"]:
        points = series.get("points", [])
        if not points:
            return False
        latest = points[0]
        stamp = datetime.fromisoformat(latest.get("interval", {}).get("endTime", "").replace("Z", "+00:00"))
        if stamp < since or (datetime.now(timezone.utc) - stamp).total_seconds() > 180:
            return False
        if latest.get("value", {}).get("int64Value") != "0":
            return False
    return True


def verify_no_running_migration(timeout=600):
    def completed():
        executions = maintenance_cloud("run", "jobs", "executions", "list", "--job=" + name(os.environ["DEPLOYMENT_ID"]) + "-migrate",
                                       "--region=" + os.environ["REGION"])
        if not isinstance(executions, list):
            raise ValueError("unknown prior migration executions; inspect before retry")
        for execution in executions:
            status = execution.get("status", {})
            if not status.get("completionTime") or not any(condition.get("type") == "Completed" and condition.get("status") in ("True", "False")
                                                           for condition in status.get("conditions", [])):
                return False
        return True
    wait_for_completion(completed, "prior migration still running or unknown before deadline; inspect before retry", timeout)


def maintenance_fence(plan, timeout=900):
    # Prior state is read, not guessed from cloud absence. Fence every existing
    # owned service before native migration; never delete services or revisions.
    def resources(module):
        yield from module.get("resources", [])
        for child in module.get("child_modules", []):
            yield from resources(child)
    prior = list(resources(plan.get("prior_state", {}).get("values", {}).get("root_module", {})))
    existing = [r for r in prior if r.get("type") == "google_cloud_run_v2_service"]
    if not existing:
        # Migration precedes service creation, so an interrupted first install
        # can have a running migration even though neither service is in state.
        migration = name(os.environ["DEPLOYMENT_ID"]) + "-migrate"
        for resource in prior:
            values = resource.get("values", {})
            if resource.get("type") == "google_cloud_run_v2_job" and values.get("name") == migration:
                if values.get("project") != os.environ["PROJECT_ID"] or values.get("location") != os.environ["REGION"]:
                    raise ValueError("unexpected migration target")
                verify_no_running_migration()
        return False
    expected = {name(os.environ["DEPLOYMENT_ID"]) + suffix for suffix in ("-api", "-web")}
    if len(existing) != 2 or {r.get("values", {}).get("name") for r in existing} != expected:
        raise ValueError("unknown service ownership; refusing maintenance")
    region, project = os.environ["REGION"], os.environ["PROJECT_ID"]
    for resource in existing:
        values = resource.get("values", {})
        if values.get("project") != project or values.get("location") != region:
            raise ValueError("unexpected service target")
    # A prior caught/unknown execution can outlive the old runner's mutex.
    # Inspect it; never blindly retry migrations or cancel somebody else's job.
    verify_no_running_migration()
    # Permission/read preflight before taking anything offline.
    started = datetime.now(timezone.utc)
    revisions = {}
    for service in sorted(expected):
        observations = instance_observations(service, started - timedelta(minutes=5))
        if observations.get("nextPageToken"):
            raise ValueError("incomplete instance inventory")
        live = service_status(service)
        if live.get("metadata", {}).get("name") != service:
            raise ValueError("unexpected live service identity")
        revisions[service] = {series.get("resource", {}).get("labels", {}).get("revision_name")
                              for series in observations.get("timeSeries", [])}
        revisions[service].update(entry.get("revisionName") for entry in live.get("status", {}).get("traffic", []))
        if not revisions[service] or None in revisions[service]:
            raise ValueError("incomplete revision inventory")
    for service in sorted(expected):
        # Tag-only revisions are NOT disabled by scaling zero. Remove their
        # request/restart path first; no rollback or tag is restored on failure.
        maintenance_cloud("run", "services", "update-traffic", service, "--clear-tags", "--region=" + region)
        maintenance_cloud("run", "services", "update", service, "--scaling=0", "--region=" + region)
    disabled_at = datetime.now(timezone.utc)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        states = [service_status(service) for service in sorted(expected)]
        if not all(disabled_service(status) for status in states):
            # The completed update can precede propagation to describe/status.
            # Never migrate while waiting for the disabled generation to appear.
            time.sleep(min(3, max(0, deadline - time.monotonic())))
            continue
        if all(drained_instances(instance_observations(service, disabled_at), disabled_at, revisions[service]) for service in sorted(expected)):
            # Recheck to catch an independent deployer resuming a service while
            # monitoring was read. Independent deployers are unsupported.
            if not all(disabled_service(service_status(service)) for service in sorted(expected)):
                raise ValueError("service resumed while draining; maintenance retained")
            verify_no_running_migration()
            return True
        time.sleep(3)
    raise ValueError("no authoritative zero-instance observation; maintenance retained")


def verify_maintained_revisions(images, timeout=600):
    def ready():
        for key, suffix in (("den_api", "-api"), ("den_web", "-web")):
            service = name(os.environ["DEPLOYMENT_ID"]) + suffix
            live = service_status(service)
            status = live.get("status", {})
            revision = status.get("latestReadyRevisionName")
            traffic = status.get("traffic", [])
            template = live.get("spec", {}).get("template", {})
            containers = template.get("spec", {}).get("containers", [])
            service_uid = live.get("metadata", {}).get("uid")
            if (not disabled_service(live) or not service_uid or not isinstance(revision, str)
                    or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", revision) or status.get("latestCreatedRevisionName") != revision
                    or len(traffic) != 1 or traffic[0].get("revisionName") != revision or traffic[0].get("percent") != 100
                    or len(containers) != 1 or containers[0].get("image") != images[key]):
                return False
            if key == "den_api" and (containers[0].get("command") != ["node"] or containers[0].get("args") != ["/app/ee/apps/den-api/dist/main.js"]):
                return False
            # v2-created services can omit template.metadata.name. A revision's
            # v1 owner is Configuration, not Service: bind it through the scoped
            # v2 resource instead of comparing unrelated Kubernetes owner UIDs.
            full_name = ("projects/" + os.environ["PROJECT_ID"] + "/locations/" + os.environ["REGION"]
                         + "/services/" + service + "/revisions/" + revision)
            actual = json.loads(request("https://run.googleapis.com/v2/" + urllib.parse.quote(full_name, safe="/"),
                                        headers=storage_headers(), limit=1024 * 1024))
            actual_containers = actual.get("containers", [])
            if (actual.get("name") != full_name or actual.get("service") != service or not actual.get("uid")
                    or not any(condition.get("type") == "Ready" and condition.get("state") == "CONDITION_SUCCEEDED"
                               for condition in actual.get("conditions", []))
                    or len(actual_containers) != 1 or actual_containers[0].get("image") != images[key]):
                return False
            if key == "den_api" and (actual_containers[0].get("command") != ["node"] or actual_containers[0].get("args") != ["/app/ee/apps/den-api/dist/main.js"]):
                return False
            current = service_status(service)
            if (not disabled_service(current) or current.get("metadata", {}).get("uid") != service_uid
                    or current.get("metadata", {}).get("generation") != live["metadata"]["generation"]
                    or current.get("status", {}).get("latestReadyRevisionName") != revision
                    or current.get("status", {}).get("latestCreatedRevisionName") != revision
                    or current.get("status", {}).get("traffic") != traffic):
                return False
        return True
    wait_for_completion(ready, "API-only revision ownership not verified before deadline; maintenance retained", timeout)


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


def docker_binary(root):
    url = f"https://download.docker.com/linux/static/stable/x86_64/docker-{DOCKER_VERSION}.tgz"
    data = request(url, limit=150 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != DOCKER_SHA256:
        raise ValueError("Docker client checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        member = archive.getmember("docker/docker")
        if not member.isfile():
            raise ValueError("unexpected Docker client archive")
        binary = root / "docker-bin"
        binary.write_bytes(archive.extractfile(member).read())
    binary.chmod(0o700)
    return str(binary)


def release_manifest():
    return json.loads((Path(__file__).resolve().parents[4] / "release.json").read_text())


def load_release_images():
    # This file is inside the bundle whose SHA-256 install.py checked before
    # bootstrap. Runtime environment variables can never select source images.
    return release_images(release_manifest(), os.environ["VERSION"])


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
    token = access_token()
    docker = docker_binary(Path.cwd())
    # Credentials live only in the run's private temporary directory.
    docker_config = Path.cwd() / "docker-config"
    docker_config.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")}
    environment["DOCKER_CONFIG"] = str(docker_config)
    registry = region + "-docker.pkg.dev"
    subprocess.run([docker, "login", "-u", "oauth2accesstoken", "--password-stdin", registry],
                   input=token, text=True, env=environment, check=True, stdout=subprocess.DEVNULL)
    images = {}
    for kind, source in pinned.items():
        destination = f"{registry}/{project}/{repository}/{kind}:" + os.environ["VERSION"]
        subprocess.run([docker, "pull", "--platform=linux/amd64", source], env=environment, check=True)
        local = json.loads(subprocess.run([docker, "image", "inspect", source], env=environment,
                           check=True, capture_output=True, text=True).stdout)
        if (not isinstance(local, list) or len(local) != 1 or local[0].get("Os") != "linux"
                or local[0].get("Architecture") != "amd64" or not image_source_matches(source, local[0].get("RepoDigests"))
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", local[0].get("Id", ""))):
            raise ValueError("pulled image does not match release pin/platform")
        # Tag the inspected immutable local config ID, not any mutable source tag.
        subprocess.run([docker, "tag", local[0]["Id"], destination], env=environment, check=True)
        subprocess.run([docker, "push", destination], env=environment, check=True)
        image = gcloud("artifacts", "docker", "images", "describe", destination)
        digest = image.get("image_summary", {}).get("digest")
        if digest != source.split("@", 1)[1]:
            raise ValueError("mirrored image digest differs from release pin")
        images[kind] = destination.split(":" , 1)[0] + "@" + digest
    return images


def storage_headers():
    # Mint again for release: certificate/health verification may outlast the
    # access token used to acquire the lock. Never print or persist this token.
    with maintenance_command():
        token = access_token(timeout=30)
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
    # buildId names the Cloud Build build that owns the lock, so a customer
    # administrator can see whether that build is still running before recovery.
    owner = json.dumps({"runId": os.environ["RUN_ID"], "buildId": os.environ["BUILD_ID"]}, separators=(",", ":")).encode()
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


class StepFailure(Exception):
    """A failure with a specific, allowlisted code for the control plane."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---- Customer-owned objects next to the Terraform state ----
# deployments/<id>/overrides.json  optional tuning, validated against an allowlist
# deployments/<id>/ejected.json    the owner took the deployment over; refuse to run
# deployments/<id>/applied/        what the last successful apply used (no secrets)
# Same keys, units and rules as the AWS runner unless noted.
STATE_OBJECT_LIMIT = 16 * 1024
# Memory (MiB, whole GiB) Cloud Run allows for each CPU value (1024 per vCPU).
CLOUD_RUN_MEMORY = {1024: tuple(range(1024, 4097, 1024)), 2048: tuple(range(1024, 8193, 1024)),
                    4096: tuple(range(2048, 16385, 1024)), 8192: tuple(range(4096, 32769, 1024))}
# What each size profile gives before tuning (gcp/terraform/main.tf). Tuning never goes below it.
SIZE_BASELINE = {"small": {"api": {"cpu": 2048, "memory": 2048, "min_instances": 1, "max_instances": 10},
                           "web": {"cpu": 1024, "memory": 1024, "min_instances": 1, "max_instances": 10},
                           "database": {"disk_size_gb": 20}}}
MAX_MIN_INSTANCES = 10
MAX_INSTANCES = 100  # Cloud Run scales between the two; AWS runs a fixed count.
MAX_DISK_SIZE_GB = 4096
DATABASE_TIER = re.compile(r"db-custom-(1|2|4|8|16|32)-([1-9][0-9]{3,5})")
OTEL_NAME = re.compile(r"OTEL_[A-Z0-9_]{1,120}")
# The AWS list, plus the names the shared Cloud Run module refuses as plain values.
CREDENTIAL_NAME = re.compile(r"(?i)(secret|password|passwd|token|api_key|private_key|encryption_key|credential|authorization|headers"
                             r"|bootstrap_code|database_url|smtp_pass)")
URL_CREDENTIAL = re.compile(r"://[^/@\s]*@")


def deployment_key(name_):
    return "deployments/" + os.environ["DEPLOYMENT_ID"] + "/" + name_


def state_object(name_):
    """A customer-owned object beside the state, or None when it is absent.

    Absence is a definite "not found" only: a denied or broken read stops the
    run instead of being read as "not there".
    """
    try:
        return read_object(os.environ["STATE_BUCKET"], deployment_key(name_), storage_headers(), limit=STATE_OBJECT_LIMIT)
    except ValueError:
        return b"\0" * (STATE_OBJECT_LIMIT + 1)  # larger than the limit; reported by the caller
    except OSError:
        print(f"Could not look for {name_} in the deployment's state bucket; nothing was changed.")
        raise StepFailure("infrastructure_failed") from None


def refuse_ejected_run():
    if state_object("ejected.json") is None:
        return
    print(f'This deployment was taken over by its owner: gs://{os.environ["STATE_BUCKET"]}/{deployment_key("ejected.json")} exists. '
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

    def section(name_, allowed):
        value = document.get(name_)
        if name_ not in document:
            return None
        if not isinstance(value, dict):
            problems.append(f"{name_} must be an object")
            return None
        for key in sorted(set(value) - set(allowed), key=str):
            problems.append(f"{name_}.{str(key)[:64]} cannot be tuned")
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
            if memory not in CLOUD_RUN_MEMORY.get(cpu, ()):
                problems.append(f"{service}.cpu and {service}.memory must be a Cloud Run size together "
                                f"(cpu {cpu} allows memory {', '.join(map(str, CLOUD_RUN_MEMORY.get(cpu, ()))) or 'nothing; use 1024, 2048, 4096 or 8192'})")
            elif cpu < baseline[service]["cpu"] or memory < baseline[service]["memory"]:
                problems.append(f"{service}.cpu and {service}.memory cannot be below the {size} size "
                                f"(cpu {baseline[service]['cpu']}, memory {baseline[service]['memory']})")
        low, high = tuned.get("min_instances", baseline[service]["min_instances"]), tuned.get("max_instances", baseline[service]["max_instances"])
        if "min_instances" in tuned and not 1 <= tuned["min_instances"] <= MAX_MIN_INSTANCES:
            problems.append(f"{service}.min_instances must be from 1 to {MAX_MIN_INSTANCES}")
        elif "max_instances" in tuned and not 1 <= tuned["max_instances"] <= MAX_INSTANCES:
            problems.append(f"{service}.max_instances must be from 1 to {MAX_INSTANCES}")
        elif low > high:
            problems.append(f"{service}.max_instances cannot be below {service}.min_instances ({low})")
        if tuned:
            overrides[service] = tuned

    given = section("database", ("tier", "disk_size_gb", "high_availability"))
    if given is not None:
        tuned = {}
        if "tier" in given:
            tier = DATABASE_TIER.fullmatch(given["tier"]) if isinstance(given["tier"], str) else None
            cpus, megabytes = (int(tier.group(1)), int(tier.group(2))) if tier else (0, 0)
            # Cloud SQL: memory in 256 MB steps, at least 3840 MB, 0.9 to 6.5 GB per vCPU.
            if tier and megabytes % 256 == 0 and megabytes >= 3840 and cpus * 922 <= megabytes <= cpus * 6656:
                tuned["tier"] = given["tier"]
            else:
                problems.append("database.tier must be a Cloud SQL custom tier within its memory rules, such as db-custom-2-7680")
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
            for name_, value in given.items():
                if not OTEL_NAME.fullmatch(str(name_)):
                    refused.append(f"extra_environment.{str(name_)[:64]} is not allowed: only OTEL_ variables can be added")
                elif CREDENTIAL_NAME.search(name_):
                    refused.append(f"extra_environment.{name_} is not allowed: it carries a credential, and overrides never hold secrets")
                elif not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                    refused.append(f"extra_environment.{name_} must be a single-line string of at most 2048 characters")
                elif URL_CREDENTIAL.search(value):
                    refused.append(f"extra_environment.{name_} must not contain a user name or password in a URL")
        problems.extend(refused)
        if given and not refused:
            overrides["extra_environment"] = dict(given)

    if "log_retention_days" in document:
        # Accepted on AWS. Here the services log to the project's Cloud Logging
        # buckets, which this deployment does not own, so it is refused, not ignored.
        problems.append("log_retention_days cannot be tuned on Google Cloud: set retention on the project's Cloud Logging bucket instead")
    return overrides, problems


def customer_overrides():
    """Read and validate the optional overrides.json. None when the owner wrote none."""
    data = state_object("overrides.json")
    if data is None:
        return None
    problems, overrides = [], {}
    def unique(pairs):
        keys = [key for key, _ in pairs]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate key")
        return dict(pairs)
    def constant(_):
        raise ValueError("not a JSON number")
    if len(data) > STATE_OBJECT_LIMIT:
        problems.append(f"the file must be at most {STATE_OBJECT_LIMIT} bytes")
    else:
        try:
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


def storage_below_disk(plan):
    """Databases whose disk the plan would shrink, with the size they have now.

    Cloud SQL never shrinks a disk. A smaller configured size is planned as a
    refused change or a replacement. It happens when database.disk_size_gb is
    lowered or removed, or after Cloud SQL grew the disk by itself.
    """
    refused = {}
    for resource in plan.get("resource_changes", []):
        change = resource.get("change", {})
        before, after = change.get("before") or {}, change.get("after") or {}
        disk = ((before.get("settings") or [{}])[0] or {}).get("disk_size")
        planned = ((after.get("settings") or [{}])[0] or {}).get("disk_size")
        if resource.get("type") == "google_sql_database_instance" and whole_number(disk) and whole_number(planned) and planned < disk:
            refused[resource["address"]] = disk
    return refused


def inputs(images, overrides=None):
    values = {"deployment_id": os.environ["DEPLOYMENT_ID"], "domain_name": os.environ["DOMAIN_NAME"],
        "owner_email": os.environ["OWNER_EMAIL"], "openwork_version": os.environ["VERSION"],
        "control_plane_origin": os.environ["CONTROL_PLANE_ORIGIN"], "size": "small",
        "project_id": os.environ["PROJECT_ID"], "project_number": os.environ["PROJECT_NUMBER"],
        "region": os.environ["REGION"], "dns_zone_name": os.environ["DNS_ZONE_NAME"], "images": images}
    if overrides is not None:
        # One typed root variable; the Terraform root merges it over the size
        # profile. No file means the inputs are what they were before overrides.
        values["overrides"] = overrides
    return values


def terraform_environment(root):
    # The environment may carry debug logging, CLI arguments, a different
    # backend, other credentials or provider dev_overrides. None belongs to this
    # run: TF_LOG can print credentials and dev_overrides bypass provider lock
    # hashes. Terraform and its backend use the build's own identity only.
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("TF_", "GOOGLE_BACKEND_")) and key not in
                   ("GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN",
                    "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT")}
    config = root / "terraform.rc"
    config.write_text("# Verified providers from the release lock file only.\n")
    config.chmod(0o600)
    environment.update(TF_CLI_CONFIG_FILE=str(config), TF_IN_AUTOMATION="1")
    return environment


def backend_settings():
    return {"bucket": os.environ["STATE_BUCKET"], "prefix": "deployments/" + os.environ["DEPLOYMENT_ID"]}


def apply(root, images, overrides=None):
    tf_root = root / "infra/managed-deployments/gcp/terraform"
    binary = terraform_binary(root)
    environment = terraform_environment(root)
    variables = tf_root / "managed.auto.tfvars.json"
    variables.write_text(json.dumps(inputs(images, overrides)))
    variables.chmod(0o600)
    subprocess.run([binary, "init", "-input=false", "-lockfile=readonly",
        *("-backend-config=" + key + "=" + value for key, value in backend_settings().items())],
        cwd=tf_root, env=environment, check=True)

    def approved_plan(label):
        plan = tf_root / (label + ".tfplan")
        subprocess.run([binary, "plan", "-input=false", "-lock-timeout=120s", "-out=" + str(plan)], cwd=tf_root, env=environment, check=True)
        raw = json.loads(subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root, env=environment))
        shrunk = storage_below_disk(raw)
        if shrunk:
            print(f"The database disk is {max(shrunk.values())} GB and cannot shrink. Set database.disk_size_gb in overrides.json "
                  "to at least that size; nothing was changed.")
            raise StepFailure("infrastructure_failed")
        if unsafe_changes(raw):
            raise ValueError("refusing protected replacement, secret change or database version change; maintenance retained")
        return plan, raw
    plan, decoded = approved_plan("platform")
    maintained = maintenance_fence(decoded)
    if maintained:
        # Keep scale zero THROUGH revision deployment. Restoring auto in the
        # template-changing update could restart an old migration-capable revision.
        variables.write_text(json.dumps({**inputs(images, overrides), "managed_maintenance": True}))
        plan, _ = approved_plan("maintained-platform")
    # run_execution_token executes and waits once inside the module graph. A
    # second CLI jobs execute here would run the migration twice.
    subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, env=environment, check=True)
    if maintained:
        verify_maintained_revisions(images)
        variables.write_text(json.dumps({**inputs(images, overrides), "managed_maintenance": False}))
        plan, _ = approved_plan("resume-api-only")
        subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, env=environment, check=True)
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root, env=environment)
    return {key: value["value"] for key, value in json.loads(raw).items()}


PUBLIC_OUTPUTS = ("web_url", "api_url", "setup_url", "health_agent", "service_names")
TAKEOVER_README = Template("""# OpenWork deployment $deployment_id

Written by the OpenWork installer after its last successful apply (OpenWork
$version, run $run_id) in Google Cloud project $project_id, region $region.
This folder describes that apply. It holds no secrets, no Terraform state and
no installer credentials.

| File | Contents |
| --- | --- |
| `release.json` | The installer release that was applied: version, bundle URL and SHA-256 |
| `inputs.auto.tfvars.json` | Every Terraform input of that apply, your overrides included |
| `backend.tf.json` | Where this deployment's Terraform state lives |
| `terraform-version.json` | The exact Terraform version, with the Linux download checksum |
| `outputs.json` | The non-sensitive Terraform outputs |
| `unmanaged.json` | Resources that exist outside the Terraform state |

## Tune it and stay managed

Write `gs://$bucket/$prefix/overrides.json`. The next installer run you
approve from OpenWork (an update or a retry) applies it. The installer checks
the file before it changes anything and refuses the run when a setting is not
allowed.

```json
{
  "api": { "cpu": 4096, "memory": 8192, "min_instances": 2, "max_instances": 20 },
  "web": { "memory": 2048 },
  "database": { "tier": "db-custom-2-7680", "disk_size_gb": 50, "high_availability": true },
  "extra_environment": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318" }
}
```

Every key is optional and nothing else can be set: not the database version,
deletion protection, backups, secrets or the network. `cpu` counts 1024 per
vCPU (1024, 2048, 4096 or 8192) and `memory` is MiB in whole GiB. Cloud Run
scales between `min_instances` (1 to 10) and `max_instances` (up to 100). Sizes
cannot go below the installed size. `log_retention_days` is not accepted on
Google Cloud: set retention on the project's Cloud Logging bucket. The database
disk only grows: keep `disk_size_gb` at or above the current disk, or the run
is refused. Changing the database tier restarts the database. Like every
update, the run that applies the file takes both services offline briefly. The
file is applied by the next installer run and every run after it; delete a
setting to return it to its default.

## Take it over

Take over only when no installer run is in progress and the last run reached
"Infrastructure installed". After a run that failed before that step, this
folder still describes the apply before it: finish or retry that run first.

1. Stop the installer by writing the marker (its content is up to you):

   ```sh
   echo '{"reason":"managed by our platform team"}' | gcloud storage cp - gs://$bucket/$prefix/ejected.json
   ```

   While it exists the installer refuses every run for this deployment. Health
   reports to OpenWork continue.
2. Download the bundle named in `release.json`, check it and unpack it:

   ```sh
   curl -fsSLo bundle.tar.gz '$bundle_url'
   echo '$bundle_sha256  bundle.tar.gz' | shasum -a 256 -c -
   mkdir openwork && tar -xzf bundle.tar.gz -C openwork
   ```
3. Install Terraform $terraform_version, exactly that version.
4. Copy two files from this folder into
   `openwork/infra/managed-deployments/gcp/terraform/`:
   `inputs.auto.tfvars.json` under the same name, and `backend.tf.json` as
   `backend_override.tf.json`.
5. In that directory:

   ```sh
   terraform init -lockfile=readonly
   terraform plan -lock-timeout=120s
   ```

   The plan must end with "No changes". If it lists changes, do not apply:
   something was changed outside Terraform, or the files are not from the last
   apply.

From here the deployment is yours: edit the inputs or the Terraform and apply
with your own review. The installer's safeguard against deleting or replacing
the database, secrets and services no longer runs for you; read every plan for
those resources.

### Credentials

Use your own identity in project $project_id, for example
`gcloud auth application-default login`. The Terraform configuration names no
identity. The installer's account (`$runner`) is started only by the installer's
builds.

- `terraform plan`: read and write on objects under `gs://$bucket/$prefix/`
  (the state and its lock), and read access to the deployment's resources,
  including its Secret Manager secret versions, which Terraform refreshes.
- `terraform apply` and `terraform destroy`: also create, change and delete
  those resources. The project roles the installer's account holds are listed
  in `unmanaged.json`; an owner of a dedicated project is the simple choice.

The state holds the database password and the application keys. Anyone who can
read it can administer this deployment.

### Hand it back

Delete `ejected.json`. The next installer run applies the installer's inputs
again and reverts what you changed, except that it refuses to delete or replace
the database, secrets or services. Hand back only a deployment whose state you
have not moved to another Terraform or provider version.

## Remove it

1. Take it over (steps 1 to 5) and get a plan with no changes.
2. Keep what you need: export the database first. Removal deletes it and its
   backups.
3. Turn off deletion protection on the database and services:
   `terraform apply -var allow_destroy=true`
4. Run `terraform destroy -var allow_destroy=true` and read the plan before you
   confirm it.
5. Remove what Terraform does not own, listed in `unmanaged.json`: the Artifact
   Registry repository `$name`, the five `$name-…` service accounts and the
   roles granted to them, and the custom role. Enabled APIs can stay.
6. Delete the bucket `$bucket` last. It is the only copy of the Terraform
   state.
""")


def applied_kit(images, overrides, outputs):
    """The applied/ files: everything needed to plan this deployment without OpenWork."""
    deployment, project, region = os.environ["DEPLOYMENT_ID"], os.environ["PROJECT_ID"], os.environ["REGION"]
    bucket, prefix = os.environ["STATE_BUCKET"], name(deployment)
    release = {"provider": "gcp", "version": os.environ["VERSION"]}
    revision = release_manifest().get("installerRevision")
    if whole_number(revision) and revision >= 1:
        release["installerRevision"] = revision
    # Validated by install.py as an immutable GCS generation URL: no signed query to drop.
    release.update({"bundleUrl": os.environ["BUNDLE_URL"], "bundleSha256": os.environ["BUNDLE_SHA256"],
                    "deploymentId": deployment, "runId": os.environ["RUN_ID"]})
    accounts = {kind: f"{prefix}-{kind}@{project}.iam.gserviceaccount.com" for kind in ("runner", "runtime", "web", "health", "scheduler")}
    drain_role = "projects/" + project + "/roles/" + prefix.replace("-", "_") + "_drain"
    unmanaged = {
        "bootstrap": {
            "note": "Created by the approval command with the approving person's credentials. Terraform does not own any of it.",
            "enabledApis": APIS, "serviceAccounts": accounts, "customRole": drain_role,
            "projectRoles": {"runner": [*RUNNER_ROLES, drain_role], "runtime": ["roles/cloudsql.client"], "health": HEALTH_ROLES},
            "serviceAccountRoles": [
                *({"on": accounts[kind], "member": "serviceAccount:" + accounts["runner"], "role": "roles/iam.serviceAccountUser"}
                  for kind in ("runtime", "web", "health", "scheduler")),
                {"on": accounts["runner"], "member": "serviceAccount:" + accounts["runner"], "role": "roles/iam.serviceAccountOpenIdTokenCreator"},
                {"on": accounts["runner"], "member": "each person who approved a run", "role": "roles/iam.serviceAccountUser"}],
            "stateBucket": {"name": bucket, "runnerRole": "roles/storage.objectAdmin",
                            "note": "Holds every version of the Terraform state. Delete it last."},
        },
        "createdByTheInstaller": [
            f"Artifact Registry repository projects/{project}/locations/{region}/repositories/{prefix} and the images mirrored into it",
            "Cloud Build build records and their logs in Cloud Logging",
        ],
        "leftByTerraformDestroy": ["Secret Manager and Cloud SQL resources still inside Google's own recovery or retention windows"],
    }
    readme = TAKEOVER_README.substitute(
        deployment_id=deployment, version=release["version"], run_id=release["runId"], project_id=project, region=region,
        bucket=bucket, prefix="deployments/" + deployment, bundle_url=release["bundleUrl"], bundle_sha256=release["bundleSha256"],
        terraform_version=TERRAFORM_VERSION, runner=accounts["runner"], name=prefix)
    def document(value):
        return json.dumps(value, indent=2, sort_keys=True) + "\n"
    # release.json is written last: its presence means the whole folder is from this run.
    return {
        "inputs.auto.tfvars.json": document(inputs(images, overrides)),
        "backend.tf.json": document({"terraform": {"backend": {"gcs": backend_settings()}}}),
        "terraform-version.json": document({
            "version": TERRAFORM_VERSION, "sha256": TERRAFORM_SHA256, "platform": "linux_amd64",
            "url": f"https://releases.hashicorp.com/terraform/{TERRAFORM_VERSION}/terraform_{TERRAFORM_VERSION}_linux_amd64.zip"}),
        "outputs.json": document({key: outputs[key] for key in PUBLIC_OUTPUTS if key in outputs}),
        "unmanaged.json": document(unmanaged),
        "README.md": readme,
        "release.json": document(release),
    }


def write_applied(images, overrides, outputs, token):
    """Record the apply under deployments/<id>/applied/ in the customer's state bucket."""
    files = applied_kit(images, overrides, outputs)
    # The run's credentials never belong in the record, whatever an input contained.
    if any(credential and credential in content for credential in (os.environ.get("CHALLENGE", ""), token) for content in files.values()):
        raise ValueError("refusing to record a run credential")
    bucket = urllib.parse.quote(os.environ["STATE_BUCKET"], safe="")
    for file, content in files.items():
        object_name = deployment_key("applied/" + file)
        query = urllib.parse.urlencode({"uploadType": "media", "name": object_name})
        headers = {**storage_headers(), "Content-Type": "text/markdown; charset=utf-8" if file.endswith(".md") else "application/json"}
        receipt = json.loads(request("https://storage.googleapis.com/upload/storage/v1/b/" + bucket + "/o?" + query,
                                     content.encode(), headers, limit=65536))
        if receipt.get("name") != object_name:
            raise ValueError("applied record not stored")
    print(f'Recorded this apply in gs://{os.environ["STATE_BUCKET"]}/{deployment_key("applied/")}')


def verify_services(outputs, timeout=600):
    def ready():
        for service in outputs["service_names"].values():
            status = service_status(service)
            observed = status.get("status", {})
            generation = status.get("metadata", {}).get("generation")
            if (generation is None or str(observed.get("observedGeneration")) != str(generation)
                    or not any(c.get("type") == "Ready" and c.get("status") == "True" for c in observed.get("conditions", []))):
                return False
        return True
    wait_for_completion(ready, "latest service revision not ready before deadline", timeout)


def verify_health_job(outputs, timeout=300):
    deadline = time.monotonic() + timeout
    job = name(os.environ["DEPLOYMENT_ID"]) + "-health"
    if outputs.get("health_agent") != job:
        raise ValueError("unexpected health job; not executed")
    execution_name = None
    def diagnostic(code, http_status=None):
        print(json.dumps({"healthExecution": {"execution": execution_name, "errorCode": code, "httpStatus": http_status}}))
    def call(*args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            diagnostic("execution_deadline")
            raise ValueError("owned health execution deadline exceeded")
        try:
            return gcloud(*args, timeout=min(30, remaining))
        except subprocess.TimeoutExpired:
            diagnostic("execution_command_deadline")
            raise ValueError("health execution command deadline exceeded") from None
        except subprocess.CalledProcessError as error:
            # Parse only fixed diagnostic tokens; never echo stderr/stdout,
            # command arguments, credentials or arbitrary provider messages.
            stderr = error.stderr if isinstance(error.stderr, str) else ""
            code = next((candidate for candidate in ("PERMISSION_DENIED", "UNAUTHENTICATED", "RESOURCE_EXHAUSTED", "NOT_FOUND", "DEADLINE_EXCEEDED")
                         if re.search(r"\b" + candidate + r"\b", stderr)), "gcloud_failed")
            status = re.search(r"\b(?:HTTPError|HTTP Error|HTTP|status code)\s*[:=]?\s*([1-5][0-9]{2})\b", stderr)
            diagnostic(code, int(status.group(1)) if status else None)
            raise ValueError("health execution command failed; see safe diagnostic") from None
    def owned(execution):
        metadata = execution.get("metadata", {})
        labels = metadata.get("labels", {})
        return (metadata.get("namespace") in (os.environ["PROJECT_ID"], os.environ["PROJECT_NUMBER"])
                and labels.get("run.googleapis.com/job") == job
                and labels.get("cloud.googleapis.com/location") == os.environ["REGION"])
    # A failed/uncertain start is NEVER replayed. Retain the one creation receipt
    # before polling; Scheduler's separate success cannot satisfy this wait.
    receipt = call("run", "jobs", "execute", job, "--region=" + os.environ["REGION"], "--async")
    candidate = receipt.get("metadata", {}).get("name")
    if (not isinstance(candidate, str) or len(candidate) > 128
            or not re.fullmatch(re.escape(job) + r"-[a-z0-9-]+", candidate) or not owned(receipt)):
        diagnostic("unknown_execution_receipt")
        raise ValueError("health execution ownership unknown; inspect before retry")
    execution_name = candidate
    diagnostic("started")
    def completed():
        execution = call("run", "jobs", "executions", "describe", execution_name, "--region=" + os.environ["REGION"])
        if execution.get("metadata", {}).get("name") != execution_name or not owned(execution):
            diagnostic("execution_mismatch")
            raise ValueError("health execution ownership changed")
        status = execution.get("status", {})
        conditions = status.get("conditions", [])
        if any(condition.get("type") == "Completed" and condition.get("status") == "False" for condition in conditions):
            diagnostic("execution_failed")
            raise ValueError("owned health execution failed")
        if not status.get("completionTime"):
            return False
        if (not any(condition.get("type") == "Completed" and condition.get("status") == "True" for condition in conditions)
                or type(execution.get("spec", {}).get("taskCount")) is not int or execution["spec"]["taskCount"] != 1
                or type(status.get("succeededCount")) is not int or status["succeededCount"] != 1
                or type(status.get("failedCount", 0)) is not int or status.get("failedCount", 0) != 0
                or type(status.get("cancelledCount", 0)) is not int or status.get("cancelledCount", 0) != 0):
            diagnostic("execution_failed")
            raise ValueError("owned health execution did not succeed")
        return True
    try:
        wait_for_completion(completed, "owned health execution deadline exceeded", max(0, deadline - time.monotonic()))
    except ValueError:
        diagnostic("not_completed")
        raise
    diagnostic("succeeded")


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
        # install.py verifies the pinned bundle and its entire inventory in the
        # approving terminal and again in this build before starting this file;
        # this milestone cannot precede that check.
        current = (2, "release_verified", "release_verification_failed")
        report(token, 2, "release_verified")
        current = (3, "account_verified", "runner_failed")
        from argparse import Namespace
        verify_target(Namespace(**{key.lower(): os.environ[key] for key in
            ("PROJECT_ID", "PROJECT_NUMBER", "DNS_ZONE_NAME", "DOMAIN_NAME")}))
        # Both stop the run here with infrastructure_failed, before the lock,
        # image mirroring or Terraform: nothing has been changed.
        refuse_ejected_run()
        overrides = customer_overrides()
        report(token, 3, "account_verified")
        current = (4, "infrastructure_applied", "infrastructure_failed")
        with orchestration_mutex():
            images = mirror_images()
            outputs = apply(Path.cwd(), images, overrides)
            # "Infrastructure installed" is reported only after applied/ was written.
            write_applied(images, overrides, outputs, token)
            report(token, 4, "infrastructure_applied")
            current = (5, "services_ready", "service_unhealthy")
            verify_services(outputs)
            report(token, 5, "services_ready")
            current = (6, "health_verified", "health_check_failed")
            verify_health(outputs)
            # First report must be accepted, not just queued. The health job exits
            # nonzero when the control plane rejects its signed report.
            verify_health_job(outputs)
        report(token, 6, "health_verified")
        print("OpenWork is ready. Retrieve the administrator setup code from this deployment's Secret Manager bootstrap secret.")
    except Exception as error:
        sequence, step, code = current
        report(token, sequence, step, "failed", error.code if isinstance(error, StepFailure) else code)
        raise


if __name__ == "__main__":
    main()
