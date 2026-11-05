import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  assertForward, assertSameLatest, assertTrustedEvent, compareVersions, latestStable,
  promote, publisherConfig, releaseConfig, releaseImages, renderClient, shouldPrepare, stableVersion, verifyRuntimeImage,
} from "./managed-stable-release.mjs";

const repository = "example/project";
const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const candidate = { version: "1.2.10", tag: "v1.2.10", commit, bundleSha256: "c".repeat(64) };
const config = {
  version: candidate.version,
  templateUrl: "https://releases.s3.us-east-1.amazonaws.com/template.json?versionId=template1",
  bundleUrl: "https://releases.s3.us-east-1.amazonaws.com/bundle.tar.gz?versionId=bundle1",
  bundleSha256: candidate.bundleSha256,
};
const previous = { ...config, version: "1.2.9", bundleSha256: "d".repeat(64) };
const snapshot = (value) => ({ atomic: value === null ? null : JSON.stringify(value), legacy: value === null ? [null, null, null, null] : [] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const old = snapshot(previous);
function fixture(options = {}) {
  const calls = [];
  const client = {
    snapshot: async () => { calls.push("read-current"); return options.changed ?? old; },
    put: async (provider, value) => { calls.push(["put", provider, value]); },
    deploy: async () => { calls.push("deploy"); return { id: "dep-123abc" }; },
  };
  const args = {
    candidate, expected: old, client, qualified: true,
    latest: async () => { calls.push("latest"); return candidate; },
    publish: async () => { calls.push("publish"); return config; },
  };
  return { calls, args };
}

test("strict stable numeric versions, not alpha/dev/prerelease/draft or semver coercion", async () => {
  for (const version of ["1.2.3", "v1.2.3", "0.0.0"]) assert.equal(stableVersion(version), version.replace(/^v/, ""));
  for (const version of ["dev", "alpha", "1.2.3-dev.1", "v1.2.3-alpha", "1.2.3+build", "01.2.3", "1.2", "v1.2.3\n", "V1.2.3"]) {
    assert.throws(() => stableVersion(version), /strict numeric/);
  }
  for (const release of [
    { tag_name: "v1.2.3", draft: true, prerelease: false },
    { tag_name: "v1.2.3", draft: false, prerelease: true },
    { tag_name: "v1.2.3-alpha", draft: false, prerelease: false },
    { tag_name: "v1.2.3", prerelease: false },
  ]) await assert.rejects(latestStable(repository, "token", async () => response(release)));
});

test("latest is discovered from the official API and tag is resolved to its commit", async () => {
  const calls = [];
  const found = await latestStable(repository, "token", async (url) => {
    calls.push(url);
    return response(calls.length === 1 ? { tag_name: candidate.tag, draft: false, prerelease: false }
      : { ref: `refs/tags/${candidate.tag}`, object: { type: "commit", sha: commit } });
  });
  assert.deepEqual(found, { version: candidate.version, tag: candidate.tag, commit });
  assert.deepEqual(calls, ["https://api.github.com/repos/example/project/releases/latest", "https://api.github.com/repos/example/project/git/ref/tags/v1.2.10"]);
  await assert.rejects(latestStable(repository, "token", async (url) => response(url.endsWith("latest")
    ? { tag_name: candidate.tag, draft: false, prerelease: false }
    : { ref: `refs/tags/${candidate.tag}`, object: { type: "commit", sha: "missing" } })), /resolve to a commit/);
  const annotated = await latestStable(repository, "token", async (url) => response(url.endsWith("latest")
    ? { tag_name: candidate.tag, draft: false, prerelease: false }
    : url.includes("/git/ref/") ? { ref: `refs/tags/${candidate.tag}`, object: { type: "tag", sha: "e".repeat(40) } }
      : { object: { type: "commit", sha: commit } }));
  assert.equal(annotated.commit, commit);
  await assert.rejects(latestStable(repository, "token", async (url) => response(url.endsWith("latest")
    ? { tag_name: candidate.tag, draft: false, prerelease: false }
    : { ref: `refs/heads/${candidate.tag}`, object: { type: "commit", sha: commit } })), /reference does not match/);
});

test("cheap plan skips unrelated dev publisher commits but retains stable/release/fallback candidates", () => {
  assert.equal(shouldPrepare({ workflow_run: { head_sha: "d".repeat(40) } }, "workflow_run", candidate), false);
  assert.equal(shouldPrepare({ workflow_run: { head_sha: commit } }, "workflow_run", candidate), true);
  assert.equal(shouldPrepare({ workflow_run: {} }, "workflow_run", candidate), false);
  for (const name of ["release", "schedule", "workflow_dispatch"]) assert.equal(shouldPrepare({}, name, candidate), true);
});

test("numeric ordering is not lexical (.9 -> .10), handles large numeric semver", () => {
  assert.equal(compareVersions("1.2.9", "1.2.10"), -1);
  assert.equal(compareVersions("10.0.0", "9.99.99"), 1);
  assert.equal(compareVersions("9007199254740994.0.0", "9007199254740993.0.0"), 1);
  assert.equal(compareVersions("v1.2.10", "1.2.10"), 0);
  assert.throws(() => assertForward(config, previous), /downgrade/);
  assert.throws(() => assertForward(config, { ...config, bundleSha256: "e".repeat(64) }), /different bytes/);
});

test("workflow_run fork refs are rejected; trusted completions are only signals", () => {
  const event = { repository: { full_name: repository, default_branch: "main" }, workflow_run: { head_repository: { full_name: repository }, conclusion: "success", name: "Release App", head_branch: "v1.2.3" } };
  assert.doesNotThrow(() => assertTrustedEvent(event, "workflow_run", repository));
  assert.throws(() => assertTrustedEvent({ ...event, workflow_run: { ...event.workflow_run, head_repository: { full_name: "fork/project" } } }, "workflow_run", repository), /Untrusted/);
  assert.throws(() => assertTrustedEvent({ ...event, workflow_run: { ...event.workflow_run, conclusion: "failure" } }, "workflow_run", repository), /unsuccessful/);
  assert.throws(() => assertTrustedEvent(event, "workflow_dispatch", repository, "refs/heads/other"), /default branch/);
  assert.doesNotThrow(() => assertTrustedEvent(event, "schedule", repository, "refs/heads/main"));
  assert.throws(() => assertTrustedEvent(event, "pull_request_target", repository), /Unsupported/);
});

const image = (pin) => ({ Os: "linux", Architecture: "amd64", RepoDigests: [pin], Config: { Labels: { "org.opencontainers.image.revision": commit, "org.opencontainers.image.source": `https://github.com/${repository}` } } });
const manifest = () => ({ Descriptor: { platform: { os: "linux", architecture: "amd64" }, digest }, OCIManifest: { config: { digest: `sha256:${"f".repeat(64)}` } } });
test("shared builder resolver selects unique Linux/amd64 pins and verifies source labels", () => {
  const pins = releaseImages(candidate, repository, manifest, image);
  assert.match(pins.den_api, /openwork-den-api@sha256:/);
  assert.match(pins.den_web, /openwork-den-web@sha256:/);
  for (const badManifest of [() => [], () => [manifest(), manifest()], () => ({ ...manifest(), Descriptor: { ...manifest().Descriptor, platform: { os: "linux", architecture: "arm64" } } })]) {
    assert.throws(() => releaseImages(candidate, repository, badManifest, image), /Linux\/amd64/);
  }
  const pin = pins.den_api;
  for (const invalid of [
    null, { ...image(pin), Architecture: "arm64" }, { ...image(pin), Os: "windows" }, { ...image(pin), RepoDigests: [] },
    { ...image(pin), Config: { Labels: {} } },
    { ...image(pin), Config: { Labels: { ...image(pin).Config.Labels, "org.opencontainers.image.revision": "d".repeat(40) } } },
    { ...image(pin), Config: { Labels: { ...image(pin).Config.Labels, "org.opencontainers.image.source": "https://github.com/untrusted/fork" } } },
  ]) assert.throws(() => verifyRuntimeImage(invalid, pin, candidate, repository), /does not match/);
});

test("atomic configuration contains only four fields and immutable provider URLs", () => {
  assert.deepEqual(releaseConfig("aws", config), config);
  for (const value of [
    { ...config, apiOrigin: "https://example.com" },
    { ...config, version: "v1.2.10" },
    { ...config, templateUrl: config.templateUrl.split("?")[0] },
    { ...config, templateUrl: config.templateUrl + "&x=1" },
    { ...config, templateUrl: config.templateUrl + "&versionId=second" },
    { ...config, templateUrl: config.templateUrl.replace("template1", "null") },
    { ...config, templateUrl: config.templateUrl.replace("https:", "http:") },
    { ...config, templateUrl: config.templateUrl.replace(".com/", ".com:8443/") },
    { ...config, templateUrl: config.templateUrl.replace("template1", "%20%20") },
  ]) assert.throws(() => releaseConfig("aws", value));
  const gcp = { ...config, templateUrl: "https://storage.googleapis.com/bucket/tutorial.md?generation=12", bundleUrl: "https://storage.googleapis.com/bucket/bundle.tar.gz?generation=13" };
  assert.deepEqual(releaseConfig("gcp", gcp), gcp);
  for (const bundleUrl of [gcp.bundleUrl.replace("13", "0"), gcp.bundleUrl.replace(".com/", ".com:8443/"),
    "https://storage.googleapis.com/bucket?generation=13", "https://storage.googleapis.com/b/bundle.tar.gz?generation=13"]) {
    assert.throws(() => releaseConfig("gcp", { ...gcp, bundleUrl }));
  }
});

test("existing publisher's public four-field receipt becomes exactly one atomic value", () => {
  const receipt = {
    DEN_MANAGED_DEPLOYMENT_AWS_VERSION: config.version,
    DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: config.templateUrl,
    DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: config.bundleUrl,
    DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: config.bundleSha256,
  };
  assert.deepEqual(publisherConfig(receipt), config);
  assert.deepEqual(publisherConfig({ DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify(config) }), config);
  assert.throws(() => publisherConfig({ ...receipt, DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: "bad" }));
});

test("qualified promotion writes ONE selected JSON key then ONE deploy", async () => {
  const { calls, args } = fixture();
  assert.deepEqual(await promote(args), { status: "deploy-requested", deploymentId: "dep-123abc" });
  assert.deepEqual(calls, ["latest", "publish", "latest", "read-current", ["put", "aws", config], "deploy"]);
});

test("already-current exact config rerun is a no-op, same-version bytes/config changes rejected", async () => {
  const { calls, args } = fixture();
  args.expected = snapshot(config);
  assert.deepEqual(await promote(args), { status: "already-current" });
  assert.ok(!calls.includes("deploy"));
  args.expected = snapshot({ ...config, bundleSha256: "a".repeat(64) });
  await assert.rejects(promote(args), /different bytes/);
  args.expected = snapshot({ ...config, templateUrl: config.templateUrl.replace("template1", "template2") });
  await assert.rejects(promote(args), /different configuration/);
});

test("failed/unqualified/stale candidate never changes production", async () => {
  const cases = [
    { qualified: false },
    { provider: "gcp" },
    { expected: snapshot({ ...config, version: "1.3.0" }) },
    { expected: { atomic: "malformed", legacy: [config.version, config.templateUrl, config.bundleUrl, config.bundleSha256] } },
    { publish: async () => { throw new Error("publication interrupted"); } },
    { publish: async () => ({ ...config, bundleSha256: "a".repeat(64) }) },
    { latest: async () => ({ ...candidate, version: "1.2.11" }) },
  ];
  for (const changes of cases) {
    const { calls, args } = fixture();
    await assert.rejects(promote({ ...args, ...changes }));
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === "put"));
    assert.ok(!calls.includes("deploy"));
  }
});

test("changed latest immediately before promotion, retag and expected-current conflict fail closed", async () => {
  for (const change of [{ ...candidate, version: "1.2.11" }, { ...candidate, commit: "d".repeat(40) }]) {
    const { calls, args } = fixture();
    let count = 0;
    args.latest = async () => ++count === 1 ? candidate : change;
    await assert.rejects(promote(args), /Latest stable release changed/);
    assert.ok(!calls.includes("deploy"));
  }
  const { calls, args } = fixture({ changed: snapshot(config) });
  await assert.rejects(promote(args), /changed during preparation/);
  assert.ok(!calls.includes("deploy"));
  assert.throws(() => assertSameLatest(candidate, { ...candidate, tag: "1.2.10" }), /changed/);
});

test("atomic invalid blocks legacy fallback; absent atomic alone reads four legacy keys", async () => {
  const seen = [];
  const client = renderClient("srv-test123", "do-not-log-token", async (url, options) => {
    seen.push([new URL(url).pathname, options.method ?? "GET", options.body]);
    const key = new URL(url).pathname.split("/").at(-1);
    if (options.method === "PUT") return response({ key, value: JSON.parse(options.body).value });
    if (url.endsWith("/deploys")) return response({ id: "dep-123abc" });
    if (key.endsWith("_RELEASE")) return response({}, 404);
    const suffix = key.replace("DEN_MANAGED_DEPLOYMENT_AWS_", "");
    return response({ key, value: { VERSION: "1.2.9", TEMPLATE_URL: "legacy", BUNDLE_URL: "legacy", BUNDLE_SHA256: previous.bundleSha256 }[suffix] });
  });
  const expected = await client.snapshot("aws");
  assert.equal(seen.length, 5);
  await promote({ candidate, expected, client, latest: async () => candidate, publish: async () => config, qualified: true });
  const writes = seen.filter(([, method]) => method !== "GET");
  assert.deepEqual(writes, [
    ["/v1/services/srv-test123/env-vars/DEN_MANAGED_DEPLOYMENT_AWS_RELEASE", "PUT", JSON.stringify({ value: JSON.stringify(config) })],
    ["/v1/services/srv-test123/deploys", "POST", "{}"],
  ]);
  assert.ok(seen.every(([path]) => !path.endsWith("/env-vars")), "must never read or bulk-replace all env vars");
});

// Reusable loopback-only proof harness. It exercises real HTTP serialization
// through renderClient without permitting any external provider mutation.
export async function withMockRender(run) {
  let atomic = JSON.stringify(previous);
  const requests = [];
  const key = "DEN_MANAGED_DEPLOYMENT_AWS_RELEASE";
  const envPath = `/v1/services/srv-test123/env-vars/${key}`;
  const deployPath = "/v1/services/srv-test123/deploys";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method, path: request.url, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === envPath && request.method === "GET") response.end(JSON.stringify({ key, value: atomic }));
    else if (request.url === envPath && request.method === "PUT") {
      atomic = body.value;
      response.end(JSON.stringify({ key, value: atomic }));
    } else if (request.url === deployPath && request.method === "POST") response.end(JSON.stringify({ id: "dep-123abc" }));
    else { response.statusCode = 400; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback test server unavailable.");
  const client = renderClient("srv-test123", "local-fixture-token", (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.render.com");
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}`, options);
  });
  try {
    return await run({ client, requests, changeCurrent: (value) => { atomic = JSON.stringify(value); } });
  } finally {
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}

test("loopback HTTP proof: one atomic env PUT then one deploy; expected-current race means zero writes", async () => {
  await withMockRender(async ({ client, requests }) => {
    const expected = await client.snapshot("aws");
    await promote({ candidate, expected, client, latest: async () => candidate, publish: async () => config, qualified: true });
    const writes = requests.filter(({ method }) => method !== "GET");
    assert.deepEqual(writes, [
      { method: "PUT", path: "/v1/services/srv-test123/env-vars/DEN_MANAGED_DEPLOYMENT_AWS_RELEASE", body: { value: JSON.stringify(config) } },
      { method: "POST", path: "/v1/services/srv-test123/deploys", body: {} },
    ]);
    assert.equal(requests.filter(({ method }) => method === "GET").length, 2);
    assert.ok(requests.every(({ path }) => !path.endsWith("/env-vars")));
  });
  await withMockRender(async ({ client, requests, changeCurrent }) => {
    const expected = await client.snapshot("aws");
    await assert.rejects(promote({ candidate, expected, client, latest: async () => candidate, qualified: true,
      publish: async () => { changeCurrent({ ...config, version: "1.3.0" }); return config; },
    }), /changed during preparation/);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
  });
});

test("provider errors never expose tokens or response body; mutation dispatch is not retried", async () => {
  const secret = "token-must-never-appear";
  const client = renderClient("srv-test123", secret, async () => response({ message: secret }, 401));
  await assert.rejects(client.snapshot("aws"), (error) => !error.message.includes(secret) && error.message.includes("401"));
  const throwing = renderClient("srv-test123", secret, async () => { throw new Error(secret); });
  await assert.rejects(throwing.snapshot("aws"), (error) => !error.message.includes(secret));
  const { calls, args } = fixture();
  args.client.deploy = async () => { calls.push("deploy"); throw new Error("uncertain deploy"); };
  await assert.rejects(promote(args), /uncertain deploy/);
  assert.equal(calls.filter((call) => call === "deploy").length, 1);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "put").length, 1);
});

test("workflow keeps cheap checks independent; trusted code, review and serialized production gates", () => {
  const workflow = readFileSync(new URL("../workflows/managed-stable-release.yml", import.meta.url), "utf8");
  const cheap = workflow.split("  helper-tests:")[1].split("  prepare:")[0];
  assert.doesNotMatch(cheap, /needs:|environment:|secrets\.|terraform|docker|pip install/);
  assert.match(workflow, /workflows: \[Publish EE Artifacts, Release App\]/);
  assert.match(workflow, /cron: "23 \*\/6 \* \* \*"/);
  assert.match(workflow, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(workflow, /ref:.*workflow_run\./);
  assert.match(workflow, /group: den-api-env/);
  assert.match(workflow, /name: den-production/);
  assert.match(workflow, /MANAGED_DEPLOYMENT_AWS_PROMOTION_ENABLED/);
  assert.doesNotMatch(workflow, /AUTO_RELEASE/);
  assert.match(workflow, /test "\$PROMOTION_ENABLED" = true/);
  assert.ok(workflow.indexOf("managed-stable-release.mjs plan") < workflow.indexOf("Install verified Terraform"));
  assert.equal((workflow.match(/if: steps.plan.outputs.prepare == 'true'/g) ?? []).length, 5,
    "Terraform, native checks, image packaging, container smoke and upload are all gated by the cheap plan");
  for (const path of ["infra/managed-deployments/**", "infra/terraform/modules/openwork-aws-ecs/**", "infra/terraform/modules/openwork-gcp-cloud-run/**", "packages/managed-deployments/**"]) {
    assert.ok(workflow.includes(`      - ${path}`));
  }
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && inputs.promote/);
  assert.match(workflow, /reviewed_manifest_sha256:/);
  assert.match(workflow, /qualification_url:/);
  const script = readFileSync(new URL("managed-stable-release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /\/api\/.*(?:organizations|deployments)|slack|send.*mail/);
  assert.match(script, /only.*new-install default changed/i);
});
