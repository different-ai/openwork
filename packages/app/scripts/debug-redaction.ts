import assert from "node:assert/strict";

import { redactHeaders, redactRecord, sanitizePayload } from "../src/app/lib/debug-log";

const redacted = redactRecord({
  apiKey: "secret-123",
  token: "abc",
  nested: {
    password: "p@ss",
    safe: "ok",
  },
});

assert.equal(typeof redacted.apiKey, "object");
assert.equal((redacted.apiKey as { redacted?: boolean }).redacted, true);
assert.equal((redacted.token as { redacted?: boolean }).redacted, true);
assert.equal((redacted.nested as any).password.redacted, true);
assert.equal((redacted.nested as any).safe, "ok");

const headers = redactHeaders({
  Authorization: "Bearer secret-token",
  Cookie: "session=abc",
  "X-Custom": "value",
});

assert.equal((headers?.Authorization as { redacted?: boolean }).redacted, true);
assert.equal((headers?.Cookie as { redacted?: boolean }).redacted, true);
assert.equal(headers?.["X-Custom"], "value");

const payload = sanitizePayload({
  prompt: "hello",
  clientSecret: "super-secret",
});
assert.equal((payload?.clientSecret as { redacted?: boolean }).redacted, true);

console.log(JSON.stringify({ ok: true }));
