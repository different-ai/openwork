import assert from "node:assert/strict";
import { test } from "node:test";
import { DISCOVERY_STREAM_ERROR, readDiscoveryStream, type DiscoveryCheck } from "./connector-discovery-stream";

const result = {
  status: "ready",
  server: { url: "https://mcp.example.test/mcp", initialize: "authentication_required" },
  authentication: {
    kind: "oauth", authorizationServers: [{ issuer: "https://auth.example.test", clientIdMetadataDocumentSupported: true }],
    requiredScopes: [], recommendedScopes: [], refreshSupport: "unknown", availableRegistrationMethods: ["client_metadata"], recommendedRegistrationMethod: "client_metadata",
  },
  tools: { visibility: "requires_auth" }, manualRequirements: [], warnings: [],
};
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { parts.forEach((part) => controller.enqueue(new TextEncoder().encode(part))); controller.close(); } });
}

test("a real check reaches the caller while the final response is still held", async () => {
  let push: (part: string) => void = () => { throw new Error("not initialized"); };
  let close: () => void = () => { throw new Error("not initialized"); };
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    push = (part) => controller.enqueue(new TextEncoder().encode(part)); close = () => controller.close();
  } });
  let received = () => {};
  const firstCheck = new Promise<void>((resolve) => { received = resolve; });
  const checks: DiscoveryCheck[] = [];
  let finished = false;
  const reading = readDiscoveryStream(body, (check) => { checks.push(check); received(); }).then((value) => { finished = true; return value; });
  push(event("check", { id: "server", status: "passed", httpStatus: 401, code: "authentication_required" }));
  await firstCheck;
  assert.equal(finished, false);
  assert.equal(checks[0]?.httpStatus, 401);
  push(event("result", result)); close();
  assert.deepEqual(await reading, result);
});

test("chunked CRLF events, comments and multibyte results are decoded without inventing phases", async () => {
  const check = { id: "provider", status: "failed", httpStatus: 200, code: "issuer_mismatch" };
  const text = `: keepalive\r\n\r\n${event("check", check).replaceAll("\n", "\r\n")}${event("result", { ...result, warnings: [{ code: "sample", message: "Café" }] }).replaceAll("\n", "\r\n")}`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const checks: DiscoveryCheck[] = [];
  const parsed = await readDiscoveryStream(body, (value) => checks.push(value));
  assert.deepEqual(checks, [check]);
  assert.equal(parsed.warnings[0]?.message, "Café");
});

test("an anonymous skipped phase stays skipped", async () => {
  const checks: DiscoveryCheck[] = [];
  await readDiscoveryStream(stream([event("check", { id: "provider", status: "skipped", code: "not_required" }), event("result", result)]), (check) => checks.push(check));
  assert.equal(checks[0]?.status, "skipped");
});

test("an error event cannot leak its raw provider message", async () => {
  await assert.rejects(readDiscoveryStream(stream([event("error", { message: "secret-provider-token" })]), () => {}), (error: unknown) => error instanceof Error && error.message === DISCOVERY_STREAM_ERROR);
});

test("malformed or credential-bearing progress and malformed final results fail safely", async () => {
  for (const text of [event("check", { id: "server", status: "passed", token: "secret-provider-token" }), event("check", { id: "invented", status: "passed" }), event("result", { status: "ready" }), "event: check\ndata: not-json\n\n"]) {
    await assert.rejects(readDiscoveryStream(stream([text]), () => {}), { message: DISCOVERY_STREAM_ERROR });
  }
});

test("a disconnected stream does not turn partial receipts into success", async () => {
  const checks: DiscoveryCheck[] = [];
  await assert.rejects(readDiscoveryStream(stream([event("check", { id: "server", status: "passed", httpStatus: 401 })]), (check) => checks.push(check)), { message: DISCOVERY_STREAM_ERROR });
  assert.equal(checks.length, 1);
});

test("aborting a held stream cancels it and delivers no later progress", async () => {
  const controller = new AbortController();
  let canceled = false;
  const checks: DiscoveryCheck[] = [];
  const reading = readDiscoveryStream(new ReadableStream({ cancel() { canceled = true; } }), (check) => checks.push(check), controller.signal);
  controller.abort(new Error("Canceled"));
  await assert.rejects(reading, /Canceled/);
  assert.equal(canceled, true);
  assert.deepEqual(checks, []);
});

test("oversized unfinished events are rejected", async () => {
  await assert.rejects(readDiscoveryStream(stream([`data: ${"x".repeat(1024 * 1024 + 1)}`]), () => {}), { message: DISCOVERY_STREAM_ERROR });
});
