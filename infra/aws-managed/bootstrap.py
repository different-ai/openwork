"""CodeBuild bootstrap: identity-bound enrollment and verified bundle execution.

Only small progress codes go to the control plane. Logs and credentials stay in
this customer-owned CodeBuild process. This file is embedded in the template.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def post(origin, path, payload, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin.rstrip("/") + path,
                                     data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def enroll():
    region = os.environ["AWS_REGION"]
    session = boto3.Session(region_name=region)
    request = AWSRequest(method="POST", url=f"https://sts.{region}.amazonaws.com/",
                         data="Action=GetCallerIdentity&Version=2011-06-15",
                         headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                                  "x-openwork-run": os.environ["RUN_ID"] + ":" + os.environ["CHALLENGE"]})
    SigV4Auth(session.get_credentials().get_frozen_credentials(), "sts", region).add_auth(request)
    headers = {key.lower(): str(value) for key, value in request.headers.items()}
    headers.pop("content-type")
    return post(os.environ["CONTROL_PLANE_ORIGIN"], run_path() + "/enroll", {"headers": headers})["token"]


def run_path():
    return f'/v1/aws-deployments/{os.environ["DEPLOYMENT_ID"]}/runs/{os.environ["RUN_ID"]}'


def event(token, sequence, step, outcome="succeeded", error_code=None):
    payload = {"sequence": sequence, "step": step, "outcome": outcome}
    if error_code:
        payload["errorCode"] = error_code
    return post(os.environ["CONTROL_PLANE_ORIGIN"], run_path() + "/events", payload, token)


def download_bundle(url, digest, destination):
    if not url.startswith("https://") or len(digest) != 64:
        raise ValueError("invalid release")
    archive = destination / "bundle.tar.gz"
    hasher = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 100 * 1024 * 1024:
                raise ValueError("release too large")
            hasher.update(chunk)
            output.write(chunk)
    if hasher.hexdigest() != digest:
        raise ValueError("release checksum mismatch")
    with tarfile.open(archive) as tar:
        # Never allow a verified archive to escape its isolated extraction root.
        for member in tar.getmembers():
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError("invalid archive member")
        tar.extractall(destination, filter="data")


def main():
    token = enroll()  # Never retry an uncertain single-use enrollment.
    event(token, 1, "runner_connected")
    with tempfile.TemporaryDirectory(prefix="openwork-release-") as directory:
        root = Path(directory)
        try:
            download_bundle(os.environ["BUNDLE_URL"], os.environ["BUNDLE_SHA256"], root)
            manifest = json.loads((root / "release.json").read_text())
            if manifest.get("version") != os.environ["OPENWORK_VERSION"] or manifest.get("protocolVersion") != 1:
                raise ValueError("release does not match the approved version")
        except Exception:
            event(token, 2, "release_verified", "failed", "release_verification_failed")
            raise
        event(token, 2, "release_verified")
        token_file = root / ".runner-token"
        token_file.write_text(token)
        token_file.chmod(0o600)
        # Only the trusted, verified release sees the run-scoped credential.
        env = {**os.environ, "RUNNER_TOKEN_FILE": str(token_file)}
        result = subprocess.run(["python3", str(root / "infra/aws-managed/runner.py")], cwd=root, env=env)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
