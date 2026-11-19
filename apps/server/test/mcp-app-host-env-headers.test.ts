import assert from "node:assert/strict";
import { test } from "node:test";
import { expandEnvInHeaders, expandEnvTemplates } from "../src/mcp-app-host.js";

test("expandEnvTemplates matches OpenCode: set var", () => {
  assert.equal(expandEnvTemplates("Bearer {env:MY_API_KEY}", { MY_API_KEY: "secret-from-env" }), "Bearer secret-from-env");
});

test("expandEnvTemplates matches OpenCode: missing var becomes empty", () => {
  assert.equal(expandEnvTemplates("Bearer {env:MISSING_KEY}", {}), "Bearer ");
});

test("expandEnvInHeaders expands all string headers", () => {
  assert.deepEqual(
    expandEnvInHeaders(
      { "x-api-key": "Bearer {env:MY_API_KEY}", "x-plain": "nope" },
      { MY_API_KEY: "secret-from-env" },
    ),
    { "x-api-key": "Bearer secret-from-env", "x-plain": "nope" },
  );
});

test("expandEnvTemplates never sends the server-only encryption key, under any spelling", () => {
  const env = { OPENWORK_ENCRYPTION_KEY: "server-secret", openwork_encryption_key: "server-secret", MY_API_KEY: "ok" };
  assert.equal(expandEnvTemplates("{env:OPENWORK_ENCRYPTION_KEY}", env), "");
  assert.equal(expandEnvTemplates("{env:openwork_encryption_key}", env), "");
  assert.deepEqual(
    expandEnvInHeaders({ authorization: "Bearer {env:MY_API_KEY}", "x-key": "{env:OPENWORK_ENCRYPTION_KEY}" }, env),
    { authorization: "Bearer ok", "x-key": "" },
  );
});
