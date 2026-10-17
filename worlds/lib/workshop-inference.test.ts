import assert from "node:assert/strict";
import test from "node:test";
import { FAST_DEFAULT_VARIANT } from "../../packages/types/src/cloud-model-fast.ts";
import { workshopModelProfile, takeWorkshopCredential, assertWorkshopModel, startWorkshopInferenceProxy } from "./workshop-inference.ts";

test("workshop profiles pin actual upstream IDs, protocol and independent Fast semantics", () => {
  const gpt = workshopModelProfile(["--model-profile", "gpt-sol-fast"]);
  assert.deepEqual(gpt, { name: "gpt-sol-fast", provider: "openai", model: "gpt-6.1-sol", credentialEnv: "OPENAI_API_KEY",
    upstream: "https://api.openai.com/v1", route: "/responses", variant: FAST_DEFAULT_VARIANT, serviceTier: "priority" });
  const qwen = workshopModelProfile(["--model-profile", "qwen-27b"]);
  assert.equal(qwen.provider, "openrouter");
  assert.equal(qwen.model, "qwen/qwen3.8-27b");
  assert.equal(qwen.variant, undefined);
  assert.equal(qwen.serviceTier, undefined);
  assert.equal(qwen.route, "/chat/completions");
  assert.equal(workshopModelProfile([]).model, "gpt-4.1");
  assert.equal(workshopModelProfile(["--model", "gpt-4.1-mini"]).model, "gpt-4.1-mini");
});

test("invalid or ambiguous model requests fail instead of downgrading", () => {
  for (const argv of [["--model-profile"], ["--model-profile", "gpt"], ["--model-profile", "gpt-sol-fast", "--model", "gpt-4.1"],
    ["--model", "--probe-inference"], ["--model", "gpt-4.1", "--model", "gpt-4.1-mini"], ["--model-profile", "qwen-27b", "--model-profile", "gpt-sol-fast"]]) {
    assert.throws(() => workshopModelProfile(argv));
  }
});

test("only selected key is captured, all paid credential alternatives are stripped before boot", () => {
  const env = { OPENAI_API_KEY: " paid-fixture ", OPENROUTER_API_KEY: "other-fixture", AI_GATEWAY_API_KEY: "unverified-fixture", AI_GATEWAY_AUTH_TOKEN: "unverified-fixture", PATH: "/bin" };
  assert.equal(takeWorkshopCredential(workshopModelProfile(["--model-profile", "gpt-sol-fast"]), env), "paid-fixture");
  assert.deepEqual(env, { PATH: "/bin" });
  for (const key of [undefined, "", "*not found*"]) {
    const missing = { OPENAI_API_KEY: key, OPENROUTER_API_KEY: "must-not-fallback" };
    assert.throws(() => takeWorkshopCredential(workshopModelProfile(["--model-profile", "gpt-sol-fast"]), missing), /BLOCKED/);
    assert.deepEqual(missing, {});
  }
  const router = { OPENROUTER_API_KEY: "router-fixture", OPENAI_API_KEY: "other-fixture" };
  assert.equal(takeWorkshopCredential(workshopModelProfile(["--model-profile", "qwen-27b"]), router), "router-fixture");
  assert.deepEqual(router, {});
});

test("Fast requires trusted native OpenAI priority metadata, never a display label", () => {
  const profile = workshopModelProfile(["--model-profile", "gpt-sol-fast"]);
  const config = { experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } } };
  const provider = { providerConfig: { npm: "@ai-sdk/openai" }, models: [{ id: "world-gateway-alias", upstreamModelId: "gpt-6.1-sol", config }] };
  assert.equal(assertWorkshopModel(profile, provider).id, "world-gateway-alias");
  for (const value of [
    { ...provider, providerConfig: { npm: "@ai-sdk/openai-compatible" } },
    { ...provider, models: [{ id: "wrong", upstreamModelId: "gpt-4.1", config }] },
    { ...provider, models: [{ id: "label-only", upstreamModelId: profile.model, config: { name: "GPT-6.1 Sol Fast", variants: { fast: { reasoningEffort: "low" } } } }] },
    { ...provider, models: [...provider.models, ...provider.models] },
    { ...provider, models: [{ ...provider.models[0], config: { experimental: { modes: { fast: { provider: { body: { service_tier: "ultrafast" } } } } } } }] },
  ]) assert.throws(() => assertWorkshopModel(profile, value), /BLOCKED/);
});

test("real recording proxy rejects missing Fast instead of injecting it; records no prompts or secrets", async () => {
  await using stack = new AsyncDisposableStack();
  let calls = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "paid-secret-fixture", {
    maxOutputTokens: 64,
    upstreamFetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer paid-secret-fixture");
      assert.equal(new Headers(init?.headers).get("x-caller-secret"), null);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal(body.service_tier, "priority");
      assert.equal(body.max_output_tokens, 64);
      assert.equal(body.store, false);
      assert.equal(body.reasoning, undefined, "Fast/default must not secretly reduce reasoning");
      return Response.json({ status: "completed", model: body.model, service_tier: "fast", reasoning: { effort: "medium" },
        output: [{ type: "function_call", name: "fixture" }], usage: { input_tokens: 17, output_tokens: 8, output_tokens_details: { reasoning_tokens: 2 } } });
    },
  });
  assert.equal(calls, 0, "creating a proxy does not run paid inference");
  assert.equal(proxy.provider.npm, "@ai-sdk/openai");
  assert.equal(proxy.variant, FAST_DEFAULT_VARIANT);
  const headers = { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json", "x-caller-secret": "never-forward" };
  const missing = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ model: proxy.modelId, input: "private prompt sentinel" }) });
  assert.equal(missing.status, 400);
  assert.equal(calls, 0);
  assert.equal(proxy.witnesses[0].rejection, "missing-priority-Fast-request-option");
  const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ model: proxy.modelId, input: "private prompt sentinel", service_tier: "priority", max_output_tokens: 1024 }) });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(calls, 1);
  const witness = proxy.witnesses[1];
  assert.equal(witness.status, "completed");
  assert.equal(witness.requestedServiceTier, "priority");
  assert.equal(witness.returnedServiceTier, "fast");
  assert.equal(witness.returnedReasoningEffort, "medium");
  assert.equal(witness.inputTokens, 17);
  assert.equal(witness.outputTokens, 8);
  assert.equal(witness.reasoningTokens, 2);
  assert.equal(witness.costStatus, "estimated-not-billed");
  assert.ok(witness.estimatedUsd !== null);
  for (const secret of ["private prompt sentinel", "paid-secret-fixture", "never-forward", proxy.provider.options.apiKey]) assert.equal(JSON.stringify(proxy.witnesses).includes(secret), false);
});

test("Qwen recording supports streamed tools/usage without assuming Fast or calling on startup", async () => {
  await using stack = new AsyncDisposableStack();
  let calls = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "qwen-27b"]), "router-secret-fixture", {
    upstreamFetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.service_tier, undefined);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.equal(body.model, "qwen/qwen3.8-27b");
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"private_fixture"}}]}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":20,"completion_'));
        controller.enqueue(encoder.encode('tokens":9,"cost":0.000031,"completion_tokens_details":{"reasoning_tokens":3}}}\n\ndata: [DONE]\n\n'));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(calls, 0);
  assert.equal(proxy.provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(proxy.variant, undefined);
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, messages: [{ role: "user", content: "private prompt" }], stream: true }) });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("private_fixture"), "real tool deltas reach the client unchanged");
  assert.equal(calls, 1);
  assert.equal(proxy.witnesses[0].inputTokens, 20);
  assert.equal(proxy.witnesses[0].outputTokens, 9);
  assert.equal(proxy.witnesses[0].reportedCostUsd, 0.000031);
  assert.equal(proxy.witnesses[0].requestedServiceTier, null);
  assert.equal(proxy.witnesses[0].variantEvidence, "not-fast");
  assert.equal(proxy.witnesses[0].status, "completed");
  assert.equal(proxy.witnesses[0].terminalEvent, "[DONE]");
  assert.equal(proxy.witnesses[0].finishReason, "tool_calls");
  assert.equal(proxy.witnesses[0].eventCount, 4);
  assert.deepEqual(proxy.witnesses[0].functionCalls, [{ name: "private_fixture", callId: null }]);
});

test("proxy refuses foreign routes/models/auth and does not forward sensitive upstream errors", async () => {
  await using stack = new AsyncDisposableStack();
  let calls = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "paid-key-fixture", {
    maxRequests: 4,
    upstreamFetch: async () => { calls++; return Response.json({ error: "paid-key-fixture private-prompt-fixture" }, { status: 401 }); },
  });
  const headers = { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" };
  assert.equal((await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(proxy.witnesses.length, 0);
  assert.equal((await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal((await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-4.1", service_tier: "priority" }) })).status, 400);
  assert.equal(calls, 0);
  const error = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority" }) });
  assert.equal(error.status, 502);
  assert.equal((await error.text()).includes("paid-key-fixture"), false);
  assert.equal(calls, 1);
  assert.equal(proxy.witnesses[2].httpStatus, 401);
  assert.equal(proxy.witnesses[2].status, "upstream-error");
  await proxy.stop();
  await proxy.stop();
});

test("proxy request/output budgets fail closed without additional upstream calls", async () => {
  await using stack = new AsyncDisposableStack();
  let calls = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "paid-fixture", {
    maxRequests: 2, maxOutputTokens: 8, maxTotalOutputTokens: 8,
    upstreamFetch: async () => { calls++; return Response.json({ usage: { input_tokens: 1, output_tokens: 8 }, status: "completed" }); },
  });
  const options = { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority" }) };
  await (await fetch(`${proxy.baseUrl}/responses`, options)).text();
  assert.equal(calls, 1);
  const exhausted = await fetch(`${proxy.baseUrl}/responses`, options);
  assert.equal(exhausted.status, 429);
  assert.equal(calls, 1);
  assert.deepEqual(proxy.status(), { status: "blocked", reason: "output-token-budget-exhausted" });
  assert.equal((await fetch(`${proxy.baseUrl}/responses`, options)).status, 429);
  assert.equal(calls, 1);
  assert.equal(proxy.witnesses.length, 2, "ledger itself stays bounded");
});

test("proxy never sends paid credentials to a modified profile endpoint", async () => {
  await using stack = new AsyncDisposableStack();
  await assert.rejects(() => startWorkshopInferenceProxy(stack, { ...workshopModelProfile(["--model-profile", "gpt-sol-fast"]), upstream: "https://example.test" }, "paid-fixture"), /Untrusted/);
});

test("bounded simultaneous delegates are allowed and a null Responses error is successful", async () => {
  await using stack = new AsyncDisposableStack();
  let active = 0, peak = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "paid-secret-fixture", { upstreamFetch: async () => {
    active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 40)); active--;
    return new Response(JSON.stringify({ model: "gpt-6.1-sol", service_tier: "fast", status: "completed", error: null, output: [], usage: { input_tokens: 2, output_tokens: 3 } }), { headers: { "content-type": "application/json" } });
  } });
  const call = () => fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority", input: "Transport regression only" }) }).then(async (response) => { await response.text(); return response.status; });
  assert.deepEqual(await Promise.all([call(), call()]), [200, 200]);
  assert.equal(peak, 2);
  assert.ok(proxy.witnesses.every((entry) => entry.status === "completed"));
});

test("Responses EOF without response.completed is interrupted, not a completed witness", async () => {
  await using stack = new AsyncDisposableStack();
  const stream = 'data: {"type":"response.created","response":{"status":"in_progress"}}\n\ndata: {"type":"response.output_text.delta","delta":"private-output-sentinel"}\n\n';
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "fixture-key", {
    upstreamFetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority", stream: true }) });
  assert.equal(await response.text(), stream, "diagnostics do not rewrite upstream protocol bytes");
  assert.equal(proxy.witnesses[0].status, "interrupted");
  assert.equal(proxy.witnesses[0].responseStatus, "in_progress");
  assert.equal(proxy.witnesses[0].terminalEvent, null);
  assert.equal(proxy.witnesses[0].eofSeen, true);
  assert.equal(proxy.witnesses[0].eventCount, 2);
  assert.deepEqual(proxy.status(), { status: "blocked", reason: "missing-protocol-terminal" });
  assert.equal(JSON.stringify(proxy.witnesses).includes("private-output-sentinel"), false);
});

for (const fixture of [
  { name: "Responses complete", profile: "gpt-sol-fast", events: [{ type: "response.completed", response: { status: "completed", error: null } }], done: false, expected: "completed", terminal: "response.completed" },
  { name: "Responses status alone is not a terminal", profile: "gpt-sol-fast", events: [{ type: "response.created", response: { status: "completed" } }], done: false, expected: "interrupted", terminal: null },
  { name: "Responses completed event requires completed status", profile: "gpt-sol-fast", events: [{ type: "response.completed", response: { status: "in_progress" } }], done: false, expected: "upstream-error", terminal: "response.completed" },
  { name: "Responses incomplete", profile: "gpt-sol-fast", events: [{ type: "response.incomplete", response: { status: "incomplete" } }], done: false, expected: "upstream-error", terminal: "response.incomplete" },
  { name: "Responses failed", profile: "gpt-sol-fast", events: [{ type: "response.failed", response: { status: "failed", error: { message: "private-error" } } }], done: false, expected: "upstream-error", terminal: "response.failed" },
  { name: "Responses error cannot be undone by completion", profile: "gpt-sol-fast", events: [{ type: "error", error: { message: "private-error" } }, { type: "response.completed", response: { status: "completed" } }], done: false, expected: "upstream-error", terminal: "response.completed" },
  { name: "Chat finish plus DONE", profile: "qwen-27b", events: [{ choices: [{ finish_reason: "stop", delta: {} }] }], done: true, expected: "completed", terminal: "[DONE]" },
  { name: "Chat finish without DONE", profile: "qwen-27b", events: [{ choices: [{ finish_reason: "stop", delta: {} }] }], done: false, expected: "interrupted", terminal: null },
  { name: "Chat DONE without finish", profile: "qwen-27b", events: [{ choices: [{ delta: { content: "private-output" } }] }], done: true, expected: "interrupted", terminal: "[DONE]" },
  { name: "Chat error with DONE", profile: "qwen-27b", events: [{ error: { message: "private-error" } }], done: true, expected: "upstream-error", terminal: "[DONE]" },
]) test(`stream terminal protocol: ${fixture.name}`, async () => {
  await using stack = new AsyncDisposableStack();
  const stream = fixture.events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + (fixture.done ? "data: [DONE]\r\n\r\n" : "");
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", fixture.profile]), "fixture-secret", {
    upstreamFetch: async () => new Response(new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(stream);
      // Exercise terminal JSON and CRLF split across transport chunks.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } }),
  });
  const response = await fetch(`${proxy.baseUrl}${proxy.metadata.profile === "gpt-sol-fast" ? "/responses" : "/chat/completions"}`, {
    method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: proxy.modelId, stream: true, ...(fixture.profile === "gpt-sol-fast" ? { service_tier: "priority" } : {}) }),
  });
  assert.equal(await response.text(), stream);
  const witness = proxy.witnesses[0];
  assert.equal(witness.status, fixture.expected);
  assert.equal(witness.terminalEvent, fixture.terminal);
  assert.equal(witness.eofSeen, true);
  assert.equal(witness.eventCount, fixture.events.length + Number(fixture.done));
  for (const secret of ["fixture-secret", "private-error", "private-output"]) assert.equal(JSON.stringify(witness).includes(secret), false);
});

test("stream transport failure is interrupted with no EOF and no raw error retained", async () => {
  await using stack = new AsyncDisposableStack();
  let chunks = 0;
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "fixture-key", {
    upstreamFetch: async () => new Response(new ReadableStream({ pull(controller) {
      if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'));
      else controller.error(new Error("private-transport-secret"));
    } }), { headers: { "content-type": "text/event-stream" } }),
  });
  await assert.rejects(async () => {
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority", stream: true }) });
    await response.text();
  });
  assert.equal(proxy.witnesses[0].status, "interrupted");
  assert.equal(proxy.witnesses[0].eofSeen, false);
  assert.equal(proxy.witnesses[0].terminalEvent, null);
  assert.equal(JSON.stringify(proxy.witnesses).includes("private-transport-secret"), false);
});

test("function diagnostics retain bounded names/call IDs, never arguments, outputs or response IDs", async () => {
  await using stack = new AsyncDisposableStack();
  const calls = Array.from({ length: 40 }, (_, i) => ({ type: "function_call", name: `fixture_${i}`, call_id: `call_${i}`, arguments: "argument-secret" }));
  const events = [
    { type: "response.output_item.added", item: calls[0] },
    { type: "response.output_item.done", item: calls[0] },
    { type: "response.function_call_arguments.delta", delta: "delta-secret" },
    { type: "response.completed", response: { status: "completed", id: "response-id-not-retained", output: [...calls,
      { type: "message", content: [{ text: "text-secret" }] }, { type: "function_call_output", output: "output-secret" }] } },
  ];
  const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", "gpt-sol-fast"]), "fixture-secret", {
    upstreamFetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: proxy.modelId, service_tier: "priority", stream: true, input: "prompt-secret" }) });
  assert.equal(await response.text(), stream);
  const witness = proxy.witnesses[0];
  assert.equal(witness.status, "completed");
  assert.equal(witness.functionCalls.length, 32);
  assert.deepEqual(witness.functionCalls[0], { name: "fixture_0", callId: "call_0" });
  for (const secret of ["argument-secret", "delta-secret", "text-secret", "output-secret", "prompt-secret", "response-id-not-retained", "fixture-secret"]) assert.equal(JSON.stringify(witness).includes(secret), false);
});

for (const fixture of [
  { name: "Responses complete JSON", profile: "gpt-sol-fast", body: { status: "completed", error: null }, expected: "completed" },
  { name: "Responses incomplete JSON", profile: "gpt-sol-fast", body: { status: "incomplete" }, expected: "upstream-error" },
  { name: "Responses missing status JSON", profile: "gpt-sol-fast", body: { output: [] }, expected: "interrupted" },
  { name: "Chat complete JSON", profile: "qwen-27b", body: { choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "fixture_tool", arguments: "private-arguments" } }] }, finish_reason: "tool_calls" }] }, expected: "completed" },
  { name: "Chat missing finish JSON", profile: "qwen-27b", body: { choices: [{ message: { content: "private-text" } }] }, expected: "interrupted" },
]) test(`nonstream terminal protocol: ${fixture.name}`, async () => {
  await using stack = new AsyncDisposableStack();
  const proxy = await startWorkshopInferenceProxy(stack, workshopModelProfile(["--model-profile", fixture.profile]), "fixture-key", {
    upstreamFetch: async () => Response.json(fixture.body),
  });
  const response = await fetch(`${proxy.baseUrl}${fixture.profile === "gpt-sol-fast" ? "/responses" : "/chat/completions"}`, {
    method: "POST", headers: { authorization: `Bearer ${proxy.provider.options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: proxy.modelId, ...(fixture.profile === "gpt-sol-fast" ? { service_tier: "priority" } : {}) }),
  });
  assert.deepEqual(await response.json(), fixture.body);
  assert.equal(proxy.witnesses[0].status, fixture.expected);
  assert.equal(proxy.witnesses[0].eofSeen, true);
  assert.equal(proxy.witnesses[0].eventCount, 0);
  assert.equal(proxy.witnesses[0].terminalEvent, null);
  if (fixture.name === "Chat complete JSON") assert.deepEqual(proxy.witnesses[0].functionCalls, [{ name: "fixture_tool", callId: "call_1" }]);
  assert.equal(JSON.stringify(proxy.witnesses).includes("private-"), false);
});

test("Qwen selection is exact and does not inherit GPT Fast", () => {
  const profile = workshopModelProfile(["--model-profile", "qwen-27b"]);
  assert.equal(assertWorkshopModel(profile, { models: [{ id: "qwen-alias", upstreamModelId: profile.model, config: {} }] }).id, "qwen-alias");
  assert.throws(() => assertWorkshopModel(profile, { models: [{ id: "qwen3-other", upstreamModelId: "qwen/qwen3-32b", config: {} }] }), /BLOCKED/);
});
