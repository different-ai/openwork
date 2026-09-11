// Offline Helm coalescing and bootstrap configuration checks. No database imports,
// bootstrap entrypoint, network calls, or Kubernetes client are executed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const chart = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(chart, "../../..");
const scratch = mkdtempSync(path.join(tmpdir(), "openwork-helm-upgrade-"));
let passed = 0;
let failed = 0;

function test(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function helm(args, expectedError) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.ifError(result.error);
  if (expectedError) {
    assert.notEqual(result.status, 0, "Helm should reject invalid configuration");
    assert.ok(result.stderr.includes(expectedError), `Missing diagnostic: ${expectedError}`);
    assert.ok(!result.stderr.includes("do-not-disclose"), "Diagnostic leaked fixture secret");
  } else {
    assert.equal(result.status, 0, `Helm failed: ${result.stderr}`);
  }
  return result.stdout;
}

function render(chartPath = chart, args = [], error) {
  return helm(["template", "openwork-ee", chartPath, "--skip-tests", ...args], error);
}

// Upgrade --reuse-values replaces chart.Values with the previous release's
// coalesced values, then coalesces the new overrides. Materialize that exact
// defaults shape with Helm itself; -f old.yaml against new defaults is NOT enough.
function reusedChart(name, args, canonical = false) {
  const destination = path.join(scratch, name);
  cpSync(chart, destination, { recursive: true });
  let values = readFileSync(path.join(chart, "values.yaml"), "utf8");
  if (!canonical) {
    values = values.replace(/^gateway: \{\}\r?\n/m, "")
      .replace(/^    gatewayPublicBaseUrl:.*\r?\n/m, "")
      .replace(/^    database(?:Host|Username|Password):.*\r?\n/gm, "");
  }
  writeFileSync(path.join(destination, "values.yaml"), values);
  const snapshotTemplate = path.join(destination, "templates", "saved-values.yaml");
  writeFileSync(snapshotTemplate, "{{ toYaml .Values }}\n");
  const saved = render(destination, ["--show-only", "templates/saved-values.yaml", ...args]);
  unlinkSync(snapshotTemplate);
  writeFileSync(path.join(destination, "values.yaml"), saved);
  if (!canonical) assert.ok(!/^gateway:/m.test(saved), "Old computed values must not acquire new gateway defaults");
  return destination;
}

// Evaluate ONLY the two pure connection configuration functions from the actual
// backend sources. Keep their bodies intact; strip their three TS annotations.
const bootstrap = readFileSync(path.join(root, "ee/packages/den-db/scripts/bootstrap.ts"), "utf8");
const configFunction = bootstrap.match(/^function mysqlConnectionConfigFromEnv\(\): ReturnType<typeof parseMySqlConnectionConfig> \{[\s\S]*?^\}/m)?.[0];
assert.ok(configFunction, "Bootstrap configuration signature changed; update this isolated contract test");
const mysqlSource = readFileSync(path.join(root, "ee/packages/den-db/src/mysql-config.ts"), "utf8");
assert.ok(mysqlSource.includes("function readSslSettings(parsed: URL)"));
assert.ok(mysqlSource.includes("export function parseMySqlConnectionConfig(databaseUrl: string): ParsedMySqlConfig"));
const parser = mysqlSource.slice(mysqlSource.indexOf("function readSslSettings"))
  .replace("(parsed: URL)", "(parsed)")
  .replace("export function parseMySqlConnectionConfig(databaseUrl: string): ParsedMySqlConfig", "function parseMySqlConnectionConfig(databaseUrl)");
function bootstrapConfig(env) {
  return vm.runInNewContext(`${parser}\n${configFunction.replace(": ReturnType<typeof parseMySqlConnectionConfig>", "")}\nmysqlConnectionConfigFromEnv()`, {
    URL,
    process: { env },
  }, { timeout: 1000 });
}

// The Job emits a simple env list of Helm-quoted strings or secretKeyRefs.
// Resolve test Secret keys only, never consult real environment or Kubernetes.
function migrationEnv(yaml, secret = {}) {
  const env = {};
  let name;
  for (const line of yaml.split("\n")) {
    const entry = line.match(/^            - name: ([A-Z_]+)$/);
    if (entry) name = entry[1];
    const value = line.match(/^              value: (".*")$/);
    if (value && name) env[name] = JSON.parse(value[1]);
    const key = line.match(/^                  key: (.+)$/);
    if (key && name) {
      const decoded = key[1].startsWith('"') ? JSON.parse(key[1]) : key[1];
      assert.ok(Object.hasOwn(secret, decoded), `Missing test Secret key: ${decoded}`);
      env[name] = secret[decoded];
    }
  }
  return env;
}
const migrationOnly = ["--show-only", "templates/migration-job.yaml"];
const url = "mysql://fixture:do-not-disclose@mysql.example.internal:3307/production_db?sslmode=verify-full";
const created = [...migrationOnly, "--set-string", `secret.values.databaseUrl=${url}`];

try {
  const legacyArgs = ["--set", "inference.enabled=true", "--set", "inference.replicaCount=3",
    "--set", "inference.image.tag=legacy-pinned", "--set", "inference.env.LEGACY=retained",
    "--set", "inference.service.annotations.legacy=retained", "--set", "inference.resources.limits.cpu=2",
    "--set", "inference.retention.enabled=true", "--set", "inference.retention.adminTokenSecret=retention"];
  let old;
  test("reused-old-values-without-gateway-root", () => {
    old = reusedChart("old-values", legacyArgs);
    const output = render(old);
    assert.ok(output.includes("replicas: 3"));
    assert.ok(output.includes('openwork-inference:legacy-pinned"'));
    assert.ok(output.includes("kind: CronJob"));
    assert.equal((output.match(/- name: GATEWAY_ENABLED\n\s+value: "false"/g) ?? []).length, 2);
  });
  test("reused-legacy-clears-still-work", () => {
    assert.ok(old, "Old-values simulation must succeed first");
    const output = render(old, ["--set-json", 'gateway={"env":{},"resources":{},"service":{"annotations":{}},"retention":{},"replicaCount":0,"image":{"tag":""}}']);
    assert.ok(output.includes("replicas: 0"));
    assert.ok(!output.includes("retained"));
    assert.ok(!output.includes("legacy-pinned"));
    assert.ok(!output.includes("kind: CronJob"));
    assert.ok(!output.includes("cpu: 2"));
  });
  test("reused-legacy-explicit-disable", () => {
    assert.ok(old);
    const output = render(old, ["--set", "gateway.enabled=false"]);
    assert.ok(!output.includes("name: openwork-ee-inference"));
    assert.ok(!output.includes("kind: CronJob"));
  });
  for (const value of ["false", '""', "[]"]) {
    test(`explicit-nonmap-root-${value}`, () => render(chart, ["--set-json", `gateway=${value}`], "gateway must be a sparse values map"));
  }
  test("reused-canonical-map-is-refilled-by-helm", () => {
    const current = reusedChart("canonical-values", ["--set", "inference.enabled=true", "--set", "gateway.env.SAVED=retained"], true);
    const output = render(current, ["--set-json", "gateway.env={}"]);
    assert.ok(output.includes("- name: SAVED"), "Helm coalesces saved canonical defaults before the chart helper");
  });
  test("reset-values-allows-canonical-map-clear", () => {
    const output = render(chart, ["--set", "inference.enabled=true", "--set-json", "gateway.env={}"]);
    assert.ok(!output.includes("- name: SAVED"));
  });
  test("bootstrap-rejects-http-only-credentials", () => {
    assert.throws(() => bootstrapConfig({ DATABASE_HOST: "mysql.example.internal", DATABASE_USERNAME: "fixture", DATABASE_PASSWORD: "fixture" }), /DATABASE_NAME/);
  });
  for (const mode of ["mysql", "planetscale"]) {
    test(`migration-created-url-${mode}`, () => {
      const output = render(chart, [...created, "--set", `config.databaseMode=${mode}`]);
      const env = migrationEnv(output);
      const config = bootstrapConfig(env);
      assert.equal(env.DATABASE_URL, url);
      assert.equal(config.database, "production_db");
      assert.equal(config.host, "mysql.example.internal");
      assert.equal(config.port, 3307);
      assert.equal(config.ssl.rejectUnauthorized, true);
      assert.ok(!Object.hasOwn(env, "DATABASE_HOST"));
    });
    test(`migration-existing-secret-url-${mode}`, () => {
      const output = render(chart, [...migrationOnly, "--set", `config.databaseMode=${mode}`, "--set", "secret.create=false", "--set", "secret.existingSecret=migration-secret", "--set", "secret.keys.databaseUrl=tcp-url", "--set", "secret.keys.denDbEncryptionKey=encryption"]);
      assert.ok(!output.includes(url));
      const env = migrationEnv(output, { "tcp-url": url, encryption: "fixture-encryption" });
      assert.equal(bootstrapConfig(env).database, "production_db");
    });
  }
  test("legacy-local-tcp-url-still-supported", () => {
    const output = render(chart, [...created, "--set-string", "secret.values.databaseUrl=mysql://fixture:fixture@127.0.0.1/local_db"]);
    assert.equal(bootstrapConfig(migrationEnv(output)).database, "local_db");
  });
  for (const [name, value] of [["empty", ""], ["missing-database", "mysql://fixture:do-not-disclose@mysql.example.internal"], ["missing-user", "mysql://:do-not-disclose@mysql.example.internal/db"], ["wrong-scheme", "https://fixture:do-not-disclose@mysql.example.internal/db"]]) {
    test(`migration-invalid-url-${name}`, () => render(chart, [...created, "--set-string", `secret.values.databaseUrl=${value}`], "mysql:// TCP URL"));
  }
  test("migration-invalid-tcp-port", () => render(chart, [...created, "--set-string", "secret.values.databaseUrl=mysql://fixture:do-not-disclose@mysql.example.internal:65536/db"], "migration TCP host and port"));
  test("planetscale-placeholder-is-not-migration-config", () => render(chart, [...migrationOnly, "--set", "config.databaseMode=planetscale"], "explicit migration TCP URL"));
  test("migration-missing-url-secret-key", () => render(chart, [...migrationOnly, "--set", "config.databaseMode=planetscale", "--set", "secret.create=false", "--set", "secret.existingSecret=migration-secret", "--set-string", "secret.keys.databaseUrl="], "secret.keys.databaseUrl is required"));
  test("disabled-migrations-do-not-require-tcp-url", () => {
    const output = render(chart, ["--set", "migrations.enabled=false", "--set-string", "secret.values.databaseUrl=", "--set", "config.databaseMode=planetscale"]);
    assert.ok(!output.includes("name: openwork-ee-migrate"));
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`Upgrade/bootstrap matrix: ${passed} passed, ${failed} failed, 0 skipped`);
process.exitCode = failed === 0 ? 0 : 1;
