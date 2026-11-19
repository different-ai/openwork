import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  EE_IMAGES, FINGERPRINT_LABEL, helmDecision, imageConfiguration, imageDecision,
  promoteIfCurrent, publisherVersion, readPublishedFingerprint, selectImages, sourceDecision,
} from "./ee-image-inputs.mjs";
import { buildFingerprint, isBuildAffected } from "./build-inputs.mjs";

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
  { eventName: "schedule", ref: "refs/heads/dev" },
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
  assert.match(workflow, /group: ee-\$\{\{ needs\.artifact-version\.outputs\.publication_channel \}\}-\$\{\{ matrix\.target \}\}-\$\{\{ github\.ref \}\}-\$\{\{ needs\.image-inputs\.outputs\.publisher_version \}\}$/m);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /type=raw,value=dev/);
  assert.match(workflow, /type=raw,value=build-\$\{\{ steps\.source\.outputs\.source_sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /BUILD_DIGEST: \$\{\{ steps\.build\.outputs\.digest \|\| steps\.build_sentry\.outputs\.digest \}\}/);
  assert.match(workflow, /io\.openwork\.build-inputs=\$\{\{ steps\.inputs\.outputs\.fingerprint \}\}/);
  for (const assertion of ["Assert Den DB migration assets", "Smoke health endpoint", "SENTRY_RELEASE", "sentry_dist=", "mysqladmin ping"]) assert.ok(workflow.includes(assertion), assertion);
});

test("nightly and manual build-only runs exercise six real builds and smoke checks without publishing", () => {
  const workflow = read(".github/workflows/publish-ee-images.yml");
  const triggers = workflow.split("\npermissions:\n")[0];
  assert.doesNotMatch(triggers, /^  pull_request:/m, "PRs run only the quick check");
  assert.match(triggers, /^  schedule:\n    - cron: /m);
  assert.match(workflow, /publish="false"\n\s+if \[ "\$\{GITHUB_EVENT_NAME\}" = "push" \]; then/);
  assert.match(workflow, /- name: Log in to GHCR\n\s+if:.*needs\.artifact-version\.outputs\.publish == 'true'/);
  assert.match(workflow, /- name: Resolve Sentry source-map upload\n\s+id: sentry_sourcemaps\n\s+if:.*needs\.artifact-version\.outputs\.publish == 'true'/);
  assert.match(workflow, /load: \$\{\{ needs\.artifact-version\.outputs\.publish != 'true' \}\}/);
  assert.match(workflow, /push: \$\{\{ needs\.artifact-version\.outputs\.publish == 'true' \}\}/);
  assert.match(workflow, /- name: Assert Den DB migration assets\n\s+if:.*needs\.artifact-version\.outputs\.publish != 'true'/);
  assert.match(workflow, /- name: Smoke health endpoint\n\s+if:.*needs\.artifact-version\.outputs\.publish != 'true'/);
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

// Exercise the real CLI with a local Git remote, never GitHub/GHCR or the
// developer's shared repository. Fixture commits are confined to these repos.
const publisherInputs = [".github/workflows/publish-ee-images.yml", ".github/scripts/ee-image-inputs.mjs", ".github/scripts/build-inputs.mjs"];
function sourceFixture(t) {
  // macOS aliases /var to /private/var. ESM resolves the real path, so the
  // subprocess argv must use that same canonical path to exercise its CLI.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwork-ee-source-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin");
  const runner = join(directory, "runner");
  mkdirSync(origin);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:GIT_|GITHUB_|GH_TOKEN$)/.test(name)));
  const config = join(directory, "empty.gitconfig");
  writeFileSync(config, "");
  Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  const git = (cwd, args) => execFileSync("git", ["-c", "user.name=CI Fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  git(origin, ["init", "--quiet", "--initial-branch=dev"]);
  const write = (path, contents) => {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), contents);
  };
  for (const path of publisherInputs) write(path, read(path));
  // Minimal real input graph: the source CLI's checkout must change the same
  // content fingerprint consumed by the subsequent image decision/promotion.
  write("ee/apps/den-api/package.json", JSON.stringify({ name: "@openwork-ee/den-api", private: true }));
  write("packaging/docker/Dockerfile.den", "FROM scratch\nCOPY input.txt /app/input.txt\n");
  const commit = (input) => {
    write("input.txt", input);
    git(origin, ["add", "--all"]);
    git(origin, ["commit", "--quiet", "-m", "Fixture source"]);
    return git(origin, ["rev-parse", "HEAD"]);
  };
  let queuedPublisher;
  const clone = () => {
    git(directory, ["clone", "--quiet", "--no-local", origin, runner]);
    queuedPublisher = publisherVersion({ root: runner });
  };
  let invocations = 0;
  const cli = (command, { eventName = "push", ref = "refs/heads/dev", actions = "false", expectedPublisher = queuedPublisher, publish = eventName === "push" ? "true" : "false" } = {}) => {
    const invocation = invocations++;
    const output = join(directory, `output-${invocation}`);
    const environment = join(directory, `environment-${invocation}`);
    const args = Array.isArray(command) ? command : [command];
    const result = spawnSync(process.execPath, [join(runner, ".github/scripts/ee-image-inputs.mjs"), ...args], {
      cwd: runner, encoding: "utf8", env: {
        ...env, GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, GITHUB_ACTIONS: actions,
        GITHUB_OUTPUT: output, GITHUB_ENV: environment, PUBLISHER_VERSION: expectedPublisher,
        PUBLISH_IMAGES: publish === null ? undefined : publish,
      },
    });
    return { ...result, values: stepOutputs(output), localEnv: stepOutputs(environment) };
  };
  return { directory, origin, runner, git, write, commit, clone, cli };
}

function stepOutputs(path) {
  return Object.fromEntries((existsSync(path) ? readFileSync(path, "utf8") : "").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

// Execute the authoritative version job's shell, not a second implementation of
// its manual/default/PR publication policy or build-only concurrency channel.
function versionDecision(t, { eventName = "push", ref = "refs/heads/dev", push = "false", runId = "101", runAttempt = "1", chartVersion = "" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openwork-ee-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "outputs");
  const block = read(".github/workflows/publish-ee-images.yml").match(/^  artifact-version:\n([\s\S]*?)(?=^  image-inputs:)/m)?.[1];
  assert.ok(block);
  const marker = "        run: |\n";
  assert.ok(block.includes(marker));
  const script = block.slice(block.indexOf(marker) + marker.length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
    PATH: process.env.PATH, GITHUB_EVENT_NAME: eventName, GITHUB_REF_TYPE: ref.startsWith("refs/tags/") ? "tag" : "branch",
    GITHUB_REF_NAME: ref.replace(/^refs\/(?:heads|tags)\//, ""), GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_OUTPUT: output, INPUT_PUSH: push, INPUT_CHART_VERSION: chartVersion,
  } });
  return { ...result, values: stepOutputs(output) };
}

function publisherGroup(version, channel = "publish", ref = "refs/heads/dev") {
  const template = read(".github/workflows/publish-ee-images.yml").match(/^\s+group: (ee-.+)$/m)?.[1];
  assert.ok(template);
  return template.replace("${{ matrix.target }}", "den-api").replace("${{ github.ref }}", ref)
    .replace("${{ needs.image-inputs.outputs.publisher_version }}", version)
    .replace("${{ needs.artifact-version.outputs.publication_channel }}", channel);
}

test("publisherVersion hashes exactly the three Git publisher blobs, not unrelated source/commit identity", (t) => {
  const fixture = sourceFixture(t);
  const a = fixture.commit("A");
  const version = publisherVersion({ root: fixture.origin, ref: a });
  const tree = fixture.git(fixture.origin, ["ls-tree", "-z", a, "--", ...publisherInputs]);
  const entries = tree.split("\0").filter(Boolean);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.split("\t")[1]).sort(), [...publisherInputs].sort());
  assert.ok(entries.every((entry) => /^100644 blob [a-f0-9]{40}\t/.test(entry)));
  assert.equal(version, createHash("sha256").update(tree).digest("hex"));
  const b = fixture.commit("B");
  assert.equal(publisherVersion({ root: fixture.origin, ref: b }), version);
  let previous = version;
  for (const path of publisherInputs) {
    fixture.write(path, readFileSync(join(fixture.origin, path), "utf8") + "\n");
    const sha = fixture.commit(path);
    const updated = publisherVersion({ root: fixture.origin, ref: sha });
    assert.notEqual(updated, previous, path);
    previous = updated;
  }
  assert.throws(() => publisherVersion({ root: fixture.origin, ref: "missing-publisher-ref" }));
});

test("CLI selection transfers only target identifiers and publisher hash, never image/runtime/smoke configuration", (t) => {
  const fixture = sourceFixture(t);
  fixture.commit("A");
  fixture.clone();
  const result = fixture.cli("select", { eventName: "workflow_dispatch" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.values.publisher_version, publisherVersion({ root: fixture.runner }));
  assert.deepEqual(Object.keys(result.values).sort(), ["gateway", "images", "publisher_version"]);
  assert.deepEqual(JSON.parse(result.values.images), EE_IMAGES.filter(({ target }) => target !== "client-web").map(({ target }) => ({ target })));
  assert.deepEqual(JSON.parse(result.values.gateway), [{ target: "client-web" }]);
  const transferred = JSON.stringify(result.values);
  assert.ok(transferred.length < 512, "matrix metadata stays compact");
  assert.doesNotMatch(transferred + result.stdout, /smoke_env|dockerfile|health_path|openwork-den-|ci-den-|ci-headless-|ci-workbot-|ci-model/);
  for (const { smoke_env } of EE_IMAGES) if (smoke_env) assert.ok(!transferred.includes(smoke_env));
  assert.deepEqual(result.localEnv, {}, "selection does not export runtime configuration either");
  const workflow = read(".github/workflows/publish-ee-images.yml");
  assert.match(workflow, /publisher_version: \$\{\{ steps\.inputs\.outputs\.publisher_version \}\}/);
  assert.match(workflow, /concurrency: \*image-publish-lock/);
});

for (const expected of EE_IMAGES) {
  test(`${expected.target}: a target-only matrix entry resolves the exact trusted local image and smoke configuration`, (t) => {
    const { target, ...configuration } = expected;
    assert.deepEqual(imageConfiguration(target), configuration);
    const fixture = sourceFixture(t);
    fixture.commit("selected source");
    fixture.clone();
    const result = fixture.cli(["config", target]);
    assert.equal(result.status, 0, result.stderr);
    const { smoke_env, port, ...safe } = configuration;
    assert.deepEqual(result.values, { ...safe, port: String(port) });
    assert.deepEqual(result.localEnv, { EE_IMAGE_SMOKE_ENV: smoke_env });
    assert.doesNotMatch(JSON.stringify(result.values) + result.stdout, /smoke_env|ci-den-|ci-headless-|ci-workbot-|ci-model/);
  });
}

test("unknown targets fail local configuration instead of silently selecting an image/default", (t) => {
  assert.throws(() => imageConfiguration("unknown-target"), /Unknown/);
  const fixture = sourceFixture(t);
  fixture.commit("selected source");
  fixture.clone();
  const result = fixture.cli(["config", "unknown-target"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.values, {});
  assert.deepEqual(result.localEnv, {});
  const workflow = read(".github/workflows/publish-ee-images.yml");
  assert.deepEqual([...new Set([...workflow.matchAll(/matrix\.([a-z_]+)/g)].map((match) => match[1]))], ["target"]);
  assert.equal([...workflow.matchAll(/name: Build \$\{\{ matrix\.target \}\}/g)].length, 2);
  assert.match(workflow, /id: config\n\s+if:.*\n\s+run: node \.github\/scripts\/ee-image-inputs\.mjs config "\$\{\{ matrix\.target \}\}"/);
  for (const key of ["images", "gateway"]) assert.ok(workflow.includes("include: ${{ fromJSON(needs.image-inputs.outputs." + key + ") }}"));
  assert.doesNotMatch(workflow, /fromJSON\([^\n]*\|\|/);
});

for (const target of ["den-api", "client-web", "den-web"]) {
  test(`${target}: locally resolved configuration drives the existing health callback and API-only migration bootstrap`, async (t) => {
    const configuration = imageConfiguration(target);
    const directory = mkdtempSync(join(tmpdir(), "openwork-ee-health-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const binary = join(directory, "bin");
    mkdirSync(binary);
    const log = join(directory, "docker.jsonl");
    // Only Docker is stubbed. The workflow's real Node fetch must reach this
    // loopback callback at the locally resolved health path. No real containers.
    writeFileSync(join(binary, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EE_MOCK_LOG, JSON.stringify(args) + String.fromCharCode(10));
if (args[0] === "port") process.stdout.write("0.0.0.0:" + process.env.EE_MOCK_PORT + String.fromCharCode(10));
else if (args[0] === "run" && args.includes("-d")) process.stdout.write("fixture-container" + String.fromCharCode(10));
`, { mode: 0o755 });
    const block = read(".github/workflows/publish-ee-images.yml").match(/^      - name: Smoke health endpoint\n([\s\S]*?)(?=^      - name: Promote current dev inputs)/m)?.[1];
    assert.ok(block);
    const marker = "        run: |\n";
    assert.ok(block.includes(marker));
    const script = block.slice(block.indexOf(marker) + marker.length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n")
      .replaceAll("${{ steps.config.outputs.image }}", configuration.image)
      .replaceAll("${{ steps.config.outputs.port }}", String(configuration.port))
      .replaceAll("${{ steps.config.outputs.health_path }}", configuration.health_path)
      .replaceAll(/\bdocker /g, `'${join(binary, "docker").replaceAll("'", "'\\''")}' `);
    assert.doesNotMatch(script, /\$\{\{/);
    assert.doesNotMatch(script, /\bdocker\s+(?:run|exec|network|port|inspect|logs|rm)/);
    const result = await new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", script], { cwd: directory, timeout: 15_000, env: {
        PATH: binary + delimiter + process.env.PATH, EE_MOCK_LOG: log, EE_MOCK_PORT: String(address.port),
        IMAGE_TAGS: "local-image:smoke", EE_IMAGE_SMOKE_ENV: configuration.smoke_env,
      } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => { stdout += value; });
      child.stderr.on("data", (value) => { stderr += value; });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, [{ "den-api": "/health", "client-web": "/__gw/health", "den-web": "/api/health" }[target]]);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args[0] === "port" && args[2] === `${configuration.port}/tcp`));
    const run = calls.find((args) => args[0] === "run" && args[args.indexOf("--name") + 1] === `openwork-smoke-${configuration.image}`);
    assert.ok(run);
    assert.equal(run.at(-1), "local-image:smoke");
    for (const argument of configuration.smoke_env.split(/\s+/).filter(Boolean)) assert.ok(run.includes(argument));
    assert.equal(calls.some((args) => args.includes("/app/ee/packages/den-db/dist/scripts/bootstrap.js")), target === "den-api");
  });
}

test("A building, C queued, then late selector B replaces C: surviving B builds and publishes C without another push", async (t) => {
  const fixture = sourceFixture(t);
  const a = fixture.commit("A");
  const b = fixture.commit("B");
  fixture.clone();
  const c = fixture.commit("C");
  assert.equal(publisherVersion({ root: fixture.origin, ref: b }), publisherVersion({ root: fixture.origin, ref: c }));
  // GitHub keeps one running and one pending job, with no FIFO ordering. Model
  // its documented replacement, then drive the surviving job's real source CLI.
  let pending = c;
  pending = b;
  assert.equal(pending, b);
  let published = "0".repeat(64);
  const fingerprint = (ref) => buildFingerprint("den-api", { root: fixture.origin, ref });
  const desiredFingerprint = () => fingerprint(c);
  assert.notEqual(fingerprint(b), fingerprint(c));
  assert.equal(await promoteIfCurrent({ fingerprint: fingerprint(a), latestFingerprint: desiredFingerprint, promote: () => { assert.fail("A is stale"); } }), false);
  const result = fixture.cli("source");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.values, { current: "true", source_sha: c, source_short_sha: c.slice(0, 7) });
  assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), c);
  assert.equal(readFileSync(join(fixture.runner, "input.txt"), "utf8"), "C");
  const decision = await imageDecision({ ...dev, target: "den-api", getFingerprint: () => buildFingerprint("den-api", { root: fixture.runner }), readBaseline: async () => published });
  assert.equal(decision.build, true);
  assert.equal(decision.fingerprint, fingerprint(c));
  assert.equal(await promoteIfCurrent({ fingerprint: decision.fingerprint, latestFingerprint: desiredFingerprint, promote: async () => { published = decision.fingerprint; } }), true);
  assert.equal(published, fingerprint(c));
});

test("version job shares the publishing channel but isolates every build-only run/attempt, including default manual dry-runs and PRs", (t) => {
  const automatic = versionDecision(t);
  const manual = versionDecision(t, { eventName: "workflow_dispatch", push: "true", chartVersion: "1.2.3", runId: "102" });
  for (const result of [automatic, manual]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.publish, "true");
    assert.equal(result.values.publication_channel, "publish");
  }
  const buildOnly = [
    versionDecision(t, { eventName: "workflow_dispatch", runId: "201" }),
    versionDecision(t, { eventName: "workflow_dispatch", runId: "201", runAttempt: "2" }),
    versionDecision(t, { eventName: "pull_request", ref: "refs/pull/123/merge", push: "true", runId: "202" }),
  ];
  for (const result of buildOnly) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.publish, "false");
    assert.match(result.values.publication_channel, /^build-[0-9]+-[0-9]+$/);
    assert.notEqual(publisherGroup(current, result.values.publication_channel), publisherGroup(current, "publish"));
  }
  assert.equal(new Set(buildOnly.map(({ values }) => values.publication_channel)).size, 3);
  assert.equal(versionDecision(t, { eventName: "workflow_dispatch", push: "true" }).status, 1, "manual publishes still require a chart version");
  assert.equal(versionDecision(t, { eventName: "workflow_dispatch", runId: "" }).status, 1, "missing dry-run identity must not share a channel");
  assert.match(read(".github/workflows/publish-ee-images.yml"), /PUBLISH_IMAGES: \$\{\{ needs\.artifact-version\.outputs\.publish \}\}/);
});

test("A running/C queued/manual default dry-run arrives: dry-run cannot replace C, which publishes without a fourth push", async (t) => {
  const fixture = sourceFixture(t);
  const a = fixture.commit("A");
  const b = fixture.commit("B");
  fixture.clone();
  const c = fixture.commit("C");
  const version = publisherVersion({ root: fixture.runner });
  const automatic = versionDecision(t);
  const dryRun = versionDecision(t, { eventName: "workflow_dispatch", runId: "202" });
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const pending = new Map([[publisherGroup(version, automatic.values.publication_channel), c]]);
  pending.set(publisherGroup(version, dryRun.values.publication_channel), b);
  assert.equal(pending.get(publisherGroup(version, automatic.values.publication_channel)), c);
  const drySource = fixture.cli("source", { eventName: "workflow_dispatch", publish: dryRun.values.publish, expectedPublisher: "" });
  assert.equal(drySource.status, 0, drySource.stderr);
  assert.equal(drySource.values.source_sha, b);
  assert.equal(fixture.git(fixture.runner, ["rev-parse", "refs/remotes/origin/dev"]), b, "dry-run did not fetch latest dev");
  const desired = () => buildFingerprint("den-api", { root: fixture.origin, ref: c });
  assert.equal(await promoteIfCurrent({ fingerprint: buildFingerprint("den-api", { root: fixture.origin, ref: a }), latestFingerprint: desired, promote: () => { assert.fail("A is stale"); } }), false);
  const source = fixture.cli("source", { publish: automatic.values.publish });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.values.source_sha, c);
  let published;
  const fingerprint = buildFingerprint("den-api", { root: fixture.runner });
  assert.equal(await promoteIfCurrent({ fingerprint, latestFingerprint: desired, promote: async () => { published = fingerprint; } }), true);
  assert.equal(published, desired());
});

test("a publishing dev dispatch can replace pending C, but reconciles and publishes C with C's source SHA", async (t) => {
  const fixture = sourceFixture(t);
  const a = fixture.commit("A");
  const b = fixture.commit("B");
  fixture.clone();
  const c = fixture.commit("C");
  const version = publisherVersion({ root: fixture.runner });
  const automatic = versionDecision(t);
  const manual = versionDecision(t, { eventName: "workflow_dispatch", push: "true", chartVersion: "1.2.3", runId: "202" });
  assert.equal(manual.status, 0, manual.stderr);
  const pending = new Map([[publisherGroup(version, automatic.values.publication_channel), c]]);
  pending.set(publisherGroup(version, manual.values.publication_channel), b);
  assert.equal(pending.get(publisherGroup(version, automatic.values.publication_channel)), b, "publishing dispatch shares the automatic publication queue");
  const desired = () => buildFingerprint("den-api", { root: fixture.origin, ref: c });
  assert.equal(await promoteIfCurrent({ fingerprint: buildFingerprint("den-api", { root: fixture.origin, ref: a }), latestFingerprint: desired, promote: () => { assert.fail("A is stale"); } }), false);
  const source = fixture.cli("source", { eventName: "workflow_dispatch", publish: manual.values.publish });
  assert.equal(source.status, 0, source.stderr);
  assert.deepEqual(source.values, { current: "true", source_sha: c, source_short_sha: c.slice(0, 7) });
  assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), c);
  const manualEvent = { eventName: "workflow_dispatch", ref: "refs/heads/dev" };
  const decision = await imageDecision({ ...manualEvent, target: "den-api", getFingerprint: () => buildFingerprint("den-api", { root: fixture.runner }), readBaseline: () => { assert.fail("manual builds remain full"); } });
  const selected = await selectImages({ ...manualEvent, getFingerprint: () => desired(), readBaseline: () => { assert.fail("manual builds remain full"); } });
  assert.equal(selected.images.length + selected.gateway.length, 6);
  assert.equal(helmDecision({ ...manualEvent, files: [] }), true);
  let published;
  assert.equal(await promoteIfCurrent({ fingerprint: decision.fingerprint, latestFingerprint: desired, promote: async () => { published = decision.fingerprint; } }), true);
  assert.equal(published, desired());
});

test("reconciled checkout SHA is the provenance in tags, OCI revision and both build steps' API/gateway versions", (t) => {
  const fixture = sourceFixture(t);
  const queued = fixture.commit("B");
  fixture.clone();
  const latest = fixture.commit("C");
  const result = fixture.cli("source");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.values.source_sha, queued);
  assert.equal(result.values.source_sha, latest);
  const workflow = read(".github/workflows/publish-ee-images.yml");
  assert.doesNotMatch(workflow, /github\.sha|type=sha,/);
  const rendered = workflow
    .replaceAll("${{ steps.source.outputs.source_sha }}", result.values.source_sha)
    .replaceAll("${{ steps.source.outputs.source_short_sha }}", result.values.source_short_sha)
    .replaceAll("${{ github.run_id }}", "101").replaceAll("${{ github.run_attempt }}", "1");
  assert.ok(rendered.includes(`type=raw,value=sha-${latest.slice(0, 7)}`));
  assert.ok(rendered.includes(`type=raw,value=build-${latest}-101-1`));
  assert.ok(rendered.includes(`org.opencontainers.image.revision=${latest}`));
  const versions = [...workflow.matchAll(/format\('DEN_(API|GATEWAY)_VERSION=\{0\}', ([^)]+)\)/g)];
  assert.deepEqual(versions.map((match) => match[1]), ["API", "GATEWAY", "API", "GATEWAY"]);
  for (const match of versions) assert.equal(match[2], "needs.artifact-version.outputs.chart_version || steps.source.outputs.source_sha");
  assert.ok(workflow.indexOf("ee-image-inputs.mjs source") < workflow.indexOf("ee-image-inputs.mjs check"));
  assert.match(workflow, /- name: Recheck published inputs under the target lock\n\s+id: inputs\n\s+if: \$\{\{ steps\.source\.outputs\.current == 'true' \}\}/);
});

test("different publisher implementations have distinct queues; an old job never builds the new workflow's tree", (t) => {
  const fixture = sourceFixture(t);
  const oldSha = fixture.commit("old publisher");
  fixture.clone();
  const oldVersion = publisherVersion({ root: fixture.runner });
  fixture.write(publisherInputs[0], read(publisherInputs[0]) + "\n# New publisher implementation\n");
  const latestSha = fixture.commit("new publisher");
  const latestVersion = publisherVersion({ root: fixture.origin });
  assert.notEqual(oldVersion, latestVersion);
  const pending = new Map([[publisherGroup(latestVersion), latestSha]]);
  pending.set(publisherGroup(oldVersion), oldSha);
  assert.equal(pending.get(publisherGroup(latestVersion)), latestSha);
  const result = fixture.cli("source");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.values, { current: "false", source_sha: oldSha, source_short_sha: oldSha.slice(0, 7) });
  assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), oldSha);
  assert.deepEqual(sourceDecision({ ...dev, publish: true, sha: latestSha, latestSha, expectedPublisher: latestVersion, latestPublisher: latestVersion }), { current: true, source_sha: latestSha, source_short_sha: latestSha.slice(0, 7) });
});

for (const event of [
  { eventName: "pull_request", ref: "refs/pull/123/merge", publish: "false" },
  { eventName: "schedule", ref: "refs/heads/dev", publish: "false" },
  { eventName: "push", ref: "refs/tags/v1.2.3", publish: "true" },
  { eventName: "workflow_dispatch", ref: "refs/heads/dev", publish: "false" },
  { eventName: "workflow_dispatch", ref: "refs/heads/release", publish: "false" },
  { eventName: "workflow_dispatch", ref: "refs/heads/release", publish: "true" },
  { eventName: "workflow_dispatch", ref: "refs/tags/v1.2.3", publish: "true" },
]) {
  test(`${event.eventName} ${event.ref} publish=${event.publish}: source CLI keeps the selected commit and never fetches dev`, (t) => {
    const fixture = sourceFixture(t);
    const sha = fixture.commit("selected source");
    fixture.clone();
    fixture.git(fixture.runner, ["remote", "remove", "origin"]);
    const result = fixture.cli("source", { ...event, expectedPublisher: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.values, { current: "true", source_sha: sha, source_short_sha: sha.slice(0, 7) });
    assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), sha);
  });
}

test("source decision rejects missing/invalid desired source and publisher versions", () => {
  const options = { ...dev, publish: true, sha: "1".repeat(40), latestSha: "2".repeat(40), expectedPublisher: current, latestPublisher: current };
  for (const missing of [undefined, "", "unknown", "0".repeat(40)]) assert.throws(() => sourceDecision({ ...options, latestSha: missing }));
  for (const field of ["expectedPublisher", "latestPublisher"]) {
    for (const missing of [undefined, "", "unknown"]) assert.throws(() => sourceDecision({ ...options, [field]: missing }));
  }
  assert.throws(() => sourceDecision({ ...options, sha: "unknown" }));
  for (const publish of [undefined, null, "true", "false", 0, 1]) assert.throws(() => sourceDecision({ ...options, publish }));
  assert.throws(() => sourceDecision({ ...options, eventName: "pull_request", publish: true }));
  assert.throws(() => sourceDecision({ ...options, eventName: "schedule", publish: true }), /invalid/);
});

test("source CLI requires a literal version-job publication flag and refuses publishing PRs", (t) => {
  const fixture = sourceFixture(t);
  const sha = fixture.commit("A");
  fixture.clone();
  for (const publish of [null, "", "TRUE", "1", "yes"]) {
    const result = fixture.cli("source", { publish });
    assert.equal(result.status, 1);
    assert.deepEqual(result.values, {});
    assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), sha);
  }
  const pr = fixture.cli("source", { eventName: "pull_request", publish: "true" });
  assert.equal(pr.status, 1);
  assert.deepEqual(pr.values, {});
});

test("source CLI fails closed on dev fetch failure, without a buildable source output", (t) => {
  const fixture = sourceFixture(t);
  const sha = fixture.commit("A");
  fixture.clone();
  fixture.git(fixture.runner, ["remote", "set-url", "origin", join(fixture.directory, "missing-origin")]);
  for (const eventName of ["push", "workflow_dispatch"]) {
    const result = fixture.cli("source", { eventName, publish: "true" });
    assert.equal(result.status, 1);
    assert.deepEqual(result.values, {});
    assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), sha);
  }
});

test("source CLI fails closed on a missing queued version or mismatched executing checkout", (t) => {
  const fixture = sourceFixture(t);
  const sha = fixture.commit("A");
  fixture.clone();
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const expectedPublisher of ["", "0".repeat(64)]) {
      const result = fixture.cli("source", { eventName, publish: "true", expectedPublisher });
      assert.equal(result.status, 1);
      assert.deepEqual(result.values, {});
      assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), sha);
    }
  }
});

test("source CLI fails closed when the latest publisher tree is incomplete", (t) => {
  const fixture = sourceFixture(t);
  const sha = fixture.commit("A");
  fixture.clone();
  rmSync(join(fixture.origin, publisherInputs[0]));
  fixture.commit("missing workflow");
  assert.throws(() => publisherVersion({ root: fixture.origin }), /unavailable/);
  const result = fixture.cli("source");
  assert.equal(result.status, 1);
  assert.deepEqual(result.values, {});
  assert.equal(fixture.git(fixture.runner, ["rev-parse", "HEAD"]), sha);
});

for (const actions of ["false", "true"]) {
  test(`source CLI only allows depth-1 fetching in disposable Actions checkouts (GITHUB_ACTIONS=${actions})`, (t) => {
    const fixture = sourceFixture(t);
    fixture.commit("A");
    fixture.clone();
    const latest = fixture.commit("B");
    const result = fixture.cli("source", { actions });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.source_sha, latest);
    assert.equal(fixture.git(fixture.runner, ["rev-parse", "--is-shallow-repository"]), actions);
    assert.equal(fixture.git(fixture.origin, ["rev-parse", "--is-shallow-repository"]), "false");
  });
}
