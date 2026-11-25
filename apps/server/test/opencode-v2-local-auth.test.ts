import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { localProviderDefinitions, type LocalProviderAuth } from "../src/opencode-v2-local-auth.js";

const KEY = "sk-local-test-key";
const PASSWORD = "fixture-password";
const engine = createServer((request, response) => {
  assert.equal(request.url, "/provider");
  assert.equal(request.headers.authorization, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`);
  response.writeHead(503).end();
});
let engineUrl = "";
const connection = () => ({ opencodeBaseUrl: engineUrl, opencodeUsername: "opencode", opencodePassword: PASSWORD });
const auth = (): LocalProviderAuth => ({
  apiKeys: new Map([["self-hosted", KEY], ["groq", "gsk-local-test-key"]]),
  signIns: new Set(["openai"]),
});
const native = new Map([["groq", { name: "Groq", env: ["GROQ_API_KEY"] }]]);

before(async () => {
  await new Promise<void>(resolve => engine.listen(0, "127.0.0.1", resolve));
  const address = engine.address();
  if (!address || typeof address === "string") throw new Error("fixture engine did not bind");
  engineUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>(resolve => engine.close(() => resolve()));
});

test("an engine that cannot describe one provider costs only that provider", async () => {
  const failures: string[] = [];
  const result = await localProviderDefinitions(connection(), auth(), {}, {
    native,
    environment: {},
    onCatalogError: error => { failures.push(error.message); },
  });

  assert.deepEqual(result.providers, {});
  assert.deepEqual(result.native, [{ id: "groq", name: "Groq", apiKey: "gsk-local-test-key" }], "a catalog provider needs no v1 metadata");
  assert.deepEqual(result.skipped, [{ id: "openai", reason: "oauth" }, { id: "self-hosted", reason: "metadata" }]);
  assert.deepEqual(failures, ["Could not read locally connected provider metadata"]);
  assert.equal(JSON.stringify([failures, result.skipped]).includes(KEY), false);
});

test("local metadata failures still reject when no error callback is provided", async () => {
  await assert.rejects(
    localProviderDefinitions(connection(), auth(), {}, { native, environment: {} }),
    { message: "Could not read locally connected provider metadata" },
  );
});
