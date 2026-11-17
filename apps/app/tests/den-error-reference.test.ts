import assert from "node:assert/strict";
import { test } from "node:test";
import { denErrorReferenceId } from "@openwork/types/den/error-reference";
import { connectionDiagnosticHistory, createConnectionDiagnosticHistory } from "../src/app/lib/connection-diagnostic-history";
import { observeDenRequest } from "../src/app/lib/den-request-diagnostics";

const referenceId = "req_01h2xcejqtf2nbrexx3vqjhp41";
const secondReference = "req_01h2xcejqtf2nbrexx3vqjhp42";

test("Den reference extraction accepts only opaque server request ids", () => {
  assert.equal(denErrorReferenceId({ referenceId }), referenceId);
  for (const payload of [null, {}, { referenceId: "client-id" }, { referenceId: "person@example.test" }, { referenceId: `${referenceId}\n` }]) {
    assert.equal(denErrorReferenceId(payload), undefined);
  }
});

test("existing diagnostics keep distinct request references instead of coalescing them away", () => {
  const history = createConnectionDiagnosticHistory(() => 100);
  for (const reference of [referenceId, secondReference]) {
    history.record("den_request_http_failure", "failure", { httpStatus: 500, referenceId: reference });
  }
  assert.deepEqual(history.read().recent.map((entry) => entry.referenceId), [referenceId, secondReference]);
  const exported = JSON.stringify(history.read());
  assert.ok(exported.includes(referenceId));
  assert.ok(exported.includes(secondReference));
  history.record("den_request_http_failure", "failure", { httpStatus: 500, referenceId: "secret" });
  assert.equal(history.read().recent.at(-1)?.referenceId, undefined);
});

test("the desktop Den client retains the reference on errors and in exported history", async (t) => {
  const { createDenClient, DenApiError } = await import("../src/app/lib/den");
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable", message: "Try again", referenceId }, { status: 503 }));
  const client = createDenClient({ baseUrl: "https://api.example.test", apiBaseUrl: "https://api.example.test" });
  await assert.rejects(client.getSession(), (error: unknown) => error instanceof DenApiError && error.referenceId === referenceId && error.message === "Try again");
  assert.equal(connectionDiagnosticHistory.read().recent.at(-1)?.referenceId, referenceId);
});

test("failed Den responses add their reference to existing connection history", async () => {
  const response = { ok: false, status: 401, referenceId };
  assert.equal(await observeDenRequest(async () => response), response);
  assert.equal(connectionDiagnosticHistory.read().recent.at(-1)?.referenceId, referenceId);
});
