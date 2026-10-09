"""CodeBuild bootstrap: identity-bound enrollment and verified bundle execution.

Only small progress codes go to the control plane. Logs and credentials stay in
this customer-owned CodeBuild process. This file is embedded in the template.
"""
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

# Standard library only: nothing is downloaded from a package index while the
# installer holds AWS credentials.
STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15"
STS_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8"


def container_credentials():
    """CodeBuild's role credentials from the container credentials endpoint."""
    uri = os.environ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]
    with urllib.request.urlopen("http://169.254.170.2" + uri, timeout=10) as response:
        data = json.load(response)
    return data["AccessKeyId"], data["SecretAccessKey"], data["Token"]


def signed_identity(proof, region, credentials, now=None):
    """SigV4-sign (never send) an STS GetCallerIdentity POST carrying the proof header."""
    access_key, secret_key, token = credentials
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    host = f"sts.{region}.amazonaws.com"
    headers = {"content-type": STS_CONTENT_TYPE, "host": host, "x-amz-date": amz_date,
               "x-amz-security-token": token, "x-openwork-proof": proof}
    names = sorted(headers)
    canonical = "\n".join(["POST", "/", "", "".join(f"{name}:{headers[name]}\n" for name in names), ";".join(names),
                           hashlib.sha256(STS_BODY.encode()).hexdigest()])
    scope = f"{day}/{region}/sts/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + secret_key).encode()
    for part in (day, region, "sts", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return {"authorization": f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}",
            "x-amz-date": amz_date, "x-amz-security-token": token, "x-openwork-proof": proof}


def post(origin, path, payload, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin.rstrip("/") + path,
                                     data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def enroll():
    proof = "enroll:" + os.environ["RUN_ID"] + ":" + os.environ["CHALLENGE"]
    headers = signed_identity(proof, os.environ["AWS_REGION"], container_credentials())
    return post(os.environ["CONTROL_PLANE_ORIGIN"], run_path() + "/enroll", {"headers": headers})["token"]


def run_path():
    return f'/v1/managed-deployments/{os.environ["DEPLOYMENT_ID"]}/runs/{os.environ["RUN_ID"]}'


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
        result = subprocess.run(["python3", str(root / "infra/managed-deployments/aws/runner/runner.py")], cwd=root, env=env)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
