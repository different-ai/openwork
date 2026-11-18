import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runSmoke, smokeServices } from "./managed-stable-release-smoke.mjs";
import { releaseRepositories } from "./managed-stable-release.mjs";

const images = Object.fromEntries(Object.entries(releaseRepositories("aws")).map(([kind, registry]) => [kind, `${registry}@sha256:${"a".repeat(64)}`]));
const candidate = { provider: "aws", images };
function harness({ failingPath, badDatabase = false, cleanupFails = false } = {}) {
  const calls = [];
  const paths = [];
  return { calls, paths, options: {
    suffix: "unit-test", wait: async () => {},
    docker(args) {
      calls.push(args);
      if (cleanupFails && args[0] === "volume" && args[1] === "rm") throw new Error("cleanup");
      if (args[0] === "inspect") return "true false";
      if (args[0] === "port") return "127.0.0.1:45678";
      return "fixture";
    },
    async fetchImpl(url) {
      const path = new URL(url).pathname;
      paths.push(path);
      return { ok: path !== failingPath, json: async () => ({ ok: true, checks: { database: badDatabase ? "error" : "ok" } }) };
    },
  } };
}
test("AWS smoke requires and boots every exact Gateway runtime with production Gateway env", async () => {
  const { calls, paths, options } = harness();
  const checked = await runSmoke(candidate, options);
  assert.deepEqual(checked, ["ai_gateway/health", "ai_gateway/ready", "den_api/health", "den_web/api/health", "headless_runner/health", "workbot/healthz"]);
  assert.equal(paths.length, 12, "all six probes are rechecked after the whole five-service stack starts");
  const runtime = calls.filter((args) => args[0] === "run" && args.includes("--platform=linux/amd64") && args.includes("-d"));
  assert.equal(runtime.length, 5);
  assert.deepEqual(runtime.map((args) => args.at(-1)).sort(), Object.values(images).sort());
  for (const args of runtime) {
    assert.ok(args.includes("NODE_ENV=production"));
    assert.ok(args.includes("OPENWORK_DEV_MODE=0"));
    assert.match(args[args.indexOf("-p") + 1], /^127\.0\.0\.1::\d+$/);
  }
  for (const kind of ["den_api", "ai_gateway"]) {
    const args = runtime.find((args) => args.at(-1) === images[kind]);
    for (const key of ["GATEWAY_ENABLED=true", "GATEWAY_PUBLIC_BASE_URL=https://models.example.test", "DB_MODE=mysql"])
      assert.ok(args.includes(key));
    assert.ok(args.some((value) => value.startsWith("GATEWAY_PROXY_BASE_URL=http://exp-managed-release-")));
    assert.ok(args.some((value) => value.startsWith("DATABASE_URL=mysql://smoke:smoke@exp-managed-release-")));
  }
  const runner = runtime.find((args) => args.at(-1) === images.headless_runner);
  assert.ok(runner.includes("HEADLESS_COMPUTER=off"));
  assert.ok(runner.includes("HEADLESS_MODEL_PROTOCOL=openai"));
  assert.ok(runner.includes("HEADLESS_MODEL_BASE_URL=https://models.example.test"));
  assert.ok(runner.includes("HEADLESS_MODEL=openai/gpt-6-luna"));
  assert.ok(!runtime.flat().some((arg) => /(?:HEADLESS_MODEL_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY)=/.test(arg)));
  assert.ok(!runner.some((arg) => /(?:DAYTONA_API_KEY|FREESTYLE_API_KEY|HEADLESS_COMPUTER_SNAPSHOT)=/.test(arg)));
  const api = runtime.find((args) => args.at(-1) === images.den_api);
  assert.ok(api.includes("DEN_HEADLESS_RUNNER_URL=http://exp-managed-release-unit-test-headless-runner:8795"));
  assert.ok(api.includes("DEN_HEADLESS_RUNNER_TOKEN=ci-headless-runner-token-value-1234567890"));
  assert.ok(api.includes("DEN_AUTOMATIONS_ENABLED=true"));
  assert.ok(api.includes("DEN_SLACK_ASSISTANT_WORKER_ENABLED=true"));
  assert.ok(api.includes("DEN_WORKBOT_URL=https://chat.example.test"));
  assert.equal(calls.filter((args) => args[0] === "rm").length, 6);
  assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  assert.ok(calls.some((args) => args[0] === "network" && args[1] === "rm"));
  assert.ok(calls.every((args) => !args.includes("prune")));
});
test("missing, legacy, mutable or cross-provider images fail before any Docker creation", async () => {
  for (const invalid of [
    { ...candidate, images: { den_api: images.den_api, den_web: images.den_web } },
    { ...candidate, images: { ...images, ai_gateway: "ghcr.io/different-ai/openwork-inference:dev" } },
    { ...candidate, images: { ...images, headless_runner: images.workbot } },
    { ...candidate, provider: "other" }, { images },
  ]) {
    const { calls, options } = harness();
    await assert.rejects(runSmoke(invalid, options));
    assert.deepEqual(calls, []);
  }
});
test("GCP retains core-pair health smoke without enabling the AWS Gateway", async () => {
  const { calls, options } = harness();
  const checked = await runSmoke({ provider: "gcp", images: { den_api: images.den_api, den_web: images.den_web } }, options);
  assert.deepEqual(checked, ["den_api/health", "den_web/api/health"]);
  assert.ok(!calls.flat().includes("GATEWAY_ENABLED=true"));
  assert.ok(calls.flat().includes("BETTER_AUTH_URL=http://127.0.0.1:8788"));
  assert.ok(!calls.flat().some((arg) => /^DEN_(?:HEADLESS_RUNNER|SLACK_ASSISTANT|AUTOMATIONS|WORKBOT)_/.test(arg)));
});
test("Gateway liveness alone cannot pass: DB readiness failure cleans up and fails", async () => {
  for (const failure of [{ failingPath: "/ready" }, { badDatabase: true }, { failingPath: "/healthz" }]) {
    const { calls, options } = harness(failure);
    await assert.rejects(runSmoke(candidate, options), /runtime health/);
    assert.ok(calls.some((args) => args[0] === "rm"));
    assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
    assert.ok(calls.some((args) => args[0] === "network" && args[1] === "rm"));
  }
  const { options } = harness({ cleanupFails: true });
  await assert.rejects(runSmoke(candidate, options), /cleanup incomplete/);
});
test("failed migration bootstrap cleans only its own database resources and never starts apps", async () => {
  const { calls, options } = harness();
  const docker = options.docker;
  await assert.rejects(runSmoke(candidate, { ...options, docker(args) {
    const result = docker(args);
    if (args.includes("/app/ee/packages/den-db/dist/scripts/bootstrap.js")) throw new Error("fixture migration failure");
    return result;
  } }), /migration failure/);
  assert.equal(calls.filter((args) => args[0] === "run" && args.includes("-d")).length, 1);
  assert.equal(calls.filter((args) => args[0] === "rm").length, 1);
  assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  assert.ok(calls.some((args) => args[0] === "network" && args[1] === "rm"));
});

test("an earlier service dying while the rest boot cannot produce a passing smoke", async () => {
  const { calls, options } = harness();
  const docker = options.docker;
  await assert.rejects(runSmoke(candidate, { ...options, docker(args) {
    return args[0] === "inspect" ? "false true" : docker(args);
  } }), /local Docker OOM/);
  const fetchImpl = options.fetchImpl;
  let requests = 0;
  await assert.rejects(runSmoke(candidate, { ...options, async fetchImpl(url) {
    if (++requests > 6) return { ok: false };
    return fetchImpl(url);
  } }), /lost readiness/);
  assert.equal(calls.filter((args) => args[0] === "rm").length, 12);
});

test("smoke resource names remain valid production DNS labels and reject unsafe suffixes", async () => {
  const { calls, options } = harness();
  await runSmoke(candidate, { ...options, suffix: "a".repeat(24) });
  for (const value of calls.flat().filter((value) => value.startsWith("GATEWAY_PROXY_BASE_URL="))) {
    assert.ok(new URL(value.split("=")[1]).hostname.length <= 63);
  }
  for (const suffix of ["a".repeat(25), "../other", "", "unsafe name"]) {
    const { calls, options } = harness();
    await assert.rejects(runSmoke(candidate, { ...options, suffix }), /identifier/);
    assert.deepEqual(calls, []);
  }
});

test("production smoke fixture helper and workflow remain cheap and import-safe", () => {
  assert.equal(smokeServices(candidate, { mysql: "fixture-mysql", ai_gateway: "fixture-gateway" }).length, 5);
  const workflow = readFileSync(new URL("../workflows/managed-stable-release.yml", import.meta.url), "utf8");
  const cheap = workflow.split("  helper-tests:")[1].split("  prepare:")[0];
  assert.ok(cheap.includes("managed-stable-release-smoke.test.mjs"));
  assert.doesNotMatch(cheap, /needs:|environment:|secrets\.|terraform|docker|pnpm install/);
});
