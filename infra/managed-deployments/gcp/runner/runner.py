"""Verified runner, executed with customer-approved short-lived impersonation."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
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
                   "google_storage_bucket", "google_kms_crypto_key", "google_compute_network", "random_password",
                   "google_cloud_run_v2_service", "google_compute_global_address", "google_compute_region_network_endpoint_group",
                   "google_compute_backend_service", "google_compute_managed_ssl_certificate", "google_compute_url_map",
                   "google_compute_target_https_proxy", "google_compute_global_forwarding_rule"}


def gcloud(*args, timeout=None):
    return cloud(*args, project=os.environ["PROJECT_ID"], impersonate=os.environ["RUNNER_SERVICE_ACCOUNT"], timeout=timeout)


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


def service_status(service):
    return gcloud("run", "services", "describe", service, "--region=" + os.environ["REGION"])


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
        executions = gcloud("run", "jobs", "executions", "list", "--job=" + name(os.environ["DEPLOYMENT_ID"]) + "-migrate",
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
    existing = [r for r in resources(plan.get("prior_state", {}).get("values", {}).get("root_module", {}))
                if r.get("type") == "google_cloud_run_v2_service"]
    if not existing:
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
        gcloud("run", "services", "update-traffic", service, "--clear-tags", "--region=" + region)
        gcloud("run", "services", "update", service, "--scaling=0", "--region=" + region)
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

    def approved_plan(label):
        plan = tf_root / (label + ".tfplan")
        subprocess.run([binary, "plan", "-input=false", "-lock-timeout=120s", "-out=" + str(plan)], cwd=tf_root, env=environment, check=True)
        raw = json.loads(subprocess.check_output([binary, "show", "-json", str(plan)], cwd=tf_root, env=environment))
        if unsafe_changes(raw):
            raise ValueError("refusing protected replacement, secret change or database version change; maintenance retained")
        return plan, raw
    plan, decoded = approved_plan("platform")
    maintained = maintenance_fence(decoded)
    if maintained:
        # Keep scale zero THROUGH revision deployment. Restoring auto in the
        # template-changing update could restart an old migration-capable revision.
        variables.write_text(json.dumps({**inputs(images), "managed_maintenance": True}))
        plan, _ = approved_plan("maintained-platform")
    # run_execution_token executes and waits once inside the module graph. A
    # second CLI jobs execute here would run the migration twice.
    subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, env=environment, check=True)
    if maintained:
        verify_maintained_revisions(images)
        variables.write_text(json.dumps({**inputs(images), "managed_maintenance": False}))
        plan, _ = approved_plan("resume-api-only")
        subprocess.run([binary, "apply", "-input=false", "-lock-timeout=120s", str(plan)], cwd=tf_root, env=environment, check=True)
    raw = subprocess.check_output([binary, "output", "-json"], cwd=tf_root, env=environment)
    return {key: value["value"] for key, value in json.loads(raw).items()}


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
            verify_health_job(outputs)
        report(token, 6, "health_verified")
        print("OpenWork is ready. Retrieve the administrator setup code from this deployment's Secret Manager bootstrap secret.")
    except Exception:
        sequence, step, code = current
        report(token, sequence, step, "failed", code)
        raise


if __name__ == "__main__":
    main()
