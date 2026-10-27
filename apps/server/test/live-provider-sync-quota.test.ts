import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/opencode-plugins/openwork-gateway-quota-v2.js";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE } from "@openwork/types/den/gateway-usage-limits";

type Event = { model: { providerID: string }; request: Request; response: Response };
const id = "ipr_fixture";
const base = `https://gateway.example.invalid/api/v1/providers/${id}`;
function quota() {
  return Response.json({ error: { code: GATEWAY_USAGE_LIMIT_ERROR_CODE, source: "openwork_gateway", type: "usage_limit_error",
    message: "You have reached your AI Gateway usage limit." } }, { status: 429, headers: { "X-OpenWork-Error-Code": GATEWAY_USAGE_LIMIT_ERROR_CODE, "X-OpenWork-Usage-State": "blocked", "Retry-After": "60" } });
}

test("live-only gateway catalogs retain quota handling without static provider definitions", () => {
  const rendered = renderOpencodeV2Config({ providers: [], skills: [], desktopSession: "http://127.0.0.1:1234/session",
    providerSyncPluginDirectory: "/fixture/sync", gatewayQuotaPluginDirectory: "/fixture/quota" });
  assert.deepEqual(rendered.providers, {});
  assert.ok(JSON.stringify(rendered).includes('"liveProviders":true'));
  const off = renderOpencodeV2Config({ providers: [], skills: [], gatewayQuotaPluginDirectory: "/fixture/quota" });
  assert.equal(off.plugins, undefined, "flag-off still omits unused quota registration");
});

for (const live of [false, true]) test(`${live ? "plugin-injected" : "legacy materialized"} gateways receive the same no-retry response`, async () => {
  const callbacks: Array<(event: Event) => Promise<void>> = [];
  let currentBase = base;
  let disposed = 0;
  const cleanup = await plugin.setup({
    options: live ? { liveProviders: true } : { providers: { [id]: base } },
    provider: { get: async () => ({ settings: { baseURL: currentBase } }) },
    session: { hook: async (_name, callback) => { callbacks.push(callback); return { dispose: async () => { disposed++; } }; } },
  });
  assert.equal(callbacks.length, 1);
  const event = { model: { providerID: id }, request: new Request(`${base}/chat/completions`), response: quota() };
  await callbacks[0]?.(event);
  assert.equal(event.response.headers.get("x-should-retry"), "false");
  assert.equal(event.response.headers.get("retry-after"), "60");
  assert.equal((await event.response.json()).error.code, GATEWAY_USAGE_LIMIT_ERROR_CODE);
  const foreign = { model: { providerID: id }, request: new Request("https://elsewhere.example.invalid/chat/completions"), response: quota() };
  await callbacks[0]?.(foreign);
  assert.equal(foreign.response.headers.get("x-should-retry"), null, "a foreign response cannot acquire the gateway marker");
  if (live) {
    currentBase = `https://replacement.example.invalid/api/v1/providers/${id}`;
    const changed = { model: { providerID: id }, request: new Request(`${currentBase}/chat/completions`), response: quota() };
    await callbacks[0]?.(changed);
    assert.equal(changed.response.headers.get("x-should-retry"), "false", "the hook follows refreshed native settings, not a second catalog snapshot");
    const old = { model: { providerID: id }, request: new Request(`${base}/chat/completions`), response: quota() };
    await callbacks[0]?.(old);
    assert.equal(old.response.headers.get("x-should-retry"), null);
  }
  await cleanup();
  assert.equal(disposed, 1);
});
