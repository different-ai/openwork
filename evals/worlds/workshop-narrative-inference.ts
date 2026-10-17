import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workshopModelProfile, startWorkshopInferenceProxy } from "../../worlds/lib/workshop-inference.ts";
const run = promisify(execFile);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Scoped secret consumption: no key goes into child/provider configuration or a report. */
export async function startNarrativeInference(name: string, stack: AsyncDisposableStack) {
  const profile = workshopModelProfile(["--model-profile", name]);
  const metadata: Record<string, unknown> = { profile: profile.name, upstreamModel: profile.model, route: `${profile.upstream}${profile.route}`, requestedVariant: profile.variant ?? "default", requestedServiceTier: profile.serviceTier ?? null };
  let key: string;
  try {
    const secret = await run("infisical", ["secrets", "get", profile.credentialEnv, "--env", "dev", "--path", profile.provider === "openrouter" ? "/openwork-ops" : "/", "--plain", "--silent"], { timeout: 30_000, maxBuffer: 8192 });
    key = secret.stdout.trim();
    if (!key || key === "*not found*") throw new Error("missing");
  } catch { return { ready: false as const, reason: `Missing scoped ${profile.credentialEnv}; no provider fallback`, metadata }; }
  const proxy = await startWorkshopInferenceProxy(stack, profile, key, { maxRequests: 220, maxOutputTokens: 8192, maxTotalOutputTokens: 131072, maxInputBytes: 2 * 1024 * 1024, maxTotalInputBytes: 32 * 1024 * 1024, lifetimeMs: 35 * 60_000, requestTimeoutMs: 180_000 });
  key = "";
  const tools = [{ type: "function", name: "workshop_probe", description: "Return the explicit protocol-check result; no business action.", strict: true, parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }];
  const body = profile.route === "/responses"
    ? { model: profile.model, service_tier: "priority", store: false, max_output_tokens: 256, input: "Call workshop_probe once with ok=true. Do not output prose.", tools, tool_choice: { type: "function", name: "workshop_probe" } }
    : { model: profile.model, max_tokens: 256, reasoning: { enabled: false }, messages: [{ role: "user", content: "Call workshop_probe once with ok=true. Do not output prose." }], tools: tools.map(({ type, ...fn }) => ({ type, function: fn })), tool_choice: { type: "function", function: { name: "workshop_probe" } } };
  const started = Date.now();
  let result: unknown;
  let status = 0;
  try {
    const response = await fetch(`${proxy.baseUrl}${profile.route}`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: "error" });
    status = response.status;
    result = await response.json();
  } catch { return { ready: false as const, reason: "Exact-model tool-call preflight failed; no fallback", metadata: { ...metadata, httpStatus: status || null, elapsedMs: Date.now() - started, witnesses: proxy.witnesses } }; }
  let toolCall = false;
  if (record(result) && profile.route === "/responses") toolCall = result.model === profile.model && ["priority", "fast"].includes(String(result.service_tier)) && result.status === "completed" && Array.isArray(result.output) && result.output.some((item) => record(item) && item.type === "function_call" && item.name === "workshop_probe");
  if (record(result) && profile.route === "/chat/completions") {
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const message = record(choices[0]) && record(choices[0].message) ? choices[0].message : {};
    toolCall = result.model === profile.model && Array.isArray(message.tool_calls) && message.tool_calls.some((item) => record(item) && record(item.function) && item.function.name === "workshop_probe");
  }
  const verified = { ...metadata, httpStatus: status, toolCall, preflightElapsedMs: Date.now() - started, preflightWitnesses: structuredClone(proxy.witnesses), limits: proxy.limits };
  if (status !== 200 || !toolCall) return { ready: false as const, reason: "Exact-model real tool-call preflight was not verified; no fallback", metadata: verified };
  return { ready: true as const, providerId: proxy.providerId, provider: proxy.provider, modelId: proxy.modelId, variant: proxy.variant ?? null, metadata: verified, observations: () => structuredClone(proxy.witnesses) };
}
