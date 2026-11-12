#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Explicit operator action, using the caller's AWS credential chain. No keys
// enter the bundle or the application. The bucket must be in a release account.
const [directory, bucket, accountId, region = "us-east-1"] = process.argv.slice(2);
if (!directory || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") || !/^\d{12}$/.test(accountId ?? "") || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error("Usage: publish-release.mjs <directory> <release-bucket> <release-account-id> [region]");
const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8" }));
const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== accountId) throw new Error("Wrong AWS release account; refusing publication.");
const versioning = aws(["s3api", "get-bucket-versioning", "--bucket", bucket, "--expected-bucket-owner", accountId]);
if (versioning.Status !== "Enabled") throw new Error("The release bucket must have versioning enabled.");
const artifacts = ["bundle.tar.gz", "cloudformation.json", "manifest.json"];
const digests = Object.fromEntries(artifacts.map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")]));
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
if (manifest?.provider !== "aws" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("Invalid release manifest.");
for (const [name, expected] of [["bundle.tar.gz", manifest.bundleSha256], ["cloudformation.json", manifest.templateSha256]]) {
  if (digests[name] !== expected) throw new Error("Release artifact changed after packaging.");
}
const prefix = `releases/aws/${manifest.version}/`;
const uploaded = {};
const publicUrl = (key, versionId) => {
  if (typeof versionId !== "string" || !versionId || versionId === "null") throw new Error("Upload did not return an immutable version ID.");
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}?versionId=${encodeURIComponent(versionId)}`;
};
async function verify(name, url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Published ${name} is not publicly readable (${response.status}). Configure the release bucket's public access policy, then verify before configuring Den.`);
  const digest = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  if (digest !== digests[name]) throw new Error(`Published ${name} differs from the reviewed local artifact.`);
}
// Preflight every immutable version before writing anything. Never replace or
// delete existing bytes, including noncurrent versions and delete markers.
const existing = aws(["s3api", "list-object-versions", "--bucket", bucket, "--expected-bucket-owner", accountId, "--prefix", prefix]);
if (!existing || !Array.isArray(existing.Versions ?? []) || !Array.isArray(existing.DeleteMarkers ?? [])) throw new Error("Invalid release object inventory.");
if ((existing.DeleteMarkers ?? []).length) throw new Error("Release prefix contains delete markers; refusing publication.");
for (const object of existing.Versions ?? []) {
  const name = object.Key?.slice(prefix.length);
  if (!object.Key?.startsWith(prefix) || !artifacts.includes(name)) throw new Error("Unexpected existing release object.");
  const url = publicUrl(object.Key, object.VersionId);
  await verify(name, url);
  uploaded[name] = url;
}
for (const name of artifacts) {
  if (uploaded[name]) continue;
  const key = `${prefix}${name}`;
  const result = aws(["s3api", "put-object", "--bucket", bucket, "--expected-bucket-owner", accountId, "--key", key, "--body", resolve(directory, name), "--if-none-match", "*", "--server-side-encryption", "AES256", "--content-type", name.endsWith(".json") ? "application/json" : "application/gzip"]);
  uploaded[name] = publicUrl(key, result.VersionId);
}
// Successful uploads are not readiness: customers must be able to download the
// exact pinned bytes without credentials. Never change IAM or public policy here.
for (const [name, url] of Object.entries(uploaded)) await verify(name, url);
// Public installer URLs and hashes only. There are no credentials in these values.
console.log(JSON.stringify({
  DEN_MANAGED_DEPLOYMENT_AWS_VERSION: manifest.version,
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: uploaded["cloudformation.json"],
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: uploaded["bundle.tar.gz"],
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: manifest.bundleSha256,
}, null, 2));
