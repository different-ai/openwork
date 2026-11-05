import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildRelease, GCP_REPOSITORIES, HEALTH_SOURCE, resolveGcpImages, resolveAwsImages, validateModuleReferences } from "../tools/build-release.mjs";

const digest = (character) => "sha256:" + character.repeat(64);
const metadata = (character, os = "linux", architecture = "amd64") => ({
  Descriptor: { digest: digest(character), platform: { os, architecture } },
  SchemaV2Manifest: { config: { digest: digest("d") } },
});
const pins = { den_api: GCP_REPOSITORIES.den_api + "@" + digest("a"), den_web: GCP_REPOSITORIES.den_web + "@" + digest("b") };
const inspect = (source) => metadata(source.includes("openwork-den-api") ? "a" : source.includes("openwork-den-web") ? "b" : "c");

test("operator resolves exact published tags and re-verifies Linux/amd64 child digests", () => {
  const calls = [];
  const images = resolveGcpImages("0.18.0", undefined, (ref) => {
    calls.push(ref);
    const selected = inspect(ref);
    return ref.includes("@") && ref !== HEALTH_SOURCE ? selected
      : [metadata("e", "linux", "arm64"), metadata("f", "unknown", "unknown"), selected];
  });
  assert.deepEqual(images, { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
  assert.deepEqual(calls, [GCP_REPOSITORIES.den_api + ":0.18.0", pins.den_api,
    GCP_REPOSITORIES.den_web + ":0.18.0", pins.den_web, HEALTH_SOURCE, images.health]);
});

test("Docker OCIManifest metadata is supported as well as schema-v2 metadata", () => {
  const images = resolveGcpImages("0.18.0", undefined, (source) => {
    const entry = inspect(source);
    entry.OCIManifest = entry.SchemaV2Manifest;
    delete entry.SchemaV2Manifest;
    return entry;
  });
  assert.deepEqual(images, { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
});

test("explicit approved pins are verified, never accepted offline by production builder", () => {
  const calls = [];
  assert.deepEqual(resolveGcpImages("0.18.0", pins, (ref) => { calls.push(ref); return inspect(ref); }),
    { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
  assert.equal(calls[0], pins.den_api);
  assert.equal(calls[1], pins.den_api);
  assert.throws(() => resolveGcpImages("0.18.0", pins, () => { throw new Error("registry pin not found"); }), /not found/);
});

test("missing, mutable, wrong-repository and unexpected approved pin inventories fail closed", () => {
  for (const candidate of [null, [], {}, { den_api: pins.den_api }, { ...pins, health: HEALTH_SOURCE },
    { ...pins, den_api: GCP_REPOSITORIES.den_api + ":0.18.0" },
    { ...pins, den_api: "evil.test/api@" + digest("a") }, { ...pins, den_api: pins.den_web },
    { ...pins, den_api: pins.den_api + "\n" }, { ...pins, den_api: pins.den_api.toUpperCase() }]) {
    let contacted = false;
    assert.throws(() => resolveGcpImages("0.18.0", candidate, (ref) => { contacted = true; return inspect(ref); }));
    assert.equal(contacted, false);
  }
});

test("unavailable/ambiguous platforms and invalid registry digests cannot produce pins", () => {
  const malformed = metadata("a");
  malformed.Descriptor.digest = "sha256:" + "G".repeat(64);
  for (const response of [[], {}, metadata("a", "linux", "arm64"),
    [metadata("a"), metadata("b")], malformed, { ...metadata("a"), SchemaV2Manifest: undefined }]) {
    assert.throws(() => resolveGcpImages("0.18.0", undefined, () => response), /Linux\/amd64/);
  }
});

test("registry re-verification and approved manifest identity must match", () => {
  let count = 0;
  assert.throws(() => resolveGcpImages("0.18.0", undefined, () => metadata(++count === 1 ? "a" : "b")), /Registry digest mismatch/);
  assert.throws(() => resolveGcpImages("0.18.0", { ...pins, den_api: GCP_REPOSITORIES.den_api + "@" + digest("e") }, inspect), /Approved pin/);
});

test("default AWS release resolves current image tags without adding GCP inventory", () => {
  const output = mkdtempSync(join(tmpdir(), "openwork-aws-build-test-"));
  try {
    buildRelease(["aws", "0.18.65", output], inspect);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.provider, "aws");
    const release = JSON.parse(execFileSync("tar", ["-xOf", join(output, "bundle.tar.gz"), "release.json"], { encoding: "utf8" }));
    assert.equal(release.provider, "aws");
    assert.deepEqual(release.images, pins);
    assert.ok(release.files["infra/managed-deployments/aws/runner/runner.py"]);
    assert.equal(Object.keys(release.files).some((file) => file.includes("/gcp/")), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("GCP CLI cannot disable registry verification or use unsupported options", () => {
  const script = new URL("../tools/build-release.mjs", import.meta.url).pathname;
  for (const args of [["gcp", "latest"], ["gcp", "0.18.0", "/unused", "--skip-verification"],
    ["aws", "0.18.0", "/unused", "--image-pins", "/unused"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  }
});

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("second-update fixture only overrides the non-secret revision default", () => {
  const fixture = readFileSync(resolve(root, "infra/managed-deployments/tests/second-update_override.tf"), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("#")).join("\n").trim();
  assert.match(fixture, /^variable "tls_task_revision"\s*\{\s*default = "second-update"\s*\}$/);
  const main = readFileSync(resolve(root, "infra/managed-deployments/aws/terraform/main.tf"), "utf8");
  assert.match(main, /variable "tls_task_revision"\s*\{\s*type\s*=\s*string\s*default\s*=\s*""/);
  assert.match(main, /OPENWORK_MANAGED_TASK_REVISION\s*=\s*var\.tls_task_revision/);
});
const modulePath = "infra/terraform/modules/openwork-aws-ecs";
test("new AWS installer versions use independently approved immutable application images", () => {
  assert.deepEqual(resolveAwsImages(pins, inspect), pins);
  for (const candidate of [{}, { ...pins, den_api: GCP_REPOSITORIES.den_api + ":latest" }, { ...pins, health: HEALTH_SOURCE }]) {
    assert.throws(() => resolveAwsImages(candidate, inspect));
  }
  assert.throws(() => resolveAwsImages(pins, () => { throw new Error("missing image"); }), /missing image/);
});
test("AWS tag resolution verifies both unique Linux/amd64 manifests", () => {
  const calls = [];
  assert.deepEqual(resolveAwsImages("0.18.65", undefined, (ref) => {
    calls.push(ref);
    return [metadata("e", "linux", "arm64"), inspect(ref)];
  }), pins);
  assert.deepEqual(calls, [GCP_REPOSITORIES.den_api + ":0.18.65", pins.den_api,
    GCP_REPOSITORIES.den_web + ":0.18.65", pins.den_web]);
  for (const response of [[], metadata("a", "linux", "arm64"), [metadata("a"), metadata("b")]]) {
    assert.throws(() => resolveAwsImages("0.18.65", undefined, () => response), /Linux\/amd64/);
  }
  assert.deepEqual(resolveAwsImages("0.18.65", pins, inspect), pins);
});

for (const provider of ["aws", "gcp"]) {
  test(`${provider} repeated builds produce identical archives and manifests`, () => {
    const output = mkdtempSync(join(tmpdir(), "openwork-reproducible-build-"));
    try {
      buildRelease([provider, "0.18.65-test.1", output], inspect);
      const before = ["bundle.tar.gz", "manifest.json"].map((name) => readFileSync(join(output, name)));
      buildRelease([provider, "0.18.65-test.1", output], inspect);
      for (const [index, name] of ["bundle.tar.gz", "manifest.json"].entries()) {
        assert.deepEqual(readFileSync(join(output, name)), before[index]);
      }
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

test("portable archive ignores source timestamps, modes and output filename, refuses symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "openwork-archive-test-"));
  const source = join(directory, "source");
  const helper = fileURLToPath(new URL("../tools/deterministic-archive.py", import.meta.url));
  try {
    // Keep outputs outside the archived source tree.
    mkdirSync(source);
    const file = join(source, "runner.py");
    writeFileSync(file, "print('fixture')\n");
    execFileSync("python3", [helper, source, join(directory, "first.tar.gz")]);
    chmodSync(file, 0o755);
    utimesSync(file, 100, 200);
    execFileSync("python3", [helper, source, join(directory, "second.tar.gz")]);
    assert.deepEqual(readFileSync(join(directory, "first.tar.gz")), readFileSync(join(directory, "second.tar.gz")));
    symlinkSync(file, join(source, "link"));
    const result = spawnSync("python3", [helper, source, join(directory, "third.tar.gz")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing symlink/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("missing module-local file references fail the release before packaging", () => {
  const definition = `${modulePath}/migration.tf`;
  const code = `${modulePath}/migration.py`;
  const source = readFileSync(resolve(root, definition), "utf8");
  assert.throws(() => validateModuleReferences([definition], () => source), /Missing packaged module reference.*migration.py/);
  assert.doesNotThrow(() => validateModuleReferences([definition, code], () => source));
});

test("managed AWS explicitly preserves legacy keys while adopting the shared module", () => {
  const tls = readFileSync(resolve(root, modulePath, "security.tf"), "utf8");
  assert.match(tls, /https:\/\/truststore\.pki\.rds\.amazonaws\.com/);
  assert.match(tls, /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(tls, /insecure\s*=\s*true/);
  const main = readFileSync(resolve(root, "infra/managed-deployments/aws/terraform/main.tf"), "utf8");
  assert.match(main, /source\s*=\s*"\.\.\/\.\.\/\.\.\/terraform\/modules\/openwork-aws-ecs"/);
  assert.match(main, /write_only_secrets\s*=\s*false/);
  assert.match(main, /managed_legacy_secrets\s*=\s*true/);
});

test("installer archive contains every shared operational dependency with identical file bytes", () => {
  const output = mkdtempSync(join(tmpdir(), "openwork-shared-installer-test-"));
  try {
    buildRelease(["aws", "0.18.58", output], inspect);
    const bundle = join(output, "bundle.tar.gz");
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.bundleSha256, sha256(readFileSync(bundle)));
    const release = JSON.parse(execFileSync("tar", ["-xOf", bundle, "release.json"], { encoding: "utf8" }));
    const names = Object.keys(release.files);
    // Python lists raw members; macOS tar can hide AppleDouble sidecars.
    const archiveNames = JSON.parse(execFileSync("python3", ["-c",
      "import json,sys,tarfile; a=tarfile.open(sys.argv[1]); print(json.dumps([e.name for e in a.getmembers() if e.isfile()]))", bundle], { encoding: "utf8" }));
    assert.deepEqual(archiveNames.sort(), [...names, "release.json"].sort());
    const expected = readdirSync(resolve(root, modulePath)).filter((name) => name.endsWith(".tf") || name === "migration.py").map((name) => `${modulePath}/${name}`).sort();
    assert.ok(expected.includes(`${modulePath}/migration.py`));
    validateModuleReferences(expected);
    assert.deepEqual(names.filter((name) => name.startsWith(modulePath + "/")).sort(), expected);
    assert.equal(names.some((name) => name.includes("aws/terraform/modules/openwork-aws-ecs/")), false);
    assert.equal(names.some((name) => name.includes("/examples/") || name.includes("/tests/")), false);
    assert.equal(names.some((name) => name.endsWith("second-update_override.tf")), false);
    assert.match(execFileSync("tar", ["-xOf", bundle, "infra/managed-deployments/aws/runner/runner.py"], { encoding: "utf8" }), /def tls_redeploy\(force=True, cluster=None, expected=None\):/);
    for (const name of expected) {
      const source = readFileSync(resolve(root, name));
      const packaged = execFileSync("tar", ["-xOf", bundle, name]);
      assert.deepEqual(packaged, source, name);
      assert.equal(release.files[name], sha256(source), name);
    }
    const packagedMain = execFileSync("tar", ["-xOf", bundle, "infra/managed-deployments/aws/terraform/main.tf"], { encoding: "utf8" });
    assert.match(packagedMain, /source\s*=\s*"\.\.\/\.\.\/\.\.\/terraform\/modules\/openwork-aws-ecs"/);
    assert.equal(names.some((name) => /\.(?:tfstate|tfvars|tfplan)(?:\.|$)/.test(name)), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
