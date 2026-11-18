#!/usr/bin/env node
// Explicit operator publication only. This command never creates a bucket,
// enables billing, changes IAM, or uploads credentials.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [directory, bucket, projectId, projectNumber] = process.argv.slice(2);
if (!directory || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket ?? "") || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? "") || !/^\d{6,20}$/.test(projectNumber ?? "")) {
  throw new Error("Usage: publish-gcp-release.mjs <directory> <existing-public-release-bucket> <release-project-id> <release-project-number>");
}
const gcloud = (args) => JSON.parse(execFileSync("gcloud", [...args, "--format=json", "--quiet"], { encoding: "utf8" }));
// Validate all local bytes before contacting the release project.
const artifacts = ["bundle.tar.gz", "tutorial.md", "manifest.json"];
const digests = Object.fromEntries(artifacts.map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")]));
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
if (manifest?.provider !== "gcp" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("Invalid GCP release manifest.");
for (const [name, checksum] of [["bundle.tar.gz", manifest.bundleSha256], ["tutorial.md", manifest.templateSha256]]) {
  if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum) || digests[name] !== checksum) throw new Error(`Release artifact changed: ${name}`);
}
const project = gcloud(["projects", "describe", projectId]);
if (project.projectId !== projectId || String(project.projectNumber) !== projectNumber) throw new Error("Wrong release project; refusing publication.");
// Default gcloud describe output omits projectNumber. --raw exposes the
// Cloud Storage JSON API fields (name, projectNumber, versioning.enabled).
const storage = gcloud(["storage", "buckets", "describe", `gs://${bucket}`, "--raw", "--project", projectId]);
if (storage.name !== bucket || String(storage.projectNumber) !== projectNumber) throw new Error("Release bucket belongs to another project or does not match the requested bucket.");
if (storage.versioning?.enabled !== true) throw new Error("The release bucket must have object versioning enabled.");
if (storage.iamConfiguration?.publicAccessPrevention === "enforced" || storage.billing?.requesterPays === true) throw new Error("The release bucket prevents unauthenticated public downloads.");
const policy = gcloud(["storage", "buckets", "get-iam-policy", `gs://${bucket}`, "--project", projectId]);
// Fail closed: this publisher supports existing bucket-wide public reader
// policies, not arbitrary conditional IAM expressions or per-object ACLs.
if (!policy.bindings?.some((binding) => binding.role === "roles/storage.objectViewer" && !binding.condition && binding.members?.includes("allUsers"))) throw new Error("The release bucket must already grant unconditional roles/storage.objectViewer to allUsers; publication does not change public-access policy.");
const prefix = `releases/gcp/${manifest.version}/`;
const publicUrl = (key, generation) => {
  if (typeof generation !== "string" || !/^[1-9]\d*$/.test(generation)) throw new Error("Upload did not return an immutable generation.");
  return `https://storage.googleapis.com/${bucket}/${key}?generation=${generation}`;
};
async function verify(name, url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Published ${name} is not publicly readable (${response.status}). Configure the release bucket's public access policy, then verify before configuring Den.`);
  const digest = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  if (digest !== digests[name]) throw new Error(`Published ${name} differs from the reviewed local artifact.`);
}
// objects list includes live AND noncurrent generations by default (not --stat).
// Use raw API fields so names and generation strings cannot be reformatted.
// Check all of them before writing; never hide conflicting historical bytes.
const existing = gcloud(["storage", "objects", "list", `gs://${bucket}/${prefix}**`, "--raw", "--project", projectId]);
if (!Array.isArray(existing)) throw new Error("Invalid release object inventory.");
const uploaded = {};
for (const object of existing) {
  const name = object.name?.slice(prefix.length);
  if (!object.name?.startsWith(prefix) || !artifacts.includes(name)) throw new Error("Unexpected existing release object.");
  const url = publicUrl(object.name, object.generation);
  await verify(name, url);
  uploaded[name] = url;
}
for (const name of artifacts) {
  if (uploaded[name]) continue;
  const key = `${prefix}${name}`;
  execFileSync("gcloud", ["storage", "cp", resolve(directory, name), `gs://${bucket}/${key}`, "--project", projectId, "--if-generation-match=0", "--quiet"], { stdio: "inherit" });
  const object = gcloud(["storage", "objects", "describe", `gs://${bucket}/${key}`, "--raw", "--project", projectId]);
  uploaded[name] = publicUrl(key, object.generation);
}
// Verify unauthenticated access; publication is not readiness when the bucket
// policy prevents customer installers from downloading these bytes.
for (const [name, url] of Object.entries(uploaded)) await verify(name, url);
console.log(JSON.stringify({
  DEN_MANAGED_DEPLOYMENT_GCP_VERSION: manifest.version,
  DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: uploaded["tutorial.md"],
  DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: uploaded["bundle.tar.gz"],
  DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: manifest.bundleSha256,
}, null, 2));
