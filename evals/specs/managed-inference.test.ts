import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { bootManagedInference } from "../worlds/managed-inference.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function events(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6))).filter(record);
}

test("managed inference preserves completion, access, cancellation, and usage identity", { timeout: 240000 }, async ({ place, evidence }) => {
  needs({ placement: "local" });
  await using world = await bootManagedInference(place);
  const [first, teammate, other] = world.identities;
  if (!first || !teammate || !other) throw new Error("Missing fixture identities");
  const model = "z-ai/glm-5.2";
  const message = { role: "user", content: "private fixture prompt" };
  const headers = (key = first.key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
  const chat = (body: Record<string, unknown> = {}, key = first.key, signal: AbortSignal = AbortSignal.timeout(10000)) => fetch(`${world.url}/api/v1/chat/completions`, {
    method: "POST", headers: headers(key), signal, body: JSON.stringify({ model, messages: [message], stream: true, ...body }),
  });
  const claim = (name: string, detail: string) => evidence.recordAssertionEvidence(name, detail, true);
  const legacy = await world.rows("SELECT cost_amount,provider_usage FROM inference_usage_ledger_entries WHERE external_job_id='legacy-fixture'");
  expect(legacy).toMatchObject([{ cost_amount: 123, provider_usage: null }]);
  claim("The additive migration preserves existing ledger data", "The actual migration adds nullable provider usage to a database containing a legacy ledger entry; its original amount remains unchanged and unknown historical usage remains null.");

  const catalogResponse = await fetch(`${world.url}/api/v1/models`, { headers: headers(), signal: AbortSignal.timeout(10000) });
  const catalog = await catalogResponse.json();
  expect(catalogResponse.status).toBe(200);
  expect(catalog.data).toHaveLength(9);
  const expectedModels = [
    { id: "z-ai/glm-5.2", context: 1048576, output: 131072, inputs: ["text"], mandatory: false, efforts: ["high", "xhigh"] },
    { id: "moonshotai/kimi-k2.7-code", context: 262144, output: 235929, inputs: ["text", "image"], mandatory: true, efforts: [] },
    { id: "tencent/hy3-preview", context: 262144, output: 235929, inputs: ["text"], mandatory: false, efforts: ["high", "low", "none"] },
    { id: "moonshotai/kimi-k2.6", context: 262144, output: 235929, inputs: ["text", "image"], mandatory: false, efforts: [] },
    { id: "deepseek/deepseek-v4-flash", context: 1024000, output: 384000, inputs: ["text"], mandatory: false, efforts: ["high", "xhigh"] },
    { id: "minimax/minimax-m2.7", context: 204800, output: 131072, inputs: ["text"], mandatory: true, efforts: [] },
    { id: "minimax/minimax-m3", context: 524288, output: 512000, inputs: ["text", "image"], mandatory: false, efforts: [] },
    { id: "z-ai/glm-5.1", context: 200000, output: 128000, inputs: ["text"], mandatory: false, efforts: [] },
    { id: "moonshotai/kimi-k3", context: 1048576, output: 943718, inputs: ["text", "image"], mandatory: false, efforts: ["low", "high", "max"] },
  ];
  expect(catalog.data.map((entry: { id: string }) => entry.id).sort()).toEqual(expectedModels.map((entry) => entry.id).sort());
  for (const expected of expectedModels) {
    expect(catalog.data.find((entry: { id: string }) => entry.id === expected.id)).toMatchObject({
      context_length: expected.context, top_provider: { max_completion_tokens: expected.output },
      architecture: { input_modalities: expected.inputs, output_modalities: ["text"] },
      reasoning: { mandatory: expected.mandatory, supported_efforts: expect.arrayContaining(expected.efforts) },
      supported_parameters: expect.arrayContaining(["tools", "reasoning"]),
    });
    expect(catalog.data.find((entry: { id: string }) => entry.id === expected.id).reasoning.supported_efforts).toHaveLength(expected.efforts.length);
  }
  expect(catalog.data.find((item: { id: string }) => item.id === model)).toMatchObject({ context_length: 1048576, top_provider: { max_completion_tokens: 131072 }, architecture: { input_modalities: ["text"] } });
  const response = await chat();
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text.match(/Complete café/g)).toHaveLength(1);
  expect(text.match(/\[DONE\]/g)).toHaveLength(1);
  expect(events(text).find((event) => event.usage)?.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } });
  const original = world.witness.requests[0];
  expect(original?.credential).toBe(`Bearer ${first.providerKey}`);
  expect(original?.body).toMatchObject({ model, user: first.memberId, provider: { allow_fallbacks: false, require_parameters: true }, transforms: [] });
  const delayedResponse = await chat();
  expect(delayedResponse.status).toBe(200);
  expect(await delayedResponse.text()).toContain("[DONE]");
  const delayedRequest = world.witness.requests.at(-1);
  const delayedTrace = delayedRequest?.body.trace;
  if (!delayedRequest || !record(delayedTrace)) throw new Error("Missing admitted delayed-usage request");
  const delayedRequestId = String(delayedRequest.body.session_id);
  expect(delayedRequestId).toBe(delayedResponse.headers.get("x-openwork-request-id"));
  claim("Catalog and successful streaming agree", "The authenticated catalog has nine models; streamed UTF-8 text is preserved once, with a completion marker and provider usage details.");

  world.witness.mode("tools");
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } } }];
  const toolText = await (await chat({ tools })).text();
  const toolEvents = events(toolText);
  const argumentsParts = toolEvents.flatMap((event) => Array.isArray(event.choices) ? event.choices : []).flatMap((choice) => record(choice) && record(choice.delta) && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []).flatMap((call) => record(call) && record(call.function) && typeof call.function.arguments === "string" ? [call.function.arguments] : []);
  expect(JSON.parse(argumentsParts.join(""))).toEqual({ key: "value" });
  expect(toolText).toContain("Fixture reasoning");
  expect(toolText).toContain("[DONE]");
  world.witness.mode("success");
  const history = [message, { role: "assistant", content: null, reasoning_details: [{ type: "reasoning.text", text: "Fixture reasoning" }], tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":"value"}' } }] }, { role: "tool", tool_call_id: "call_1", content: "Fixture result" }];
  expect(await (await chat({ messages: history, tools })).text()).toContain("[DONE]");
  expect(world.witness.requests.at(-1)?.body.messages).toEqual(history);
  const noParameterTools = [{ type: "function", function: { name: "clock" } }];
  const optionalTools = await chat({ tools: noParameterTools, messages: [message, { role: "assistant", content: "Earlier text", tool_calls: null }, message] });
  expect(optionalTools.status).toBe(200);
  expect(await optionalTools.text()).toContain("[DONE]");
  expect(world.witness.requests.at(-1)?.body.tools).toEqual(noParameterTools);
  claim("Tool-call fragments and reasoning remain distinct", "Fragmented arguments assemble into the expected JSON; assistant reasoning and matching tool results return upstream unchanged.");

  world.witness.mode("engine-tool");
  const engine = await world.bootEngine();
  const providers = await engine.engine("GET", "/provider");
  if (!record(providers) || !Array.isArray(providers.all)) throw new Error("Missing engine model catalog");
  const managed = providers.all.find((provider) => record(provider) && provider.id === "openwork");
  expect(managed).toMatchObject({ models: { [model]: { cost: { input: 0.966, output: 3.036, cache: { read: 0.1932 } } } } });
  expect(managed).toMatchObject({ models: { [model]: { limit: { context: 1048576, output: 131072 }, variants: { high: { reasoning: { effort: "high" } }, xhigh: { reasoning: { effort: "xhigh" } } } } } });
  const session = await engine.engine("POST", "/session", { title: "Managed inference tool task" });
  if (!record(session) || typeof session.id !== "string") throw new Error("Missing engine session");
  const savedConfig = await engine.engine("GET", "/config");
  if (!record(savedConfig) || !record(savedConfig.agent) || !record(savedConfig.agent["saved-reasoning"])) throw new Error("Missing saved reasoning configuration");
  const savedVariant = savedConfig.agent["saved-reasoning"].variant;
  expect(savedVariant).toBe("medium");
  const persistedBefore = await engine.savedConfig();
  const beforeStale = world.witness.requests.length;
  await expect(engine.engine("POST", `/session/${session.id}/message`, { model: { providerID: "openwork", modelID: model }, agent: "saved-reasoning", variant: savedVariant, parts: [{ type: "text", text: "A saved unsupported setting" }] })).rejects.toThrow("saved reasoning setting");
  expect(world.witness.requests.length).toBe(beforeStale);
  expect(await engine.engine("GET", `/session/${session.id}/message`)).toEqual([]);
  expect(await engine.engine("GET", "/config")).toMatchObject({ agent: { "saved-reasoning": { variant: "medium" } } });
  expect(await engine.savedConfig()).toBe(persistedBefore);
  const engineResult = await engine.engine("POST", `/session/${session.id}/message`, { model: { providerID: "openwork", modelID: model }, variant: "high", parts: [{ type: "text", text: "Read the managed inference fixture and finish." }] });
  expect(engineResult, engine.output().slice(-2000)).toMatchObject({ parts: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Complete café" })]) });
  expect(record(engineResult) && record(engineResult.info) ? engineResult.info.cost : null).toBeGreaterThan(0);
  const toolRequests = world.witness.requests.slice(beforeStale).filter((request) => Array.isArray(request.body.tools) && request.body.tools.length);
  expect(toolRequests.length).toBeGreaterThanOrEqual(2);
  expect(toolRequests.every((request) => record(request.body.reasoning) && request.body.reasoning.effort === "high")).toBe(true);
  const transcript = await engine.engine("GET", `/session/${session.id}/message`);
  const toolParts = Array.isArray(transcript) ? transcript.filter(record).flatMap((message) => Array.isArray(message.parts) ? message.parts.filter(record) : []).filter((part) => part.type === "tool") : [];
  expect(toolParts.filter((part) => part.tool === "read")).toHaveLength(1);
  expect(toolParts[0]).toMatchObject({ state: { status: "completed", output: expect.stringContaining("Managed inference tool result") } });
  claim("A real managed engine task completes its tool exactly once", "The running OpenCode engine sees the shared context/output limits and supported reasoning variants; its fragmented Read call executes once, returns the file result through managed inference, and finishes with persisted assistant text.");
  claim("Engine cost estimates remain separate from settled usage", "The engine receives the verified input/output/cache prices and records a positive estimate for a paid-model run; allowance charging is independently checked against provider-reported monetary usage.");
  claim("Saved unsupported reasoning requires an explicit new choice", "The real server rejects a saved medium effort for GLM-5.2 before the engine or provider can substitute a default; a supported high effort completes.");

  world.witness.mode("interrupted");
  const interrupted = await engine.engine("POST", "/session", { title: "Interrupted managed task" });
  if (!record(interrupted) || typeof interrupted.id !== "string") throw new Error("Missing interrupted session");
  const partial = await engine.engine("POST", `/session/${interrupted.id}/message`, { model: { providerID: "openwork", modelID: model }, parts: [{ type: "text", text: "Keep the partial result." }] });
  expect(partial).toMatchObject({ info: { error: expect.anything() }, parts: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Partial" })]) });
  const statuses = await engine.engine("GET", "/session/status");
  expect(record(statuses) ? statuses[interrupted.id] : null).not.toMatchObject({ type: "busy" });
  claim("The real engine preserves interrupted work and leaves the active state", "A provider EOF becomes a persisted session error with its partial text; the engine no longer reports the session as busy.");

  world.witness.mode("json");
  const jsonResponse = await chat({ stream: false });
  expect(jsonResponse.status).toBe(200);
  expect(await jsonResponse.json()).toMatchObject({ choices: [{ message: { content: "Complete" }, finish_reason: "stop" }], usage: { total_tokens: 24 } });
  for (const mode of ["json-empty-tools", "json-null-tools"] as const) {
    world.witness.mode(mode);
    const ordinaryText = await chat({ stream: false });
    expect(ordinaryText.status).toBe(200);
    expect(await ordinaryText.json()).toMatchObject({ choices: [{ message: { content: "Complete" }, finish_reason: "stop" }] });
  }
  world.witness.mode("incomplete-json");
  const incompleteJson = await chat({ stream: false });
  expect(incompleteJson.status).toBe(502);
  expect(await incompleteJson.json()).toMatchObject({ error: { code: "upstream_incomplete" } });
  claim("Non-streaming responses require complete content too", "A complete JSON response retains text and usage, while an HTTP 200 with unfinished tool arguments returns an explicit incomplete-response error.");

  for (const mode of ["interrupted", "malformed", "incomplete-tools", "missing-tools", "duplicate-tools", "extra-choice", "stall"] as const) {
    world.witness.mode(mode);
    const failure = await (await chat()).text();
    expect(failure).toContain('"error"');
    expect(failure).not.toContain("[DONE]");
    if (mode !== "incomplete-tools" && mode !== "duplicate-tools") expect(failure).toContain("Partial");
    if (mode === "incomplete-tools") {
      expect(failure).toContain("Fixture reasoning");
      expect(events(failure)).toEqual(expect.arrayContaining([expect.objectContaining({ choices: expect.arrayContaining([expect.objectContaining({ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":' } }] } })]) })]));
    }
    expect(failure).not.toContain("Unrequested second choice");
  }
  claim("Interrupted streams cannot appear successful", "EOF, invalid JSON, unfinished tool arguments, and a stalled provider preserve valid partial output and return an error without a success marker.");

  world.witness.mode("stall");
  const abort = new AbortController();
  const cancelling = await chat({}, first.key, abort.signal);
  const reader = cancelling.body!.getReader();
  await reader.read();
  const cancellingRequest = world.witness.requests.at(-1)!;
  abort.abort();
  await reader.cancel().catch(() => {});
  await eventually(async () => cancellingRequest.cancelled, { within: 5000, intervalMs: 50 });
  expect(cancellingRequest.cancelled).toBe(true);
  claim("Cancellation reaches the provider", "Cancelling the client connection closes the real upstream HTTP connection.");

  for (const [mode, status] of [["rate-limit", 429], ["access-denied", 401]] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const failure = await chat();
    expect(failure.status).toBe(status);
    expect(failure.headers.get("retry-after")).toBe("7");
    expect(await failure.text()).not.toContain("private provider");
    expect(world.witness.requests.length).toBe(count + 1);
  }
  claim("Failures are bounded and do not replay requests", "Rate limiting and upstream access denial preserve Retry-After, expose safe guidance, and send exactly one upstream request.");

  world.witness.mode("success");
  const beforeInvalid = world.witness.requests.length;
  for (const body of [{ messages: [] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] }, { max_tokens: 131073 }, { reasoning: { effort: "high", max_tokens: 100 } }, { messages: [{ role: "tool", tool_call_id: "missing", content: "result" }] }, { models: ["another/model"] }]) {
    expect((await chat(body)).status).toBe(400);
  }
  expect((await chat({}, "invalid-key")).status).toBe(401);
  expect(world.witness.requests.length).toBe(beforeInvalid);
  await (await chat({ user: first.memberId, trace: { inference_key_id: first.keyId } }, teammate.key)).text();
  expect(world.witness.requests.at(-1)?.body).toMatchObject({ user: teammate.memberId, trace: { inference_key_id: teammate.keyId, org_membership_id: teammate.memberId } });
  await (await chat({}, other.key)).text();
  expect(world.witness.requests.at(-1)?.credential).toBe(`Bearer ${other.providerKey}`);
  expect(world.witness.requests.at(-1)?.credential).not.toBe(`Bearer ${first.providerKey}`);
  await world.change("UPDATE member SET removed_at=NOW(3) WHERE id=?", [teammate.memberId]);
  expect((await chat({}, teammate.key)).status).toBe(401);
  claim("Access and capability failures never borrow another identity", "Invalid inputs do not reach upstream; trace ownership is server-assigned; separate organizations use separate keys; a removed member is rejected.");

  const trace = original?.body.trace;
  if (!record(trace)) throw new Error("Missing request correlation trace");
  const attribute = (key: string, value: string | number) => ({ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: value } });
  const usage = (event: string, identity = first, reportedModel = model, requestId = String(original?.body.session_id), admission = trace) => ({ resourceSpans: [{ scopeSpans: [{ spans: [{ startTimeUnixNano: `${BigInt(Date.now()) * 1000000n}`, attributes: [
    attribute("trace.inference_key_id", identity.keyId), attribute("trace.org_membership_id", identity.memberId),
    attribute("trace.openwork_request_id", requestId), attribute("trace.usage_started_at", identity === first ? String(admission.usage_started_at) : new Date().toISOString()),
    attribute("event_id", event), attribute("gen_ai.request.model", model), attribute("gen_ai.response.model", reportedModel),
    attribute("gen_ai.usage.input_cost", 0.01), attribute("gen_ai.usage.output_cost", 0.02), attribute("gen_ai.usage.currency", "USD"),
    attribute("gen_ai.usage.input_tokens", 11), attribute("gen_ai.usage.output_tokens", 13), attribute("gen_ai.usage.total_tokens", 24),
    attribute("gen_ai.usage.cached_tokens", 5), attribute("gen_ai.usage.reasoning_tokens", 3),
  ] }] }] }] });
  const settle = (body: unknown) => fetch(`${world.url}/webhooks/openrouter`, { method: "POST", headers: { authorization: "Bearer fixture-webhook-secret", "content-type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify(body) });
  // Exhaust one window before settlement: usage must still reach all three.
  await world.change("UPDATE inference_org_usage_buckets b JOIN inference_org_limit_policies p ON b.policy_id=p.id SET b.used_amount=b.limit_amount WHERE b.organization_id=? AND p.window_type='five_hour'", [first.organizationId]);
  const before = await world.rows("SELECT id,used_amount FROM inference_org_usage_buckets WHERE organization_id=? ORDER BY id", [first.organizationId]);
  const deliveries = await Promise.all([settle(usage("event-1")), settle(usage("event-1")), settle(usage("event-1"))]);
  expect(deliveries.map((item) => item.status)).toEqual([200, 200, 200]);
  const after = await world.rows("SELECT id,used_amount FROM inference_org_usage_buckets WHERE organization_id=? ORDER BY id", [first.organizationId]);
  expect(after.map((row, index) => Number(row.used_amount) - Number(before[index]?.used_amount))).toEqual([3000000, 3000000, 3000000]);
  const ledger = await world.rows("SELECT organization_id,org_membership_id,input_tokens,provider_usage FROM inference_usage_ledger_entries WHERE external_job_id=?", [String(original?.body.session_id)]);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ organization_id: first.organizationId, org_membership_id: first.memberId, input_tokens: 11, provider_usage: { status: "settled", inputCost: 0.01, outputCost: 0.02, cacheReadTokens: 5, reasoningTokens: 3 } });
  expect(await world.rows("SELECT id FROM inference_usage_ledger_entries WHERE organization_id=?", [other.organizationId])).toHaveLength(0);
  expect((await settle(usage("event-1", other))).status).toBe(503);
  expect(await world.rows("SELECT id FROM inference_usage_ledger_entries WHERE organization_id=?", [other.organizationId])).toHaveLength(0);
  claim("Provider usage settles exactly once in every window", "Three concurrent deliveries produce one ledger entry and one charge in each window, including the exhausted window. A colliding event from another identity is rejected.");

  // Represent a delivery from the old partial-settlement path: keep the ledger
  // and two charges, then prove redelivery fills only the missing charge.
  const charges = await world.rows("SELECT c.id,c.bucket_id,c.amount FROM inference_usage_ledger_bucket_charges c JOIN inference_usage_ledger_entries e ON e.id=c.ledger_entry_id WHERE e.external_job_id=? ORDER BY c.id", [String(original?.body.session_id)]);
  const missing = charges[0];
  if (!missing) throw new Error("Missing settled charge");
  await world.change("DELETE FROM inference_usage_ledger_bucket_charges WHERE id=?", [String(missing.id)]);
  await world.change("UPDATE inference_org_usage_buckets SET used_amount=used_amount-? WHERE id=?", [Number(missing.amount), String(missing.bucket_id)]);
  expect((await settle(usage("event-1"))).status).toBe(200);
  expect(await world.rows("SELECT id,used_amount FROM inference_org_usage_buckets WHERE organization_id=? ORDER BY id", [first.organizationId])).toEqual(after);
  claim("Redelivery repairs partial settlement without double charging", "With a durable ledger row and only two prior bucket charges, replay restores the missing charge and preserves the other two.");

  expect((await settle(usage("unknown-model", first, "provider/new-version", "unknown-model-request"))).status).toBe(200);
  const missingCost = usage("missing-cost", first, model, "missing-cost-request");
  const missingSpan = missingCost.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  missingSpan.attributes = missingSpan.attributes.filter((item) => item.key !== "gen_ai.usage.output_cost");
  missingSpan.attributes.push(attribute("gen_ai.usage.input_cost", " "));
  expect((await settle(missingCost)).status).toBe(200);
  const unpriced = await world.rows("SELECT external_job_id,cost_amount,provider_usage FROM inference_usage_ledger_entries WHERE organization_id=? AND event_type='openrouter_usage_unpriced'", [first.organizationId]);
  expect(unpriced).toHaveLength(2);
  expect(unpriced.every((row) => Number(row.cost_amount) === 0 && record(row.provider_usage) && row.provider_usage.status === "unpriced")).toBe(true);
  expect(unpriced.find((row) => row.external_job_id === "unknown-model-request")).toMatchObject({ provider_usage: { responseModel: "provider/new-version", inputCost: 0.01, outputCost: 0.02 } });
  expect(unpriced.find((row) => row.external_job_id === "missing-cost-request")).toMatchObject({ provider_usage: { inputCost: null, outputCost: null } });
  expect(await world.rows("SELECT id,used_amount FROM inference_org_usage_buckets WHERE organization_id=? ORDER BY id", [first.organizationId])).toEqual(after);
  claim("Unknown usage is retained without fabricated charges", "An unknown model retains its reported monetary costs but gets no allowance charge; absent or blank monetary costs remain null. Both records are identified individually, remain unpriced, and leave allowance totals unchanged.");

  const count = world.witness.requests.length;
  const exhausted = await chat();
  expect(exhausted.status).toBe(429);
  expect(exhausted.headers.get("retry-after")).not.toBeNull();
  expect(world.witness.requests.length).toBe(count);
  const unavailable = await fetch(`${world.url}/api/v1/models`, { headers: headers() }).then((item) => item.json());
  expect(unavailable.data).toEqual([]);
  await world.change("DELETE FROM inference_org_limit_policies WHERE organization_id=? AND window_type='weekly'", [other.organizationId]);
  expect((await chat({}, other.key)).status).toBe(403);
  await world.change("UPDATE organization SET metadata=? WHERE id=?", [JSON.stringify({ inference: { enabled: false, tier: "tier1" } }), other.organizationId]);
  expect((await chat({}, other.key)).status).toBe(403);
  claim("Model discovery and execution agree on unavailable access", "Exhausted allowance returns no usable models and rejects execution with a reset time; disabled access fails even with a previously valid tier and key.");

  const historicalEnd = new Date(new Date(String(delayedTrace.usage_started_at)).getTime() + 1000);
  const historicalBefore = await world.rows("SELECT id,used_amount FROM inference_org_usage_buckets WHERE organization_id=? ORDER BY id", [first.organizationId]);
  await world.change("UPDATE inference_org_usage_buckets SET window_end_at=? WHERE organization_id=?", [historicalEnd, first.organizationId]);
  world.witness.mode("success");
  expect(await (await chat()).text()).toContain("[DONE]");
  // A redelivery cannot move an existing charge into a new billing window,
  // even if provider timing metadata has changed since the first delivery.
  const changedTimestamp = usage("event-1");
  const changedSpan = changedTimestamp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  changedSpan.attributes = changedSpan.attributes.map((item) => item.key === "trace.usage_started_at" ? attribute(item.key, new Date().toISOString()) : item);
  expect((await settle(changedTimestamp)).status).toBe(200);
  expect(await world.rows("SELECT c.id FROM inference_usage_ledger_bucket_charges c JOIN inference_usage_ledger_entries e ON e.id=c.ledger_entry_id WHERE e.external_job_id=?", [String(original?.body.session_id)])).toHaveLength(3);
  await world.change("UPDATE inference_keys SET status='revoked',revoked_at=NOW(3) WHERE id=?", [first.keyId]);
  expect((await settle(usage("late-usage", first, model, delayedRequestId, delayedTrace))).status).toBe(200);
  expect(await world.rows("SELECT id FROM inference_usage_ledger_entries WHERE external_job_id=?", [delayedRequestId])).toHaveLength(1);
  const lateCharges = await world.rows("SELECT c.bucket_id,c.amount,b.used_amount FROM inference_usage_ledger_bucket_charges c JOIN inference_usage_ledger_entries e ON e.id=c.ledger_entry_id JOIN inference_org_usage_buckets b ON b.id=c.bucket_id WHERE e.external_job_id=? ORDER BY c.bucket_id", [delayedRequestId]);
  expect(lateCharges).toHaveLength(3);
  expect(lateCharges.map((charge) => charge.bucket_id)).toEqual(historicalBefore.map((bucket) => bucket.id));
  expect(lateCharges.map((charge) => Number(charge.amount))).toEqual([3000000, 3000000, 3000000]);
  expect(lateCharges.map((charge, index) => Number(charge.used_amount) - Number(historicalBefore[index]?.used_amount))).toEqual([3000000, 3000000, 3000000]);
  const currentWindows = await world.rows("SELECT b.used_amount FROM inference_org_usage_buckets b JOIN inference_org_limit_policies p ON p.current_bucket_id=b.id WHERE b.organization_id=?", [first.organizationId]);
  expect(currentWindows).toHaveLength(3);
  expect(currentWindows.every((bucket) => Number(bucket.used_amount) === 0)).toBe(true);
  expect((await chat()).status).toBe(401);
  claim("Delayed usage stays in the original windows after rollover and revocation", "After all windows roll over, usage for an earlier admitted request still settles after key revocation without charging any current window; the same bearer cannot start a new request.");

  expect(world.logs()).not.toContain("private fixture prompt");
  expect(world.logs()).not.toContain("private provider error payload");
  expect(world.logs()).not.toContain(first.key);
  expect(world.logs()).not.toContain(first.providerKey);
  claim("Routine diagnostics exclude private payloads", "Real service logs contain none of the fixture prompt, provider payload, member bearer key, or upstream credential.");
});
