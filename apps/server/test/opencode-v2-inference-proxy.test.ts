import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";
import { createProviderSecretRedactor } from "../src/opencode-v2-inference-proxy.js";

const den = { baseUrl: "https://den.example.invalid", token: "host-only-den-inference-secret", orgId: "org_inference" };
const gatewayKey = "ow_gw_host_only_reusable_gateway_key";
const providerId = "ipr_fixture";
const gatewayBase = `https://gateway.example.invalid/api/v1/providers/${providerId}`;
const connected = () => Response.json({ inferenceProvider: { id: providerId, apiKey: gatewayKey, providerConfig: { options: { baseURL: gatewayBase } } } });

test("HTTP inference resolves raw Gateway auth server-side, translating native protocol keys and preserving semantic data/quota markers", async () => {
  let connects = 0;
  let inferences = 0;
  const bridge = await createV2ProviderSessionBridge(() => den, { fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    if (url.startsWith(den.baseUrl)) {
      connects++;
      assert.equal(url, `${den.baseUrl}/v1/inference-providers/${providerId}/connect`);
      assert.equal(headers.get("authorization"), `Bearer ${den.token}`);
      return connected();
    }
    inferences++;
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(url.startsWith(gatewayBase + "/"));
    assert.ok(!url.includes("key="));
    assert.equal(headers.get("authorization"), `Bearer ${gatewayKey}`);
    for (const name of ["host", "cookie", "x-api-key", "api-key", "x-goog-api-key", "x-openwork-org-id", "x-openwork-legacy-org-id"]) assert.equal(headers.get(name), null, name);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("x-openwork-gateway-request-model"), "gwm_fixture");
    assert.equal(Buffer.from(init?.body instanceof Uint8Array ? init.body : []).toString(), '{"model":"gwm_fixture","stream":true}');
    return new Response(new ReadableStream({ start(output) {
      const text = JSON.stringify({ error: { source: "openwork_gateway", code: "openwork_gateway_usage_limit_exceeded", type: "usage_limit_error", message: "You have reached your AI Gateway usage limit." }, denEcho: den.token, gatewayEcho: gatewayKey });
      for (let i = 0; i < text.length; i += 3) output.enqueue(new TextEncoder().encode(text.slice(i, i + 3)));
      output.close();
    } }), { status: 429, headers: { "content-type": "application/json", "x-openwork-error-code": "openwork_gateway_usage_limit_exceeded", "x-openwork-usage-state": "blocked", "retry-after": "123", "x-should-retry": "false", "set-cookie": "inference_probe=present; HttpOnly; Secure; SameSite=Strict", location: gatewayKey, "x-raw-key": gatewayKey } });
  } });
  try {
    const metadata = await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json();
    assert.match(metadata.inferenceKey, /^ow_local_[a-f0-9]{64}$/);
    const protocols = [
      ["chat/completions", "authorization"], ["v1/chat/completions", "authorization"], ["responses", "api-key"], ["v1/responses", "authorization"],
      ["messages", "x-api-key"], ["v1/messages", "x-api-key"], ["models/gemini-fixture:generateContent", "x-goog-api-key"],
      ["v1beta/models/gemini-fixture:streamGenerateContent", "query"], ["v1/models/gemini-fixture:generateContent", "query"],
    ];
    for (const [path, auth] of protocols) {
      const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-openwork-gateway-request-model": "gwm_fixture", cookie: "untrusted-client-cookie", "x-openwork-org-id": "org_evil" };
      if (auth !== "query") headers[auth] = auth === "authorization" ? `Bearer ${metadata.inferenceKey}` : metadata.inferenceKey;
      const query = auth === "query" ? `?key=${metadata.inferenceKey}&alt=sse` : "";
      const response = await fetch(`${metadata.inferenceOrigin}/api/v1/providers/${providerId}/${path}${query}`, { method: "POST", headers, body: '{"model":"gwm_fixture","stream":true}' });
      assert.equal(response.status, 429, path);
      assert.equal(response.headers.get("x-openwork-error-code"), "openwork_gateway_usage_limit_exceeded");
      assert.equal(response.headers.get("x-openwork-usage-state"), "blocked");
      assert.equal(response.headers.get("retry-after"), "123");
      assert.equal(response.headers.get("x-should-retry"), "false");
      for (const name of ["set-cookie", "location", "x-raw-key"]) assert.equal(response.headers.get(name), null);
      const body = await response.text();
      assert.ok(!body.includes(den.token));
      assert.ok(!body.includes(gatewayKey));
      assert.equal(JSON.parse(body).error.message, "You have reached your AI Gateway usage limit.");
    }
    assert.equal(inferences, protocols.length);
    assert.equal(connects, protocols.length, "no raw Gateway credential/provider-state cache between requests");
  } finally { await bridge.close(); }
});

test("identity-bound ephemeral keys expire on account replacement/bridge close; a new bridge key can infer without a catalog refresh", async () => {
  let session = den;
  let inference = 0;
  const fetcher = async (url: string) => url.startsWith(den.baseUrl) ? connected() : (inference++, Response.json({ text: "approved" }));
  const one = await createV2ProviderSessionBridge(() => session, { fetch: fetcher });
  const two = await createV2ProviderSessionBridge(() => session, { fetch: fetcher });
  const read = async (bridge: typeof one) => (await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json());
  const post = (metadata: { inferenceOrigin: string; inferenceKey: string }, path = "chat/completions") => fetch(`${metadata.inferenceOrigin}/api/v1/providers/${providerId}/${path}`, { method: "POST", headers: { authorization: `Bearer ${metadata.inferenceKey}` }, body: "{}" });
  try {
    const before = await read(one);
    const warm = await read(two);
    assert.equal(before.identity, warm.identity);
    assert.notEqual(before.inferenceKey, warm.inferenceKey);
    assert.notEqual(before.inferenceOrigin, warm.inferenceOrigin);
    assert.equal((await post(warm)).status, 200, "portable catalog needs only newly rebound proxy auth");
    assert.equal((await post({ ...warm, inferenceKey: before.inferenceKey })).status, 401);
    for (const path of ["admin", "models", "models/gemini/delete", "files", "v1/mcp/token", "messages/batches", "responses/some-id/cancel"]) assert.equal((await post(warm, path)).status, 404, path);
    session = { ...den, token: "new-account-den-token", orgId: "org_new" };
    assert.equal((await post(before)).status, 401, "old key cannot acquire the new identity's Gateway credential");
    assert.equal((await post(warm)).status, 401);
    assert.equal(inference, 1);
    const after = await read(one);
    assert.notEqual(after.inferenceKey, before.inferenceKey);
    assert.equal((await post(after)).status, 200);
    await one.close();
    await assert.rejects(() => post(after));
  } finally { await one.close(); await two.close(); }
});

test("inference identity is fenced after the awaited per-request connect", async () => {
  let session = den;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let inference = 0;
  const bridge = await createV2ProviderSessionBridge(() => session, { fetch: async (url) => {
    if (url.startsWith(den.baseUrl)) { entered?.(); await blocked; return connected(); }
    inference++; return Response.json({ text: "must not run" });
  } });
  try {
    const metadata = await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json();
    const pending = fetch(`${metadata.inferenceOrigin}/api/v1/providers/${providerId}/responses`, { method: "POST", headers: { authorization: `Bearer ${metadata.inferenceKey}` }, body: "{}" });
    await ready;
    session = { ...den, token: "new-account-den-token", orgId: "org_new" };
    release?.();
    assert.equal((await pending).status, 409);
    assert.equal(inference, 0);
  } finally { await bridge.close(); }
});

test("stream redaction spans arbitrary chunk boundaries without holding ordinary SSE heartbeats", () => {
  const redact = createProviderSecretRedactor([gatewayKey, den.token]);
  assert.equal(redact(": heartbeat\n\n"), ": heartbeat\n\n");
  assert.equal(redact("data: hello\n\n"), "data: hello\n\n");
  assert.equal(redact("before " + gatewayKey.slice(0, 7)), "before ");
  assert.equal(redact(gatewayKey.slice(7) + " after\n\n"), "[redacted] after\n\n");
  let result = "";
  for (const character of den.token) result += redact(character);
  result += redact("", true);
  assert.equal(result, "[redacted]");
});
