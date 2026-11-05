#!/usr/bin/env node
// Reconcile NEW installer defaults only. Never call Den deployment/org APIs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GCP_REPOSITORIES, resolveImage } from "../../infra/managed-deployments/tools/build-release.mjs";

export const PROMOTION_ENVIRONMENT = "managed-installer-production";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function stableVersion(tag) {
  const version = typeof tag === "string" ? tag.replace(/^v/, "") : "";
  if (!VERSION.test(version)) throw new Error("Expected a strict numeric stable release tag.");
  return version;
}
export function compareVersions(left, right) {
  const a = stableVersion(left).split(".").map(BigInt);
  const b = stableVersion(right).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function assertTrustedEvent(event, name, repository, ref) {
  if (event.repository?.full_name !== repository || !event.repository.default_branch) throw new Error("Untrusted repository event.");
  if (name === "workflow_run") {
    if (event.workflow_run?.head_repository?.full_name !== repository
      || event.workflow_run.conclusion !== "success"
      || !["Publish EE Artifacts", "Release App"].includes(event.workflow_run.name)) throw new Error("Untrusted or unsuccessful release workflow.");
  } else if (name === "workflow_dispatch" || name === "schedule") {
    if (ref !== `refs/heads/${event.repository.default_branch}`) throw new Error("Run this workflow from the trusted default branch.");
  } else if (name !== "release" || event.action !== "published") {
    throw new Error("Unsupported release event.");
  }
}

async function jsonRequest(url, token, fetchImpl, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    // URLs, headers and provider response bodies can contain credentials: do not log them.
    throw new Error("Release provider request failed; inspect provider status separately.");
  }
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`Release provider returned HTTP ${response.status}.`);
  try { return await response.json(); } catch { throw new Error("Release provider returned invalid JSON."); }
}
export function assertPromotionPolicy(environment) {
  const reviewers = environment?.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (environment?.name !== PROMOTION_ENVIRONMENT || reviewers?.prevent_self_review !== true
    || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length === 0
    || !reviewers.reviewers.every((entry) => ["User", "Team"].includes(entry?.type)
      && Number.isSafeInteger(entry.reviewer?.id) && entry.reviewer.id > 0)) {
    throw new Error("Managed installer promotion requires its dedicated environment with nonempty required reviewers and prevent_self_review enabled.");
  }
}
export async function checkPromotionPolicy(repository, token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository.");
  // A named environment is not evidence of approval protection. A missing,
  // unprotected or unreadable policy must fail before release credentials/mutations.
  const environment = await jsonRequest(`https://api.github.com/repos/${repository}/environments/${PROMOTION_ENVIRONMENT}`, token, fetchImpl);
  assertPromotionPolicy(environment);
}
export async function latestStable(repository, token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository.");
  const api = `https://api.github.com/repos/${repository}`;
  // GitHub's official latest endpoint, NOT a local checkout, event head, or :dev.
  const release = await jsonRequest(`${api}/releases/latest`, token, fetchImpl);
  if (release?.draft !== false || release.prerelease !== false) throw new Error("Latest GitHub release is not published stable production.");
  const version = stableVersion(release.tag_name);
  const tagRef = await jsonRequest(`${api}/git/ref/tags/${encodeURIComponent(release.tag_name)}`, token, fetchImpl);
  if (tagRef?.ref !== `refs/tags/${release.tag_name}`) throw new Error("Release tag reference does not match.");
  let object = tagRef.object;
  // Peel annotated tags explicitly; /commits/<name> can also resolve branches.
  for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
    if (!SHA.test(object.sha ?? "")) throw new Error("Invalid annotated release tag.");
    const tag = await jsonRequest(`${api}/git/tags/${object.sha}`, token, fetchImpl);
    object = tag?.object;
  }
  if (object?.type !== "commit" || !SHA.test(object.sha ?? "")) throw new Error("Release tag does not resolve to a commit.");
  return { version, tag: release.tag_name, commit: object.sha };
}
export function shouldPrepare(event, name, latest) {
  // Most Publish EE completions are unrelated :dev builds. Do not provision
  // Terraform/Docker for them; release and scheduled/manual reconciliation
  // still handle a missing GitHub-token-created release event.
  return name !== "workflow_run" || event.workflow_run?.head_sha === latest.commit;
}
export function assertSameLatest(candidate, latest) {
  if (candidate.version !== latest.version || candidate.tag !== latest.tag || candidate.commit !== latest.commit) {
    throw new Error("Latest stable release changed; prepare and qualify the new candidate instead.");
  }
}

export function verifyRuntimeImage(metadata, pin, candidate, repository) {
  if (!metadata || metadata.Os !== "linux" || metadata.Architecture !== "amd64"
    || !metadata.RepoDigests?.includes(pin)
    || metadata.Config?.Labels?.["org.opencontainers.image.revision"] !== candidate.commit
    || metadata.Config?.Labels?.["org.opencontainers.image.source"] !== `https://github.com/${repository}`) {
    throw new Error("Runtime image platform, digest or OCI release source does not match.");
  }
}
export function releaseImages(candidate, repository, inspectManifest, inspectRuntime) {
  return Object.fromEntries(["den_api", "den_web"].map((kind) => {
    const registry = GCP_REPOSITORIES[kind];
    // Share the builder's unique Linux/amd64 resolver, including digest re-read.
    const pin = resolveImage(`${registry}:${candidate.version}`, registry, inspectManifest);
    verifyRuntimeImage(inspectRuntime(pin), pin, candidate, repository);
    return [kind, pin];
  }));
}

export function releaseConfig(provider, value) {
  if (!["aws", "gcp"].includes(provider) || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "bundleSha256,bundleUrl,templateUrl,version") throw new Error("Invalid atomic release configuration.");
  if (stableVersion(value.version) !== value.version || value.version.length > 80) throw new Error("Atomic release version must be canonical numeric semver.");
  if (!HASH.test(value.bundleSha256 ?? "")) throw new Error("Invalid release bundle hash.");
  for (const field of ["templateUrl", "bundleUrl"]) {
    let url;
    try { url = new URL(value[field]); } catch { throw new Error("Invalid immutable release URL."); }
    const aws = provider === "aws";
    const key = aws ? "versionId" : "generation";
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash
      || (aws ? !/^[a-z0-9][a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) : url.host !== "storage.googleapis.com")
      || [...url.searchParams.keys()].join(",") !== key
      || !url.searchParams.get(key)?.trim() || url.searchParams.get(key) === "null"
      || (!aws && (!/^[1-9]\d*$/.test(url.searchParams.get(key))
        || !/^\/[a-z0-9][a-z0-9._-]{1,221}\/[^\\\s]+$/.test(url.pathname)))) throw new Error("Release URLs must be immutable cloud object versions.");
  }
  return { version: value.version, templateUrl: value.templateUrl, bundleUrl: value.bundleUrl, bundleSha256: value.bundleSha256 };
}
export function publisherConfig(published) {
  if (Object.hasOwn(published, "DEN_MANAGED_DEPLOYMENT_AWS_RELEASE")) {
    const atomic = published.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE;
    return releaseConfig("aws", typeof atomic === "string" ? JSON.parse(atomic) : atomic);
  }
  // Existing operator publisher output, not four writes to Render.
  return releaseConfig("aws", {
    version: published.DEN_MANAGED_DEPLOYMENT_AWS_VERSION,
    templateUrl: published.DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL,
    bundleUrl: published.DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL,
    bundleSha256: published.DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256,
  });
}
function parseCurrent(provider, snapshot) {
  if (snapshot.atomic !== null) {
    try { return releaseConfig(provider, JSON.parse(snapshot.atomic)); } catch { throw new Error("Present atomic release is invalid; refusing legacy fallback."); }
  }
  const values = snapshot.legacy;
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null || value === "")) throw new Error("Incomplete legacy installer configuration.");
  // Old URLs may not be version-pinned. Read them only to prohibit a downgrade.
  stableVersion(values[0]);
  return { version: values[0], templateUrl: values[1], bundleUrl: values[2], bundleSha256: values[3] };
}
export function assertForward(current, candidate) {
  if (!current) return;
  const order = compareVersions(candidate.version, current.version);
  if (order < 0) throw new Error("Refusing an installer downgrade.");
  if (order === 0 && current.bundleSha256 !== candidate.bundleSha256) throw new Error("Same installer version has different bytes; refusing replacement.");
}

export function renderClient(serviceId, token, fetchImpl = fetch) {
  if (!/^srv-[a-z0-9]+$/.test(serviceId ?? "") || !token) throw new Error("Configure the explicit Render service and API credential.");
  const base = `https://api.render.com/v1/services/${serviceId}`;
  const request = (path, options) => jsonRequest(base + path, token, fetchImpl, options);
  const readKey = async (key) => {
    const result = await request(`/env-vars/${key}`, { allowMissing: true });
    if (result === null) return null;
    if (result.key !== key || typeof result.value !== "string") throw new Error("Invalid Render environment variable response.");
    return result.value;
  };
  return {
    async snapshot(provider) {
      const prefix = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}`;
      const atomic = await readKey(`${prefix}_RELEASE`);
      return { atomic, legacy: atomic === null ? await Promise.all(["VERSION", "TEMPLATE_URL", "BUNDLE_URL", "BUNDLE_SHA256"].map((suffix) => readKey(`${prefix}_${suffix}`))) : [] };
    },
    put(provider, value) { return request(`/env-vars/DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_RELEASE`, { method: "PUT", body: JSON.stringify({ value: JSON.stringify(value) }) }); },
    deploy() { return request("/deploys", { method: "POST", body: "{}" }); },
    deployment(id) {
      if (!/^dep-[a-z0-9]+$/.test(id ?? "")) throw new Error("Invalid Render deploy receipt.");
      return request(`/deploys/${id}`);
    },
  };
}

// Render has no server-side compare-and-swap. The workflow serializes with the
// existing den-api-env lock, and re-reads this exact selected key before PUT.
// Dashboard/API writers must respect that lock operationally; no bulk env PUT.
export async function promote({ candidate, expected, client, latest, publish, provider = "aws", qualified = false }) {
  if (provider !== "aws") throw new Error("GCP publication remains an explicit operator action; do not enable an unconfigured provider.");
  if (!qualified) throw new Error("A reviewed real-cloud fresh install and approved Update are required.");
  const current = parseCurrent(provider, expected);
  assertSameLatest(candidate, await latest());
  assertForward(current, { version: candidate.version, bundleSha256: candidate.bundleSha256 });
  const config = releaseConfig(provider, await publish()); // existing safe/idempotent publisher owns object writes
  if (config.version !== candidate.version || config.bundleSha256 !== candidate.bundleSha256) throw new Error("Published release does not match the qualified candidate.");
  assertForward(current, config);
  if (current?.version === config.version) {
    if (JSON.stringify(current) !== JSON.stringify(config)) throw new Error("Same installer version has different configuration; refusing replacement.");
    return { status: "already-current" };
  }
  assertSameLatest(candidate, await latest());
  if (JSON.stringify(await client.snapshot(provider)) !== JSON.stringify(expected)) throw new Error("Render release changed during preparation; nothing was promoted.");
  await client.put(provider, config); // ONE selected JSON env key. Never the legacy four or full env list.
  // No automatic retry, rollback or second deploy on an ambiguous provider write.
  const deployment = await client.deploy();
  if (!/^dep-[a-z0-9]+$/.test(deployment?.id ?? "")) throw new Error("Render did not return a deploy receipt; inspect before retrying.");
  return { status: "deploy-requested", deploymentId: deployment.id };
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}
export async function main(command = process.argv[2], env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  assertTrustedEvent(event, env.GITHUB_EVENT_NAME, repository, env.GITHUB_REF);
  const directory = resolve(env.RELEASE_DIRECTORY ?? "dist/managed-stable");
  const githubLatest = () => latestStable(repository, env.GH_TOKEN);
  if (command === "check-promotion-policy") {
    if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Promotion policy check requires explicit dispatch.");
    await checkPromotionPolicy(repository, env.GH_TOKEN);
    return;
  }
  if (command === "plan") {
    const candidate = await githubLatest();
    const prepare = shouldPrepare(event, env.GITHUB_EVENT_NAME, candidate);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "plan.json"), JSON.stringify(candidate) + "\n");
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `prepare=${prepare}\n`);
    if (!prepare) summary("Unrelated publisher completion: its source is not the latest stable release commit. Skipped Terraform, Docker, packaging and publication.");
    return;
  }
  if (command === "prepare") {
    const provider = env.RELEASE_PROVIDER || "aws";
    if (!["aws", "gcp"].includes(provider)) throw new Error("Unknown installer provider.");
    const candidate = await githubLatest();
    assertSameLatest(JSON.parse(readFileSync(resolve(directory, "plan.json"), "utf8")), candidate);
    const inspectRuntime = (pin) => {
      execFileSync("docker", ["pull", "--platform=linux/amd64", pin], { stdio: "ignore" });
      return JSON.parse(execFileSync("docker", ["image", "inspect", pin], { encoding: "utf8" }))[0];
    };
    const images = releaseImages(candidate, repository, undefined, inspectRuntime);
    mkdirSync(directory, { recursive: true });
    const pins = resolve(directory, "image-pins.json");
    writeFileSync(pins, JSON.stringify(images) + "\n");
    execFileSync(process.execPath, ["infra/managed-deployments/tools/build-release.mjs", provider, candidate.version, directory, "--image-pins", pins], { stdio: "inherit" });
    const manifestBytes = readFileSync(resolve(directory, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    writeFileSync(resolve(directory, "candidate.json"), JSON.stringify({ ...candidate, provider, images, bundleSha256: manifest.bundleSha256, manifestSha256: hash(manifestBytes) }, null, 2) + "\n");
    summary(`### Prepared ${provider} stable installer ${candidate.version}\nRelease source: \`${candidate.commit}\`\n\nReviewed manifest SHA-256: \`${hash(manifestBytes)}\`\n\nNative checks and exact-digest OCI/platform verification are **not** real-cloud fresh-install/Update qualification. No publication, customer update or production activation occurred.`);
    return;
  }
  if (command !== "promote") throw new Error("Use plan, prepare, check-promotion-policy or promote.");
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.PROMOTION_ENABLED !== "true"
    || !HASH.test(env.REVIEWED_MANIFEST_SHA256 ?? "")) throw new Error("Promotion requires explicit dispatch, provider opt-in and reviewed manifest digest.");
  let evidence;
  try { evidence = new URL(env.QUALIFICATION_URL); } catch { throw new Error("Supply the trusted real-cloud qualification review URL."); }
  if (evidence.origin !== "https://github.com" || !evidence.pathname.startsWith(`/${repository}/`)
    || !/^\/(?:[^/]+\/){2}(?:actions\/runs\/\d+|issues\/\d+|pull\/\d+)(?:\/|$)/.test(evidence.pathname)
    || evidence.username || evidence.password || evidence.search) throw new Error("Qualification evidence must be a review in this trusted repository.");
  const candidate = JSON.parse(readFileSync(resolve(directory, "candidate.json"), "utf8"));
  if (candidate.provider !== "aws" || candidate.manifestSha256 !== env.REVIEWED_MANIFEST_SHA256
    || hash(readFileSync(resolve(directory, "manifest.json"))) !== candidate.manifestSha256
    || hash(readFileSync(resolve(directory, "bundle.tar.gz"))) !== candidate.bundleSha256) throw new Error("Candidate bytes differ from the reviewed real-cloud qualification.");
  // Re-read after environment approval/OIDC setup as well, so accidentally
  // removing the policy while the job was waiting cannot authorize publication.
  await checkPromotionPolicy(repository, env.GH_TOKEN);
  const client = renderClient(env.RENDER_SERVICE_ID, env.RENDER_API_KEY);
  const expected = await client.snapshot("aws");
  const result = await promote({ candidate, expected, client, latest: githubLatest, qualified: true, publish: async () => {
    const output = execFileSync(process.execPath, ["infra/managed-deployments/tools/publish-release.mjs", directory, env.RELEASE_BUCKET, env.RELEASE_ACCOUNT_ID, env.AWS_REGION], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const published = JSON.parse(output);
    return publisherConfig(published);
  } });
  if (result.status === "deploy-requested") {
    let live = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const deployment = await client.deployment(result.deploymentId);
      if (deployment.status === "live") { live = true; break; }
      if (["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(deployment.status)) throw new Error("Render deploy failed; inspect it before any further change. No automatic retry or rollback.");
      await new Promise((done) => setTimeout(done, 10_000));
    }
    if (!live) throw new Error("Render deploy did not become live within 15 minutes; inspect before retrying.");
  }
  summary(`### AWS installer ${candidate.version}: ${result.status === "already-current" ? "already current (no deploy)" : "Den deploy live"}\nOperator attested fresh-install/approved-Update review: ${evidence.href}\n\nOnly the new-install default changed; existing customer installations were not updated.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Child process and remote error objects may embed secrets. Keep CI errors bounded.
    console.error("Managed stable release failed closed. Inspect the failing step/provider separately; no automatic mutation retry was attempted.");
    process.exitCode = 1;
  });
}
