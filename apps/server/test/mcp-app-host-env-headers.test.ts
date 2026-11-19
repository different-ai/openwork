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
