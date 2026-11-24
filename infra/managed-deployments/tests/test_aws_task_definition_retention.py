"""Offline task-definition adoption proof using native Terraform state/plans."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest

from test_aws_installer import runner

ROOT = Path(__file__).resolve().parents[1] / "aws/terraform"
FAMILIES = ("runner", "workbot", "ai_gateway")


class TaskDefinitionRetentionTests(unittest.TestCase):
    def test_real_provider_replacement_reads_prior_retention_and_forget_never_deregisters(self):
        terraform = shutil.which("terraform")
        self.assertIsNotNone(terraform, "Terraform is required by the managed workflow")
        events, definitions, revisions = [], {}, {}
        lock = threading.Lock()

        class Ecs(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                operation = self.headers.get("X-Amz-Target", "").rsplit(".", 1)[-1]
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                identifier = body.get("family") or body.get("taskDefinition")
                with lock:
                    events.append((operation, identifier))
                    status = 200
                    if operation == "RegisterTaskDefinition":
                        family = body["family"]
                        revisions[family] = revisions.get(family, 0) + 1
                        arn = f"arn:aws:ecs:us-east-1:123456789012:task-definition/{family}:{revisions[family]}"
                        definition = {**body, "taskDefinitionArn": arn, "revision": revisions[family],
                                      "status": "ACTIVE", "compatibilities": ["FARGATE"],
                                      "requiresAttributes": [], "enableFaultInjection": False}
                        definitions[arn] = definition
                        response = {"taskDefinition": definition}
                    elif operation == "DescribeTaskDefinition":
                        response = {"taskDefinition": definitions[body["taskDefinition"]], "tags": []}
                    elif operation == "DeregisterTaskDefinition":
                        status = 400
                        response = {"__type": "AccessDeniedException", "message": "Deregistration is forbidden by this offline fixture"}
                    else:
                        status = 400
                        response = {"__type": "UnknownOperationException", "message": "Unexpected operation"}
                payload = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/x-amz-json-1.1")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Ecs)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cli = root / "empty.tfrc"
                cli.write_text("disable_checkpoint = true\n")
                env = {key: value for key, value in os.environ.items()
                       if key in ("HOME", "PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TMPDIR")}
                env.update(TF_IN_AUTOMATION="1", CHECKPOINT_DISABLE="1", TF_CLI_CONFIG_FILE=str(cli),
                           AWS_EC2_METADATA_DISABLED="true", AWS_CONFIG_FILE=str(root / "no-aws-config"),
                           AWS_SHARED_CREDENTIALS_FILE=str(root / "no-aws-credentials"))
                shutil.copyfile(ROOT / ".terraform.lock.hcl", root / ".terraform.lock.hcl")
                required = {name: {"source": "hashicorp/" + name, "version": constraint}
                            for name, constraint in re.findall(
                                r'provider "registry\.terraform\.io/hashicorp/([^\"]+)" \{\s+version\s*=\s*"[^\"]+"\s+constraints\s*=\s*"([^\"]+)"',
                                (root / ".terraform.lock.hcl").read_text())}
                self.assertIn("aws", required)
                endpoint = f"http://127.0.0.1:{server.server_port}"

                def configure(retained, image, memory, renamed=False):
                    resources = {family + ("_v1" if renamed else ""): {
                        "family": "exp-retention-" + family.replace("_", "-"),
                        "skip_destroy": retained, "requires_compatibilities": ["FARGATE"],
                        "network_mode": "awsvpc", "cpu": "512", "memory": str(memory),
                        "container_definitions": json.dumps([{"name": family, "image": f"example.test/{family}@sha256:{image * 64}", "essential": True}]),
                    } for family in FAMILIES}
                    (root / "main.tf.json").write_text(json.dumps({
                        "terraform": {"required_providers": required},
                        "provider": {"aws": {"region": "us-east-1", "access_key": "mock", "secret_key": "mock",
                            "skip_credentials_validation": True, "skip_metadata_api_check": True,
                            "skip_requesting_account_id": True, "skip_region_validation": True,
                            "endpoints": [{"ecs": endpoint, "iam": endpoint, "sts": endpoint}]}},
                        "resource": {"aws_ecs_task_definition": resources},
                    }))

                def run(*arguments, success=True):
                    result = subprocess.run([terraform, *arguments], cwd=root, env=env,
                                            capture_output=True, text=True, timeout=120)
                    if success:
                        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                    return result

                def plan(name):
                    run("plan", "-input=false", "-no-color", "-out=" + name)
                    return json.loads(run("show", "-json", name).stdout)

                configure(False, "a", 1024)
                run("init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color",
                    "-plugin-dir=" + str(ROOT / ".terraform/providers"))
                run("apply", "-input=false", "-auto-approve", "-no-color")
                configure(True, "b", 2048)
                replacement = plan("flag-only.tfplan")
                for change in replacement["resource_changes"]:
                    self.assertEqual(set(change["change"]["actions"]), {"delete", "create"})
                    self.assertFalse(change["change"]["before"]["skip_destroy"])
                    self.assertTrue(change["change"]["after"]["skip_destroy"])
                denied = run("apply", "-input=false", "-no-color", "flag-only.tfplan", success=False)
                self.assertNotEqual(denied.returncode, 0)
                self.assertIn("AccessDeniedException", denied.stderr)
                self.assertEqual(sum(operation == "DeregisterTaskDefinition" for operation, _ in events), 3)

                configure(True, "b", 2048, renamed=True)
                (root / "retention.tf").write_text("\n".join(
                    "removed {\n  from = aws_ecs_task_definition." + family + "\n  lifecycle { destroy = false }\n}\n"
                    for family in FAMILIES))
                adoption = plan("retained.tfplan")
                changes = {change["address"]: change["change"] for change in adoption["resource_changes"]}
                for family in FAMILIES:
                    self.assertEqual(changes["aws_ecs_task_definition." + family]["actions"], ["forget"])
                    self.assertFalse(changes["aws_ecs_task_definition." + family]["before"]["skip_destroy"])
                    self.assertEqual(changes["aws_ecs_task_definition." + family + "_v1"]["actions"], ["create"])
                run("apply", "-input=false", "-no-color", "retained.tfplan")
                self.assertEqual(sum(operation == "DeregisterTaskDefinition" for operation, _ in events), 3)
                configure(True, "c", 3072, renamed=True)
                future = plan("future.tfplan")
                for change in future["resource_changes"]:
                    self.assertEqual(set(change["change"]["actions"]), {"delete", "create"})
                    self.assertTrue(change["change"]["before"]["skip_destroy"])
                    self.assertTrue(change["change"]["after"]["skip_destroy"])
                run("apply", "-input=false", "-no-color", "future.tfplan")
                self.assertEqual(sum(operation == "DeregisterTaskDefinition" for operation, _ in events), 3)
                self.assertEqual(sum(operation == "RegisterTaskDefinition" for operation, _ in events), 9)
                self.assertEqual({operation for operation, _ in events},
                                 {"RegisterTaskDefinition", "DescribeTaskDefinition", "DeregisterTaskDefinition"})
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)

    def test_native_adoption_forgets_legacy_definitions_and_preserves_data(self):
        terraform = shutil.which("terraform")
        self.assertIsNotNone(terraform, "Terraform is required by the managed workflow")
        env = {key: value for key, value in os.environ.items()
               if key in ("HOME", "PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TMPDIR")}
        env.update(TF_IN_AUTOMATION="1", CHECKPOINT_DISABLE="1", AWS_EC2_METADATA_DISABLED="true")
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "empty.tfrc"
            config.write_text("disable_checkpoint = true\n")
            env["TF_CLI_CONFIG_FILE"] = str(config)
            result = subprocess.run([terraform, "test", "-json", "-verbose", "-filter=tests/task_definition_retention.tftest.hcl"],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        plans = {row["@testrun"]: row["test_plan"] for row in map(json.loads, result.stdout.splitlines())
                 if row.get("type") == "test_plan"}
        adoption = plans["adoption_forgets_old_optional_definitions"]
        changes = {item["address"]: item for item in adoption["resource_changes"]}
        for family in FAMILIES:
            with self.subTest(family=family):
                old = changes[f"aws_ecs_task_definition.{family}[0]"]["change"]
                self.assertEqual(old["actions"], ["forget"], "Old false-valued definitions must never enter provider Delete")
                self.assertFalse(old["before"]["skip_destroy"])
                new = changes[f"aws_ecs_task_definition.{family}_v1[0]"]["change"]
                self.assertEqual(new["actions"], ["create"])
                self.assertTrue(new["after"]["skip_destroy"])
        guarded = copy.deepcopy(adoption)
        for item in guarded["resource_changes"]:
            item["address"] = "module.platform." + item["address"]
        self.assertEqual(runner.unsafe_changes(guarded), [])
        self.assertFalse(any("delete" in item["change"]["actions"] for item in adoption["resource_changes"]))
        future = plans["future_optional_image_and_memory_update_keeps_prior_retention"]
        future_changes = {item["address"]: item for item in future["resource_changes"]}
        for family in FAMILIES:
            change = future_changes[f"aws_ecs_task_definition.{family}_v1[0]"]["change"]
            self.assertEqual(set(change["actions"]), {"delete", "create"})
            self.assertTrue(change["before"]["skip_destroy"])
            self.assertTrue(change["after"]["skip_destroy"])
        guarded_future = copy.deepcopy(future)
        for item in guarded_future["resource_changes"]:
            item["address"] = "module.platform." + item["address"]
        self.assertEqual(runner.unsafe_changes(guarded_future), [])
        for item in future["resource_changes"]:
            if item["type"] in runner.PROTECTED_TYPES or item["type"] in ("aws_lb", "aws_ecs_cluster"):
                self.assertNotIn("delete", item["change"]["actions"], item["address"])
                self.assertNotIn("forget", item["change"]["actions"], item["address"])
                if item["change"]["before"] is not None and "id" in item["change"]["before"]:
                    self.assertEqual(item["change"]["before"]["id"], item["change"]["after"]["id"], item["address"])
                if item["type"] == "aws_secretsmanager_secret_version":
                    self.assertEqual(item["change"]["before"]["secret_string"], item["change"]["after"]["secret_string"])
        partial = {item["address"]: item["change"] for item in plans["adoption_forgets_present_partial_gateway_only"]["resource_changes"]}
        self.assertEqual(partial["aws_ecs_task_definition.ai_gateway[0]"]["actions"], ["forget"])
        self.assertNotIn("aws_ecs_task_definition.runner[0]", partial)
        self.assertNotIn("aws_ecs_task_definition.workbot[0]", partial)


if __name__ == "__main__":
    unittest.main()
