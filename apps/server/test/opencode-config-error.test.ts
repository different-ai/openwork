import { expect, test } from "bun:test";
import { opencodeConfigApiError } from "../src/opencode-config-error.js";
import { unwrapOpencodeResult } from "../src/server.js";
import { ApiError } from "../src/errors.js";

// Bodies captured from the bundled OpenCode 1.18 engine for a folder whose
// opencode.json uses a v2 `reasoning` object, and one that is not valid JSON.
const invalid = {
  name: "ConfigInvalidError",
  data: {
    path: "/work/acme/opencode.json",
    issues: [{
      path: ["provider", "anthropic", "models", "x", "reasoning"],
      message: "Expected boolean | undefined, got {\"supported\":true,\"effort\":[\"low\",\"high\"]}",
    }],
  },
};
const malformed = {
  name: "ConfigJsonError",
  data: {
    path: "/work/acme/opencode.json",
    message: "\n--- JSONC Input ---\n{\"provider\": {\n\n--- Errors ---\nCloseBraceExpected at line 2, column 1\nCloseBraceExpected at line 2, column 1\n--- End ---",
  },
};

test("an invalid setting names the file and the field", () => {
  const error = opencodeConfigApiError(invalid, "/session/ses_1");
  expect(error?.status).toBe(400);
  expect(error?.code).toBe("opencode_config_invalid");
  expect(error?.message).toBe(
    "OpenCode can't use the config file /work/acme/opencode.json: provider.anthropic.models.x.reasoning: Expected boolean | undefined, got {\"supported\":true,\"effort\":[\"low\",\"high\"]}. Fix or remove that setting, then try again.",
  );
});

test("a file that is not JSON lists the parse errors, not the whole file", () => {
  expect(opencodeConfigApiError(malformed, "/session")?.message).toBe(
    "OpenCode can't use the config file /work/acme/opencode.json: CloseBraceExpected at line 2, column 1. Fix or remove that setting, then try again.",
  );
});

test("engine requests failing on the config are a clear 400, not a generic 502", () => {
  const failed = { data: undefined, error: invalid, request: new Request("http://engine/session"), response: new Response(null, { status: 400 }) };
  let thrown: unknown;
  try { unwrapOpencodeResult(failed, "/session"); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ApiError);
  expect(thrown instanceof ApiError ? [thrown.status, thrown.code] : null).toEqual([400, "opencode_config_invalid"]);

  const other = { ...failed, error: { name: "UnknownError", data: { message: "boom" } } };
  try { unwrapOpencodeResult(other, "/session"); } catch (error) { thrown = error; }
  expect(thrown instanceof ApiError ? [thrown.status, thrown.code] : null).toEqual([502, "opencode_request_failed"]);
});
