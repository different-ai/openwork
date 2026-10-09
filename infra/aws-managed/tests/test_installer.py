import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
bootstrap = load("bootstrap")
runner = load("runner")

def archive(name="release.json", data=b"{}", symlink=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        entry = tarfile.TarInfo(name)
        entry.size = 0 if symlink else len(data)
        if symlink:
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
        tar.addfile(entry, None if symlink else io.BytesIO(data))
    return output.getvalue()

class BootstrapTests(unittest.TestCase):
    def test_checksum_verified_before_extraction(self):
        data = archive()
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
            with self.assertRaises(ValueError):
                bootstrap.download_bundle("https://release.example.test/bundle", "a" * 64, Path(directory))
            self.assertFalse((Path(directory) / "release.json").exists())

    def test_path_traversal_and_links_rejected(self):
        for data in [archive("../../escape"), archive("/absolute"), archive("link", symlink=True)]:
            with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
                with self.assertRaises(ValueError):
                    bootstrap.download_bundle("https://release.example.test/bundle", hashlib.sha256(data).hexdigest(), Path(directory))

    def test_verified_regular_file_extracted(self):
        data = archive(data=b'{"protocolVersion":1}')
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(data)):
            bootstrap.download_bundle("https://release.example.test/bundle", hashlib.sha256(data).hexdigest(), Path(directory))
            self.assertEqual(json.loads((Path(directory) / "release.json").read_text())["protocolVersion"], 1)

    def test_release_requires_https(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                bootstrap.download_bundle("http://release.example.test/bundle", "a" * 64, Path(directory))

    def test_runtime_does_not_accept_unexpected_origins(self):
        with patch.dict(os.environ, {"DOMAIN_NAME": "den.example.test"}):
            with self.assertRaises(ValueError):
                runner.verify_health({"web_url": "https://attacker.example.test", "api_url": "https://api.den.example.test"})

class TemplateTests(unittest.TestCase):
    def test_customer_state_is_retained_encrypted_and_private(self):
        template = json.loads((ROOT / "cloudformation.json").read_text())
        bucket = template["Resources"]["StateBucket"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["Properties"]["VersioningConfiguration"]["Status"], "Enabled")
        self.assertTrue(all(bucket["Properties"]["PublicAccessBlockConfiguration"].values()))
        self.assertEqual(template["Resources"]["StateLock"]["DeletionPolicy"], "Retain")

    def test_no_long_lived_aws_keys_or_arbitrary_control_plane_commands(self):
        template = json.loads((ROOT / "cloudformation.json").read_text())
        variables = template["Resources"]["Runner"]["Properties"]["Environment"]["EnvironmentVariables"]
        self.assertFalse(any(item["Name"] in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "RUNNER_TOKEN") for item in variables))
        serialized = json.dumps(template)
        self.assertNotIn("AdministratorAccess", serialized)
        self.assertNotIn('"Action": "iam:*"', serialized)
        self.assertNotIn('"Action": "*"', serialized)
        self.assertFalse(template["Resources"]["Runner"]["Properties"]["Environment"]["PrivilegedMode"])

if __name__ == "__main__":
    unittest.main()
