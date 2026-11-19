import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import type { JsonObject } from "@openwork-ee/utils/observability";
import { setStructuredLogSink } from "../../../observability/runtime-logger";
import { createErrorReferenceCapture } from "./error-reference-capture";
import { proxyUpstream } from "./upstream-proxy";

const referenceId = "req_01h2xcejqtf2nbrexx3vqjhp41";
const encoder = new TextEncoder();

test("reference capture is bounded and never accepts arbitrary error details", () => {
  for (const body of ["not-json", JSON.stringify({ referenceId: "private@example.test" }), JSON.stringify({ referenceId, message: "x".repeat(8192) })]) {
    const capture = createErrorReferenceCapture();
    capture.append(encoder.encode(body));
    assert.equal(capture.referenceId(), undefined);
  }
  const capture = createErrorReferenceCapture();
  const text = JSON.stringify({ message: "é", referenceId });
  for (const byte of encoder.encode(text)) capture.append(new Uint8Array([byte]));
  assert.equal(capture.referenceId(), referenceId);
});

test("the existing proxy completion log records Den's reference while forwarding unchanged error bytes", async (t) => {
  const previous = process.env.DEN_API_BASE;
  process.env.DEN_API_BASE = "https://api.example.test";
  const logs: Array<{ message: string; fields?: JsonObject }> = [];
  setStructuredLogSink({ log(_level, message, fields) { logs.push({ message, fields }); } });
  t.after(() => {
    if (previous === undefined) delete process.env.DEN_API_BASE;
    else process.env.DEN_API_BASE = previous;
    setStructuredLogSink({ log() {} });
  });
  const body = JSON.stringify({ error: "unauthorized", referenceId, message: "private error details" });
  t.mock.method(globalThis, "fetch", async () => {
    const chunks = [body.slice(0, 20), body.slice(20)];
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }), { status: 401, headers: { "content-type": "application/json", "x-request-id": "internal" } });
  });
  const request = new NextRequest("https://dashboard.example.test/api/den/v1/me");
  const response = await proxyUpstream(request, ["v1", "me"], { routePrefix: "/api/den" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-request-id"), null);
  assert.equal(await response.text(), body);
  const completed = logs.filter((entry) => entry.message === "den-web upstream proxy completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.fields?.reference_id, referenceId);
  assert.ok(!JSON.stringify(logs).includes("private error details"));
  logs.length = 0;
  const scim = await proxyUpstream(new NextRequest("https://dashboard.example.test/api/auth/scim/v2/Users"), ["scim", "v2", "Users"], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });
  assert.equal(await scim.text(), body);
  assert.equal(logs.find((entry) => entry.message === "den-web upstream proxy completed")?.fields?.reference_id, undefined);
});
