import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { FAST_DEFAULT_VARIANT, catalogFastVariants } from "../../packages/types/src/cloud-model-fast.ts";
import { record } from "./acme-gateway.ts";

export interface WorkshopModelProfile {
  name: string;
  provider: "openai" | "openrouter";
  model: string;
  credentialEnv: "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  upstream: string;
  route: "/responses" | "/chat/completions";
  variant?: string;
  serviceTier?: "priority";
}

/** Fast is a request option, not a model-name suffix or a reasoning-effort alias. */
export function workshopModelProfile(argv: string[]): WorkshopModelProfile {
  function option(name: string) {
    const indices = argv.flatMap((value, index) => value === name ? [index] : []);
    if (indices.length > 1) throw new Error(`Duplicate ${name}.`);
    const index = indices[0];
    if (index === undefined) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  }
  const name = option("--model-profile");
  const model = option("--model");
  if (name && model) throw new Error("Use --model-profile or --model, not both.");
  if (name === "gpt-sol-fast") return {
    name, provider: "openai", model: "gpt-6.1-sol", credentialEnv: "OPENAI_API_KEY",
    upstream: "https://api.openai.com/v1", route: "/responses", variant: FAST_DEFAULT_VARIANT, serviceTier: "priority",
  };
  if (name === "qwen-27b") return {
    name, provider: "openrouter", model: "qwen/qwen3.8-27b", credentialEnv: "OPENROUTER_API_KEY",
    upstream: "https://openrouter.ai/api/v1", route: "/chat/completions",
  };
  if (name) throw new Error("--model-profile must be gpt-sol-fast or qwen-27b. No model fallback is permitted.");
  const legacy = model ?? "gpt-4.1";
  if (!/^[a-zA-Z0-9._-]+$/.test(legacy)) throw new Error("--model requires an OpenAI model ID.");
  // Keep the original world invocation compatible, but do not silently downgrade a requested subject.
  return { name: "legacy-openai", provider: "openai", model: legacy, credentialEnv: "OPENAI_API_KEY", upstream: "https://api.openai.com/v1", route: "/chat/completions" };
}

/** Capture only the selected credential, then remove paid keys before any child starts. */
export function takeWorkshopCredential(profile: WorkshopModelProfile, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[profile.credentialEnv]?.trim();
  for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "AI_GATEWAY_AUTH_TOKEN"]) delete env[name];
  if (!key || key === "*not found*") {
    const path = profile.provider === "openrouter" ? "/openwork-ops" : "/";
    throw new Error(`BLOCKED: set ${profile.credentialEnv} from Infisical dev ${path} for this command. No service was started.`);
  }
  return key;
}

export function assertWorkshopModel(profile: WorkshopModelProfile, provider: unknown) {
  if (!record(provider) || !Array.isArray(provider.models)) throw new Error("BLOCKED: workshop provider has no model catalog.");
  const matches = provider.models.filter((model) => record(model) && model.upstreamModelId === profile.model);
  const model = matches[0];
  if (matches.length !== 1 || !record(model) || typeof model.id !== "string" || !record(model.config)) throw new Error("BLOCKED: exact workshop upstream model unavailable; no fallback.");
  if (profile.variant && (!record(provider.providerConfig) || !catalogFastVariants(model.config, provider.providerConfig.npm))) {
    throw new Error("BLOCKED: exact workshop model does not advertise verified native OpenAI priority/Fast semantics.");
  }
  return { id: model.id, config: model.config };
}

/** Only the newly booted world's canonical Den receives the paid credential. */
export async function seedWorkshopInference(den: Den, baseline: { orgId: string; providerId: string }, profile: WorkshopModelProfile, key: string) {
  const origin = new URL(den.ref.apiUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !den.database || origin.username || origin.password) throw new Error("Workshop inference requires the owned local Den and its disposable database.");
  const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": baseline.orgId };
  const created = await denFetch(den.admin, "/v1/inference-providers", {
    method: "POST", headers,
    body: JSON.stringify({ name: profile.name === "legacy-openai" ? "Workshop OpenAI" : `Workshop ${profile.name}`, providerId: profile.provider, modelIds: [profile.model],
      credential: { kind: "api_key", secret: key }, allMembers: true }),
  });
  const provider = record(created.body) && record(created.body.inferenceProvider) ? created.body.inferenceProvider : undefined;
  if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`BLOCKED: workshop provider creation HTTP ${created.response.status}; private response omitted. No fallback.`);
  const connected = await denFetch(den.admin, `/v1/inference-providers/${provider.id}/connect`, { headers });
  if (!connected.response.ok) throw new Error(`BLOCKED: workshop provider connect HTTP ${connected.response.status}; private response omitted.`);
  const inference = record(connected.body) ? connected.body.inferenceProvider : undefined;
  const model = assertWorkshopModel(profile, inference);
  const removed = await denFetch(den.admin, `/v1/inference-providers/${baseline.providerId}`, { method: "DELETE", headers });
  if (removed.response.status !== 204) throw new Error(`Could not remove the workshop's synthetic model: HTTP ${removed.response.status}`);
  return { providerId: provider.id, modelId: model.id, ...(profile.variant ? { variant: profile.variant } : {}) };
}

/** Explicit opt-in only: one bounded real GPT tool call through this world's gateway.
 * This is a protocol witness, not the workshop narrative or proof of engine variant selection.
 * No prompt, authorization, response ID, tool arguments or credential is retained.
 */
export async function probeWorkshopInference(den: Den, orgId: string, gatewayUrl: string, paid: { providerId: string; modelId: string }, profile: WorkshopModelProfile) {
  if (profile.name !== "gpt-sol-fast") throw new Error("Only gpt-sol-fast has an authorized startup protocol probe. Qwen inference must follow the GPT narrative.");
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1" || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== "/") throw new Error("Workshop probe requires its owned loopback gateway.");
  const connected = await denFetch(den.admin, `/v1/inference-providers/${paid.providerId}/connect`, {
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId },
  });
  const provider = record(connected.body) && record(connected.body.inferenceProvider) ? connected.body.inferenceProvider : undefined;
  if (!connected.response.ok || typeof provider?.apiKey !== "string") throw new Error("Workshop probe could not obtain its disposable gateway credential.");
  const started = Date.now();
  const route = `/api/v1/providers/${paid.providerId}/responses`;
  const response = await fetch(`${gateway.origin}${route}`, {
    method: "POST", redirect: "error", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: paid.modelId, service_tier: "priority", store: false, max_output_tokens: 512,
      input: "Call workshop_probe once with ok=true. Do not output prose.",
      tools: [{ type: "function", name: "workshop_probe", description: "Disposable protocol probe; no business data or writes.", strict: true,
        parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }],
      tool_choice: { type: "function", name: "workshop_probe" } }),
    signal: AbortSignal.timeout(90_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !record(body) || body.status !== "completed"
    || ![profile.model, paid.modelId].includes(String(body.model))
    || !["priority", "fast"].includes(String(body.service_tier))
    || !Array.isArray(body.output) || !body.output.some((item) => record(item) && item.type === "function_call" && item.name === "workshop_probe")) {
    throw new Error(`BLOCKED: GPT Responses/Fast tool-call witness failed (HTTP ${response.status}); private response omitted. No fallback or automatic retry.`);
  }
  const usage = record(body.usage) ? body.usage : {};
  const reasoning = record(body.reasoning) ? body.reasoning : {};
  return { profile: profile.name, upstreamModel: profile.model, route: `${profile.upstream}${profile.route}`,
    gatewayRoute: route, requestedVariant: profile.variant, requestedServiceTier: "priority", returnedServiceTier: String(body.service_tier),
    requestedReasoning: "unspecified (Fast/default)", returnedReasoningEffort: typeof reasoning.effort === "string" ? reasoning.effort : null,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    maxOutputTokens: 512, elapsedMs: Date.now() - started, toolCall: true, scope: "explicit bounded gateway protocol probe; not a narrative/engine witness" };
}

export interface WorkshopInferenceWitness {
  sequence: number;
  profile: string;
  upstreamModel: string;
  route: string;
  requestedServiceTier: string | null;
  returnedServiceTier: string | null;
  requestedReasoningEffort: string | null;
  returnedReasoningEffort: string | null;
  requestedMaxOutputTokens: number | null;
  forwardedMaxOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  elapsedMs: number;
  httpStatus: number | null;
  status: "started" | "completed" | "rejected" | "upstream-error" | "interrupted";
  rejection: string | null;
  costStatus: "unavailable" | "estimated-not-billed";
  estimatedUsd: number | null;
  /** Cost reported by the upstream usage payload, not independently reconciled against an invoice. */
  reportedCostUsd: number | null;
  /** A request body proves priority was requested, not which UI variant produced it. */
  variantEvidence: "priority-request-body" | "not-fast";
}

export interface WorkshopInferenceProxyOptions {
  maxRequests?: number;
  maxOutputTokens?: number;
  maxTotalOutputTokens?: number;
  maxInputBytes?: number;
  maxTotalInputBytes?: number;
  lifetimeMs?: number;
  requestTimeoutMs?: number;
  /** Test transport only; production callers omit this. The target URL remains pinned. */
  upstreamFetch?: typeof fetch;
}

/** Real paid upstream, but no paid key is ever put in provider config or a child environment.
 * Owned fixture config only: callers must place `provider` in the fresh world's runtime.
 * The proxy never discovers or mutates installed/org providers and never calls a business connector.
 * Creating the proxy sends NO inference request (including for Qwen).
 */
export async function startWorkshopInferenceProxy(stack: AsyncDisposableStack, profile: WorkshopModelProfile, paidKey: string, options: WorkshopInferenceProxyOptions = {}) {
  if (!["gpt-sol-fast", "qwen-27b"].includes(profile.name)) throw new Error("Recording proxy requires an exact workshop subject profile.");
  // Refuse caller-supplied profile lookalikes that could exfiltrate a paid key.
  const trusted = workshopModelProfile(["--model-profile", profile.name]);
  if (JSON.stringify(trusted) !== JSON.stringify(profile)) throw new Error("Untrusted workshop inference profile.");
  if (!paidKey.trim() || paidKey.trim() === "*not found*") throw new Error(`BLOCKED: missing ${profile.credentialEnv}; no inference attempted.`);
  const limits = {
    maxRequests: options.maxRequests ?? 180,
    maxOutputTokens: options.maxOutputTokens ?? 8192,
    maxTotalOutputTokens: options.maxTotalOutputTokens ?? 131072,
    maxInputBytes: options.maxInputBytes ?? 2 * 1024 * 1024,
    maxTotalInputBytes: options.maxTotalInputBytes ?? 32 * 1024 * 1024,
    lifetimeMs: options.lifetimeMs ?? 45 * 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 180_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid workshop inference bound: ${name}`);
  }
  const transport = options.upstreamFetch ?? fetch;
  const syntheticKey = `workshop-only-${randomUUID()}`;
  const witnesses: WorkshopInferenceWitness[] = [];
  const started = Date.now();
  const controllers = new Set<AbortController>();
  let inputBytes = 0;
  let outputReserved = 0;
  let active = false;
  let stopped = false;
  const server = createServer(async (request, response) => {
    const requestStart = Date.now();
    const witness: WorkshopInferenceWitness = {
      sequence: witnesses.length + 1, profile: profile.name, upstreamModel: profile.model,
      route: `${profile.upstream}${profile.route}`, requestedServiceTier: null, returnedServiceTier: null,
      requestedReasoningEffort: null, returnedReasoningEffort: null, requestedMaxOutputTokens: null,
      forwardedMaxOutputTokens: 0, inputTokens: null, outputTokens: null, reasoningTokens: null,
      elapsedMs: 0, httpStatus: null, status: "started", rejection: null, costStatus: "unavailable", estimatedUsd: null, reportedCostUsd: null,
      variantEvidence: "not-fast",
    };
    // Unauthenticated traffic does not get to fill the in-memory witness ledger.
    if (request.headers.authorization !== `Bearer ${syntheticKey}`) {
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Workshop synthetic authentication required"}}');
      return;
    }
    function reject(status: number, reason: string) {
      witness.status = "rejected";
      witness.rejection = reason;
      witness.httpStatus = status;
      witness.elapsedMs = Date.now() - requestStart;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Workshop inference blocked: ${reason}` } }));
    }
    if (witnesses.length >= limits.maxRequests) { reject(429, "request-budget-exhausted"); return; }
    witnesses.push(witness);
    if (stopped || Date.now() - started >= limits.lifetimeMs) { reject(410, "world-inference-lifetime-exhausted"); return; }
    if (active) { reject(429, "concurrent-inference-not-permitted"); return; }
    if (request.method !== "POST" || request.url !== `/v1${profile.route}`) { reject(400, "wrong-protocol-route"); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limits.maxInputBytes || inputBytes + size > limits.maxTotalInputBytes) { reject(413, "input-byte-budget-exhausted"); return; }
        chunks.push(bytes);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body) || body.model !== profile.model) { reject(400, "wrong-upstream-model"); return; }
      witness.requestedServiceTier = typeof body.service_tier === "string" ? body.service_tier : null;
      witness.requestedReasoningEffort = record(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort
        : typeof body.reasoning_effort === "string" ? body.reasoning_effort : null;
      if (profile.serviceTier && body.service_tier !== profile.serviceTier) { reject(400, "missing-priority-Fast-request-option"); return; }
      if (!profile.serviceTier && body.service_tier !== undefined) { reject(400, "unexpected-service-tier-for-Qwen"); return; }
      if (body.background === true || body.previous_response_id !== undefined || body.conversation !== undefined) { reject(400, "stored-or-background-inference-not-permitted"); return; }
      if (Array.isArray(body.tools) && body.tools.some((tool) => !record(tool) || tool.type !== "function")) { reject(400, "hosted-upstream-tools-not-permitted"); return; }
      witness.variantEvidence = profile.serviceTier ? "priority-request-body" : "not-fast";
      const tokenField = profile.route === "/responses" ? "max_output_tokens" : "max_tokens";
      const requested = body[tokenField] ?? body.max_completion_tokens;
      if (requested !== undefined && (!Number.isSafeInteger(requested) || typeof requested !== "number" || requested <= 0)) { reject(400, "invalid-output-token-bound"); return; }
      witness.requestedMaxOutputTokens = typeof requested === "number" ? requested : null;
      const allowance = Math.min(typeof requested === "number" ? requested : limits.maxOutputTokens, limits.maxOutputTokens, limits.maxTotalOutputTokens - outputReserved);
      if (allowance <= 0) { reject(429, "output-token-budget-exhausted"); return; }
      // Token bounds may be tightened, but Fast and reasoning are NEVER injected or modified.
      body[tokenField] = allowance;
      delete body.max_completion_tokens;
      if (profile.route === "/responses") body.store = false;
      if (profile.route === "/chat/completions" && body.stream === true) body.stream_options = { include_usage: true };
      witness.forwardedMaxOutputTokens = allowance;
      inputBytes += size;
      outputReserved += allowance;
      active = true;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs);
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnected);
      let upstream: Response | undefined;
      let observedOutput: number | null = null;
      let upstreamFailed = false;
      function observe(value: unknown) {
        if (!record(value)) return;
        const result = record(value.response) ? value.response : value;
        if (result.status === "failed" || result.status === "incomplete" || value.type === "error" || value.error !== undefined) upstreamFailed = true;
        if (typeof result.service_tier === "string") witness.returnedServiceTier = result.service_tier;
        if (record(result.reasoning) && typeof result.reasoning.effort === "string") witness.returnedReasoningEffort = result.reasoning.effort;
        const usage = record(result.usage) ? result.usage : undefined;
        if (usage) {
          if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) witness.reportedCostUsd = usage.cost;
          const input = usage.input_tokens ?? usage.prompt_tokens;
          const output = usage.output_tokens ?? usage.completion_tokens;
          const details = record(usage.output_tokens_details) ? usage.output_tokens_details : record(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
          if (typeof input === "number" && Number.isFinite(input) && input >= 0) witness.inputTokens = input;
          if (typeof output === "number" && Number.isFinite(output) && output >= 0) { witness.outputTokens = output; observedOutput = output; }
          if (typeof details.reasoning_tokens === "number") witness.reasoningTokens = details.reasoning_tokens;
        }
      }
      try {
        upstream = await transport(`${profile.upstream}${profile.route}`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${paidKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
        });
        witness.httpStatus = upstream.status;
        if (!upstream.ok || !upstream.body) {
          witness.status = "upstream-error";
          // Never relay upstream error bodies: they can echo credentials or prompt data.
          await upstream.body?.cancel();
          response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Workshop upstream HTTP ${upstream.status}; private response omitted` } }));
          return;
        }
        const streaming = upstream.headers.get("content-type")?.includes("text/event-stream");
        response.writeHead(upstream.status, { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store" });
        const decoder = new TextDecoder();
        let pending = "";
        const reader = upstream.body.getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value;
          response.write(chunk);
          pending += decoder.decode(chunk, { stream: true });
          if (streaming) {
            let end: number;
            while ((end = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, end).trimEnd();
              pending = pending.slice(end + 1);
              if (line.startsWith("data:")) {
                const data = line.slice(5).trim();
                if (data !== "[DONE]") { try { observe(JSON.parse(data)); } catch { /* no raw events retained */ } }
              }
            }
          }
          if (pending.length > 2 * 1024 * 1024) throw new Error("bounded-upstream-metadata-buffer-exceeded");
        }
        pending += decoder.decode();
        if (!streaming) { try { observe(JSON.parse(pending)); } catch { /* preserve unavailable usage */ } }
        witness.status = upstreamFailed ? "upstream-error" : "completed";
        response.end();
      } catch {
        witness.status = "interrupted";
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end('{"error":{"message":"Workshop upstream interrupted; private details omitted"}}');
        else response.destroy();
      } finally {
        clearTimeout(timer);
        response.off("close", disconnected);
        controllers.delete(controller);
        active = false;
        // Keep the whole reservation for an interrupted/unknown-usage request.
        if (observedOutput !== null) outputReserved -= Math.max(0, allowance - observedOutput);
        witness.elapsedMs = Date.now() - requestStart;
        if (witness.inputTokens !== null && witness.outputTokens !== null) {
          const rates = profile.name === "gpt-sol-fast" ? { input: 4, output: 20 } : { input: 0.24, output: 2.2 };
          witness.estimatedUsd = (witness.inputTokens * rates.input + witness.outputTokens * rates.output) / 1_000_000;
          witness.costStatus = "estimated-not-billed";
        }
      }
    } catch {
      if (!response.headersSent) reject(400, "invalid-request-body");
      else response.destroy();
    }
  });
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = Math.min(30_000, limits.requestTimeoutMs);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  stack.defer(stop);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workshop inference proxy did not bind.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const providerId = `workshop-${profile.name}`;
  const provider = {
    npm: profile.provider === "openai" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
    name: `Workshop ${profile.name}`,
    options: { baseURL: baseUrl, apiKey: syntheticKey },
    models: { [profile.model]: {
      id: profile.model, name: profile.name === "gpt-sol-fast" ? "GPT-6.1 Sol" : "Qwen3.8 27B",
      family: profile.name === "gpt-sol-fast" ? "gpt-sol" : "qwen", reasoning: true, tool_call: true,
      temperature: profile.name !== "gpt-sol-fast", attachment: true,
      limit: { context: profile.name === "gpt-sol-fast" ? 1050000 : 1000000, output: limits.maxOutputTokens },
      ...(profile.variant ? { variants: { [profile.variant]: { serviceTier: "priority" } } } : {}),
    } },
  };
  function status() {
    const latest = witnesses.at(-1);
    if (!latest) return { status: "configured-not-yet-witnessed", reason: null };
    if (latest.status === "completed") return { status: "witnessed", reason: null };
    if (latest.status === "started") return { status: "running", reason: null };
    return { status: "blocked", reason: latest.rejection ?? `upstream-${latest.httpStatus ?? latest.status}` };
  }
  return { baseUrl, providerId, modelId: profile.model, variant: profile.variant, provider, witnesses, limits, stop, status,
    metadata: { profile: profile.name, upstream: `${profile.upstream}${profile.route}`, requestedVariant: profile.variant ?? "default", status: "configured-not-yet-witnessed" } };
}

/** Optional fail-closed descriptor for native matrices that continue to a fresh second world. */
export async function prepareWorkshopInferenceProxy(stack: AsyncDisposableStack, profile: WorkshopModelProfile, paidKey: string | undefined, options: WorkshopInferenceProxyOptions = {}): Promise<
  { status: "blocked"; reason: string; proxy: null } | { status: "configured"; reason: null; proxy: Awaited<ReturnType<typeof startWorkshopInferenceProxy>> }
> {
  if (!paidKey?.trim() || paidKey.trim() === "*not found*") return { status: "blocked", reason: `missing-${profile.credentialEnv}`, proxy: null };
  try {
    const proxy = await startWorkshopInferenceProxy(stack, profile, paidKey, options);
    return { status: "configured", reason: null, proxy };
  } catch {
    return { status: "blocked", reason: "workshop-inference-configuration-unavailable", proxy: null };
  }
}
