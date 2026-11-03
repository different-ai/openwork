import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, openWorkModelsAllowanceErrorBody } from "@openwork/types/den/inference";
import { OpenWorkGatewayQuota } from "../src/opencode-plugins/openwork-gateway-quota.js";

const base = "https://models.example.invalid/api/v1";
const allowance = () => Response.json(openWorkModelsAllowanceErrorBody(), { status: 429, headers: {
  "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, "x-openwork-usage-state": "blocked", "x-should-retry": "false",
  "retry-after": "4200", "x-openwork-limit-window-type": "five_hour",
} });

async function wrapped(provider: Record<string, unknown>) {
  const config = { provider: { openwork: provider } };
  await (await OpenWorkGatewayQuota()).config(config);
  const options = config.provider.openwork.options;
  assert.ok(typeof options === "object" && options !== null && "fetch" in options && typeof options.fetch === "function");
  const fetcher: unknown = options.fetch;
  if (typeof fetcher !== "function") throw new Error("missing fetch");
  return (input: string) => Promise.resolve(fetcher(input));
}

async function withFetch<T>(response: () => Response, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => response(), { preconnect: original.preconnect });
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("a used-up OpenWork Models allowance is answered once, not retried as a rate limit", async () => {
  const fetcher = await wrapped({ npm: "@openrouter/ai-sdk-provider", options: { baseURL: base } });
  const error = await withFetch(allowance, () => fetcher(`${base}/chat/completions`).then(() => null, (reason: unknown) => reason));
  assert.ok(APICallError.isInstance(error));
  assert.equal(error.isRetryable, false);
  assert.equal(error.statusCode, 429);
  assert.equal(error.responseHeaders?.["retry-after"], "4200");
  assert.equal(error.responseHeaders?.["x-openwork-error-code"], OPENWORK_MODELS_ALLOWANCE_ERROR_CODE);
  // The engine still retries any error text that mentions a status code or a rate limit.
  assert.doesNotMatch(`${error.message} ${error.responseBody}`, /\d|rate.?limit|too many requests/i);
});

test("the provider's base URL may come from `api` alone", async () => {
  const fetcher = await wrapped({ api: base });
  const error = await withFetch(allowance, () => fetcher(`${base}/chat/completions`).then(() => null, (reason: unknown) => reason));
  assert.ok(APICallError.isInstance(error) && error.isRetryable === false);
});

test("an ordinary 429 and a foreign origin keep their normal retry behaviour", async () => {
  const fetcher = await wrapped({ options: { baseURL: base } });
  const plain = await withFetch(() => Response.json({ error: { message: "Too many requests" } }, { status: 429 }), () => fetcher(`${base}/chat/completions`));
  assert.equal(plain.status, 429);
  const foreign = await withFetch(allowance, () => fetcher("https://elsewhere.example.invalid/api/v1/chat/completions"));
  assert.equal(foreign.status, 429, "a response from another origin cannot claim the allowance marker");
  const spoofed = await withFetch(() => Response.json({ error: { code: "other" } }, { status: 429, headers: { "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, "x-openwork-usage-state": "blocked" } }),
    () => fetcher(`${base}/chat/completions`));
  assert.equal(spoofed.status, 429, "headers alone do not classify without the gateway's body");
});

test("other providers named openwork-free or custom fetches are left alone", async () => {
  const config: { provider: Record<string, Record<string, unknown>> } = { provider: {
    "openwork-free": { options: { baseURL: base } },
    openwork: { options: { baseURL: base, fetch: "custom" } },
  } };
  await (await OpenWorkGatewayQuota()).config(config);
  assert.equal(config.provider["openwork-free"]?.options && "fetch" in config.provider["openwork-free"].options, false);
  assert.deepEqual(config.provider.openwork?.options, { baseURL: base, fetch: "custom" });
});
