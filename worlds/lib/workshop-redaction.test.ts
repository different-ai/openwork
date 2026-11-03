import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { redactWorkshopDiagnostic } from "./workshop-redaction.ts";

test("unknown session credentials are removed before registration, including nested JSON", () => {
  const fields = ["token", "access_token", "password", "authorization", "cookie"];
  for (const field of fields) {
    for (const key of [field, field.toUpperCase()]) {
      const value = `unregistered-${field}`;
      const input = JSON.stringify({ user: { [key]: value }, status: 502 });
      const output = redactWorkshopDiagnostic(input, []);
      assert.ok(!output.includes(value));
      assert.equal(JSON.parse(output).status, 502);
    }
  }
});

test("truncated and escaped JSON credential previews do not leak", () => {
  for (const input of ['{"token":"unknown-prefix', '{"password":"unknown\\"suffix"}', '{"access_token":unknown-prefix']) {
    assert.ok(!redactWorkshopDiagnostic(input, []).includes("unknown"));
  }
});

test("registered secrets, bearer credentials and private URLs remain protected", () => {
  const output = redactWorkshopDiagnostic('known-password Bearer unseen-bearer https://private.invalid/path', ["known-password"]);
  assert.equal(output, "[secret] Bearer [secret] [private URL]");
});

test("bare signed preview hostnames in UI dumps are also capabilities, not public diagnostics", () => {
  assert.equal(redactWorkshopDiagnostic("Account 3005-example-cap.daytonaproxy01.net", []), "Account [private host]");
  const json = redactWorkshopDiagnostic(JSON.stringify({ body: "Attendee\n3005-example-cap.daytonaproxy01.net" }), []);
  assert.equal(JSON.parse(json).body, "Attendee\n[private host]");
});

test("account provisioning and sign-in errors do not interpolate authentication response bodies", async () => {
  const env = await readFile(new URL("../../evals/packages/env/src/den.ts", import.meta.url), "utf8");
  const behavior = await readFile(new URL("../../evals/packages/behaviors/src/den.ts", import.meta.url), "utf8");
  assert.ok(!env.includes("signUp.text.slice"));
  assert.ok(!behavior.includes("Sign-in failed for ${credentials.email}: HTTP ${result.response.status} ${preview(result.body)}"));
});
