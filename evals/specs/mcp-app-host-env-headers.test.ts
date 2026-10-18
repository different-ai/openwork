import { expect, test } from "vitest";
import { expandEnvInHeaders, expandEnvTemplates } from "../../apps/server/src/mcp-app-host.ts";

test("expandEnvTemplates matches OpenCode: set var", () => {
  expect(expandEnvTemplates("Bearer {env:MY_API_KEY}", { MY_API_KEY: "secret-from-env" })).toBe(
    "Bearer secret-from-env",
  );
});

test("expandEnvTemplates matches OpenCode: missing var becomes empty", () => {
  expect(expandEnvTemplates("Bearer {env:MISSING_KEY}", {})).toBe("Bearer ");
});

test("expandEnvInHeaders expands all string headers", () => {
  expect(
    expandEnvInHeaders(
      { "x-api-key": "Bearer {env:MY_API_KEY}", "x-plain": "nope" },
      { MY_API_KEY: "secret-from-env" },
    ),
  ).toEqual({ "x-api-key": "Bearer secret-from-env", "x-plain": "nope" });
});
