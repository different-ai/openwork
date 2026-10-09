#!/usr/bin/env node
// Builds a pinned installer release for one cloud: the bootstrap template plus a
// checksummed bundle of exactly the files the runner may execute.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [provider, version, outputArgument] = process.argv.slice(2);
if (provider !== "aws") throw new Error("Usage: build-release.mjs aws <published-version> [output-directory]");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Supply an exact published OpenWork image version.");
const output = resolve(outputArgument ?? resolve(root, "dist/managed-deployments", provider, version));
mkdirSync(output, { recursive: true });
execFileSync(process.execPath, [resolve(root, "infra/managed-deployments/aws/bootstrap/template.mjs"), resolve(output, "cloudformation.json")], { stdio: "inherit" });

// Only regular files inside the repository. Symlinks are refused outright so a
// link can never pull an operator's local files into a public release.
const realRoot = realpathSync(root);
function assertRegularInsideRoot(path) {
  const absolute = resolve(realRoot, path);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw new Error(`Refusing to package ${path}: not a regular file or directory.`);
  const real = realpathSync(absolute);
  if (real !== absolute || !real.startsWith(realRoot + "/")) throw new Error(`Refusing to package ${path}: resolves outside the release source tree.`);
  return info;
}
function files(directory, accept) {
  assertRegularInsideRoot(directory);
  return readdirSync(resolve(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    const info = assertRegularInsideRoot(path);
    if (info.isDirectory()) return name === ".terraform" || name === "build" || name === "__pycache__" ? [] : files(path, accept);
    return accept(name) ? [path] : [];
  });
}
// Explicit allowlist: never package state, variable files, plans or credentials.
const terraform = (name) => name.endsWith(".tf") || name === ".terraform.lock.hcl";
const included = [
  "infra/managed-deployments/aws/runner/runner.py",
  "infra/managed-deployments/aws/health/health_agent.py",
  ...files("infra/managed-deployments/contract", terraform),
  ...files("infra/managed-deployments/aws/terraform", terraform),
  ...files("infra/terraform/modules/openwork-aws-ecs", (name) => name.endsWith(".tf")).filter((path) => !path.includes("/examples/") && !path.includes("/tests/")),
];
const stage = mkdtempSync(resolve(tmpdir(), "openwork-managed-release-"));
try {
  const checksums = {};
  for (const file of included) {
    assertRegularInsideRoot(file);
    const destination = resolve(stage, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(root, file), destination);
    checksums[relative(stage, destination)] = createHash("sha256").update(readFileSync(destination)).digest("hex");
  }
  writeFileSync(resolve(stage, "release.json"), JSON.stringify({ provider, version, protocolVersion: 1, files: checksums }, null, 2) + "\n");
  execFileSync("tar", ["-czf", resolve(output, "bundle.tar.gz"), "-C", stage, "infra", "release.json"]);
  const digest = (name) => createHash("sha256").update(readFileSync(resolve(output, name))).digest("hex");
  writeFileSync(resolve(output, "manifest.json"), JSON.stringify({ provider, version, protocolVersion: 1, bundleSha256: digest("bundle.tar.gz"), templateSha256: digest("cloudformation.json") }, null, 2) + "\n");
  console.log(`Built ${provider} installer ${version}: ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
