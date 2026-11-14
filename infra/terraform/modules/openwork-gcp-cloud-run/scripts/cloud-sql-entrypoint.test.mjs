import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Test the exact inline deployment entrypoint, not a second implementation.
const terraform = readFileSync(new URL("../ai-gateway.tf", import.meta.url), "utf8");
const script = terraform.match(/ai_gateway_entrypoint = <<-JS\n([\s\S]*?)^\s*JS$/m)?.[1];
assert.ok(script, "Terraform entrypoint heredoc must exist");
const root = new URL("../../../../../", import.meta.url);
const validation = new URL("ee/packages/utils/src/gateway-env.ts", root).href;
const mysql = new URL("ee/packages/den-db/src/mysql-config.ts", root).href;

// A harmless data module inspects the environment exactly where the real server
// would import. No database driver, account, credential store or network is used.
function run(databaseUrl, expected) {
  const verify = `
    import assert from 'node:assert/strict';
    import { parseGatewayDeploymentEnv } from ${JSON.stringify(validation)};
    import { parseMySqlConnectionConfig } from ${JSON.stringify(mysql)};
    const original = ${JSON.stringify(databaseUrl)};
    const current = process.env.DATABASE_URL;
    assert.equal(new URL(current).hostname, ${JSON.stringify(expected)});
    const before = parseMySqlConnectionConfig(original);
    const after = parseMySqlConnectionConfig(current);
    assert.deepEqual({...before, host: after.host}, after);
    assert.equal(parseGatewayDeploymentEnv(process.env).enabled, true);
    console.log('validated enabled Gateway; credentials/socket/TLS unchanged');
  `;
  // The entrypoint intentionally imports a filesystem path in deployed images.
  // Replace just that final import for a zero-network test module.
  const isolated = script.replace('await import(pathToFileURL(process.argv[1]).href);', `await import(${JSON.stringify("data:text/javascript," + encodeURIComponent(verify))});`);
  return spawnSync(process.execPath, ["--input-type=module", "-e", isolated], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "https://models.example.com", GATEWAY_PUBLIC_BASE_URL: "https://models.example.com", DB_MODE: "mysql", DATABASE_URL: databaseUrl, DEN_DB_ENCRYPTION_KEY: "synthetic-encryption-key-0123456789abcdef" },
    encoding: "utf8",
  });
}

test("Cloud SQL URL passes production Gateway validation without changing credentials or socket", () => {
  const result = run("mysql://app:p%40ss@localhost/openwork_den?socket=%2Fcloudsql%2Ftest-project%3Aus-central1%3Aden", "cloudsql");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credentials\/socket\/TLS unchanged/);
});
test("external verified-TLS database URL is unchanged", () => {
  const result = run("mysql://app:fixture@db.example.com/openwork_den?sslaccept=strict", "db.example.com");
  assert.equal(result.status, 0, result.stderr);
});
test("localhost TCP URL still fails production validation", () => {
  const result = run("mysql://app:fixture@localhost/openwork_den?sslaccept=strict", "localhost");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production must not use localhost/);
});
test("non-Cloud-SQL socket does not bypass localhost validation", () => {
  const result = run("mysql://app:fixture@localhost/openwork_den?socket=%2Ftmp%2Fmysql.sock", "localhost");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production must not use localhost/);
});
