import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { freeCredential, freeInferenceWorld, freeModel } from "../worlds/free-inference.ts";
import type { MemberKey } from "../worlds/free-inference.ts";

// New person-metered journey: real inference HTTP routes and SQL accounting,
// not Den enrollment, paid managed-inference provisioning, or a UI journey.
test("free Luna meters a person's actual weekly usage across keys, organizations and late receipts", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["pnpm"], placement: "local" });
  await using stack = new AsyncDisposableStack();
  const world = await freeInferenceWorld(stack, place);
  const [primary, extraKey, otherOrg] = await world.seedPerson();
  const [independent] = await world.seedPerson();
  const [pending, , pendingOtherOrg] = await world.seedPerson();
  const [racing] = await world.seedPerson();
  const body = (prompt: string, options: Record<string, unknown> = {}) => ({ model: freeModel, messages: [{ role: "user", content: prompt }], ...options });
  const complete = async (member: MemberKey, prompt: string, options: Record<string, unknown> = {}) => {
    const response = await world.http("/api/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${member.key}`, "content-type": "application/json" },
      body: JSON.stringify(body(prompt, options)),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  const rejected = async (member: MemberKey, prompt: string, status: number, code: string, options: Record<string, unknown> = {}) => {
    const before = await world.calls();
    const result = await complete(member, prompt, options);
    expect(result.status, result.text).toBe(status);
    expect(JSON.parse(result.text)).toMatchObject({ error: { code } });
    expect(await world.calls(), "denied calls never reach the provider").toEqual(before);
    if (status === 423) {
      expect(JSON.parse(result.text)).toMatchObject({ error: { retryable: false, reason: "free_request_in_progress", access: { kind: "free" } } });
      expect(result.headers.has("retry-after")).toBe(false);
      expect(JSON.parse(result.text).error.upgradePath).toBeUndefined();
    }
    return result;
  };
  const callFor = async (prompt: string) => {
    const calls = await eventually(() => world.calls(), {
      within: 10_000, intervalMs: 25, label: `upstream receives ${prompt.slice(0, 50)}`,
      until: (calls) => calls.some((call) => call.prompt === prompt),
    });
    const call = calls.find((call) => call.prompt === prompt);
    if (!call) throw new Error("Upstream witness disappeared");
    return call;
  };
  const settled = (member: MemberKey, count: number) => eventually(() => world.snapshot(member.userId), {
    within: 10_000, intervalMs: 25, label: "SQL settlement commits",
    until: (state) => state.reservations.length === count && state.reservations.every((row) => row.status === "settled"),
  });

  expect(primary.userId).toBe(otherOrg.userId);
  expect(primary.memberId).not.toBe(otherOrg.memberId);
  expect(primary.orgId).not.toBe(otherOrg.orgId);
  expect(primary.memberId).toBe(extraKey.memberId);
  expect(primary.keyId).not.toBe(extraKey.keyId);
  expect(independent.userId).not.toBe(primary.userId);
  const untouched = await world.snapshot(independent.userId);
  expect(untouched).toMatchObject({ buckets: [], reservations: [], paid: [{ buckets: 0, ledger: 0 }] });

  const modelsResponse = await world.http("/api/v1/models", { headers: { authorization: `Bearer ${primary.key}` } });
  expect(modelsResponse.status).toBe(200);
  const catalog: { data: Array<{ id: string }> } = await modelsResponse.json();
  expect(catalog.data.some((entry) => entry.id === freeModel)).toBe(true);
  const paidModel = catalog.data.find((entry) => entry.id !== freeModel)?.id;
  expect(paidModel, "a known paid model, not an unknown-model rejection").toBeTruthy();
  await rejected(primary, "paid selection", 402, "managed_model_requires_upgrade", { model: paidModel });
  await rejected(primary, "x".repeat(32_768), 413, "free_inference_input_too_large");
  await rejected(primary, "unsupported image", 400, "unsupported_free_inference_input", {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://invalid.test/image" } }] }],
  });
  expect((await world.snapshot(primary.userId)).buckets).toEqual([]);

  // The positive input boundary is the full compact envelope, not string length.
  const inputAtLimit = "x".repeat(32_768 - new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: "" }] })).length);
  await world.plan(inputAtLimit, { cost: 0.25 });
  const first = await complete(primary, inputAtLimit, { max_tokens: 128_000 });
  expect(first.status, first.text).toBe(200);
  expect(JSON.parse(first.text)).toMatchObject({ model: freeModel, usage: { cost: 0.25 }, choices: [{ message: { content: "Fixture reply: caf\u00e9" } }] });
  const firstCall = await callFor(inputAtLimit);
  expect(first.headers.get("x-openwork-request-id")).toBe(firstCall.requestId);
  expect(firstCall).toMatchObject({ url: "https://openrouter.ai/api/v1/chat/completions", authorization: `Bearer ${freeCredential}`, redirect: "error" });
  expect(firstCall.body).toMatchObject({ model: freeModel, max_tokens: 4096, n: 1, messages: body(inputAtLimit).messages, provider: { allow_fallbacks: false, require_parameters: true } });
  let state = await settled(primary, 1);
  expect(state.buckets).toHaveLength(1);
  expect(state.buckets[0]).toMatchObject({ limit_amount: 100_000_000, used_amount: 25_000_000, reserved_amount: 0, blocked: 0 });
  expect(state.reservations[0]).toMatchObject({ request_id: firstCall.requestId, user_id: primary.userId, organization_id: primary.orgId, org_membership_id: primary.memberId, inference_key_id: primary.keyId, actual_amount: 25_000_000, external_event_id: firstCall.generationId, max_output_tokens: 4096 });
  expect(state.reservations[0].actual_amount).toBeGreaterThan(state.reservations[0].reserved_amount);
  const week = state.buckets[0];
  expect(week.window_start_at.getUTCDay()).toBe(1);
  expect(week.window_start_at.toISOString()).toMatch(/T00:00:00\.000Z$/);
  expect(week.window_end_at.getTime() - week.window_start_at.getTime()).toBe(7 * 86_400_000);
  expect(await world.snapshot(independent.userId)).toEqual(untouched);

  await world.plan("another organization", { cost: 0.5 });
  const second = await complete(otherOrg, "another organization", { stream: true, max_completion_tokens: 32 });
  expect(second.status, second.text).toBe(200);
  expect(second.text).toContain("Fixture reply: caf\u00e9");
  expect(second.text).toContain('"cost":0.5');
  expect(second.text).toContain("data: [DONE]");
  expect((await callFor("another organization")).body).toMatchObject({ max_tokens: 32 });
  state = await settled(primary, 2);
  expect(state.buckets).toHaveLength(1);
  expect(state.buckets[0]).toMatchObject({ used_amount: 75_000_000, reserved_amount: 0 });

  await world.plan("final capped reply", { cost: 0.5, hold: true });
  const finalRequest = complete(extraKey, "final capped reply");
  await callFor("final capped reply");
  const held = (await world.snapshot(primary.userId)).reservations.find((row) => row.status === "held");
  expect(held?.max_output_tokens).toBe(4096);
  expect(held?.reserved_amount).toBeGreaterThan(0);
  expect(held?.reserved_amount).toBeLessThan(50_000_000);
  await world.release("final capped reply");
  expect((await finalRequest).status).toBe(200);
  state = await settled(primary, 3);
  expect(state.buckets[0]).toMatchObject({ used_amount: 125_000_000, reserved_amount: 0 });
  for (const member of [primary, extraKey, otherOrg]) {
    const denial = await rejected(member, "exhausted retry", 402, "free_allowance_exhausted");
    expect(JSON.parse(denial.text)).toMatchObject({ error: { access: { kind: "exhausted", usedUsd: 1.25, remainingUsd: 0, weeklyLimitUsd: 1 } } });
  }
  expect(await world.snapshot(primary.userId)).toEqual(state);
  expect(await world.snapshot(independent.userId)).toEqual(untouched);
  evidence.recordAssertionEvidence("Actual usage, not estimates, consumes one USD per person per Monday UTC week", "HTTP 200 replies reached the fixture; SQL settled 0.25 + 0.50 + 0.50 USD. All three keys then received 402 without upstream; the second person and paid ledger stayed unchanged.", true);

  // Simultaneous first admissions for DIFFERENT people must both make progress.
  // Use memberships in the same organization to expose over-broad/deadlocking locks.
  await world.plan("independent admission", { cost: 0.125, hold: true });
  await world.plan("parallel admission", { cost: 0.125, hold: true });
  const independentRequest = complete(independent, "independent admission");
  const parallelRequest = complete(racing, "parallel admission");
  await Promise.all([callFor("independent admission"), callFor("parallel admission")]);
  for (const member of [independent, racing]) {
    const snapshot = await world.snapshot(member.userId);
    expect(snapshot.reservations.filter((row) => row.status === "held")).toHaveLength(1);
    expect(snapshot.buckets[0].used_amount).toBe(0);
  }
  await Promise.all([world.release("independent admission"), world.release("parallel admission")]);
  expect((await Promise.all([independentRequest, parallelRequest])).map((reply) => reply.status)).toEqual([200, 200]);
  expect((await settled(independent, 1)).buckets[0].used_amount).toBe(12_500_000);
  expect((await settled(racing, 1)).buckets[0].used_amount).toBe(12_500_000);

  // Fresh person/week, different memberships: exactly one first admission wins.
  await world.plan("same person race", { cost: null, hold: true });
  const competitors = [complete(pending, "same person race", { stream: true }), complete(pendingOtherOrg, "same person race", { stream: true })];
  const losingReply = await Promise.race(competitors);
  expect(losingReply.status, losingReply.text).toBe(423);
  expect(JSON.parse(losingReply.text)).toMatchObject({ error: { code: "free_request_in_progress", retryable: false } });
  expect(losingReply.headers.has("retry-after")).toBe(false);
  const missingCostCall = await callFor("same person race");
  const winningKey = missingCostCall.body.user === pending.memberId ? pending : pendingOtherOrg;
  const survivingKey = winningKey === pending ? pendingOtherOrg : pending;
  expect((await world.calls()).filter((call) => call.prompt === "same person race")).toHaveLength(1);
  expect((await world.snapshot(pending.userId)).reservations).toHaveLength(1);
  await world.release("same person race");
  const replies = await Promise.all(competitors);
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 423]);
  expect(replies.find((reply) => reply.status === 200)?.text).toContain("data: [DONE]");
  const awaitingUsage = await world.snapshot(pending.userId);
  expect(awaitingUsage.reservations[0]).toMatchObject({ status: "held", actual_amount: null });
  expect(awaitingUsage.buckets[0].reserved_amount).toBeGreaterThan(0);
  expect(awaitingUsage.buckets[0].used_amount).toBe(0);
  await rejected(pendingOtherOrg, "missing usage manual retry", 423, "free_request_in_progress");
  evidence.recordAssertionEvidence("Person locking neither deadlocks independent first use nor admits two requests for one person", "Two independent first admissions completed concurrently; two cross-organization keys for a fresh person produced exactly one upstream call and HTTP 200/423, with a retained SQL hold when usage.cost was missing.", true);

  await world.seedPreviousWeek(pending.userId);
  const oldState = await world.snapshot(pending.userId);
  const oldWeek = oldState.buckets[0].window_start_at;
  expect(oldWeek.getTime()).toBe(week.window_start_at.getTime() - 7 * 86_400_000);
  await rejected(pending, "new week still pending", 423, "free_request_in_progress");
  const rollover = await world.snapshot(pending.userId);
  expect(rollover.buckets[0]).toEqual(oldState.buckets[0]);
  // Admission may materialize the untouched new bucket before denying the hold.
  expect(rollover.buckets.length).toBeLessThanOrEqual(2);
  for (const bucket of rollover.buckets.slice(1)) {
    expect(bucket).toMatchObject({ limit_amount: 100_000_000, used_amount: 0, reserved_amount: 0 });
  }

  expect((await world.webhook(missingCostCall, 0.25, {}, "incorrect-signature")).status).toBe(401);
  const wrongIdentity = await world.webhook(missingCostCall, 0.25, { "trace.metadata.org_membership_id": independent.memberId });
  expect(wrongIdentity.status).toBe(200);
  expect(await wrongIdentity.json()).toMatchObject({ ingested: 0, skipped: 1 });
  expect(await world.snapshot(pending.userId)).toEqual(rollover);
  await world.seedRevokedKey(winningKey.keyId);
  await rejected(winningKey, "revoked key", 401, "invalid_api_key");
  const late = await world.webhook(missingCostCall, 0.25);
  expect(late.status).toBe(200);
  expect(await late.json()).toMatchObject({ ingested: 1, skipped: 0 });
  const lateState = await settled(pending, 1);
  expect(lateState.buckets[0]).toMatchObject({ window_start_at: oldWeek, used_amount: 25_000_000, reserved_amount: 0 });
  expect(lateState.buckets.slice(1)).toEqual(rollover.buckets.slice(1));
  for (const cost of [0.25, 0.75]) {
    const replay = await world.webhook(missingCostCall, cost);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ingested: 0, skipped: 1 });
    expect(await world.snapshot(pending.userId)).toEqual(lateState);
  }
  await world.plan("fresh week after receipt", { cost: 0.125 });
  expect((await complete(survivingKey, "fresh week after receipt")).status).toBe(200);
  const fresh = await settled(pending, 2);
  expect(fresh.buckets).toHaveLength(2);
  expect(fresh.buckets[0]).toEqual(lateState.buckets[0]);
  expect(fresh.buckets[1]).toMatchObject({ limit_amount: 100_000_000, used_amount: 12_500_000, reserved_amount: 0 });
  await rejected(winningKey, "revoked key stays revoked", 401, "invalid_api_key");
  evidence.recordAssertionEvidence("Old-week missing usage blocks new admission until an authenticated original-week receipt settles once", "423 survived explicit rollover seeding; invalid signature and wrong identity did not release the hold. Late and replayed receipts charged only the old week. An active key then used the fresh one-USD week; the revoked key remained denied.", true);

  const independentBeforeRace = await world.snapshot(independent.userId);
  await world.plan("response webhook race", { cost: 0.25, hold: true });
  const responseRace = complete(racing, "response webhook race", { stream: true });
  const raceCall = await callFor("response webhook race");
  const [, fallback] = await Promise.all([world.release("response webhook race"), world.webhook(raceCall, 0.25)]);
  expect(fallback.status).toBe(200);
  const fallbackBody = await fallback.json();
  expect([0, 1]).toContain(fallbackBody.ingested);
  expect(fallbackBody.ingested + fallbackBody.skipped).toBe(1);
  expect((await responseRace).status).toBe(200);
  const raced = await settled(racing, 2);
  expect(raced.buckets[0]).toMatchObject({ used_amount: 37_500_000, reserved_amount: 0 });
  expect(raced.reservations.filter((row) => row.external_event_id === raceCall.generationId)).toHaveLength(1);
  const duplicate = await world.webhook(raceCall, 0.25);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ ingested: 0, skipped: 1 });
  expect(await world.snapshot(racing.userId)).toEqual(raced);
  expect(await world.snapshot(independent.userId)).toEqual(independentBeforeRace);
  expect(raced.paid).toEqual([{ buckets: 0, ledger: 0 }]);
  evidence.recordAssertionEvidence("Response usage and signed webhook fallback cannot double-charge", "Racing the final SSE usage against the authenticated webhook settled exactly 0.25 USD once; replay left SQL unchanged, the independent person unchanged, and paid accounting empty.", true);

  // Stop the owned child and connection before dropping only this random DB.
  await stack.disposeAsync();
  expect(await world.database.exists(), "the proof leaves no owned database").toBe(false);
});
