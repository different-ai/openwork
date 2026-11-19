import assert from "node:assert/strict";
import { test } from "node:test";
import { getRequestError, ReauthRequiredError, SsoSessionRequiredError } from "./den-flow";

const referenceId = "req_01h2xcejqtf2nbrexx3vqjhp41";

test("Den errors retain references in logged details without changing visible messages or recovery types", () => {
  for (const [status, payload, expectedType] of [
    [500, { error: "internal_server_error", message: "Request failed", referenceId }, Error],
    [403, { error: "reauth", message: "Request failed", referenceId }, ReauthRequiredError],
    [409, { error: "sso_session_required", message: "Request failed", signInPath: "/sso/example", referenceId }, SsoSessionRequiredError],
  ] satisfies Array<[number, Record<string, unknown>, typeof Error | typeof ReauthRequiredError | typeof SsoSessionRequiredError]>) {
    const error = getRequestError(payload, new Response(null, { status }), "Fallback");
    assert.ok(error instanceof expectedType);
    assert.equal(error.message, "Request failed");
    assert.equal(error.referenceId, referenceId);
    assert.ok(JSON.stringify(error).includes(referenceId));
  }
  assert.equal(getRequestError({ referenceId: "not-a-server-reference" }, new Response(null, { status: 500 }), "Fallback").referenceId, undefined);
});
