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
export const GCP_REPOSITORIES = Object.freeze({
  den_api: "ghcr.io/different-ai/openwork-den-api",
  den_web: "ghcr.io/different-ai/openwork-den-web",
  health: "docker.io/library/python",
});
export const HEALTH_SOURCE = GCP_REPOSITORIES.health + "@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

// Docker authenticates with the operator's registry credentials. Resolve only
// fixed repositories, and select the actual Linux/amd64 manifest, never an index
// digest or an attestation. Re-read by digest so missing pins fail at build time.
export function resolveImage(source, repository, inspect = (ref) => JSON.parse(execFileSync("docker", ["manifest", "inspect", "--verbose", ref], { encoding: "utf8" }))) {
  const select = (metadata) => {
    const entries = Array.isArray(metadata) ? metadata : [metadata];
    const matches = entries.filter((entry) => entry?.Descriptor?.platform?.os === "linux"
      && entry.Descriptor.platform.architecture === "amd64" && !entry.Descriptor.platform.variant);
    const manifest = matches.length === 1 ? matches[0].SchemaV2Manifest ?? matches[0].OCIManifest : undefined;
    if (matches.length !== 1 || !digestPattern.test(matches[0].Descriptor.digest)
        || !manifest || !digestPattern.test(manifest.config?.digest)) {
      throw new Error(`Missing or ambiguous Linux/amd64 image manifest: ${source}`);
    }
    return matches[0].Descriptor.digest;
  };
  const digest = select(inspect(source));
  const pinned = repository + "@" + digest;
  if (select(inspect(pinned)) !== digest) throw new Error(`Registry digest mismatch: ${pinned}`);
  return pinned;
}

export function resolveGcpImages(version, approvedPins, inspect) {
  if (approvedPins !== undefined && (!approvedPins || Array.isArray(approvedPins)
      || typeof approvedPins !== "object" || Object.keys(approvedPins).sort().join(",") !== "den_api,den_web")) {
    throw new Error("Approved image pins must contain exactly den_api and den_web.");
  }
  return Object.fromEntries(Object.entries(GCP_REPOSITORIES).map(([kind, repository]) => {
    const source = kind === "health" ? HEALTH_SOURCE : approvedPins === undefined
      ? repository + ":" + version : approvedPins[kind];
    if (kind !== "health" && approvedPins !== undefined && (typeof source !== "string"
        || !source.startsWith(repository + "@") || !digestPattern.test(source.slice(repository.length + 1)))) {
      throw new Error(`Invalid approved image pin: ${kind}`);
    }
    const pin = resolveImage(source, repository, inspect);
    if (kind !== "health" && approvedPins !== undefined && source !== pin) throw new Error(`Approved pin must be a Linux/amd64 manifest: ${kind}`);
    return [kind, pin];
  }));
}

export function resolveAwsImages(approvedPins, inspect) {
  if (!approvedPins || Array.isArray(approvedPins) || typeof approvedPins !== "object"
      || Object.keys(approvedPins).sort().join(",") !== "den_api,den_web") {
    throw new Error("Approved AWS image pins must contain exactly den_api and den_web.");
  }
  return Object.fromEntries(["den_api", "den_web"].map((kind) => {
    const repository = GCP_REPOSITORIES[kind];
    const source = approvedPins[kind];
    if (typeof source !== "string" || !source.startsWith(repository + "@")
        || !digestPattern.test(source.slice(repository.length + 1))) throw new Error(`Invalid approved image pin: ${kind}`);
    const pinned = resolveImage(source, repository, inspect);
    if (pinned !== source) throw new Error(`Approved pin must be a Linux/amd64 manifest: ${kind}`);
    return [kind, pinned];
  }));
}

// Check operational module-local references against the actual payload allowlist.
// A release must not succeed just because the source checkout has the file.
export function validateModuleReferences(moduleFiles, read = (path) => readFileSync(resolve(root, path), "utf8")) {
  const included = new Set(moduleFiles);
  for (const file of moduleFiles.filter((name) => name.endsWith(".tf"))) {
    const source = read(file);
    for (const match of source.matchAll(/\$\{path\.module\}\/([^"\s]+)"/g)) {
      const target = join(dirname(file), match[1]);
      if (!included.has(target)) throw new Error(`Missing packaged module reference: ${target}`);
    }
  }
}

export function buildRelease(argv = process.argv.slice(2)) {
  const [provider, version, outputArgument, ...options] = argv;
  if (options.length && (options.length !== 2 || options[0] !== "--image-pins")) {
    throw new Error("Use --image-pins <approved-json-file> (registry verification is mandatory).");
  }
  if (!["aws", "gcp"].includes(provider)) throw new Error("Usage: build-release.mjs <aws|gcp> <published-version> [output-directory]");
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Supply an exact published OpenWork image version.");
  // Resolve before writing artifacts; no customer-time source tag resolution.
  const images = provider === "gcp" ? resolveGcpImages(version,
    options.length ? JSON.parse(readFileSync(resolve(options[1]), "utf8")) : undefined)
    : options.length ? resolveAwsImages(JSON.parse(readFileSync(resolve(options[1]), "utf8"))) : undefined;
  const output = resolve(outputArgument ?? resolve(root, "dist/managed-deployments", provider, version));
  mkdirSync(output, { recursive: true });
  const templateName = provider === "aws" ? "cloudformation.json" : "tutorial.md";
  if (provider === "aws") {
    execFileSync(process.execPath, [resolve(root, "infra/managed-deployments/aws/bootstrap/template.mjs"), resolve(output, templateName)], { stdio: "inherit" });
  }

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
    ...files("infra/managed-deployments/contract", terraform),
    ...(provider === "aws" ? [
      "infra/managed-deployments/aws/runner/runner.py",
      "infra/managed-deployments/aws/health/health_agent.py",
       ...files("infra/managed-deployments/aws/terraform", terraform).filter((path) => !path.includes("/examples/") && !path.includes("/tests/") && !path.includes("/modules/openwork-aws-ecs/")),
       ...files("infra/terraform/modules/openwork-aws-ecs", (name) => name.endsWith(".tf") || name === "migration.py")
         .filter((path) => !path.includes("/examples/") && !path.includes("/tests/")),

    ] : [
      "infra/managed-deployments/gcp/runner/install.py",
      "infra/managed-deployments/gcp/runner/runner.py",
      "infra/managed-deployments/gcp/health/health_agent.py",
      ...files("infra/managed-deployments/gcp/terraform", terraform),
    ]),
  ];
  if (provider === "aws") validateModuleReferences(included.filter((path) => path.startsWith("infra/terraform/modules/openwork-aws-ecs/")));
  assertRegularInsideRoot(`infra/managed-deployments/${provider}/terraform/.terraform.lock.hcl`);
  if (provider === "gcp") {
    assertRegularInsideRoot("infra/managed-deployments/gcp/bootstrap/tutorial.md");
    copyFileSync(resolve(root, "infra/managed-deployments/gcp/bootstrap/tutorial.md"), resolve(output, templateName));
  }
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
    writeFileSync(resolve(stage, "release.json"), JSON.stringify({ provider, version, protocolVersion: 1, files: checksums, ...(images ? { images } : {}) }, null, 2) + "\n");
    execFileSync("tar", ["-czf", resolve(output, "bundle.tar.gz"), "-C", stage, "infra", "release.json"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const digest = (name) => createHash("sha256").update(readFileSync(resolve(output, name))).digest("hex");
    writeFileSync(resolve(output, "manifest.json"), JSON.stringify({ provider, version, protocolVersion: 1, bundleSha256: digest("bundle.tar.gz"), templateSha256: digest(templateName) }, null, 2) + "\n");
    console.log(`Built ${provider} installer ${version}: ${output}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildRelease();
