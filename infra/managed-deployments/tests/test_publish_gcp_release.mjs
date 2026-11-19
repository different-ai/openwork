import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publisher = fileURLToPath(new URL("../tools/publish-gcp-release.mjs", import.meta.url));
const bucket = "offline-release-bucket";
const projectId = "offline-release-project";
const projectNumber = "123456789012";
const version = "1.2.3-test.1";
const names = ["bundle.tar.gz", "tutorial.md", "manifest.json"];
const generations = Object.fromEntries(names.map((name, index) => [name, `170000000000000${index + 1}`]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// These executables never delegate to a real CLI or network. Injection lives
// only in this test's --import preload, not in the production publisher.
const fakeGcloud = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TEST_ROOT;
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(root, "gcloud.jsonl"), JSON.stringify(args) + "\\n");
const out = (value) => console.log(JSON.stringify(value));
const action = args.slice(0, 3).join(" ");
if (args[0] === "projects" && args[1] === "describe") out(config.project);
else if (action === "storage buckets describe") {
  if (!args.includes("--raw")) throw new Error("Bucket describe must use raw API fields");
  out(config.storage);
} else if (action === "storage buckets get-iam-policy") out(config.policy);
else if (action === "storage objects list") {
  if (config.listError) { console.error("Permission denied"); process.exit(1); }
  if (!args.includes("--raw") || args.includes("--stat") || args.includes("--all-versions")) throw new Error("Must inspect raw live and noncurrent generations with supported CLI flags");
  out(Array.isArray(config.existing) ? [...config.existing, ...Object.keys(config.generations).filter((name) => existsSync(join(root, "uploaded-" + name)) && !config.existing.some((object) => object.name === "releases/gcp/" + config.version + "/" + name)).map((name) => ({ name: "releases/gcp/" + config.version + "/" + name, generation: config.generations[name] }))] : config.existing);
} else if (args[0] === "storage" && args[1] === "cp") {
  const name = args[3].split("/").at(-1);
  if (!args.includes("--if-generation-match=0")) throw new Error("Missing overwrite guard");
  if (config.concurrentObject === name || existsSync(join(root, "uploaded-" + name))) {
    console.error("412 precondition failed"); process.exit(1);
  }
  writeFileSync(join(root, "uploaded-" + name), readFileSync(args[2]));
  if (config.mutateLocal === name) writeFileSync(args[2], "changed after validation");
} else if (action === "storage objects describe") {
  const name = args[3].split("/").at(-1);
  if (!existsSync(join(root, "uploaded-" + name))) throw new Error("Describing nonexistent upload");
  out({ generation: config.badGeneration ?? config.generations[name] });
} else throw new Error("Unexpected command: " + JSON.stringify(args));
`;

const fetchPreload = `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.TEST_ROOT;
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  appendFileSync(join(root, "fetch.jsonl"), JSON.stringify({ url: url.href, redirect: options?.redirect }) + "\\n");
  const name = url.pathname.split("/").at(-1);
  if (url.origin !== "https://storage.googleapis.com" ||
      url.pathname !== "/" + config.bucket + "/releases/gcp/" + config.version + "/" + name ||
      url.search !== "?generation=" + config.generations[name] ||
      options?.redirect !== "error" || !options?.signal) throw new Error("Unsafe public verification request");
  if (config.fetchError === name) throw new Error("Network verification failed");
  const bytes = config.corruptPublic === name ? Buffer.from("wrong public bytes") : readFileSync(join(root, "uploaded-" + name));
  return new Response(bytes, { status: config.privatePublic === name ? 403 : 200 });
};
`;

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "openwork-gcp-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = Buffer.from("offline bundle fixture\n");
  const tutorial = Buffer.from("# Offline tutorial fixture\n");
  const manifest = { provider: "gcp", version, bundleSha256: sha256(bundle), templateSha256: sha256(tutorial) };
  const config = {
    project: { projectId, projectNumber },
    // Raw Cloud Storage JSON API representation, not gcloud's normalized view.
    storage: { name: bucket, projectNumber, versioning: { enabled: true }, iamConfiguration: { publicAccessPrevention: "inherited" } },
    policy: { bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }] },
    existing: [], bucket, version, generations, ...overrides,
  };
  writeFileSync(join(root, "bundle.tar.gz"), bundle);
  writeFileSync(join(root, "tutorial.md"), tutorial);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(root, "gcloud"), fakeGcloud);
  chmodSync(join(root, "gcloud"), 0o700);
  const preload = join(root, "fetch-preload.mjs");
  writeFileSync(preload, fetchPreload);
  const log = (name) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    root, manifest, config,
    run: (args = [root, bucket, projectId, projectNumber]) => spawnSync(process.execPath, ["--import", preload, publisher, ...args], {
      encoding: "utf8", timeout: 10_000,
      // PATH contains only the fake gcloud; no inherited auth, proxy, or Node preload.
      env: { PATH: root, HOME: root, CLOUDSDK_CONFIG: root, TEST_ROOT: root },
    }),
    commands: () => log("gcloud.jsonl"),
    requests: () => log("fetch.jsonl"),
  };
}

function refused(f, pattern, { beforeUpload = true } = {}) {
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, "", "A failed verification must not emit Den configuration");
  if (beforeUpload) {
    assert.equal(f.commands().filter((args) => args[0] === "storage" && args[1] === "cp").length, 0);
    assert.equal(f.requests().length, 0);
  }
}

test("publishes reviewed bytes only to immutable public Google generation URLs", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    DEN_MANAGED_DEPLOYMENT_GCP_VERSION: version,
    DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: `https://storage.googleapis.com/${bucket}/releases/gcp/${version}/tutorial.md?generation=${generations["tutorial.md"]}`,
    DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: `https://storage.googleapis.com/${bucket}/releases/gcp/${version}/bundle.tar.gz?generation=${generations["bundle.tar.gz"]}`,
    DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: f.manifest.bundleSha256,
  });
  assert.equal(f.requests().length, 3, "Manifest must also be publicly verified");
  const commands = f.commands();
  const writes = commands.filter((args) => args[0] === "storage" && args[1] === "cp");
  assert.equal(writes.length, 3);
  assert.ok(commands.findIndex((args) => args.slice(0, 3).join(" ") === "storage objects list") < commands.indexOf(writes[0]));
  for (const [index, args] of writes.entries()) {
    assert.equal(args[3], `gs://${bucket}/releases/gcp/${version}/${names[index]}`);
    assert.ok(args.includes("--if-generation-match=0"));
    assert.equal(args[args.indexOf("--project") + 1], projectId);
  }
  assert.ok(commands.every((args) => !args.some((arg) => ["create", "add-iam-policy-binding", "set-iam-policy", "update", "rm"].includes(arg))));
});

for (const [label, overrides, pattern] of [
  ["wrong project number", { project: { projectId, projectNumber: "999999999999" } }, /Wrong release project/],
  ["wrong project id", { project: { projectId: "other-project", projectNumber } }, /Wrong release project/],
  ["wrong bucket project", { storage: { name: bucket, projectNumber: "999999999999", versioning: { enabled: true } } }, /Release bucket belongs/],
  ["wrong bucket name", { storage: { name: "other-bucket", projectNumber, versioning: { enabled: true } } }, /Release bucket belongs/],
  ["normalized gcloud output lacks ownership proof", { storage: { name: bucket, project_number: projectNumber, versioning_enabled: true } }, /Release bucket belongs/],
  ["versioning off", { storage: { name: bucket, projectNumber, versioning: { enabled: false } } }, /versioning enabled/],
  ["truthy versioning is not enabled", { storage: { name: bucket, projectNumber, versioning: { enabled: "true" } } }, /versioning enabled/],
  ["public access prevention", { storage: { name: bucket, projectNumber, versioning: { enabled: true }, iamConfiguration: { publicAccessPrevention: "enforced" } } }, /prevents unauthenticated/],
  ["requester pays", { storage: { name: bucket, projectNumber, versioning: { enabled: true }, billing: { requesterPays: true } } }, /prevents unauthenticated/],
  ["private policy", { policy: { bindings: [{ role: "roles/storage.objectViewer", members: ["allAuthenticatedUsers"] }] } }, /must already grant unconditional/],
  ["conditional policy", { policy: { bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"], condition: { expression: "false" } }] } }, /must already grant unconditional/],
  ["unexpected existing object", { existing: [{ name: `releases/gcp/${version}/unexpected`, generation: "42" }] }, /Unexpected existing release object/],
  ["unverifiable existence", { listError: true }, /Permission denied/],
  ["malformed existence response", { existing: {} }, /Invalid release object inventory/],
]) {
  test(`refuses ${label} before any upload`, (t) => refused(fixture(t, overrides), pattern));
}

for (const [label, mutation, pattern] of [
  ["wrong provider", (m) => ({ ...m, provider: "aws" }), /Invalid GCP release manifest/],
  ["version path traversal", (m) => ({ ...m, version: "../other" }), /Invalid GCP release manifest/],
  ["non-string version", (m) => ({ ...m, version: 123 }), /Invalid GCP release manifest/],
  ["invalid hash", (m) => ({ ...m, bundleSha256: "not-a-checksum" }), /Release artifact changed/],
  ["incorrect template hash", (m) => ({ ...m, templateSha256: "0".repeat(64) }), /Release artifact changed/],
  ["null manifest", () => null, /Invalid GCP release manifest/],
]) {
  test(`refuses ${label} before contacting gcloud`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, "manifest.json"), JSON.stringify(mutation(f.manifest)));
    refused(f, pattern);
    assert.equal(f.commands().length, 0);
  });
}

test("refuses corrupt bundle bytes before contacting gcloud", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "bundle.tar.gz"), "corrupt");
  refused(f, /Release artifact changed: bundle.tar.gz/);
  assert.equal(f.commands().length, 0);
});

test("refuses invalid bucket arguments before contacting gcloud", (t) => {
  const f = fixture(t);
  const result = f.run([f.root, "bucket/../../other", projectId, projectNumber]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.equal(f.commands().length, 0);
});

test("GCP resumes a partial publication and reuses exact generations on a full rerun", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "uploaded-bundle.tar.gz"), readFileSync(join(f.root, "bundle.tar.gz")));
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(f.commands().filter((args) => args[1] === "cp").length, 2);
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  assert.equal(f.commands().filter((args) => args[1] === "cp").length, 2);
});

test("GCP reuses the actual verified noncurrent generation, never a synthesized generation", (t) => {
  const f = fixture(t, {
    existing: [{ name: `releases/gcp/${version}/tutorial.md`, generation: "42", timeDeleted: "2026-01-01T00:00:00Z" }],
    generations: { ...generations, "tutorial.md": "42" },
  });
  writeFileSync(join(f.root, "uploaded-tutorial.md"), readFileSync(join(f.root, "tutorial.md")));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL,
    `https://storage.googleapis.com/${bucket}/releases/gcp/${version}/tutorial.md?generation=42`);
  assert.equal(f.commands().filter((args) => args[1] === "cp").length, 2);
});

for (const name of names) {
  test(`GCP preflights conflicting existing ${name} before any writes`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, "uploaded-" + name), "conflicting immutable bytes");
    refused(f, /differs from the reviewed local artifact/, { beforeUpload: false });
    assert.equal(f.commands().filter((args) => args[1] === "cp").length, 0);
  });
}

test("generation precondition still refuses a concurrent upload after preflight", (t) => {
  const f = fixture(t, { concurrentObject: "bundle.tar.gz" });
  refused(f, /412 precondition failed/, { beforeUpload: false });
  assert.equal(f.requests().length, 0);
  assert.equal(f.commands().filter((args) => args[1] === "cp").length, 1);
});

for (const badGeneration of ["", "0", "123?redirect=other", 1700000000000001]) {
  test(`refuses invalid or lossy generation ${JSON.stringify(badGeneration)}`, (t) => {
    const f = fixture(t, { badGeneration });
    refused(f, /immutable generation/, { beforeUpload: false });
    assert.equal(f.requests().length, 0);
  });
}

for (const name of names) {
  test(`refuses publicly inaccessible ${name} without configuration output`, (t) => refused(fixture(t, { privatePublic: name }), /not publicly readable \(403\)/, { beforeUpload: false }));
  test(`refuses public byte mismatch for ${name} without configuration output`, (t) => refused(fixture(t, { corruptPublic: name }), /differs from the reviewed local artifact/, { beforeUpload: false }));
}

test("public verification fails closed on network errors", (t) => refused(fixture(t, { fetchError: "bundle.tar.gz" }), /Network verification failed/, { beforeUpload: false }));

test("verification uses the original reviewed digest even if local bytes change later", (t) => {
  const f = fixture(t, { mutateLocal: "bundle.tar.gz" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256, f.manifest.bundleSha256);
});
