import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";
import { buildInputPatterns } from "./build-inputs.mjs";
import { RENDER_SERVICES, renderBuildFilter, runRenderBuildFilters } from "./render-build-filters.mjs";

// Synthetic fixtures only. Tests never use credentials, global fetch, or a live workspace.
const OWNER = "tea-fixtureowner";
const TOKEN = "fixture-api-key-do-not-use";
const REPO = "https://github.com/different-ai/openwork";
const NAMES = ["api-private", "inference-private", "workbot", "client-web"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function fixture(name, overrides = {}) {
  const runtime = RENDER_SERVICES[name]?.runtime ?? "node";
  return {
    id: `srv-fixture${name.replaceAll("-", "")}`,
    name,
    ownerId: OWNER,
    repo: REPO,
    branch: "dev",
    rootDir: "",
    suspended: "not_suspended",
    autoDeploy: "yes",
    autoDeployTrigger: "commit",
    serviceDetails: {
      runtime,
      env: runtime,
      plan: "starter",
      numInstances: 2,
      envSpecificDetails: runtime === "docker"
        ? { dockerfilePath: "packaging/docker/Dockerfile.den-gateway", dockerContext: ".", dockerCommand: "" }
        : { buildCommand: "pnpm --filter @fixture/service... build", startCommand: "node dist/server.js" },
    },
    // A service response can contain sensitive data. None of it belongs in logs or a PATCH.
    privateMetadata: { apiKey: TOKEN, ignoredCommand: `echo ${TOKEN}` },
    ...overrides,
  };
}

function fakeRender({ services = NAMES.map((name) => fixture(name)), onRequest } = {}) {
  const state = structuredClone(services);
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.render.com");
    assert.equal(init.redirect, "error", "bearer credentials must not follow redirects");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, body, init });
    const override = await onRequest?.({ url, init, body, state, calls });
    if (override !== undefined) return override;
    if (url.pathname === "/v1/services") {
      assert.equal(init.method, "GET");
      assert.equal(url.searchParams.get("ownerId"), OWNER, "all discovery must be owner-scoped");
      assert.equal(url.searchParams.get("includePreviews"), "false");
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return json(state.slice(start, start + limit).map((service, index) => ({ service, cursor: String(start + index + 1) })));
    }
    const id = url.pathname.match(/^\/v1\/services\/(srv-[a-z0-9]+)$/)?.[1];
    assert.ok(id, "only the service detail/PATCH endpoint is permitted; no deploy or env-var calls");
    const current = state.find((service) => service.id === id);
    assert.ok(current, "never request an unknown service");
    if (init.method === "PATCH") {
      assert.deepEqual(Object.keys(body), ["buildFilter"], "preserve every setting outside buildFilter");
      current.buildFilter = structuredClone(body.buildFilter);
    } else assert.equal(init.method, "GET");
    return json(current);
  };
  return {
    state, calls, logs,
    patches: () => calls.filter((call) => call.method === "PATCH"),
    run: (options = {}) => runRenderBuildFilters({
      ownerId: OWNER, apiKey: TOKEN,
      githubRef: "refs/heads/dev", githubRepository: "different-ai/openwork",
      fetchImpl, log: (message) => logs.push(message), ...options,
    }),
    records: () => logs.map((message) => JSON.parse(message)),
  };
}

function watches(name, file) {
  return renderBuildFilter(name).paths.some((pattern) => matchesGlob(file, pattern));
}

function assertPrivateLogs(api) {
  const output = api.logs.join("\n");
  for (const secret of [TOKEN, OWNER, ...api.state.map((service) => service.id)]) assert.ok(!output.includes(secret), "logs must omit private identity/credential values");
  assert.ok(!output.includes("privateMetadata"));
  assert.ok(!output.includes("buildCommand"));
  assert.ok(!output.includes("Authorization"));
}

test("allowlist maps the audited native Node builds and source Docker client to shared scopes", () => {
  assert.deepEqual(Object.keys(RENDER_SERVICES), NAMES);
  assert.deepEqual(NAMES.map((name) => RENDER_SERVICES[name].target), ["native-den-api", "native-inference", "native-workbot", "client-web"]);
  for (const name of NAMES) {
    assert.deepEqual(renderBuildFilter(name), { paths: buildInputPatterns(RENDER_SERVICES[name].target), ignoredPaths: [] });
    const patterns = renderBuildFilter(name).paths;
    for (const blanket of ["**", "apps/**", "ee/apps/**", "apps/desktop/**"]) assert.ok(!patterns.includes(blanket));
    for (const global of [
      "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/fixture.patch",
      ".github/scripts/build-inputs.mjs", ".github/scripts/render-build-filters.mjs", ".github/workflows/render-build-filters.yml",
    ]) assert.equal(watches(name, global), true, `${name} must watch ${global}`);
    for (const unrelated of ["ee/apps/landing/src/app/page.tsx", "apps/desktop/src/main.ts", "docs/ci-build-scopes.md"]) {
      assert.equal(watches(name, unrelated), false, `${name} must not watch ${unrelated}`);
    }
  }
  assert.equal(watches("api-private", "ee/apps/den-api/src/main.ts"), true);
  assert.equal(watches("api-private", "apps/desktop/package.json"), true, "Den API consumes the desktop version manifest");
  assert.equal(watches("inference-private", "ee/apps/gateway/src/server.ts"), true);
  assert.equal(watches("workbot", "ee/apps/workbot/src/server/main.ts"), true);
  assert.equal(watches("workbot", "ee/packages/workbot-ui/src/index.tsx"), true);
  for (const name of ["api-private", "inference-private", "workbot"]) {
    assert.equal(watches(name, "apps/app/src/App.tsx"), false);
    for (const recipe of ["Dockerfile.den", "Dockerfile.gateway", "Dockerfile.workbot", "Dockerfile.den-gateway"]) {
      assert.equal(watches(name, `packaging/docker/${recipe}`), false, "native builds do not consume Docker recipes");
    }
  }
  for (const input of ["apps/app/src/App.tsx", "packages/ui/src/index.ts", "packaging/docker/Dockerfile.den-gateway", "apps/server/src/mcp-app-sandbox.ts"]) {
    assert.equal(watches("client-web", input), true, `client bakes ${input}`);
  }
  assert.equal(watches("client-web", "apps/server/src/unrelated-route.ts"), false);
});

test("preview is the default: GET current filters, print a safe plan, and issue zero PATCHes", async () => {
  const api = fakeRender();
  const result = await api.run();
  assert.equal(result.mode, "preview");
  assert.deepEqual(result.services, NAMES.map((name) => ({ name, action: "would_patch" })));
  assert.equal(api.patches().length, 0);
  assert.ok(api.calls.every((call) => call.method === "GET"));
  assert.equal(api.calls.filter((call) => call.url.pathname !== "/v1/services").length, 4, "read each filter even if list responses contain it");
  const plan = api.records()[0];
  assert.equal(plan.event, "render-build-filters.plan");
  assert.equal(plan.redeploy, false);
  assert.deepEqual(plan.services.map((service) => service.name), NAMES);
  for (const item of plan.services) {
    assert.deepEqual(item.before, { paths: [], ignoredPaths: [] });
    assert.deepEqual(item.desired, renderBuildFilter(item.name));
  }
  assertPrivateLogs(api);
});

test("an exact single selection reads and applies only that allowlisted buildFilter", async () => {
  const services = [...NAMES.map((name) => fixture(name)), fixture("unmanaged")];
  services[2].autoDeployTrigger = "checksPass"; // Preserve other settings rather than silently enabling commit autodeploys.
  const api = fakeRender({ services });
  const before = structuredClone(api.state);
  const result = await api.run({ service: "workbot", apply: true });
  assert.deepEqual(result.services, [{ name: "workbot", action: "applied" }]);
  assert.equal(api.patches().length, 1);
  assert.equal(api.patches()[0].url.pathname, `/v1/services/${before[2].id}`);
  assert.deepEqual(api.patches()[0].body, { buildFilter: renderBuildFilter("workbot") });
  const expected = structuredClone(before);
  expected[2].buildFilter = renderBuildFilter("workbot");
  assert.deepEqual(api.state, expected, "rootDir, autodeploy, commands, runtime, and all other services must be untouched");
  assert.ok(api.calls.filter((call) => call.url.pathname !== "/v1/services").every((call) => call.url.pathname.endsWith(before[2].id)));
  assert.equal(api.calls.filter((call) => call.method === "GET" && call.url.pathname.endsWith(before[2].id)).length, 3, "read, pre-write drift check, post-write verification");
  assertPrivateLogs(api);
});

test("equivalent filters are no-ops, including reordered and duplicate paths", async () => {
  const desired = renderBuildFilter("api-private");
  const existing = { paths: [...desired.paths].reverse().concat(desired.paths[0]), ignoredPaths: [] };
  const api = fakeRender({ services: [fixture("api-private", { rootDir: ".", buildFilter: existing })] });
  const result = await api.run({ service: "api-private", apply: true });
  assert.deepEqual(result.services, [{ name: "api-private", action: "noop" }]);
  assert.equal(api.patches().length, 0);
  assert.deepEqual(api.state[0].buildFilter, existing, "do not PATCH just to reorder patterns");
});

test("ignored paths participate in the comparison and are explicitly cleared", async () => {
  const existing = { ...renderBuildFilter("workbot"), ignoredPaths: ["ee/apps/workbot/**"] };
  const api = fakeRender({ services: [fixture("workbot", { buildFilter: existing })] });
  await api.run({ service: "workbot", apply: true });
  assert.deepEqual(api.patches()[0].body, { buildFilter: renderBuildFilter("workbot") });
});

for (const [label, options] of [
  ["missing owner", { ownerId: undefined }],
  ["owner URL", { ownerId: "https://foreign.invalid" }],
  ["missing key", { apiKey: "" }],
  ["foreign service", { service: "unmanaged" }],
  ["arbitrary URL", { service: "https://foreign.invalid/service" }],
  ["prototype name", { service: "__proto__" }],
  ["string apply", { apply: "true" }],
  ["non-dev apply", { apply: true, githubRef: "refs/heads/topic" }],
  ["tag apply", { apply: true, githubRef: "refs/tags/dev" }],
  ["foreign repository apply", { apply: true, githubRepository: "fixture/openwork" }],
]) test(`reject ${label} before any network request`, async () => {
  const api = fakeRender();
  await assert.rejects(api.run(options));
  assert.equal(api.calls.length, 0);
  assert.equal(api.logs.length, 0);
});

for (const [label, services] of [
  ["missing", [fixture("workbot-preview")]],
  ["ambiguous", [fixture("workbot"), fixture("workbot", { id: "srv-fixtureduplicate" })]],
  ["foreign repo", [fixture("workbot", { repo: "https://github.com/fixture/other" })]],
  ["repo substring", [fixture("workbot", { repo: `${REPO}-fork` })]],
  ["foreign branch", [fixture("workbot", { branch: "main" })]],
  ["foreign owner", [fixture("workbot", { ownerId: "tea-otherfixture" })]],
  ["suspended", [fixture("workbot", { suspended: "suspended" })]],
  ["missing active state", [fixture("workbot", { suspended: undefined })]],
  ["nested rootDir", [fixture("workbot", { rootDir: "ee/apps/workbot" })]],
  ["missing rootDir", [fixture("workbot", { rootDir: undefined })]],
  ["escaping id", [fixture("workbot", { id: "srv-fixture/../../env-vars" })]],
  ["shared build source", [fixture("workbot", { buildSourceId: "bld-fixture" })]],
  ["different runtime", [fixture("workbot", { serviceDetails: { runtime: "image" } })]],
]) test(`fail closed for ${label} service identity/configuration`, async () => {
  const api = fakeRender({ services });
  await assert.rejects(api.run({ service: "workbot", apply: true }));
  assert.equal(api.patches().length, 0);
  assertPrivateLogs(api);
});

for (const [label, docker] of [
  ["wrong recipe", { dockerfilePath: "packaging/docker/Dockerfile.den", dockerContext: "." }],
  ["non-root context", { dockerfilePath: "packaging/docker/Dockerfile.den-gateway", dockerContext: "apps/app" }],
]) test(`client Docker ${label} cannot reuse a mismatched filter`, async () => {
  const api = fakeRender({ services: [fixture("client-web", { serviceDetails: { runtime: "docker", envSpecificDetails: docker } })] });
  await assert.rejects(api.run({ service: "client-web", apply: true }), /source Docker recipe or context/);
  assert.equal(api.patches().length, 0);
});

test("unsafe detail response aborts an all apply before any selected service is written", async () => {
  const api = fakeRender({ onRequest: ({ url, state }) => {
    if (url.pathname.endsWith("fixtureclientweb")) state[3].rootDir = "ee/apps/den-gateway";
  } });
  await assert.rejects(api.run({ apply: true }), /rootDir/);
  assert.equal(api.patches().length, 0, "validate the whole plan before the first PATCH");
});

test("owner-scoped pagination finds services beyond the first page without broadening discovery", async () => {
  const unrelated = Array.from({ length: 100 }, (_, index) => fixture(`unmanaged${index}`));
  const api = fakeRender({ services: [...unrelated, ...NAMES.map((name) => fixture(name))] });
  await api.run();
  const pages = api.calls.filter((call) => call.url.pathname === "/v1/services");
  assert.equal(pages.length, 2);
  assert.equal(pages[1].url.searchParams.get("cursor"), "100");
  assert.ok(pages.every((call) => call.url.searchParams.get("ownerId") === OWNER));
  assert.equal(api.patches().length, 0);
});

test("repeated pagination cursors fail instead of resolving from an incomplete inventory", async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ service: fixture(`unmanaged${index}`), cursor: "fixturecursor" }));
  const api = fakeRender({ onRequest: () => json(entries) });
  await assert.rejects(api.run({ apply: true }), /pagination cursor/);
  assert.equal(api.patches().length, 0);
});

test("malformed inventory and filter responses fail, never become an empty/default apply", async () => {
  const malformed = fakeRender({ onRequest: () => json({ message: TOKEN }) });
  await assert.rejects(malformed.run(), /invalid service list/);
  assertPrivateLogs(malformed);
  const invalidFilter = fakeRender({ services: [fixture("workbot", { buildFilter: { paths: "invalid", ignoredPaths: [] } })] });
  await assert.rejects(invalidFilter.run({ service: "workbot", apply: true }), /invalid buildFilter/);
  assert.equal(invalidFilter.patches().length, 0);
});

test("filter drift after planning aborts instead of overwriting another operator", async () => {
  let reads = 0;
  const api = fakeRender({ services: [fixture("workbot")], onRequest: ({ url, init, state }) => {
    if (url.pathname.endsWith("fixtureworkbot") && init.method === "GET" && ++reads === 2) {
      state[0].buildFilter = { paths: ["fixture-different/**"], ignoredPaths: [] };
    }
  } });
  await assert.rejects(api.run({ service: "workbot", apply: true }), /changed after planning/);
  assert.equal(api.patches().length, 0);
  assert.equal(api.records()[0].event, "render-build-filters.plan");
  assert.ok(!api.records().some((record) => record.event === "render-build-filters.complete"));
});

test("a concurrent equivalent apply becomes a verified no-op", async () => {
  let reads = 0;
  const api = fakeRender({ services: [fixture("workbot")], onRequest: ({ url, init, state }) => {
    if (url.pathname.endsWith("fixtureworkbot") && init.method === "GET" && ++reads === 2) state[0].buildFilter = renderBuildFilter("workbot");
  } });
  assert.deepEqual((await api.run({ service: "workbot", apply: true })).services, [{ name: "workbot", action: "noop" }]);
  assert.equal(api.patches().length, 0);
});

test("an accepted PATCH must be retained by a subsequent GET", async () => {
  const api = fakeRender({ services: [fixture("workbot")], onRequest: ({ init, state }) => init.method === "PATCH" ? json(state[0]) : undefined });
  await assert.rejects(api.run({ service: "workbot", apply: true }), /did not retain/);
  assert.equal(api.patches().length, 1, "do not retry a dispatched write");
  assert.ok(!api.records().some((record) => record.event === "render-build-filters.complete"));
});

for (const stage of ["list", "detail", "patch"]) test(`HTTP/network failures at ${stage} fail without response-body or credential logs`, async () => {
  for (const failure of ["http", "network", "json"]) {
    const api = fakeRender({ services: [fixture("workbot")], onRequest: ({ url, init }) => {
      const match = stage === "list" ? url.pathname === "/v1/services"
        : stage === "patch" ? init.method === "PATCH"
          : url.pathname !== "/v1/services" && init.method === "GET";
      if (!match) return;
      if (failure === "network") throw new Error(`provider details ${TOKEN}`);
      return failure === "http" ? json({ message: TOKEN }, 503) : new Response(`private invalid JSON ${TOKEN}`);
    } });
    await assert.rejects(api.run({ service: "workbot", apply: true }), (error) => !error.message.includes(TOKEN) && /preview before retrying/i.test(error.message));
    assert.equal(api.patches().length, stage === "patch" ? 1 : 0, "never retry an uncertain request");
    assertPrivateLogs(api);
    assert.ok(!api.records().some((record) => record.event === "render-build-filters.complete"));
  }
});

test("even a credential embedded in a current filter is redacted from the structured plan", async () => {
  const id = fixture("workbot").id;
  const api = fakeRender({ services: [fixture("workbot", { buildFilter: { paths: [`fixture/${TOKEN}/**`, OWNER, id], ignoredPaths: [] } })] });
  await api.run({ service: "workbot" });
  assertPrivateLogs(api);
  assert.ok(api.logs[0].includes("[REDACTED]"));
});

test("manual workflow defaults to preview and keeps its write key behind trusted-dev/environment guards", () => {
  const workflow = readFileSync(new URL("../workflows/render-build-filters.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|schedule):/m);
  assert.match(workflow, /apply:[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(workflow, /owner_id:[\s\S]*?required: true/);
  assert.match(workflow, /if: github\.repository == 'different-ai\/openwork' && github\.ref == 'refs\/heads\/dev'/);
  assert.match(workflow, /environment:\n      name: den-production\n      deployment: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /RENDER_API_KEY: \$\{\{ secrets\.RENDER_API_KEY \}\}/);
  assert.match(workflow, /RENDER_APPLY: \$\{\{ inputs\.apply \}\}/);
  assert.match(workflow, /run: node \.github\/scripts\/render-build-filters\.mjs/);
  assert.doesNotMatch(workflow, /pnpm install|\/deploys|curl|needs:/);
  const options = workflow.match(/        options:\n((?:          - .+\n)+)/)?.[1].trim().split("\n").map((line) => line.trim().slice(2));
  assert.deepEqual(options, ["all", ...NAMES]);
  assert.ok(workflow.indexOf("run: node --test") < workflow.indexOf("RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}"), "offline tests must not receive the live write key");
});
