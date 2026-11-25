import assert from "node:assert/strict";
import { test } from "node:test";
import { memberCredentialFailure } from "../src/free-auto/responses.js";

test("Desktop recognizes an ended sandbox and still accepts older Den refusals", () => {
  const response = (reason?: string) => new TextEncoder().encode(JSON.stringify({ error: "free_not_offered", reason }));
  assert.deepEqual(memberCredentialFailure(403, response("free_sandbox_ended")), { status: 403, code: "free_sandbox_ended" });
  assert.deepEqual(memberCredentialFailure(403, response()), { status: 403, code: "free_not_offered" });
  assert.deepEqual(memberCredentialFailure(403, response("unknown")), { status: 403, code: "free_not_offered" });
});
