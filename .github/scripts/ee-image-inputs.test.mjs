import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  EE_IMAGES, FINGERPRINT_LABEL, helmDecision, imageDecision,
  promoteIfCurrent, readPublishedFingerprint, selectImages,
} from "./ee-image-inputs.mjs";
import { isBuildAffected } from "./build-inputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const old = "a".repeat(64);
const current = "b".repeat(64);
const newer = "c".repeat(64);
const dev = { eventName: "push", ref: "refs/heads/dev" };
const targets = (selection) => [...selection.images, ...selection.gateway].map(({ target }) => target).sort();

for (const target of EE_IMAGES.map(({ target }) => target)) {
  test(`${target}: only the successfully published input fingerprint suppresses a dev build`, async () => {
    const decide = (readBaseline) => imageDecision({ ...dev, target, getFingerprint: () => current, readBaseline });
    assert.equal((await decide(async () => current)).build, false);
    assert.equal((await decide(async () => old)).build, true);
    for (const missing of [null, undefined, "", "invalid", "success"]) assert.equal((await decide(async () => missing)).build, true);
    assert.equal((await decide(async () => { throw new Error("registry unavailable"); })).build, true);
  });
}

test("unavailable input fingerprints also fail open for building", async () => {
  const result = await imageDecision({ ...dev, target: "den-api", getFingerprint: () => { throw new Error("unknown graph"); }, readBaseline: () => current });
  assert.equal(result.build, true);
  assert.equal(result.fingerprint, "");
});

for (const event of [
  { eventName: "pull_request", ref: "refs/pull/123/merge" },
  { eventName: "push", ref: "refs/tags/v1.2.3" },
  { eventName: "workflow_dispatch", ref: "refs/heads/dev" },
  { eventName: "workflow_dispatch", ref: "refs/heads/release" },
]) {
  test(`${event.eventName} ${event.ref}: full six-image and Helm coverage without a registry dependency`, async () => {
    const selection = await selectImages({ ...event, getFingerprint: () => current, readBaseline: () => { assert.fail("full builds do not need a baseline"); } });
    assert.deepEqual(targets(selection), EE_IMAGES.map(({ target }) => target).sort());
    assert.equal(helmDecision({ ...event, files: [], affected: () => { assert.fail("full chart check"); } }), true);
  });
}

test("image selection is per target, never a whole-workflow success or previous-push baseline", async () => {
  const selection = await selectImages({
    ...dev,
    getFingerprint: (target) => ["den-api", "workbot"].includes(target) ? current : old,
    readBaseline: async () => old,
  });
  assert.deepEqual(targets(selection), ["den-api", "workbot"]);
  assert.equal(selection.gateway.length, 0);
});

test("an API change remains selected on the next Workbot-only push while API publication is pending", async () => {
  const published = new Map(EE_IMAGES.map(({ target }) => [target, old]));
  const head = new Map(published);
  const options = { ...dev, getFingerprint: (target) => head.get(target), readBaseline: async (target) => published.get(target) };
  head.set("den-api", current);
  assert.deepEqual(targets(await selectImages(options)), ["den-api"]);
  // Merely scheduling/starting the API build cannot advance its baseline.
  head.set("workbot", current);
  assert.deepEqual(targets(await selectImages(options)), ["den-api", "workbot"]);
  assert.equal(await promoteIfCurrent({ fingerprint: current, latestFingerprint: async () => head.get("den-api"), promote: async () => published.set("den-api", current) }), true);
  // The second API job rechecks once it owns the same target lock and avoids a
  // duplicate build; Workbot's separate target lock never cancels the first.
  assert.equal((await imageDecision({ ...options, target: "den-api" })).build, false);
  assert.deepEqual(targets(await selectImages(options)), ["workbot"]);
});

test("landing/native-desktop-only edits select no images when their published inputs are current", async () => {
  for (const path of ["ee/apps/landing/app/page.tsx", "apps/desktop/src/main/index.ts"]) {
    const selection = await selectImages({
      ...dev, readBaseline: async () => old,
      getFingerprint: (target) => isBuildAffected(target, [path]) ? current : old,
    });
    assert.deepEqual(targets(selection), [], path);
  }
});

test("Helm's cheap check has its own inputs, not the image selection or registry", () => {
  assert.equal(helmDecision({ ...dev, files: ["packaging/helm/openwork-ee/templates/den-api.yaml"] }), true);
  assert.equal(helmDecision({ ...dev, files: ["ee/apps/workbot/src/server/main.ts"] }), false);
  assert.equal(helmDecision({ ...dev, files: ["ee/apps/landing/app/page.tsx"] }), false);
  assert.equal(helmDecision({ ...dev, files: null }), true);
  assert.equal(helmDecision({ ...dev, files: [], affected: () => { throw new Error("unknown diff"); } }), true);
});

test("unrelated newer dev HEAD may promote the same target inputs", async () => {
  let promotions = 0;
  assert.equal(await promoteIfCurrent({ fingerprint: current, latestFingerprint: async () => current, promote: async () => { promotions++; } }), true);
  assert.equal(promotions, 1);
});

test("stale/out-of-order jobs cannot roll :dev back after a newer target publication", async () => {
  let tag = old;
  const promote = async (fingerprint) => promoteIfCurrent({ fingerprint, latestFingerprint: async () => newer, promote: async () => { tag = fingerprint; } });
  assert.equal(await promote(current), false);
  assert.equal(tag, old);
  assert.equal(await promote(newer), true);
  assert.equal(tag, newer);
  assert.equal(await promote(current), false);
  assert.equal(tag, newer);
});

test("unknown freshness or a failed registry promotion is a hard failure, not a successful baseline", async () => {
  let promotions = 0;
  for (const latestFingerprint of [async () => { throw new Error("fetch failed"); }, async () => ""]) {
    await assert.rejects(promoteIfCurrent({ fingerprint: current, latestFingerprint, promote: async () => { promotions++; } }));
  }
  await assert.rejects(promoteIfCurrent({ fingerprint: "", latestFingerprint: async () => current, promote: async () => { promotions++; } }));
  await assert.rejects(promoteIfCurrent({ fingerprint: current, latestFingerprint: async () => current, promote: async () => { throw new Error("registry push failed"); } }));
  assert.equal(promotions, 0);
});

const runtimeDigest = `sha256:${"1".repeat(64)}`;
const configDigest = `sha256:${"2".repeat(64)}`;
function registryMock({ index, labels = { [FINGERPRINT_LABEL]: current, "io.openwork.build-target": "den-api" }, failStatus, configLabels } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (failStatus) return { ok: false, status: failStatus };
    let body;
    if (url.startsWith("https://ghcr.io/token?")) body = { token: "registry-bearer" };
    else if (url.endsWith("/manifests/dev") && index) body = index;
    else if (url.includes("/manifests/")) body = { config: { digest: configDigest } };
    else if (url.endsWith(`/blobs/${configDigest}`)) body = { config: { Labels: configLabels ? configLabels(requests) : labels } };
    else assert.fail(`Unexpected registry endpoint: ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, requests };
}
const registryOptions = { owner: "test-owner", image: "openwork-den-api", target: "den-api", actor: "test-actor", token: "test-credential" };

test("reads a private GHCR OCI manifest/config with bounded authenticated requests", async () => {
  const mock = registryMock();
  assert.equal(await readPublishedFingerprint({ ...registryOptions, ...mock }), current);
  assert.equal(mock.requests.length, 3);
  assert.equal(mock.requests[0].options.headers.Authorization, `Basic ${Buffer.from("test-actor:test-credential").toString("base64")}`);
  assert.equal(mock.requests[1].options.headers.Authorization, "Bearer registry-bearer");
  assert.equal(mock.requests[2].options.headers.Authorization, "Bearer registry-bearer");
  for (const { options } of mock.requests) {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.cache, "no-store");
  }
});

test("reads OCI indexes while ignoring BuildKit provenance attestations", async () => {
  const mock = registryMock({ index: { manifests: [
    { digest: runtimeDigest, platform: { os: "linux", architecture: "amd64" } },
    { digest: `sha256:${"3".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" } },
  ] } });
  assert.equal(await readPublishedFingerprint({ ...registryOptions, ...mock }), current);
  assert.equal(mock.requests.length, 4);
  assert.ok(mock.requests[2].url.endsWith(`/manifests/${runtimeDigest}`));
});

test("mixed runtime labels, missing labels and wrong-target metadata never authorize a skip", async () => {
  for (const labels of [{}, { [FINGERPRINT_LABEL]: current }, { [FINGERPRINT_LABEL]: current, "io.openwork.build-target": "workbot" }]) {
    const mock = registryMock({ labels });
    const decision = await imageDecision({ ...dev, target: "den-api", getFingerprint: () => current, readBaseline: () => readPublishedFingerprint({ ...registryOptions, ...mock }) });
    assert.equal(decision.build, true);
  }
  const mock = registryMock({
    index: { manifests: [
      { digest: runtimeDigest, platform: { os: "linux", architecture: "amd64" } },
      { digest: `sha256:${"3".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } },
    ] },
    configLabels: (requests) => ({ [FINGERPRINT_LABEL]: requests.length === 4 ? current : old, "io.openwork.build-target": "den-api" }),
  });
  await assert.rejects(readPublishedFingerprint({ ...registryOptions, ...mock }), /disagree/);
});

for (const failStatus of [401, 403, 404, 429, 500]) {
  test(`registry HTTP ${failStatus} fails open for the target build`, async () => {
    const mock = registryMock({ failStatus });
    const decision = await imageDecision({ ...dev, target: "den-api", getFingerprint: () => current, readBaseline: () => readPublishedFingerprint({ ...registryOptions, ...mock }) });
    assert.equal(decision.build, true);
  });
}

test("registry transport errors also fail open and are not exposed in the decision", async () => {
  const decision = await imageDecision({ ...dev, target: "den-api", getFingerprint: () => current, readBaseline: () => readPublishedFingerprint({ ...registryOptions, fetchImpl: async () => { throw new Error("private registry credentials"); } }) });
  assert.equal(decision.build, true);
  assert.doesNotMatch(JSON.stringify(decision), /private registry credentials/);
});

test("Helm and gateway completion boundaries do not depend on the unrelated image matrix", () => {
  const workflow = read(".github/workflows/publish-ee-images.yml");
  const helm = workflow.match(/^  helm-chart:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1];
  const gateway = workflow.match(/^  den-gateway-image:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1];
  const redeploy = workflow.match(/^  redeploy-den-gateway:\n([\s\S]*)/m)?.[1];
  assert.ok(helm);
  assert.match(helm, /needs: artifact-version/);
  assert.doesNotMatch(helm, /needs:.*(?:ee-images|image-inputs)/);
  assert.ok(helm.indexOf("ee-image-inputs.mjs helm") < helm.indexOf("uses: azure/setup-helm"));
  assert.ok(gateway);
  assert.match(gateway, /needs: \[artifact-version, image-inputs\]/);
  assert.doesNotMatch(gateway, /needs:.*ee-images/);
  assert.match(gateway, /steps: \*image-build-steps/);
  assert.match(gateway, /published: \$\{\{ steps\.promote\.outputs\.published \}\}/);
  assert.doesNotMatch(gateway, /environment:/);
  assert.ok(redeploy);
  assert.match(redeploy, /needs: den-gateway-image/);
  assert.doesNotMatch(redeploy, /needs:.*ee-images/);
  assert.match(redeploy, /needs\.den-gateway-image\.outputs\.published == 'true'/);
  assert.match(redeploy, /name: den-production/);
  assert.match(workflow, /Render builds from source, not this GHCR image/);
});

test("target publishing locks replace whole-dev-run cancellation and :dev build tags", () => {
  const workflow = read(".github/workflows/publish-ee-images.yml");
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(workflow, /group: ee-publish-\$\{\{ matrix\.target \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /type=raw,value=dev/);
  assert.match(workflow, /type=raw,value=build-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /BUILD_DIGEST: \$\{\{ steps\.build\.outputs\.digest \|\| steps\.build_sentry\.outputs\.digest \}\}/);
  assert.match(workflow, /io\.openwork\.build-inputs=\$\{\{ steps\.inputs\.outputs\.fingerprint \}\}/);
  for (const assertion of ["Assert Den DB migration assets", "Smoke health endpoint", "SENTRY_RELEASE", "sentry_dist=", "mysqladmin ping"]) assert.ok(workflow.includes(assertion), assertion);
});

test("recipe/selection PRs exercise six real builds and smoke checks without publishing or production access", () => {
  const workflow = read(".github/workflows/publish-ee-images.yml");
  const pullRequest = workflow.match(/^  pull_request:\n([\s\S]*?)(?=^  push:)/m)?.[1];
  assert.ok(pullRequest);
  assert.match(pullRequest, /branches:\n\s+- "dev"/);
  for (const path of [".github/workflows/publish-ee-images.yml", ".github/scripts/build-inputs.mjs", ".github/scripts/ee-image*.mjs", ".dockerignore", "packaging/docker/Dockerfile*"]) {
    assert.ok(pullRequest.includes(`- "${path}"`), path);
  }
  assert.doesNotMatch(pullRequest, /ee\/apps\/\*\*|apps\/\*\*/);
  assert.match(workflow, /publish="false"\n\s+if \[ "\$\{GITHUB_EVENT_NAME\}" = "push" \]; then/);
  assert.match(workflow, /- name: Log in to GHCR\n\s+if:.*needs\.artifact-version\.outputs\.publish == 'true'/);
  assert.match(workflow, /- name: Resolve Sentry source-map upload\n\s+id: sentry_sourcemaps\n\s+if:.*needs\.artifact-version\.outputs\.publish == 'true'.*github\.event_name != 'pull_request'/);
  assert.match(workflow, /load: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflow, /push: \$\{\{ needs\.artifact-version\.outputs\.publish == 'true' \}\}/);
  assert.match(workflow, /- name: Assert Den DB migration assets\n\s+if:.*github\.event_name == 'pull_request'/);
  assert.match(workflow, /- name: Smoke health endpoint\n\s+if:.*github\.event_name == 'pull_request'/);
  assert.match(workflow, /redeploy-den-gateway:\n\s+needs: den-gateway-image\n\s+if:.*github\.event_name == 'push'.*needs\.den-gateway-image\.outputs\.published == 'true'/);
});

function dependencyDirectories(name) {
  const packages = new Map();
  for (const parent of ["apps", "packages", "ee/apps", "ee/packages"]) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      try {
        const directory = `${parent}/${entry.name}`;
        const body = JSON.parse(read(`${directory}/package.json`));
        packages.set(body.name, { directory, body });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const seen = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const { body } = packages.get(name);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(body[field] ?? {})) if (packages.has(dependency)) visit(dependency);
    }
  }
  visit(name);
  return [...seen].map((name) => packages.get(name).directory).sort();
}

for (const target of ["headless-runner", "workbot"]) {
  test(`${target} Docker COPY ships exactly its transitive workspace closure, never the whole repository`, () => {
    const dockerfile = read(`packaging/docker/Dockerfile.${target}`);
    const sources = [...dockerfile.matchAll(/^COPY\s+(.+)\s+\/app\/.*$/gm)].flatMap((match) => match[1].split(/\s+/));
    assert.ok(!sources.includes("."));
    assert.ok(!sources.includes("apps") && !sources.includes("ee") && !sources.includes("packages"));
    const dependencies = dependencyDirectories(`@openwork-ee/${target}`);
    const workspaces = sources.filter((source) => /^(?:ee\/)?(?:apps|packages)\/[^/]+$/.test(source));
    assert.deepEqual(workspaces.sort(), dependencies);
    for (const directory of dependencies) assert.ok(sources.includes(`${directory}/package.json`), directory);
    for (const source of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.declarations.json", "patches"]) assert.ok(sources.includes(source), source);
    assert.doesNotMatch(dockerfile, /^COPY\s+(?:ee\/apps\/landing|apps\/(?:desktop|server))\s/m);
    assert.match(dockerfile, /allowUnusedPatches: true/);
  });
}

test("the runner retains headless-computer's cross-workspace desktop asset", () => {
  const path = "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh";
  assert.ok(read("packaging/docker/Dockerfile.headless-runner").includes(`COPY ${path} /app/${path}`));
  assert.equal(isBuildAffected("headless-runner", [path]), true);
});
