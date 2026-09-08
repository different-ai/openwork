import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { anonymousInferenceWorld } from "../worlds/anonymous-inference.ts";

const test = spec.world(anonymousInferenceWorld, { timeout: 300_000, needs: {} });
const freeModel = "openai/gpt-5.6-luna";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown) { return Array.isArray(value) ? value.map(object) : []; }

async function json(response: Response) { return object(await response.json()); }

async function errorCode(response: Response) {
  const error = object((await json(response)).error);
  return String(error.code);
}

async function issueResponse(url: string, installationId = randomUUID()) {
  return fetch(`${url}/api/anonymous/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function issue(url: string, installationId = randomUUID()) {
  const response = await issueResponse(url, installationId);
  const body = await json(response);
  if (!response.ok || typeof body.token !== "string") throw new Error(`Anonymous session failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  return { token: body.token, installationId, expiresAt: body.expiresAt, model: body.model };
}

function auth(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }

async function complete(url: string, token: string, input: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)) {
  return fetch(`${url}/api/anonymous/v1/chat/completions`, {
    method: "POST", headers: auth(token),
    body: JSON.stringify({ model: freeModel, messages: [{ role: "user", content: "Prove the free model boundary." }], ...input }),
    signal,
  });
}

async function witness(url: string) { return json(await fetch(`${url}/fixture/requests`, { signal: AbortSignal.timeout(5_000) })); }

test("anonymous managed inference is separately authorized and financially bounded", { timeout: 300_000 }, async ({ world, probe, evidence }) => {
  const missing = await fetch(`${world.primaryUrl}/api/anonymous/v1/models`, { signal: AbortSignal.timeout(5_000) });
  expect(missing.status).toBe(401);
  expect(await errorCode(missing)).toBe("invalid_anonymous_token");

  const session = await issue(world.primaryUrl);
  expect(session.expiresAt).toEqual(expect.any(Number));
  expect(session.model).toBe(freeModel);
  const modelsResponse = await fetch(`${world.primaryUrl}/api/anonymous/v1/models`, {
    headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(5_000),
  });
  expect(modelsResponse.status).toBe(200);
  const models = list((await json(modelsResponse)).data);
  expect(models.map((model) => model.id)).toEqual([freeModel]);
  expect(JSON.stringify(models)).not.toContain("deepseek");

  const plain = await complete(world.primaryUrl, session.token, { stream: false });
  expect(plain.status).toBe(200);
  expect(object(list((await json(plain)).choices)[0]?.message).content).toBe("Anonymous Models are working.");
  const allowedTools = [
    { type: "function", function: { name: "alpha", description: "First allowed tool", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "omega", description: "Last allowed tool", parameters: { type: "object", properties: {} } } },
  ];
  const streamed = await complete(world.primaryUrl, session.token, {
    stream: true,
    tools: allowedTools,
    tool_choice: "auto",
    reasoningEffort: "none",
    textVerbosity: "low",
  });
  expect(streamed.status).toBe(200);
  expect(await streamed.text()).toContain("data: [DONE]");
  const observed = list((await witness(world.witnessUrl)).calls);
  expect(observed).toHaveLength(2);
  expect(observed.every((call) => call.authenticated === "anonymous" && call.model === freeModel)).toBe(true);
  expect(observed.every((call) => call.n === undefined && call.maxTokens === 4096 && call.hasPlugins === false)).toBe(true);
  expect(observed.every((call) => {
    const reasoning = object(call.reasoning);
    return reasoning.effort === "none" && reasoning.mode === "standard" && reasoning.exclude === true;
  })).toBe(true);
  expect(observed.every((call) => call.reasoningEffort === undefined && call.textVerbosity === undefined)).toBe(true);
  expect(observed[1]?.verbosity).toBe("low");
  expect(observed.every((call) => object(call.usage).include === true)).toBe(true);
  expect(object(observed[1]?.streamOptions).include_usage).toBe(true);
  expect(observed[1]?.tools).toEqual(allowedTools);
  expect(observed[1]?.toolNames).toEqual(["alpha", "omega"]);
  expect(observed.every((call) => {
    const provider = object(call.provider);
    return provider.allow_fallbacks === false && provider.require_parameters === true
      && provider.data_collection === "deny" && provider.zdr === true
      && JSON.stringify(provider.order) === '["fixture-provider"]' && JSON.stringify(provider.only) === '["fixture-provider"]'
      && object(provider.max_price).prompt === 0.25 && object(provider.max_price).completion === 1.2
      && object(provider.max_price).request === 0 && object(provider.max_price).image === 0;
  })).toBe(true);
  evidence.recordAssertionEvidence("A no-sign-in session exposes and serves only the fixed free model", "The session and HTTP models list contained only GPT-5.6 Luna; JSON and SSE chats reached the independently authenticated witness with exact tools and server-owned standard/no-reasoning, provider-only, no-fallback, ZDR/data, $0.25/M conservative input-class, $1.20/M output, n and token bounds. The genuine SDK none/low hints were accepted, camelCase controls were not forwarded, and textVerbosity became bounded OpenRouter verbosity.", true);

  const forged = await fetch(`${world.primaryUrl}/api/anonymous/v1/models`, { headers: { authorization: `Bearer ${session.token}x` } });
  expect(forged.status).toBe(401); expect(await errorCode(forged)).toBe("invalid_anonymous_token");
  const expiring = await issue(world.expiringUrl);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expired = await fetch(`${world.primaryUrl}/api/anonymous/v1/models`, { headers: { authorization: `Bearer ${expiring.token}` } });
  expect(expired.status).toBe(401); expect(await errorCode(expired)).toBe("invalid_anonymous_token");

  const beforePolicy = list((await witness(world.witnessUrl)).calls).length;
  for (const forbiddenModel of ["deepseek/deepseek-v4-flash", "z-ai/glm-5.2", "openai/gpt-5.6-luna-pro"]) {
    const forbidden = await complete(world.primaryUrl, session.token, { model: forbiddenModel });
    expect(forbidden.status).toBe(403); expect(await errorCode(forbidden)).toBe("anonymous_model_not_allowed");
  }
  for (const override of [
    { provider: { order: ["attacker"] } },
    { reasoning: { effort: "high", mode: "pro" } },
    { reasoningEffort: "medium" },
    { reasoningEffort: "pro" },
    { reasoningEffort: { effort: "none" } },
    { textVerbosity: "max" },
    { textVerbosity: null },
    { plugins: [{ id: "web" }] },
    { tools: [{ type: "openrouter:advisor" }] },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/private" } }] }] },
    { n: 2 },
    { temperature: 0 },
    { max_tokens: 4_097 },
  ]) {
    const rejected = await complete(world.primaryUrl, session.token, override);
    expect([400, 403]).toContain(rejected.status);
  }
  const queryOverride = await fetch(`${world.primaryUrl}/api/anonymous/v1/chat/completions?model=z-ai/glm-5.2`, {
    method: "POST", headers: auth(session.token), body: JSON.stringify({ model: freeModel, messages: [{ role: "user", content: "hello" }] }),
  });
  expect(queryOverride.status).toBe(403); expect(await errorCode(queryOverride)).toBe("anonymous_model_not_allowed");
  const oversizedBody = JSON.stringify({
    model: freeModel,
    messages: Array.from({ length: 3 }, (_, index) => ({ role: "user", content: `${index}:${"x".repeat(44_000)}` })),
  });
  expect(Buffer.byteLength(oversizedBody, "utf8")).toBeLessThan(262_144);
  const oversized = await fetch(`${world.primaryUrl}/api/anonymous/v1/chat/completions`, {
    method: "POST", headers: auth(session.token), body: oversizedBody, signal: AbortSignal.timeout(10_000),
  });
  expect(oversized.status).toBe(400); expect(await errorCode(oversized)).toBe("invalid_request");
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(beforePolicy);
  const expandingNumbers = Array.from({ length: 30_000 }, () => "1e20").join(",");
  const expansionBody = `{"model":"${freeModel}","messages":[{"role":"user","content":"bounded"}],"tools":[{"type":"function","function":{"name":"expanded","parameters":{"type":"object","examples":[${expandingNumbers}]}}}]}`;
  expect(Buffer.byteLength(expansionBody, "utf8")).toBeLessThan(262_144);
  const expanded = await fetch(`${world.primaryUrl}/api/anonymous/v1/chat/completions`, {
    method: "POST", headers: auth(session.token), body: expansionBody, signal: AbortSignal.timeout(10_000),
  });
  expect(expanded.status).toBe(400);
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(beforePolicy);
  const neighboringProxy = await fetch(`${world.trustedNeighborUrl}/api/anonymous/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify({ installationId: randomUUID() }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(neighboringProxy.status).toBe(503); expect(await errorCode(neighboringProxy)).toBe("anonymous_unavailable");

  const paid = await fetch(`${world.primaryUrl}/api/v1/chat/completions`, {
    method: "POST", headers: auth(world.paidKey),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Paid Models remains separate." }], stream: false }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(paid.status).toBe(200);
  expect(list((await witness(world.witnessUrl)).calls).at(-1)).toMatchObject({ authenticated: "paid", model: "z-ai/glm-5.2" });
  evidence.recordAssertionEvidence("Guest authorization and canonical payload boundaries prevent alternate spending paths", "Missing, forged and expired tokens, prior DeepSeek/other/premium/pro model IDs, alternate/pro/malformed reasoningEffort and malformed textVerbosity hints, reasoning/routing/plugin/server-tool/media/n/sampling/token/query overrides, oversized valid messages, a raw-small but canonical-expanded tool schema, and an IPv6-neighbor trusted-hop forgery made zero upstream attempts; the membership-backed paid route still returned 200.", true);

  await world.reset();
  const concurrent = await issue(world.primaryUrl);
  const sameInstallRace = await Promise.all([
    complete(world.primaryUrl, concurrent.token, { stream: true, messages: [{ role: "user", content: "fixture:hold install-a" }] }),
    complete(world.secondaryUrl, concurrent.token, { stream: true, messages: [{ role: "user", content: "fixture:hold install-b" }] }),
  ]);
  expect(sameInstallRace.map((response) => response.status).sort()).toEqual([200, 429]);
  const sameInstallDenied = sameInstallRace.find((response) => response.status === 429);
  expect(sameInstallDenied && await errorCode(sameInstallDenied)).toBe("anonymous_capacity_exceeded");
  await probe.eventually(() => witness(world.witnessUrl), { within: 10_000, label: "one same-install upstream winner", until: (snapshot) => snapshot.waiting === 1 });
  await fetch(`${world.witnessUrl}/fixture/release`, { method: "POST" });
  const sameInstallWinner = sameInstallRace.find((response) => response.status === 200);
  expect(sameInstallWinner && await sameInstallWinner.text()).toContain("[DONE]");

  await world.reset();
  const globalTokens = await Promise.all([issue(world.primaryUrl), issue(world.primaryUrl), issue(world.primaryUrl)]);
  const [globalTokenA, globalTokenB, globalTokenC] = globalTokens;
  if (!globalTokenA || !globalTokenB || !globalTokenC) throw new Error("Expected three global concurrency tokens");
  const callsBeforeGlobalRace = list((await witness(world.witnessUrl)).calls).length;
  const globalRace = await Promise.all([
    complete(world.primaryUrl, globalTokenA.token, { stream: true, messages: [{ role: "user", content: "fixture:hold global-a" }] }),
    complete(world.secondaryUrl, globalTokenB.token, { stream: true, messages: [{ role: "user", content: "fixture:hold global-b" }] }),
  ]);
  expect(globalRace.every((response) => response.status === 200)).toBe(true);
  await probe.eventually(() => witness(world.witnessUrl), { within: 10_000, label: "two cross-instance global winners", until: (snapshot) => snapshot.waiting === 2 });
  const globalDenied = await complete(world.secondaryUrl, globalTokenC.token);
  expect(globalDenied.status).toBe(429); expect(await errorCode(globalDenied)).toBe("anonymous_capacity_exceeded");
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeGlobalRace + 2);
  await fetch(`${world.witnessUrl}/fixture/release`, { method: "POST" });
  for (const response of globalRace) expect(await response.text()).toContain("[DONE]");
  const recovered = await complete(world.secondaryUrl, globalTokenC.token);
  expect(recovered.status).toBe(200); await recovered.text();
  evidence.recordAssertionEvidence("Atomic durable admission enforces distinct installation and global concurrency across service instances", "Two simultaneous same-installation requests with global capacity two produced one upstream winner and one local 429; two different installations then won a simultaneous cross-instance race, the third was denied without upstream, and release restored capacity.", true);

  await world.reset();
  const accountingToken = await issue(world.primaryUrl);
  const zeroFeeByok = await complete(world.primaryUrl, accountingToken.token, { messages: [{ role: "user", content: "fixture:byok-zero-fee" }] });
  expect(zeroFeeByok.status).toBe(200); await zeroFeeByok.text();
  const zeroFeeAccounting = await world.accounting();
  expect(list(zeroFeeAccounting.reservations)).toEqual([expect.objectContaining({ status: "settled", settledMicroUsd: 100 })]);
  expect(list(zeroFeeAccounting.buckets).find((row) => row.scope === "installation" && row.windowType === "daily")?.usedMicroUsd).toBe(100);
  for (const marker of ["fixture:byok-fee-principal", "fixture:byok-flag-mismatch", "fixture:byok-missing-principal"]) {
    const response = await complete(world.primaryUrl, accountingToken.token, { messages: [{ role: "user", content: marker }] });
    expect(response.status).toBe(200); await response.text();
  }
  const costAccounting = await world.accounting();
  expect(list(costAccounting.reservations).filter((row) => row.status === "settled").map((row) => row.settledMicroUsd).sort((left, right) => Number(left) - Number(right))).toEqual([100, 105]);
  expect(list(costAccounting.reservations).filter((row) => row.status === "retained")).toEqual([
    expect.objectContaining({ reservedMicroUsd: 41_452, settledMicroUsd: null }),
    expect.objectContaining({ reservedMicroUsd: 41_452, settledMicroUsd: null }),
  ]);
  evidence.recordAssertionEvidence("Trusted OpenRouter BYOK accounting includes provider principal exactly once", "A zero-fee BYOK response independently settled and consumed 100 micro-USD of budget from its positive provider principal; fee plus principal settled to 105; a non-BYOK marker and missing BYOK principal each retained the full 41,452-micro-USD reservation derived from 131,072 input tokens at the conservative $0.25/M cache-write bound plus 4,096 output tokens at $1.20/M and the fixed 10% margin.", true);

  await world.reset();
  const reasoningToken = await issue(world.primaryUrl);
  const inclusiveReasoning = await complete(world.primaryUrl, reasoningToken.token, { messages: [{ role: "user", content: "fixture:reasoning-inclusive" }] });
  expect(inclusiveReasoning.status).toBe(200); await inclusiveReasoning.text();
  const inclusiveReasoningAccounting = await world.accounting();
  expect(inclusiveReasoningAccounting.blocked).toBe(false);
  expect(list(inclusiveReasoningAccounting.reservations)).toEqual([expect.objectContaining({ status: "settled", settledMicroUsd: 105 })]);
  const reasoningOverTotal = await complete(world.primaryUrl, reasoningToken.token, { messages: [{ role: "user", content: "fixture:reasoning-over-total" }] });
  expect(reasoningOverTotal.status).toBe(200); await reasoningOverTotal.text();
  const inconsistentReasoningAccounting = await world.accounting();
  expect(inconsistentReasoningAccounting.blocked).toBe(false);
  expect(list(inconsistentReasoningAccounting.reservations).find((row) => row.status === "retained")).toEqual(
    expect.objectContaining({ reservedMicroUsd: 41_452, settledMicroUsd: null }),
  );
  const afterInconsistentReasoning = await complete(world.secondaryUrl, reasoningToken.token);
  expect(afterInconsistentReasoning.status).toBe(200); await afterInconsistentReasoning.text();
  expect((await world.accounting()).blocked).toBe(false);
  evidence.recordAssertionEvidence("Inclusive reasoning usage is normalized without double-counting", "A 4,096-token completion containing 2,048 reasoning tokens settled normally because OpenAI completion_tokens already includes reasoning_tokens; a reasoning count above the completion total retained the 41,452-micro-USD reservation as unknown usage without tripping the kill switch, and a later request still succeeded.", true);

  await world.reset();
  const rotationInstallation = randomUUID();
  const beforeRotation = await issue(world.primaryUrl, rotationInstallation);
  const beforeRotationCall = await complete(world.primaryUrl, beforeRotation.token);
  expect(beforeRotationCall.status).toBe(200); await beforeRotationCall.text();
  const rejectedByRotatedCipher = await fetch(`${world.rotatedUrl}/api/anonymous/v1/models`, { headers: { authorization: `Bearer ${beforeRotation.token}` } });
  expect(rejectedByRotatedCipher.status).toBe(401);
  const afterRotation = await issue(world.rotatedUrl, rotationInstallation);
  const afterRotationCall = await complete(world.rotatedUrl, afterRotation.token);
  expect(afterRotationCall.status).toBe(200); await afterRotationCall.text();
  const rotationAccounting = await world.accounting();
  const globalDailyAfterRotation = list(rotationAccounting.buckets).filter((row) => row.scope === "global" && row.windowType === "daily");
  expect(globalDailyAfterRotation).toHaveLength(1);
  expect(globalDailyAfterRotation[0]?.usedMicroUsd).toBe(210);
  evidence.recordAssertionEvidence("Token encryption rotation does not rotate durable accounting identities", "The old token failed on the rotated cipher service, a newly minted token for the same installation succeeded, and both calls accumulated 210 micro-USD in one global daily bucket keyed by the separate stable accounting secret.", true);

  await world.reset();
  const cancellation = await issue(world.primaryUrl);
  const cancelled = await complete(world.primaryUrl, cancellation.token, { stream: true, messages: [{ role: "user", content: "fixture:hold cancellation" }] });
  expect(cancelled.status).toBe(200);
  await cancelled.body?.cancel();
  const retainedAfterCancel = await probe.eventually(() => world.accounting(), {
    within: 10_000, label: "cancelled reservation retained", until: (accounting) => list(accounting.reservations).some((row) => row.status === "retained"),
  });
  expect(list(retainedAfterCancel.reservations).find((row) => row.status === "retained")?.reservedMicroUsd).toBe(41_452);
  const afterCancel = await complete(world.secondaryUrl, cancellation.token);
  expect(afterCancel.status).toBe(200); await afterCancel.text();

  await world.reset();
  const incomplete = await issue(world.primaryUrl);
  const noUsage = await complete(world.primaryUrl, incomplete.token, { stream: false, messages: [{ role: "user", content: "fixture:missing-usage" }] });
  expect(noUsage.status).toBe(200); await noUsage.text();
  const afterMissing = await complete(world.secondaryUrl, incomplete.token);
  expect(afterMissing.status).toBe(200); await afterMissing.text();
  const incompleteAccounting = await world.accounting();
  expect(list(incompleteAccounting.reservations).map((row) => row.status).sort()).toEqual(["retained", "settled"]);
  expect(list(incompleteAccounting.buckets).find((row) => row.scope === "installation" && row.windowType === "daily")?.usedMicroUsd).toBe(41_557);
  evidence.recordAssertionEvidence("Unknown usage retains reserved spend but releases capacity", "Cancellation and missing usage each became retained reservations of 41,452 micro-USD; a subsequent request through the other instance recovered capacity and a complete 5-micro-USD fee plus 100-micro-USD provider principal settled to 105 micro-USD.", true);

  await world.reset();
  for (const installationId of [randomUUID(), randomUUID()]) {
    const identity = await issue(world.primaryUrl, installationId);
    const response = await complete(world.primaryUrl, identity.token, { messages: [{ role: "user", content: "fixture:missing-usage" }] });
    expect(response.status).toBe(200); await response.text();
  }
  const resetIdentity = await issue(world.primaryUrl);
  const ipLimited = await complete(world.secondaryUrl, resetIdentity.token);
  expect(ipLimited.status).toBe(429); expect(await errorCode(ipLimited)).toBe("anonymous_limit_exceeded");

  await world.reset();
  const globalSpendTokens = await Promise.all([issue(world.globalSpendUrl), issue(world.globalSpendUrl), issue(world.globalSpendUrl)]);
  const [globalSpendA, globalSpendB, globalSpendC] = globalSpendTokens;
  if (!globalSpendA || !globalSpendB || !globalSpendC) throw new Error("Expected three global spend tokens");
  for (const identity of [globalSpendA, globalSpendB]) {
    const response = await complete(world.globalSpendUrl, identity.token);
    expect(response.status).toBe(200); await response.text();
  }
  const settledGlobal = await world.accounting();
  expect(list(settledGlobal.reservations).every((row) => row.status === "settled")).toBe(true);
  expect(list(settledGlobal.buckets).find((row) => row.scope === "global" && row.windowType === "daily")?.usedMicroUsd).toBe(210);
  const callsBeforeGlobalSpendLimit = list((await witness(world.witnessUrl)).calls).length;
  const globallyLimited = await complete(world.globalSpendUrl, globalSpendC.token);
  expect(globallyLimited.status).toBe(429); expect(await errorCode(globallyLimited)).toBe("anonymous_limit_exceeded");
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeGlobalSpendLimit);

  await world.reset();
  for (let index = 0; index < 4; index += 1) await issue(world.primaryUrl);
  const rateRowsBeforeDenial = list((await world.accounting()).rateBuckets).filter((row) => row.kind === "session" && row.scope === "installation");
  expect(rateRowsBeforeDenial).toHaveLength(4);
  for (let index = 0; index < 5; index += 1) {
    const denied = await issueResponse(world.primaryUrl);
    expect(denied.status).toBe(429); expect(await errorCode(denied)).toBe("anonymous_limit_exceeded");
  }
  const rateRowsAfterDenial = list((await world.accounting()).rateBuckets).filter((row) => row.kind === "session" && row.scope === "installation");
  expect(rateRowsAfterDenial).toHaveLength(4);
  evidence.recordAssertionEvidence("Renewal and random installation identities cannot reset shared spend or grow denied rate state", "Different UUIDs exhausted the IP budget; two settled calls accumulated 210 micro-USD until the global budget denied a fresh UUID without upstream; five UUIDs denied by the shared issuance limit persisted no new installation buckets.", true);

  await world.reset();
  const slowSession = await issue(world.slowUrl);
  const callsBeforeSlowBody = list((await witness(world.witnessUrl)).calls).length;
  const slowBody = JSON.stringify({ model: freeModel, messages: [{ role: "user", content: "slow body" }] });
  const slowResult = await world.slowChat(slowSession.token, slowBody, 1_500);
  expect(slowResult.status).toBe(503);
  expect(object(object(JSON.parse(slowResult.body)).error).code).toBe("anonymous_unavailable");
  expect(list((await world.accounting()).reservations)).toHaveLength(0);
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeSlowBody);

  await world.reset();
  const admissionCancellation = await issue(world.primaryUrl);
  const callsBeforeAdmissionCancellation = list((await witness(world.witnessUrl)).calls).length;
  const controlLock = await fetch(`${world.witnessUrl}/fixture/control-lock?ms=1500`, { method: "POST" });
  expect(controlLock.status).toBe(200);
  const cancellationController = new AbortController();
  const cancelledDuringAdmission = complete(world.primaryUrl, admissionCancellation.token, {}, cancellationController.signal);
  setTimeout(() => cancellationController.abort(), 100);
  await expect(cancelledDuringAdmission).rejects.toThrow();
  await controlLock.text();
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeAdmissionCancellation);
  const afterAdmissionCancellation = await complete(world.secondaryUrl, admissionCancellation.token);
  expect(afterAdmissionCancellation.status).toBe(200); await afterAdmissionCancellation.text();
  await probe.eventually(() => world.accounting(), {
    within: 10_000,
    label: "cancelled admission created no reservation",
    until: (accounting) => list(accounting.reservations).length === 1 && list(accounting.reservations)[0]?.status === "settled",
  });
  evidence.recordAssertionEvidence("Request lifetime begins before body consumption and dispatch revalidates cancellation", "A body slower than the one-second request lifetime returned 503 with zero reservations/upstream calls; a request cancelled while admission waited on the durable lock created no reservation or upstream attempt, and the next request recovered normally.", true);

  await world.reset();
  const outageToken = await issue(world.primaryUrl);
  const callsBeforeOutage = list((await witness(world.witnessUrl)).calls).length;
  await world.outage(true);
  const dbOutage = await complete(world.primaryUrl, outageToken.token);
  expect(dbOutage.status).toBe(503); expect(await errorCode(dbOutage)).toBe("anonymous_unavailable");
  await world.outage(false);
  const unset = await fetch(`${world.unconfiguredUrl}/api/anonymous/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId: randomUUID() }),
  });
  expect(unset.status).toBe(503); expect(await errorCode(unset)).toBe("anonymous_unavailable");
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeOutage);

  const errorBodiesBefore = Number((await witness(world.witnessUrl)).errorBodiesClosed);
  const upstreamOutage = await complete(world.primaryUrl, outageToken.token, { messages: [{ role: "user", content: "fixture:outage" }] });
  const upstreamOutageText = await upstreamOutage.text();
  expect(upstreamOutage.status).toBe(503);
  expect(object(object(JSON.parse(upstreamOutageText)).error).code).toBe("anonymous_unavailable");
  expect(upstreamOutageText).not.toContain("private fixture outage detail");
  await probe.eventually(() => witness(world.witnessUrl), {
    within: 5_000,
    label: "unused upstream error body closed",
    until: (snapshot) => Number(snapshot.errorBodiesClosed) > errorBodiesBefore,
  });

  await world.reset();
  const safetyToken = await issue(world.primaryUrl);
  const overCost = await complete(world.primaryUrl, safetyToken.token, { messages: [{ role: "user", content: "fixture:late-over-cost" }] });
  expect(overCost.status).toBe(200); await overCost.text();
  const lateAccounting = await world.accounting();
  expect(lateAccounting.blocked).toBe(true);
  expect(list(lateAccounting.reservations)).toEqual([expect.objectContaining({ status: "retained", settledMicroUsd: null })]);
  expect(list(lateAccounting.buckets).find((row) => row.scope === "installation" && row.windowType === "daily")?.usedMicroUsd).toBe(41_452);
  const callsBeforeBlock = list((await witness(world.witnessUrl)).calls).length;
  const blocked = await complete(world.secondaryUrl, safetyToken.token);
  expect(blocked.status).toBe(503); expect(await errorCode(blocked)).toBe("anonymous_unavailable");
  expect(list((await witness(world.witnessUrl)).calls)).toHaveLength(callsBeforeBlock);
  evidence.recordAssertionEvidence("Configuration, storage, upstream failure and late reservation overrun fail closed", "Unset rollout configuration and a quota-table outage returned anonymous_unavailable without spending; the upstream error body was cancelled and hidden; trusted over-reserve usage arriving after retention triggered the durable block without refund or another upstream attempt.", true);
});
