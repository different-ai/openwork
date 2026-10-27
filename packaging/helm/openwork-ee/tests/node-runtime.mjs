import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const chartDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

function render(...args) {
  return execFileSync("helm", ["template", "runtime-test", chartDir, ...args], { encoding: "utf8" });
}

const rendered = render();
const probe = rendered.split(/^---$/m).find((document) => document.includes("name: runtime-test-openwork-ee-env-probe"));
assert.ok(probe, "existing env-probe test hook is rendered");
const source = /^            - \|\n((?: {14}[^\n]*\n|\n)+)/m.exec(probe)?.[1]
  .split("\n").map((line) => line.slice(14)).join("\n");
assert.ok(source, "extract the complete rendered Node.js script, not a copied version check");

function runProbe(version, overrides = {}) {
  const output = [];
  const errors = [];
  const exit = new Error("process.exit");
  let status = 0;
  const env = {
    DATABASE_URL: "mysql://runtime-test:private-password@database/test",
    DEN_DB_ENCRYPTION_KEY: "private-encryption-key",
    BETTER_AUTH_SECRET: "private-auth-secret",
    DEN_BASE_URL: "https://den.example.test",
    DB_MODE: "mysql",
    DEN_ORG_MODE: "single_org",
    PROVISIONER_MODE: "disabled",
    DEN_API_BASE: "http://den-api:8788",
    DEN_AUTH_FALLBACK_BASE: "https://den.example.test",
    DEN_AUTH_ORIGIN: "https://den.example.test",
    OPENWORK_DEV_MODE: "false",
    PORT: "8788",
    NODE_OPTIONS: "",
    ...overrides,
  };
  try {
    runInNewContext(source, {
      require,
      console: {
        log: (line) => output.push(line),
        error: (line) => errors.push(line),
      },
      process: {
        version: `v${version}`,
        versions: { node: version },
        platform: "linux",
        arch: "arm64",
        env,
        exit: (code) => { status = code; throw exit; },
      },
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { status, output: output.join("\n"), errors: errors.join("\n") };
}

for (const version of ["24.22.1", "24.22.2", "24.22.10", "24.23.0", "24.100.0"]) {
  test(`rendered probe accepts stable Node.js ${version}`, () => {
    const result = runProbe(version);
    assert.equal(result.status, 0, result.errors);
    assert.match(result.output, /OpenWork Helm env probe passed/);
    assert.ok(result.output.includes(`Node.js runtime: v${version} (linux/arm64)`));
  });
}

for (const version of [
  "20.20.0", "22.22.1", "23.22.1", "24.0.0", "24.9.9", "24.21.99", "24.22.0",
  "24.22.1-rc.1", "24.23.0-nightly20261021", "24.22.1+custom", "25.0.0", "26.22.1", "invalid",
]) {
  test(`rendered probe rejects Node.js ${version}`, () => {
    const result = runProbe(version);
    assert.equal(result.status, 1);
    assert.match(result.errors, /expected stable 24\.x >=24\.22\.1/);
    assert.ok(result.errors.includes(`actual v${version}`));
    assert.match(result.errors, /deploy a new OpenWork application image release/);
    assert.ok(result.output.includes(`Node.js runtime: v${version} (linux/arm64)`));
    assert.doesNotMatch(result.output, /env probe passed/);
    assert.doesNotMatch(result.errors, /private-password|private-encryption-key|private-auth-secret/);
  });
}

test("runtime check retains environment checks and redacted diagnostics", () => {
  const result = runProbe("24.22.1", { OPENWORK_ENV_PROBE_EXPECTED_DB_MODE: "planetscale" });
  assert.equal(result.status, 1);
  assert.match(result.errors, /DB_MODE: expected "planetscale", actual "mysql"/);
  assert.match(result.errors, /DATABASE_URL: <set>/);
  assert.doesNotMatch(result.errors, /private-password|private-encryption-key|private-auth-secret/);
});

test("existing test hook uses the same image tag precedence as Den API", () => {
  const appVersion = /^appVersion: "([^"]+)"$/m.exec(readFileSync(`${chartDir}/Chart.yaml`, "utf8"))?.[1];
  assert.ok(appVersion);
  for (const [args, tag] of [
    [[], appVersion],
    [["--set", "image.tag=0.99.123"], "0.99.123"],
    [["--set", "image.tag=0.99.123", "--set", "denApi.image.tag=0.99.124"], "0.99.124"],
  ]) {
    const documents = render(...args).split(/^---$/m);
    const hook = documents.find((document) => document.includes("name: runtime-test-openwork-ee-env-probe"));
    const api = documents.find((document) => document.includes("kind: Deployment") && document.includes("name: runtime-test-openwork-ee-den-api"));
    assert.ok(hook?.includes(`image: "ghcr.io/different-ai/openwork-den-api:${tag}"`));
    assert.ok(api?.includes(`image: "ghcr.io/different-ai/openwork-den-api:${tag}"`));
    assert.match(hook, /"helm.sh\/hook": test/);
    assert.match(hook, /expected stable 24\.x >=24\.22\.1/);
    assert.match(hook, /Node\.js runtime:/);
  }
});
