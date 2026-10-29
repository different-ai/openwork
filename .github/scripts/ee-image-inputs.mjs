#!/usr/bin/env node
// EE image selection has one durable baseline: the inputs on the image actually
// published as :dev. A previous push (or a queued/failed build) is not success.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFingerprint, changedFiles, isBuildAffected } from "./build-inputs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FINGERPRINT_LABEL = "io.openwork.build-inputs";
const TARGET_LABEL = "io.openwork.build-target";
const fingerprintValid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digestValid = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

// Keep the existing build, migration-asset assertion and health smoke contracts.
export const EE_IMAGES = [
  {
    target: "den-api", image: "openwork-den-api", dockerfile: "packaging/docker/Dockerfile.den",
    port: 8788, health_path: "/health",
    smoke_env: "-e DB_MODE=mysql -e DEN_DB_ENCRYPTION_KEY=ci-den-db-encryption-key-value-123456 -e BETTER_AUTH_SECRET=ci-better-auth-secret-value-123456 -e BETTER_AUTH_URL=http://127.0.0.1:8788",
  },
  {
    target: "den-web", image: "openwork-den-web", dockerfile: "packaging/docker/Dockerfile.den-web",
    port: 3005, health_path: "/api/health", smoke_env: "",
  },
  {
    // Stable repository name for existing inference deployments.
    target: "inference", image: "openwork-inference", dockerfile: "packaging/docker/Dockerfile.gateway",
    port: 8791, health_path: "/health",
    smoke_env: "-e DB_MODE=mysql -e DATABASE_URL=mysql://smoke:smoke@127.0.0.1:3306/smoke -e DEN_DB_ENCRYPTION_KEY=ci-den-db-encryption-key-value-123456",
  },
  {
    // /health is proxied; this is the gateway's own liveness endpoint.
    target: "client-web", image: "openwork-den-gateway", dockerfile: "packaging/docker/Dockerfile.den-gateway",
    port: 8788, health_path: "/__gw/health",
    smoke_env: "-e DEN_API_BASE=http://127.0.0.1:9 -e DEN_GATEWAY_KEY=ci-den-gateway-key-value-123456",
  },
  {
    target: "headless-runner", image: "openwork-headless-runner", dockerfile: "packaging/docker/Dockerfile.headless-runner",
    port: 8795, health_path: "/health",
    smoke_env: "-e HEADLESS_API_TOKEN=ci-headless-runner-token-value-1234567890 -e HEADLESS_MODEL_PROTOCOL=anthropic -e HEADLESS_MODEL_BASE_URL=https://api.anthropic.com/v1 -e HEADLESS_MODEL=ci-model",
  },
  {
    target: "workbot", image: "openwork-workbot", dockerfile: "packaging/docker/Dockerfile.workbot",
    port: 3020, health_path: "/healthz",
    smoke_env: "-e WORKBOT_PUBLIC_URL=https://chat.example.com -e WORKBOT_DEN_API_URL=https://api.example.com -e WORKBOT_RUNNER_URL=http://headless-runner:8795 -e WORKBOT_RUNNER_TOKEN=ci-headless-runner-token-value-1234567890 -e WORKBOT_SESSION_SECRET=ci-workbot-session-secret-value-123456789",
  },
];

export const isDevPush = ({ eventName, ref }) => eventName === "push" && ref === "refs/heads/dev";

/** Network is injected so failed, missing and pending publication are testable. */
export async function imageDecision({ target, eventName, ref, getFingerprint = buildFingerprint, readBaseline }) {
  let fingerprint;
  try { fingerprint = getFingerprint(target); } catch { /* Unknown inputs must never skip a build. */ }
  if (!isDevPush({ eventName, ref })) return { build: true, fingerprint: fingerprint ?? "", reason: "full tag/manual build" };
  if (!fingerprintValid(fingerprint)) return { build: true, fingerprint: "", reason: "input fingerprint unavailable" };
  try {
    const baseline = await readBaseline(target);
    if (!fingerprintValid(baseline)) return { build: true, fingerprint, reason: "published baseline missing" };
    return { build: baseline !== fingerprint, fingerprint, reason: baseline === fingerprint ? "already published" : "inputs changed since publication" };
  } catch {
    // Never print network errors: registry responses may contain credentials or
    // signed URLs. Auth failures, rate limits and missing manifests all rebuild.
    return { build: true, fingerprint, reason: "published baseline unavailable" };
  }
}

export async function selectImages(options) {
  const decisions = await Promise.all(EE_IMAGES.map(async (image) => ({
    ...image, ...await imageDecision({ ...options, target: image.target }),
  })));
  const selected = decisions.filter(({ build }) => build);
  return {
    images: selected.filter(({ target }) => target !== "client-web").map(matrixEntry),
    gateway: selected.filter(({ target }) => target === "client-web").map(matrixEntry),
    decisions,
  };
}

function matrixEntry({ target, image, dockerfile, port, health_path, smoke_env }) {
  return { target, image, dockerfile, port, health_path, smoke_env };
}

export function helmDecision({ eventName, ref, files, affected = isBuildAffected }) {
  if (!isDevPush({ eventName, ref })) return true;
  try { return affected("helm", files); } catch { return true; }
}

/** Called under the target's publishing lock, immediately before tagging :dev. */
export async function promoteIfCurrent({ fingerprint, latestFingerprint, promote }) {
  if (!fingerprintValid(fingerprint)) throw new Error("Cannot promote without a build input fingerprint");
  // Unlike selection, a failed freshness check must not publish an unknown/stale
  // mutable tag. The immutable build remains available and the job fails.
  const latest = await latestFingerprint();
  if (!fingerprintValid(latest)) throw new Error("Cannot resolve latest dev build inputs");
  if (fingerprint !== latest) return false;
  await promote();
  return true;
}

/** Read OCI config labels, not a workflow artifact that can expire or mark a failed push successful. */
export async function readPublishedFingerprint({ owner, image, target, actor, token, fetchImpl = fetch }) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner) || !EE_IMAGES.some((entry) => entry.image === image && entry.target === target)) {
    throw new Error("Invalid image repository");
  }
  const repository = `${owner.toLowerCase()}/${image}`;
  const request = async (url, headers = {}) => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
    return response.json();
  };
  const authHeaders = token && actor ? { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}` } : {};
  const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, authHeaders);
  const bearer = auth.token ?? auth.access_token;
  if (typeof bearer !== "string" || !bearer) throw new Error("Registry bearer token unavailable");
  const headers = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  let reads = 0;
  async function readManifest(reference, depth = 0) {
    if (++reads > 8 || depth > 2) throw new Error("Unexpected registry manifest depth/size");
    const manifest = await request(`https://ghcr.io/v2/${repository}/manifests/${reference}`, headers);
    if (Array.isArray(manifest.manifests)) {
      // BuildKit also includes attestation manifests (unknown/unknown). They are
      // not runtime images. All published runtime architectures must agree.
      const runtimes = manifest.manifests.filter(({ platform }) => platform?.os === "linux" && ["amd64", "arm64"].includes(platform.architecture));
      if (!runtimes.length || runtimes.length > 4) throw new Error("Runtime manifests unavailable");
      const values = [];
      for (const runtime of runtimes) {
        if (!digestValid(runtime.digest)) throw new Error("Invalid runtime manifest digest");
        values.push(await readManifest(runtime.digest, depth + 1));
      }
      if (values.some((value) => value !== values[0])) throw new Error("Runtime fingerprint labels disagree");
      return values[0];
    }
    if (!digestValid(manifest.config?.digest)) throw new Error("Image config unavailable");
    const config = await request(`https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`, headers);
    const labels = config.config?.Labels;
    if (labels?.[TARGET_LABEL] !== target || !fingerprintValid(labels?.[FINGERPRINT_LABEL])) throw new Error("Image fingerprint label unavailable");
    return labels[FINGERPRINT_LABEL];
  }
  return readManifest("dev");
}

function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
}

async function cli([command, target, digest]) {
  const { GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, GITHUB_REPOSITORY_OWNER: owner, GITHUB_ACTOR: actor, GITHUB_TOKEN: token } = process.env;
  const getFingerprint = (name) => buildFingerprint(name, { root: ROOT, ref: "HEAD" });
  const readBaseline = (name) => {
    const image = EE_IMAGES.find((entry) => entry.target === name);
    if (!image) throw new Error("Unknown EE image target");
    return readPublishedFingerprint({ owner, image: image.image, target: name, actor, token });
  };
  const options = { eventName, ref, getFingerprint, readBaseline };
  if (command === "select") {
    const selection = await selectImages(options);
    for (const decision of selection.decisions) console.log(`${decision.target}: ${decision.build ? "build" : "skip"} (${decision.reason})`);
    output({ images: selection.images, gateway: selection.gateway });
  } else if (command === "check") {
    if (!EE_IMAGES.some((entry) => entry.target === target)) throw new Error("Unknown EE image target");
    // Recheck after acquiring the target lock: an earlier pending build may
    // have published these exact inputs since the matrix was selected.
    output(await imageDecision({ ...options, target }));
  } else if (command === "helm") {
    let before;
    try { before = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).before; } catch { /* Fail open. */ }
    output({ affected: helmDecision({ eventName, ref, files: changedFiles({ base: before, root: ROOT }) }) });
  } else if (command === "promote") {
    const image = EE_IMAGES.find((entry) => entry.target === target);
    if (!image || !digestValid(digest) || !/^[a-z0-9][a-z0-9-]*$/i.test(owner)) throw new Error("Invalid promotion target/digest");
    if (ref !== "refs/heads/dev") throw new Error("Only dev ref builds may promote :dev");
    const repository = `ghcr.io/${owner.toLowerCase()}/${image.image}`;
    const published = await promoteIfCurrent({
      fingerprint: process.env.BUILD_FINGERPRINT,
      latestFingerprint: () => {
        // No --depth here: this must never shallow a shared developer clone.
        execFileSync("git", ["fetch", "--no-tags", "origin", "+refs/heads/dev:refs/remotes/origin/dev"], { cwd: ROOT, stdio: "pipe" });
        return buildFingerprint(target, { root: ROOT, ref: "refs/remotes/origin/dev" });
      },
      promote: () => execFileSync("docker", ["buildx", "imagetools", "create", "--tag", `${repository}:dev`, `${repository}@${digest}`], { stdio: "inherit" }),
    });
    output({ published });
    if (!published) console.log("Newer dev inputs exist for this target; keeping the immutable build without moving :dev.");
  } else {
    throw new Error("Expected select, check <target>, helm, or promote <target> <digest>");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch(() => {
    // Deliberately do not expose exception messages from authenticated requests.
    console.error("EE image operation failed; no successful publication baseline was recorded.");
    process.exitCode = 1;
  });
}
