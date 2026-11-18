"""Offline adoption boundaries; no AWS or provider credentials are used."""
import copy
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_aws_installer as installer
from test_aws_installer import ROOT, actions_of, runner, runner_statements


class LegacyFenceTests(unittest.TestCase):
    def plan(self):
        return {"prior_state": {"values": {"root_module": {"child_modules": [{"resources": [
            {"address": "module.platform.aws_ecs_service." + key,
             "values": {"name": name, "cluster": "owned-cluster"}}
            for key, name in [("api", "owned-api"), ("web", "owned-web")]
        ]}]}}}}

    def cloud(self, *, legacy=True, draining=False, failure=None, rollback=False):
        counts = {"descriptions": 0, "tasks": 0}
        def call(*args):
            operation = args[:2]
            if operation == ("ecs", "describe-services"):
                counts["descriptions"] += 1
                maintained = counts["descriptions"] > 1
                services = [{"serviceName": name, "taskDefinition": name + ":1",
                             "desiredCount": 0 if maintained else 1, "runningCount": 0 if maintained else 1,
                             "pendingCount": 0, "deployments": [{"taskDefinition": name + ":1"}]}
                            for name in ("owned-api", "owned-web")]
                if rollback and not maintained:
                    services[0]["deployments"].append({"taskDefinition": "old-api:1"})
                if failure == "resumed" and maintained:
                    services[0]["desiredCount"] = 1
                return {"services": services}
            if operation == ("ecs", "describe-task-definition"):
                arn = args[args.index("--task-definition") + 1]
                migrates = (legacy and "api" in arn) or arn == "old-api:1"
                return {"taskDefinition": {"family": "owned-api" if "api" in arn else "owned-web",
                        "containerDefinitions": [{"name": "migrate" if migrates else "app"}]}}
            if operation == ("ecs", "list-tasks"):
                return {"taskArns": ["owned-task"]} if args[-1] == "STOPPED" else {"taskArns": []}
            if operation == ("ecs", "describe-tasks"):
                counts["tasks"] += 1
                if failure == "unknown":
                    return {"failures": [{"reason": "MISSING"}]}
                return {"tasks": [{"lastStatus": "RUNNING" if (draining and counts["tasks"] <= 2) or failure == "timeout" else "STOPPED"}]}
            return {}
        return call

    def test_fresh_and_api_only_installs_do_not_enter_maintenance(self):
        with patch.object(runner, "aws") as aws:
            self.assertFalse(runner.legacy_fence({}))
            aws.assert_not_called()
        with patch.object(runner, "aws", side_effect=self.cloud(legacy=False)) as aws:
            self.assertFalse(runner.legacy_fence(self.plan()))
        self.assertFalse(any(c.args[:2] == ("ecs", "update-service") for c in aws.call_args_list))

    def test_fence_waits_for_draining_tasks_not_just_zero_service_counts(self):
        with patch.object(runner, "aws", side_effect=self.cloud(draining=True)) as aws, patch.object(runner.time, "sleep") as poll:
            self.assertTrue(runner.legacy_fence(self.plan()))
        poll.assert_called_once_with(3)
        changes = [c.args for c in aws.call_args_list if c.args[:2] == ("ecs", "update-service")]
        self.assertEqual(len(changes), 2)
        self.assertEqual({c[c.index("--service") + 1] for c in changes}, {"owned-api", "owned-web"})
        for c in changes:
            self.assertEqual(c[c.index("--desired-count") + 1], "0")
            self.assertFalse(json.loads(c[-1])["deploymentCircuitBreaker"]["rollback"])
        self.assertFalse(any(c.args[:2] in [("ecs", "stop-task"), ("ecs", "deregister-task-definition")] for c in aws.call_args_list))

    def test_legacy_rollback_revision_is_fenced_even_with_api_only_primary(self):
        with patch.object(runner, "aws", side_effect=self.cloud(legacy=False, rollback=True)):
            self.assertTrue(runner.legacy_fence(self.plan()))

    def test_unknown_tasks_resumed_services_and_timeout_fail_closed(self):
        for failure in ("unknown", "resumed", "timeout"):
            with self.subTest(failure=failure), patch.object(runner, "aws", side_effect=self.cloud(failure=failure)) as aws, \
                    patch.object(runner.time, "monotonic", side_effect=[0, 601]):
                with self.assertRaises(ValueError):
                    runner.legacy_fence(self.plan())
            self.assertFalse(any("--desired-count" in c.args and c.args[c.args.index("--desired-count") + 1] != "0" for c in aws.call_args_list))

    def test_incomplete_service_state_fails_before_mutation(self):
        plan = self.plan()
        plan["prior_state"]["values"]["root_module"]["child_modules"][0]["resources"].pop()
        with patch.object(runner, "aws") as aws, self.assertRaises(ValueError):
            runner.legacy_fence(plan)
        aws.assert_not_called()

    def test_replan_after_fence_restores_counts_only_after_protected_guard(self):
        outputs = {"cluster_name": {"value": "owned"}, "service_names": {"value": {}}, "task_definition_arns": {"value": {}}}
        protected = {"resource_changes": [{"address": "db", "type": "aws_db_instance", "change": {"actions": ["delete", "create"]}}]}
        for unsafe in (False, True):
            commands = []
            def run(command, **kwargs):
                commands.append(command[1])
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEPLOYMENT_ID": "test", "STATE_BUCKET": "owned", "AWS_REGION": "us-east-1"}), \
                    patch.object(runner, "terraform_binary", return_value="terraform"), patch.object(runner, "terraform_inputs", return_value={}), \
                    patch.object(runner, "certificate_states", return_value={}), patch.object(runner, "legacy_fence", return_value=True), \
                    patch.object(runner, "tls_redeploy") as final, patch.object(runner.subprocess, "run", side_effect=run), \
                    patch.object(runner.subprocess, "check_output", side_effect=["{}", json.dumps(protected if unsafe else {}), json.dumps(outputs)]):
                if unsafe:
                    with self.assertRaisesRegex(ValueError, "maintenance retained"):
                        runner.apply(Path(directory), Path(directory))
                    final.assert_not_called()
                else:
                    runner.apply(Path(directory), Path(directory))
                    final.assert_called_once()
            self.assertEqual(commands.count("plan"), 2)
            self.assertEqual(commands.count("apply"), 0 if unsafe else 1)


class AdoptionPermissionAndSecretTests(unittest.TestCase):
    def test_migration_permissions_are_exact_deployment_resources(self):
        template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())
        for mode in ("dedicated", "existing"):
            statements = runner_statements(template, mode)
            by_sid = {s["Sid"]: s for s in statements if "Sid" in s}
            function = by_sid["MigrationFunction"]
            self.assertNotEqual(function["Resource"], "*")
            self.assertIn("function:${Name}-migrate", json.dumps(function["Resource"]))
            self.assertNotIn("lambda:AddPermission", actions_of(function))
            self.assertEqual(by_sid["PassMigrationRole"]["Condition"], {"StringEquals": {"iam:PassedToService": "lambda.amazonaws.com"}})
            self.assertIn("role/${Name}-migrate-*", json.dumps(by_sid["PassMigrationRole"]["Resource"]))
            self.assertNotIn("migrate", json.dumps(by_sid["PassTaskRoles"]["Resource"]))
            self.assertIn("log-group:/aws/lambda/${Name}-migrate", json.dumps(by_sid["Logs"]["Resource"]))
            for statement in statements:
                if statement.get("Effect") == "Allow" and "ecs:DeregisterTaskDefinition" in actions_of(statement):
                    self.assertNotEqual(statement["Resource"], "*")

    def test_policy_covers_the_real_provider_invocation_qualifier(self):
        terraform = shutil.which("terraform")
        self.assertIsNotNone(terraform, "Terraform is required by the managed workflow")
        tf_root = ROOT / "terraform"
        # Get the actual module's invocation arguments, then let the locked real
        # provider (not mock_provider) resolve SDK defaults such as qualifier.
        result = subprocess.run([terraform, "test", "-json", "-verbose", "-filter=tests/lifecycle.tftest.hcl"],
                                cwd=tf_root, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        plans = [row["test_plan"] for row in map(json.loads, result.stdout.splitlines()) if row.get("type") == "test_plan"]
        invocation = next(r["change"]["after"] for r in plans[0]["resource_changes"] if r["address"] == "aws_lambda_invocation.migrate")
        arguments = {"function_name": invocation["function_name"], "input": "{}"}
        if invocation.get("qualifier") is not None:
            arguments["qualifier"] = invocation["qualifier"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(tf_root / ".terraform.lock.hcl", root / ".terraform.lock.hcl")
            required = {name: {"source": "hashicorp/" + name, "version": constraint}
                        for name, constraint in re.findall(r'provider "registry\.terraform\.io/hashicorp/([^\"]+)" \{\s+version\s*=\s*"[^\"]+"\s+constraints\s*=\s*"([^\"]+)"', (root / ".terraform.lock.hcl").read_text())}
            self.assertIn("aws", required)
            (root / "main.tf.json").write_text(json.dumps({
                "terraform": {"required_providers": required},
                "provider": {"aws": {
                    "region": "us-east-1", "access_key": "mock", "secret_key": "mock",
                    "skip_credentials_validation": True, "skip_metadata_api_check": True,
                    "skip_requesting_account_id": True, "skip_region_validation": True,
                    "endpoints": [{"lambda": "http://127.0.0.1:1"}],
                }},
                "resource": {"aws_lambda_invocation": {"migrate": arguments}},
            }))
            for command in (["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color",
                             "-plugin-dir=" + str(tf_root / ".terraform/providers")],
                            ["plan", "-input=false", "-out=invocation.tfplan", "-no-color"]):
                result = subprocess.run([terraform, *command], cwd=root, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stderr)
            planned = json.loads(subprocess.check_output([terraform, "show", "-json", "invocation.tfplan"], cwd=root))
        actual = planned["resource_changes"][0]["change"]["after"]
        self.assertEqual(actual["qualifier"], "$LATEST", "Review IAM before changing the migration qualifier")
        base = "arn:aws:lambda:us-east-1:123456789012:function:" + actual["function_name"]
        invoked = base + ":" + actual["qualifier"]
        template = json.loads((ROOT / "bootstrap/cloudformation.json").read_text())
        for mode in ("dedicated", "existing"):
            statements = runner_statements(template, mode)
            invokes = [s for s in statements if s.get("Effect") == "Allow" and s.get("Sid") in ("MigrationFunction", "MigrationInvoke")
                       and "lambda:InvokeFunction" in actions_of(s)]
            resources = []
            bindings = {"AWS::Partition": "aws", "AWS::Region": "us-east-1", "AWS::AccountId": "123456789012",
                        "Name": actual["function_name"].removesuffix("-migrate")}
            for invoke in invokes:
                for resource in invoke["Resource"] if isinstance(invoke["Resource"], list) else [invoke["Resource"]]:
                    text = resource["Fn::Sub"][0]
                    for key, value in bindings.items():
                        text = text.replace("${" + key + "}", value)
                    resources.append(text)
            self.assertEqual(set(resources), {base, invoked})
            for invoke in invokes:
                self.assertEqual(actions_of(invoke), ["lambda:InvokeFunction"])
            for statement in statements:
                if statement.get("Sid") == "MigrationFunction":
                    self.assertNotIn("lambda:InvokeFunction", actions_of(statement))
                    self.assertNotIn("$LATEST", json.dumps(statement["Resource"]))

    def test_native_initial_seed_plan_passes_guard_without_rotating_keys(self):
        terraform = shutil.which("terraform")
        self.assertIsNotNone(terraform, "Terraform is required by the managed workflow")
        tf_root = ROOT / "terraform"
        shared = ROOT.parents[1] / "terraform/modules/openwork-aws-ecs"
        # Derive a pre-CA synthetic state shape from the one minimal fixture:
        # no strict version and no retained CA addresses, not another module copy.
        source = (tf_root / "tests/legacy/main.tf").read_text()
        start = source.index('resource "aws_secretsmanager_secret_version" "tls"')
        end = source.index('resource "aws_db_subnet_group"', start)
        source = source[:start] + source[end:]
        start = source.index('# Both historical address shapes')
        end = source.index('resource "random_password" "better_auth"', start)
        source = source[:start] + source[end:]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "legacy").mkdir()
            (root / "tests").mkdir()
            (root / "legacy/main.tf").write_text(source)
            (root / "main.tf").write_text('terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.69" }\n  }\n}\n')
            tests = (tf_root / "tests/lifecycle.tftest.hcl").read_text()
            tests = tests.replace('"./tests/legacy"', '"./legacy"')
            tests = tests.replace('"../../../terraform/modules/openwork-aws-ecs"', json.dumps(os.path.relpath(shared.resolve(), root.resolve())))
            tests = tests.replace('mock_provider "random" {}', '''mock_provider "random" {}
mock_provider "archive" {}
''')
            tests = tests.replace('  mock_resource "aws_db_instance" {', '''  mock_resource "aws_secretsmanager_secret_version" {
    defaults = { version_stages = ["AWSCURRENT"], secret_binary = "", has_secret_string_wo = false }
  }
  mock_resource "aws_db_instance" {''')
            (root / "tests/lifecycle.tftest.hcl").write_text(tests)
            init = subprocess.run([terraform, "init", "-backend=false", "-input=false", "-no-color",
                                   "-plugin-dir=" + str(tf_root / ".terraform/providers")], cwd=root, capture_output=True, text=True, timeout=120)
            self.assertEqual(init.returncode, 0, init.stderr)
            result = subprocess.run([terraform, "test", "-json", "-verbose"], cwd=root, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            plans = {row["@testrun"]: row["test_plan"] for row in map(json.loads, result.stdout.splitlines()) if row.get("type") == "test_plan"}
        planned = plans["upgrade_forgets_legacy_and_creates_retained_ca_revisions"]
        for resource in planned["resource_changes"]:
            resource["address"] = "module.platform." + resource["address"]
        self.assertEqual(runner.unsafe_changes(planned), [])
        target = next(r for r in planned["resource_changes"] if r["address"].endswith(".tls[0]"))
        self.assertEqual(target["change"]["actions"], ["create"])
        self.assertIsNone(target["change"]["before"])
        seed = next(r for r in planned["resource_changes"] if r["address"] == "module.platform.aws_secretsmanager_secret_version.app")
        self.assertEqual(seed["change"]["actions"], ["no-op"])
        self.assertEqual(seed["change"]["before"]["secret_string"], seed["change"]["after"]["secret_string"])

    def test_indexed_current_version_keeps_the_same_narrow_tls_guard(self):
        transition = installer.RunnerTests.tls_upgrade()["change"]
        seed = {"address": "module.platform.aws_secretsmanager_secret_version.app", "type": "aws_secretsmanager_secret_version",
                "change": {"actions": ["no-op"], "before": transition["before"], "after": transition["before"]}}
        target = {"address": "module.platform.aws_secretsmanager_secret_version.tls[0]", "type": "aws_secretsmanager_secret_version",
                  "change": {"actions": ["create"], "before": None, "after": transition["after"], "after_unknown": {}}}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [seed, target]}), [])
        rotated = copy.deepcopy(target)
        rotated["change"]["after"]["secret_string"] = rotated["change"]["after"]["secret_string"].replace("auth-unchanged", "rotation")
        self.assertEqual(runner.unsafe_changes({"resource_changes": [seed, rotated]}), [target["address"]])
        moved = copy.deepcopy(target)
        moved["previous_address"] = "module.platform.aws_secretsmanager_secret_version.tls"
        moved["change"] = {"actions": ["no-op"], "before": transition["after"], "after": transition["after"]}
        self.assertEqual(runner.unsafe_changes({"resource_changes": [moved]}), [])
        moved["change"]["actions"] = ["delete", "create"]
        self.assertEqual(runner.unsafe_changes({"resource_changes": [moved]}), [target["address"]])
