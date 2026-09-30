import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { readFile } from "node:fs/promises";
import { OpenWorkGatewayQuota } from "./openwork-gateway-quota.js";
import quotaV2 from "./openwork-gateway-quota-v2.js";
import { renderOpencodeV2Config } from "../managed-opencode-v2.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../openwork-runtime-config.js";

const originalFetch = globalThis.fetch;
const id = "ipr_synthetic";
const baseURL = `https://gateway.example/api/v1/providers/${id}`;
const code = "openwork_gateway_usage_limit_exceeded";
const error = {
  type: "usage_limit_error", code, source: "openwork_gateway",
  message: "You have reached your AI Gateway usage limit.",
};
const headers = {
  "X-OpenWork-Error-Code": code, "X-OpenWork-Usage-State": "blocked",
  "Retry-After": "2500000", "X-OpenWork-Request-Id": "req_429500503",
};
type ProviderFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

async function transport(url = baseURL, providerId = id) {
  const options: { baseURL: string; fetch?: ProviderFetch } = { baseURL: url };
  const hooks = await OpenWorkGatewayQuota();
  await hooks.config({ provider: { [providerId]: { options } } });
  return options.fetch;
}

function respond(response: Response) {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls += 1; return response; }, originalFetch);
  return () => calls;
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("managed Gateway deterministic quota transport", () => {
  test("terminates with genuine nonretryable SDK API error, preserving 429, headers and canonical identity", async () => {
    const body = { error: { ...error, details: { exhaustedBuckets: [{ bucketId: "bucket_429500503", usedMicroUsd: 500000, allowanceMicroUsd: 429000 }], retryAt: "2026-10-01T05:00:00.000Z" } } };
    const response = Response.json(body, { status: 429, headers });
    const calls = respond(response);
    const send = await transport();
    if (!send) throw new Error("Missing provider transport");
    try {
      await send(`${baseURL}/chat/completions?key=must-not-be-logged`, { method: "POST", body: "private prompt" });
      throw new Error("Expected terminal quota error");
    } catch (failure) {
      expect(APICallError.isInstance(failure)).toBe(true);
      if (!APICallError.isInstance(failure)) throw failure;
      expect(failure.isRetryable).toBe(false);
      expect(failure.statusCode).toBe(429);
      expect(failure.responseHeaders).toEqual(Object.fromEntries(response.headers));
      expect(JSON.parse(failure.responseBody ?? "null")).toEqual({ error });
      expect(failure.message).toBe(error.message);
      expect(failure.url).toBe(`${baseURL}/chat/completions`);
      expect(failure.requestBodyValues).toBeUndefined();
      expect(failure.responseBody).not.toMatch(/429|500|502|503|504|524|rate.limit|exhausted|unavailable/i);
    }
    expect(calls()).toBe(1);
  });

  test("leaves success, transient upstream 429, accounting 503, and malformed quota responses unchanged", async () => {
    const send = await transport();
    if (!send) throw new Error("Missing provider transport");
    const cases = [
      new Response("data: streamed\n\n", { headers: { "content-type": "text/event-stream" } }),
      Response.json({ error: { code: "rate_limit_exceeded", message: "Slow down" } }, { status: 429, headers: { "Retry-After": "5" } }),
      Response.json({ error }, { status: 503, headers }),
      Response.json({ error: { ...error, source: "upstream" } }, { status: 429, headers }),
      Response.json({ error }, { status: 429, headers: { "X-OpenWork-Error-Code": code } }),
      Response.json({ error }, { status: 429, headers: { ...headers, "X-OpenWork-Usage-State": "within_limit" } }),
      new Response("not json", { status: 429, headers }),
      new Response(" ".repeat(16_385) + JSON.stringify({ error }), { status: 429, headers }),
    ];
    for (const response of cases) {
      const text = await response.clone().text();
      const calls = respond(response);
      expect(await send(`${baseURL}/chat/completions`)).toBe(response);
      expect(await response.text()).toBe(text);
      expect(calls()).toBe(1);
    }
  });

  test("scopes classification to the configured provider endpoint, including Request inputs", async () => {
    const send = await transport();
    if (!send) throw new Error("Missing provider transport");
    for (const url of ["https://upstream.example/chat/completions", `${baseURL}-other/chat/completions`, `${baseURL}/../ipr_other/chat/completions`]) {
      const response = Response.json({ error }, { status: 429, headers });
      respond(response);
      expect(await send(url)).toBe(response);
    }
    respond(Response.json({ error }, { status: 429, headers }));
    await expect(send(new Request(`${baseURL}/messages`, { method: "POST" }))).rejects.toMatchObject({ statusCode: 429, isRetryable: false });
    expect(await transport(baseURL, "lpr_synthetic")).toBeUndefined();
    expect(await transport("https://upstream.example/api/v1")).toBeUndefined();
    expect(await transport(`${baseURL}?key=secret`)).toBeUndefined();
    expect(await transport(`https://user:secret@gateway.example/api/v1/providers/${id}`)).toBeUndefined();
  });

  test("preserves existing custom transport and does not install a process-wide fetch patch", async () => {
    const custom: ProviderFetch = async () => new Response("custom");
    const options = { baseURL, fetch: custom };
    const hooks = await OpenWorkGatewayQuota();
    await hooks.config({ provider: { [id]: { options } } });
    expect(options.fetch).toBe(custom);
    expect(globalThis.fetch).toBe(originalFetch);
    const send = await transport();
    if (!send) throw new Error("Missing provider transport");
    const failure = new Error("connection failed");
    globalThis.fetch = Object.assign(async () => { throw failure; }, originalFetch);
    await expect(send(`${baseURL}/chat/completions`)).rejects.toBe(failure);
  });

  test("registers and bundles the single-export runtime plugin", async () => {
    const config = buildOpenworkRuntimeConfigObjectFromSnapshot({});
    expect(config.plugin).toContainEqual(expect.stringContaining("openwork-gateway-quota"));
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.build).toContain("src/opencode-plugins/openwork-gateway-quota.ts");
    expect(pkg.scripts.build).toContain("src/opencode-plugins/openwork-gateway-quota-v2.ts");
    expect(Object.keys(await import("./openwork-gateway-quota.js"))).toEqual(["OpenWorkGatewayQuota"]);
    expect(Object.keys(await import("./openwork-gateway-quota-v2.js"))).toEqual(["default"]);
  });
});

type V2Callback = Parameters<Parameters<typeof quotaV2.setup>[0]["session"]["hook"]>[1];

async function nativeHook() {
  const callbacks: V2Callback[] = [];
  let disposed = 0;
  const cleanup = await quotaV2.setup({
    options: { providers: { [id]: baseURL, lpr_other: "https://upstream.example" } },
    session: { hook: async (name, callback, options) => {
      expect(name).toBe("http.response");
      expect(options).toEqual({ providerID: id });
      callbacks.push(callback);
      return { dispose: async () => { disposed += 1; } };
    } },
  });
  expect(callbacks).toHaveLength(1);
  const callback = callbacks[0];
  if (!callback) throw new Error("Missing native response hook");
  return { callback, cleanup, disposed: () => disposed };
}

describe("native v2 Gateway quota response hook", () => {
  test("retains exact body and 429 and adds only the engine's no-retry override", async () => {
    const hook = await nativeHook();
    const body = JSON.stringify({ error: { ...error, details: { exhaustedBuckets: [{ bucketId: "bucket_429500503", usedMicroUsd: 500000 }] } } });
    const original = new Response(body, { status: 429, headers });
    const event = { model: { providerID: id }, request: new Request(`${baseURL}/chat/completions`), response: original };
    await hook.callback(event);
    expect(event.response.status).toBe(429);
    expect(await event.response.text()).toBe(body);
    expect(Object.fromEntries(event.response.headers)).toEqual({ ...Object.fromEntries(original.headers), "x-should-retry": "false" });
    expect(original.headers.has("x-should-retry")).toBe(false);
    await hook.cleanup();
    expect(hook.disposed()).toBe(1);
  });

  test("does not change transient, malformed, foreign endpoint, or foreign provider responses", async () => {
    const hook = await nativeHook();
    const cases = [
      { providerID: id, url: `${baseURL}/chat/completions`, response: Response.json({ error }, { status: 429 }) },
      { providerID: id, url: `${baseURL}/chat/completions`, response: Response.json({ error }, { status: 503, headers }) },
      { providerID: id, url: `${baseURL}/chat/completions`, response: Response.json({ error: { ...error, source: "upstream" } }, { status: 429, headers }) },
      { providerID: id, url: "https://upstream.example/chat/completions", response: Response.json({ error }, { status: 429, headers }) },
      { providerID: "ipr_other", url: `${baseURL}/chat/completions`, response: Response.json({ error }, { status: 429, headers }) },
    ];
    for (const item of cases) {
      const event = { model: { providerID: item.providerID }, request: new Request(item.url), response: item.response };
      await hook.callback(event);
      expect(event.response).toBe(item.response);
      expect(event.response.headers.has("x-should-retry")).toBe(false);
    }
    await hook.cleanup();
  });

  test("registers native response handling only for managed Gateway endpoints without credentials", () => {
    const gateway = { id, name: "Gateway", baseUrl: baseURL, apiKey: "never-in-plugin-options", models: [] };
    const config = renderOpencodeV2Config({ providers: [gateway], skills: [], gatewayQuotaPluginDirectory: "/runtime/gateway-quota-plugin" });
    expect(config.plugins).toEqual([{ package: "file:///runtime/gateway-quota-plugin", options: { providers: { [id]: baseURL } } }]);
    expect(JSON.stringify(config.plugins)).not.toContain(gateway.apiKey);
    expect(renderOpencodeV2Config({ providers: [{ ...gateway, id: "lpr_other" }], skills: [] }).plugins).toBeUndefined();
    expect(renderOpencodeV2Config({ providers: [], skills: [] }).plugins).toBeUndefined();
  });
});
