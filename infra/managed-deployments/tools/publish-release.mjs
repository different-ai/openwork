#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Explicit operator action, using the caller's AWS credential chain. No keys
// enter the bundle or the application. The bucket must be in a release account.
const [directory, bucket, accountId, region = "us-east-1"] = process.argv.slice(2);
if (!directory || !bucket || !/^\d{12}$/.test(accountId ?? "")) throw new Error("Usage: publish-release.mjs <directory> <release-bucket> <release-account-id> [region]");
const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8" }));
const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== accountId) throw new Error("Wrong AWS release account; refusing publication.");
const versioning = aws(["s3api", "get-bucket-versioning", "--bucket", bucket]);
if (versioning.Status !== "Enabled") throw new Error("The release bucket must have versioning enabled.");
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
if (manifest.provider !== "aws" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("Invalid release manifest.");
for (const [name, expected] of [["bundle.tar.gz", manifest.bundleSha256], ["cloudformation.json", manifest.templateSha256]]) {
  if (createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex") !== expected) throw new Error("Release artifact changed after packaging.");
}
const uploaded = {};
for (const name of ["bundle.tar.gz", "cloudformation.json", "manifest.json"]) {
  const key = `releases/${manifest.provider}/${manifest.version}/${name}`;
  const result = aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", resolve(directory, name), "--if-none-match", "*", "--server-side-encryption", "AES256", "--content-type", name.endsWith(".json") ? "application/json" : "application/gzip"]);
  if (!result.VersionId) throw new Error("Upload did not return an immutable version ID.");
  uploaded[name] = `https://${bucket}.s3.${region}.amazonaws.com/${key}?versionId=${encodeURIComponent(result.VersionId)}`;
}
// Public installer URLs and hashes only. There are no credentials in these values.
console.log(JSON.stringify({
  DEN_MANAGED_DEPLOYMENT_AWS_VERSION: manifest.version,
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: uploaded["cloudformation.json"],
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: uploaded["bundle.tar.gz"],
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: manifest.bundleSha256,
}, null, 2));
