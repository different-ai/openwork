#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Supply a published OpenWork image version.");
const output = resolve(process.argv[3] ?? resolve(root, "dist/aws-deployments", version));
mkdirSync(output, { recursive: true });
execFileSync(process.execPath, [resolve(root, "infra/aws-managed/template.mjs"), resolve(output, "cloudformation.json")], { stdio: "inherit" });
const stage = mkdtempSync(resolve(tmpdir(), "openwork-aws-release-"));
try {
  // Explicit allowlist: never package .terraform, states, tfvars or credentials.
  const files = ["infra/aws-managed/bootstrap.py", "infra/aws-managed/runner.py", "infra/aws-managed/terraform/main.tf", "infra/aws-managed/terraform/.terraform.lock.hcl",
    ...readdirSync(resolve(root, "infra/terraform/modules/openwork-aws-ecs")).filter((name) => name.endsWith(".tf")).map((name) => "infra/terraform/modules/openwork-aws-ecs/" + name)];
  const checksums = {};
  for (const file of files) {
    const destination = resolve(stage, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(root, file), destination);
    checksums[file] = createHash("sha256").update(readFileSync(destination)).digest("hex");
  }
  writeFileSync(resolve(stage, "release.json"), JSON.stringify({ version, protocolVersion: 1, files: checksums }, null, 2) + "\n");
  execFileSync("tar", ["-czf", resolve(output, "bundle.tar.gz"), "-C", stage, "infra", "release.json"]);
  const bundleSha256 = createHash("sha256").update(readFileSync(resolve(output, "bundle.tar.gz"))).digest("hex");
  const templateSha256 = createHash("sha256").update(readFileSync(resolve(output, "cloudformation.json"))).digest("hex");
  writeFileSync(resolve(output, "manifest.json"), JSON.stringify({ version, protocolVersion: 1, bundleSha256, templateSha256 }, null, 2) + "\n");
  console.log(`Built AWS release ${version}: ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
