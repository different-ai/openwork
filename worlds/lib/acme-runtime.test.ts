import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertAcmeMcpOrigins, acmeRuntimeFixture, acmeProcessEnvironment } from "./acme-runtime.ts";

const den = "http://127.0.0.1:40123";
const config = (url: string) => ({ mcp: { "openwork-cloud": { type: "remote", url, enabled: true } } });
test("seeded Acme MCP refuses hosted or foreign connections, including disabled ones", () => {
  assert.doesNotThrow(() => assertAcmeMcpOrigins(config(`${den}/mcp/agent`), den));
  for (const url of ["https://api.openworklabs.com/mcp/agent", "http://127.0.0.1:40124/mcp/agent", `${den}/other`, `${den}/mcp/agent?token=fixture`]) {
    assert.throws(() => assertAcmeMcpOrigins(config(url), den));
  }
  assert.throws(() => assertAcmeMcpOrigins({ mcp: { ...config(`${den}/mcp/agent`).mcp, stale: { type: "remote", url: "https://example.test/mcp", enabled: false } } }, den));
  assert.throws(() => assertAcmeMcpOrigins({ mcp: {} }, den));
});
test("Den and build child environments discard ambient secrets and injection hooks", () => {
  const env = acmeProcessEnvironment({ OPENWORK_WORLD_UNEXPECTED_SECRET: "sentinel", OPENAI_API_KEY: "sentinel", AWS_SECRET_ACCESS_KEY: "sentinel", NODE_OPTIONS: "--import=private-plugin", OPENCODE_CONFIG_CONTENT: "sentinel", OPENWORK_EVAL_MYSQL_URL: "mysql://fixture", OPENWORK_WORLD_STAGE: "test" }, { HOME: "/owned/home", PATH: "/owned/bin" });
  assert.deepEqual(env, { OPENWORK_EVAL_MYSQL_URL: "mysql://fixture", OPENWORK_WORLD_STAGE: "test", HOME: "/owned/home", PATH: "/owned/bin" });
  const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"], { env, encoding: "utf8" });
  assert.equal(child.status, 0);
  // CoreFoundation adds this locale hint on macOS independently of spawn's env.
  assert.deepEqual(JSON.parse(child.stdout).filter((key: string) => key !== "__CF_USER_TEXT_ENCODING"), Object.keys(env).sort());
});
test("seeded runtime workspace and credentials are outside the checkout and developer home", async () => {
  await using stack = new AsyncDisposableStack();
  const fixture = await acmeRuntimeFixture(stack);
  assert.equal(fixture.workspace, await realpath(fixture.workspace));
  assert.equal(fixture.workspace.startsWith(process.cwd()), false);
  assert.notEqual(fixture.env.HOME, process.env.HOME);
  assert.equal(fixture.env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.env.OPENCODE_CONFIG, undefined);
  assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(fixture.env.OPENWORK_TOKEN, undefined);
  assert.ok(fixture.env.OPENCODE_CONFIG_DIR?.includes("config/opencode"));
});
