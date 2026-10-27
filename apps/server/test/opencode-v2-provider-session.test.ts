import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ProviderSessionBridge, providerSessionIdentity } from "../src/opencode-v2-provider-session.js";
import type { CloudProviderDenSession } from "../src/cloud-provider-sync.js";

const original: CloudProviderDenSession = { baseUrl: "https://den.example.invalid/api/den", token: "server-only-den-bearer", orgId: "org_fixture" };
const paths = ["/v1/inference-providers?scope=usable", "/v1/inference-providers/ipr_fixture/connect", "/v1/inference-providers/inventory/events"];

test("a stolen engine capability permits inventory only, never Den sessions, admin, MCP or mutations", async () => {
  let session: CloudProviderDenSession | null = original;
  const upstreams: string[] = [];
  const bridge = await createV2ProviderSessionBridge(() => session, { fetch: async (url, init) => {
    upstreams.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${original.token}`);
    assert.equal(headers.get("x-openwork-org-id"), original.orgId);
    assert.equal(headers.get("x-malicious"), null);
    assert.equal(headers.get("cookie"), null);
    if (url.endsWith("/inventory/events")) return new Response(`: ${original.token}\n\nevent: inventory.changed\ndata: {"token":"${original.token}"}\n\n`, {
      headers: { "content-type": "text/event-stream", "set-cookie": `den=${original.token}`, location: `https://example.invalid/${original.token}`, "x-den-token": original.token },
    });
    return Response.json({ inferenceProviders: [], apiKey: "ow_gw_inventory_only", diagnostic: original.token }, {
      headers: { "set-cookie": `den=${original.token}`, location: `https://example.invalid/${original.token}`, "x-den-token": original.token },
    });
  } });
  const auth = { authorization: `Bearer ${bridge.token}` };
  const endpoint = new URL(bridge.url).origin;
  try {
    const metadata = await (await fetch(bridge.url, { headers: auth })).json();
    assert.equal(metadata.apiBaseUrl, original.baseUrl);
    assert.equal(metadata.orgId, original.orgId);
    assert.equal(metadata.identity, providerSessionIdentity(original));
    assert.equal(metadata.inferenceOrigin, endpoint);
    assert.match(metadata.inferenceKey, /^ow_local_[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(metadata).includes(original.token));
    const headers = { ...auth, "x-openwork-provider-identity": metadata.identity, "x-openwork-org-id": "org_evil", "x-malicious": "yes", cookie: "untrusted" };
    for (const path of ["/v1/me", "/v1/org", "/v1/admin", "/mcp/agent", "/v1/mcp/token", "/api/auth/sign-out", "/session?token=true", "/v1/inference-providers?scope=all", "/v1/inference-providers?scope=usable&extra=1", "/v1/inference-providers/ipr_fixture/connect?extra=1"]) {
      assert.equal((await fetch(endpoint + path, { headers })).status, 404, path);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      for (const path of ["/session", ...paths]) assert.equal((await fetch(endpoint + path, { method, headers })).status, 404, `${method} ${path}`);
    }
    assert.equal(upstreams.length, 0, "forbidden calls never reach Den");
    assert.equal((await fetch(endpoint + paths[0], { headers: auth })).status, 409);
    for (const path of paths) {
      const response = await fetch(endpoint + path, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual([...response.headers.keys()].filter(key => !["content-type", "cache-control", "connection", "date", "keep-alive", "transfer-encoding", "content-length"].includes(key)), []);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("location"), null);
      const body = await response.text();
      assert.ok(!body.includes(original.token));
      assert.ok(!body.includes("ow_gw_"));
      assert.ok(path.endsWith("/events") ? body.includes("event: inventory.changed\ndata: {}") : body.includes("ow_local_catalog"));
    }
    const identity = metadata.identity;
    session = { ...original, token: "different-session", orgId: "org_other" };
    assert.equal((await fetch(endpoint + paths[0], { headers: { ...auth, "x-openwork-provider-identity": identity } })).status, 409);
    session = null;
    assert.equal(await (await fetch(bridge.url, { headers: auth })).json(), null);
    assert.equal((await fetch(endpoint + paths[0], { headers })).status, 401);
  } finally { await bridge.close(); }
});

test("opaque identity is stable across bridge ports/capabilities but changes with authority", async () => {
  const one = await createV2ProviderSessionBridge(() => original);
  const two = await createV2ProviderSessionBridge(() => ({ ...original }));
  try {
    const read = async (bridge: typeof one) => (await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json()).identity;
    assert.notEqual(one.token, two.token);
    assert.equal(await read(one), await read(two));
    for (const different of [{ ...original, token: "new" }, { ...original, orgId: "org_new" }, { ...original, baseUrl: "https://another.invalid" }]) assert.notEqual(providerSessionIdentity(original), providerSessionIdentity(different));
  } finally { await one.close(); await two.close(); }
});

test("an identity switch while awaiting upstream headers or JSON body fences the entire old response", async () => {
  for (const stage of ["headers", "body"]) {
    let session = original;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const bridge = await createV2ProviderSessionBridge(() => session, { fetch: async () => {
      if (stage === "headers") { entered?.(); await pending; }
      return new Response(new ReadableStream({ async start(output) {
        if (stage === "body") { entered?.(); await pending; }
        output.enqueue(new TextEncoder().encode(JSON.stringify({ apiKey: "ow_gw_old_org" })));
        output.close();
      } }), { headers: { "content-type": "application/json" } });
    } });
    try {
      const response = fetch(new URL(bridge.url).origin + paths[0], { headers: { authorization: `Bearer ${bridge.token}`, "x-openwork-provider-identity": providerSessionIdentity(original) } });
      await ready;
      session = { ...original, token: "new", orgId: "org_new" };
      release?.();
      const fenced = await response;
      assert.equal(fenced.status, 409, stage);
      assert.ok(!(await fenced.text()).includes("ow_gw_old_org"));
    } finally { await bridge.close(); }
  }
});

test("an established SSE is identity-fenced before forwarding each later chunk", async () => {
  let session = original;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const bridge = await createV2ProviderSessionBridge(() => session, { fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    output = controller;
    controller.enqueue(new TextEncoder().encode(": connected\n\n"));
  } }), { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await fetch(new URL(bridge.url).origin + paths[2], { headers: { authorization: `Bearer ${bridge.token}`, "x-openwork-provider-identity": providerSessionIdentity(original) } });
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), ": heartbeat\n\n");
    session = { ...original, token: "new", orgId: "org_other" };
    output?.enqueue(new TextEncoder().encode("event: inventory.changed\ndata: {\"oldOrg\":true}\n\n"));
    const next = await reader.read();
    assert.equal(next.done, true);
  } finally { await bridge.close(); }
});
