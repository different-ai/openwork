import assert from "node:assert/strict";
import test from "node:test";
import { deriveMockEnv } from "../src/mock.ts";
import { checkNeeds, needs, SkipError } from "../src/needs.ts";
import { ephemeralDatabaseName, resolvePlace } from "../src/place.ts";
import { trustedOrigins } from "../src/server.ts";

test("resolvePlace selects local unless OPENWORK_EVAL_DAYTONA is exactly 1", () => {
  const local = resolvePlace({});
  const falseyDaytona = resolvePlace({ OPENWORK_EVAL_DAYTONA: "0" });
  const daytona = resolvePlace({ OPENWORK_EVAL_DAYTONA: "1", OPENWORK_EVAL_REF: "feature-ref" });
  assert.equal(local.kind, "local");
  assert.equal(falseyDaytona.kind, "local");
  assert.equal(daytona.kind, "daytona");
  assert.deepEqual(daytona.denBase(), { kind: "daytona", ref: "feature-ref" });
});

test("needs accepts a tool-capable model and provider key", () => {
  assert.doesNotThrow(() => checkNeeds(
    { model: "tool-capable", env: ["EXTRA_REQUIRED"] },
    {
      OPENWORK_EVAL_MODEL: "openai/gpt-5",
      OPENAI_API_KEY: "test-key",
      EXTRA_REQUIRED: "1",
    },
  ));
});

test("needs throws a named SkipError for every unsatisfied resource", () => {
  assert.throws(
    () => checkNeeds({ model: "tool-capable", env: ["EXTRA_REQUIRED"], optIn: ["EXACT_OPT_IN"], daytona: true }, {}),
    (error) => {
      assert(error instanceof SkipError);
      assert.match(error.message, /^needs: /);
      assert.match(error.message, /set EXTRA_REQUIRED/);
      assert.match(error.message, /set EXACT_OPT_IN=1/);
      assert.match(error.message, /set OPENWORK_EVAL_MODEL/);
      assert.match(error.message, /set OPENAI_API_KEY or ANTHROPIC_API_KEY/);
      assert.match(error.message, /set OPENWORK_EVAL_DAYTONA=1/);
      return true;
    },
  );
});

test("needs only accepts opt-in gates set exactly to 1", () => {
  assert.throws(() => checkNeeds({ optIn: ["EXACT_OPT_IN"] }, { EXACT_OPT_IN: "true" }), SkipError);
  assert.doesNotThrow(() => checkNeeds({ optIn: ["EXACT_OPT_IN"] }, { EXACT_OPT_IN: "1" }));
});

test("needs reads process.env at the call site", () => {
  const name = "OPENWORK_TESTKIT_UNIT_RESOURCE";
  const previous = process.env[name];
  try {
    delete process.env[name];
    assert.throws(() => needs({ env: [name] }), SkipError);
    process.env[name] = "available";
    assert.deepEqual(needs({ env: [name] }), {});
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("mcp mock environment is derived from the resource name and public URLs", () => {
  assert.deepEqual(
    deriveMockEnv("acme tickets", "https://mock.example.test", "https://mock.example.test/mcp"),
    {
      OPENWORK_EVAL_MOCK_ACME_TICKETS_URL: "https://mock.example.test",
      OPENWORK_EVAL_MOCK_ACME_TICKETS_MCP_URL: "https://mock.example.test/mcp",
    },
  );
});

test("trusted origins contain both Den ports in localhost and loopback forms", () => {
  assert.deepEqual(trustedOrigins(8788, 3005), [
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:3005",
    "http://127.0.0.1:3005",
  ]);
});

test("ephemeral database names are valid and unique", () => {
  const names = new Set(Array.from({ length: 100 }, () => ephemeralDatabaseName()));
  assert.equal(names.size, 100);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]{0,62}$/);
});
