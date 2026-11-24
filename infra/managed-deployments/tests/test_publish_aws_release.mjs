import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publisher = fileURLToPath(new URL("../tools/publish-release.mjs", import.meta.url));
const bucket = "offline-release-bucket";
const accountId = "123456789012";
const region = "us-east-1";
const version = "1.2.3-test.1";
const names = ["bundle.tar.gz", "cloudformation.json", "manifest.json"];
// Exercise URL encoding, not just simple alphanumeric version IDs.
const versionIds = Object.fromEntries(names.map((name, index) => [name, `pinned+version/${index + 1}=`]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const fakeAws = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TEST_ROOT;
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(root, "aws.jsonl"), JSON.stringify(args) + "\\n");
const action = args.slice(0, 2).join(" ");
const out = (value) => console.log(JSON.stringify(value));
if (action === "sts get-caller-identity") out({ Account: config.identityAccount });
else {
  if (args[args.indexOf("--expected-bucket-owner") + 1] !== config.accountId) throw new Error("Missing expected bucket owner");
  if (args[args.indexOf("--bucket") + 1] !== config.bucket) throw new Error("Wrong bucket");
  if (config.wrongOwner) { console.error("403 expected bucket owner mismatch"); process.exit(1); }
  if (action === "s3api get-bucket-versioning") out({ Status: config.versioning });
  else if (action === "s3api list-object-versions") {
    if (config.listError) { console.error("Permission denied"); process.exit(1); }
    if (args[args.indexOf("--prefix") + 1] !== "releases/aws/" + config.version + "/") throw new Error("Wrong prefix");
    out(config.inventory ?? { Versions: Object.keys(config.versionIds).filter((name) => existsSync(join(root, "uploaded-" + name))).map((name) => ({ Key: "releases/aws/" + config.version + "/" + name, VersionId: config.versionIds[name] })) });
  }
  else if (action === "s3api put-object") {
    const name = args[args.indexOf("--key") + 1].split("/").at(-1);
    if (args[args.indexOf("--if-none-match") + 1] !== "*") throw new Error("Missing overwrite guard");
    if (config.concurrentObject === name || existsSync(join(root, "uploaded-" + name))) { console.error("412 precondition failed"); process.exit(1); }
    writeFileSync(join(root, "uploaded-" + name), readFileSync(args[args.indexOf("--body") + 1]));
    out({ VersionId: config.badVersionId ?? config.versionIds[name] });
  } else throw new Error("Unexpected command: " + JSON.stringify(args));
}
`;

const fetchPreload = `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.TEST_ROOT;
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  appendFileSync(join(root, "fetch.jsonl"), JSON.stringify({ url: url.href }) + "\\n");
  const name = url.pathname.split("/").at(-1);
  if (url.origin !== "https://" + config.bucket + ".s3.us-east-1.amazonaws.com" ||
      url.pathname !== "/releases/aws/" + config.version + "/" + name ||
      url.search !== "?versionId=" + encodeURIComponent(config.versionIds[name]) ||
      options?.redirect !== "error" || !options?.signal) throw new Error("Unsafe public verification request");
  if (config.fetchError === name) throw new Error("Network verification failed");
  const bytes = config.corruptPublic === name ? Buffer.from("wrong public bytes") : readFileSync(join(root, "uploaded-" + name));
  return new Response(bytes, { status: config.privatePublic === name ? 403 : 200 });
};
`;

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "openwork-aws-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = Buffer.from("offline bundle fixture\n");
  const template = Buffer.from('{"Description":"Offline template fixture"}\n');
  const manifest = { provider: "aws", version, bundleSha256: sha256(bundle), templateSha256: sha256(template) };
  const config = { bucket, accountId, identityAccount: accountId, versioning: "Enabled", version, versionIds, ...overrides };
  writeFileSync(join(root, "bundle.tar.gz"), bundle);
  writeFileSync(join(root, "cloudformation.json"), template);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(root, "aws"), fakeAws);
  chmodSync(join(root, "aws"), 0o700);
  const preload = join(root, "fetch-preload.mjs");
  writeFileSync(preload, fetchPreload);
  const log = (name) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    root, manifest,
    run: (args = [root, bucket, accountId, region]) => spawnSync(process.execPath, ["--import", preload, publisher, ...args], {
      encoding: "utf8", timeout: 10_000,
      // No real CLI on PATH or inherited AWS credentials, proxies, or preloads.
      env: { PATH: root, HOME: root, TEST_ROOT: root },
    }),
    commands: () => log("aws.jsonl"), requests: () => log("fetch.jsonl"),
  };
}

function refused(f, pattern, { beforeUpload = true } = {}) {
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, "", "A failed verification must not emit Den configuration");
  if (beforeUpload) {
    assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 0);
    assert.equal(f.requests().length, 0);
  }
}

test("AWS publisher verifies all unauthenticated pinned bytes and expected bucket owner", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    DEN_MANAGED_DEPLOYMENT_AWS_VERSION: version,
    DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: `https://${bucket}.s3.${region}.amazonaws.com/releases/aws/${version}/cloudformation.json?versionId=${encodeURIComponent(versionIds["cloudformation.json"])}`,
    DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: `https://${bucket}.s3.${region}.amazonaws.com/releases/aws/${version}/bundle.tar.gz?versionId=${encodeURIComponent(versionIds["bundle.tar.gz"])}`,
    DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: f.manifest.bundleSha256,
  });
  assert.equal(f.requests().length, 3);
  const commands = f.commands();
  const storageCommands = commands.filter((args) => args[0] === "s3api");
  assert.equal(storageCommands.length, 5);
  for (const args of storageCommands) assert.equal(args[args.indexOf("--expected-bucket-owner") + 1], accountId);
  const writes = storageCommands.filter((args) => args[1] === "put-object");
  assert.equal(writes.length, 3);
  for (const [index, args] of writes.entries()) {
    assert.equal(args[args.indexOf("--key") + 1], `releases/aws/${version}/${names[index]}`);
    assert.equal(args[args.indexOf("--if-none-match") + 1], "*");
    assert.equal(args[args.indexOf("--server-side-encryption") + 1], "AES256");
  }
  assert.ok(commands.every((args) => ["get-caller-identity", "get-bucket-versioning", "list-object-versions", "put-object"].includes(args[1])));
});

for (const [label, overrides, pattern] of [
  ["wrong account", { identityAccount: "999999999999" }, /Wrong AWS release account/],
  ["wrong bucket owner", { wrongOwner: true }, /expected bucket owner mismatch/],
  ["disabled versioning", { versioning: "Suspended" }, /versioning enabled/],
]) {
  test(`AWS publisher refuses ${label} before uploading`, (t) => refused(fixture(t, overrides), pattern));
}

test("AWS publisher refuses corrupt checksums before uploading", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "bundle.tar.gz"), "corrupt");
  refused(f, /Release artifact changed/);
});

test("AWS publisher refuses a wrong provider manifest before uploading", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "manifest.json"), JSON.stringify({ ...f.manifest, provider: "gcp" }));
  refused(f, /Invalid release manifest/);
});

test("AWS overwrite guard refuses concurrent objects after preflight", (t) => {
  const f = fixture(t, { concurrentObject: "bundle.tar.gz" });
  refused(f, /412 precondition failed/, { beforeUpload: false });
  assert.equal(f.requests().length, 0);
  assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 1);
});

test("AWS reuses matching immutable public objects after partial and complete publication", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "uploaded-bundle.tar.gz"), readFileSync(join(f.root, "bundle.tar.gz")));
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 2);
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 2);
});

test("AWS reuses the actual verified noncurrent version ID", (t) => {
  const reused = "historical+version/42=";
  const f = fixture(t, {
    versionIds: { ...versionIds, "cloudformation.json": reused },
    inventory: { Versions: [{ Key: `releases/aws/${version}/cloudformation.json`, VersionId: reused, IsLatest: false }] },
  });
  writeFileSync(join(f.root, "uploaded-cloudformation.json"), readFileSync(join(f.root, "cloudformation.json")));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL,
    `https://${bucket}.s3.${region}.amazonaws.com/releases/aws/${version}/cloudformation.json?versionId=${encodeURIComponent(reused)}`);
  assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 2);
});

for (const name of names) {
  test(`AWS preflights conflicting existing ${name} before any writes`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, "uploaded-" + name), "conflicting immutable bytes");
    refused(f, /differs from the reviewed local artifact/, { beforeUpload: false });
    assert.equal(f.commands().filter((args) => args[1] === "put-object").length, 0);
  });
}

for (const [label, overrides, pattern] of [
  ["list failure", { listError: true }, /Permission denied/],
  ["malformed inventory", { inventory: { Versions: {} } }, /Invalid release object inventory/],
  ["delete markers", { inventory: { DeleteMarkers: [{ Key: "deleted" }] } }, /delete markers/],
]) {
  test(`AWS refuses ${label} before any writes`, (t) => refused(fixture(t, overrides), pattern));
}

for (const badVersionId of ["", "null", 42]) {
  test(`AWS publisher refuses nonimmutable version ID ${JSON.stringify(badVersionId)}`, (t) => {
    const f = fixture(t, { badVersionId });
    refused(f, /immutable version ID/, { beforeUpload: false });
    assert.equal(f.requests().length, 0);
  });
}

for (const name of names) {
  test(`AWS publisher refuses publicly inaccessible ${name}`, (t) => refused(fixture(t, { privatePublic: name }), /not publicly readable \(403\)/, { beforeUpload: false }));
  test(`AWS publisher refuses public byte mismatch for ${name}`, (t) => refused(fixture(t, { corruptPublic: name }), /differs from the reviewed local artifact/, { beforeUpload: false }));
}

test("AWS public verification fails closed on network errors", (t) => refused(fixture(t, { fetchError: "bundle.tar.gz" }), /Network verification failed/, { beforeUpload: false }));

test("AWS publisher rejects a bucket URL injection before invoking the CLI", (t) => {
  const f = fixture(t);
  const result = f.run([f.root, "example.com/path?redirect=", accountId, region]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.equal(f.commands().length, 0);
});

test("AWS publisher rejects a region URL injection before invoking the CLI", (t) => {
  const f = fixture(t);
  const result = f.run([f.root, bucket, accountId, "us-east-1.example/path"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.equal(f.commands().length, 0);
});
