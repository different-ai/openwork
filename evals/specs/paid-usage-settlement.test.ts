import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { paidUsageWorld } from "../worlds/models-analytics.ts";

const test = spec.world(paidUsageWorld, { timeout: 900_000, needs: { placement: "local" } });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected rows");
  return value.map(record);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}

test("paid usage keeps its admitted windows through retries, reset, repricing and revocation", async ({ world, evidence, probe, step }) => {
  const api = (path: string, method = "GET", body?: unknown) => denFetch(world.den.admin, path, {
    method, headers: { authorization: `Bearer ${world.den.admin.token}`, "x-openwork-org-id": world.orgId },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const fixture = async (action = "state", body: Record<string, unknown> = {}) => {
    const response = await fetch(`${world.witnessUrl}/fixture/usage/${action}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const payload = record(await response.json());
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload;
  };
  const calls = async () => rows(record(await fetch(`${world.witnessUrl}/fixture/requests`).then((r) => r.json())).calls);
  const complete = async (memberId = world.memberId) => {
    const response = await fetch(`${world.inferenceUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${world.fixtureKey(memberId)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], stream: false, trace: { usage_started_at: "2000-01-01T00:00:00Z" } }), signal: AbortSignal.timeout(30_000),
    });
    await response.text();
    return response.status;
  };
  const usage = async (trace: Record<string, unknown>, eventId: string, costs: Record<string, unknown> = { input_cost: 0, output_cost: 0 }, extra: Record<string, unknown> = {}) => {
    const attrs = { ...Object.fromEntries(Object.entries(trace).map(([key, value]) => [`trace.${key}`, value])), event_id: eventId,
      "gen_ai.response.model": "z-ai/glm-5.2", ...Object.fromEntries(Object.entries(costs).map(([key, value]) => [`gen_ai.usage.${key}`, value])), ...extra };
    const response = await fetch(`${world.inferenceUrl}/webhooks/openrouter`, {
      method: "POST", headers: { authorization: "Bearer paid-usage-fixture-secret", "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) }, scopeSpans: [{ scope: { attributes: [] }, spans: [{ spanId: eventId, attributes: [] }] }] }] }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: record(await response.json()) };
  };
  const context = record((await api("/v1/org")).body);
  const userId = text(record(context.currentMember).userId);
  const reset = () => api(`/v1/admin/users/${userId}/inference-usage/reset`, "POST");
  const initial = await fixture();
  const teammate = rows(initial.keys).find((key) => key.org_membership_id !== world.memberId);
  if (!teammate) throw new Error("Missing unaffected member");

  await step("upgrade an existing paid ledger with the real migration runner, then rerun it", async () => {
    expect(await complete()).toBe(200);
    const trace = record((await calls()).at(-1)?.trace);
    expect((await usage(trace, "upgrade-receipt")).body.ingested).toBe(1);
    const legacy = await fixture("before-upgrade");
    expect(legacy.columns).toEqual([]);
    const upgraded = await fixture("upgrade");
    expect(upgraded.ledger).toEqual(legacy.ledger);
    expect(await fixture("upgrade")).toEqual(upgraded);
    expect(rows((await fixture()).ledger)[0]?.provider_usage).toBeNull();
    await fixture("partial", { requestId: trace.openwork_request_id });
    const legacyGap = await fixture();
    expect((await usage(trace, "upgrade-receipt")).body.deferred).toBe(1);
    expect(await fixture()).toEqual(legacyGap);
    evidence.recordAssertionEvidence("The additive accounting upgrade preserves paid history and reruns idempotently", "The production bootstrap runner applied generated migration 0094 to a 0093 ledger with existing usage; ledger identity/time/cost and migration journal were unchanged on rerun.", true);
    evidence.recordAssertionEvidence("Legacy reset ambiguity never silently restores forgiven usage", "A legacy receipt with no provider facts and a missing charge was acknowledged as durably deferred, not backfilled: old reset deletion is indistinguishable from interrupted settlement.", true);
  });

  let original: Record<string, unknown> = {};
  let control: Record<string, unknown> = {};
  await step("settle all exhausted windows once, repair a partial write, and keep reset intentional", async () => {
    expect(await complete(text(teammate.org_membership_id))).toBe(200);
    control = record((await calls()).at(-1)?.trace);
    expect((await usage(control, "control-member")).body.ingested).toBe(1);
    expect(await complete()).toBe(200);
    original = record((await calls()).at(-1)?.trace);
    const exhausted = await fixture("exhaust");
    const responses = await Promise.all(Array.from({ length: 4 }, () => usage(original, "duplicate-paid", { input_cost: 0.00000002, output_cost: 0 })));
    expect(responses.every((response) => response.status === 200 && response.body.ingested === 1)).toBe(true);
    const settled = await fixture();
    expect(rows(settled.buckets)).toHaveLength(3);
    for (const bucket of rows(settled.buckets)) {
      const before = rows(exhausted.buckets).find((row) => row.id === bucket.id)!;
      expect(bucket.used_amount).toBe(Number(before.used_amount) + 2);
      expect(bucket.limit_amount).toBe(before.limit_amount);
    }
    await fixture("partial", { requestId: original.openwork_request_id });
    expect((await usage(original, "duplicate-paid")).status).toBe(200);
    const repaired = await fixture();
    expect(repaired.buckets).toEqual(settled.buckets);
    expect(rows(repaired.charges)).toHaveLength(rows(settled.charges).length);
    const firstResetRace = await Promise.all([reset(), usage(original, "duplicate-paid")]);
    expect(firstResetRace.map((result) => "response" in result ? result.response.status : result.status)).toEqual([200, 200]);
    const forgiven = await fixture();
    expect(rows(forgiven.buckets).every((bucket) => bucket.used_amount === 1)).toBe(true);
    // Race two real admin reset requests with duplicate settlement.
    const race = await Promise.all([reset(), reset(), usage(original, "duplicate-paid"), usage(original, "changed-delivery-id")]);
    expect(race.map((result) => "response" in result ? result.response.status : result.status)).toEqual([200, 200, 200, 200]);
    expect(await fixture()).toEqual(forgiven);
    expect(rows(forgiven.charges).filter((charge) => charge.amount === 0)).toHaveLength(rows(repaired.charges).length - 3);
    evidence.recordAssertionEvidence("Exhaustion does not truncate settlement and reset survives replay", "Concurrent receipts charged all three original buckets once without changing limits; a missing charge repaired without double charging, and reset plus replay races preserved zero forgiven identities and the other member's usage.", true);
  });

  await step("retain unpriced facts and promote the same identity without accepting another key's event", async () => {
    // Give admission headroom through the existing Den endpoint, not new policy.
    expect((await api("/v1/inference", "PATCH", { enabled: true, tier: "tier1" })).response.status).toBe(200);
    expect(await complete()).toBe(200);
    const unpricedTrace = record((await calls()).at(-1)?.trace);
    expect((await usage(unpricedTrace, "unpriced-event", { input_tokens: 7, input_cost: " ", output_cost: "" })).body.deferred).toBe(1);
    const retained = rows((await fixture()).ledger).find((row) => row.external_job_id === unpricedTrace.openwork_request_id)!;
    expect(record(retained.provider_usage)).toMatchObject({ status: "unpriced", inputCost: null, outputCost: null });
    expect((await usage(unpricedTrace, "unpriced-event", { input_cost: 0.00000003, output_cost: 0 })).body.ingested).toBe(1);
    const repriced = await fixture();
    const promoted = rows(repriced.ledger).filter((row) => row.external_job_id === unpricedTrace.openwork_request_id);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ id: retained.id, occurred_at: retained.occurred_at, inference_key_id: retained.inference_key_id, cost_amount: 3, event_type: "openrouter_usage" });
    expect(record(promoted[0]!.provider_usage).status).toBe("priced");
    expect((await usage({ ...unpricedTrace, usage_started_at: "2030-01-01T00:00:00Z" }, "new-delivery-id", { input_cost: 100, output_cost: 100 })).status).toBe(200);
    expect((await usage(control, "unpriced-event")).body.skipped).toBe(1);
    expect(await fixture()).toEqual(repriced);
    const malformed = await usage(unpricedTrace, "invalid-event", { input_cost: "-1", output_cost: 0 });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ invalid: 1, failed: 0 });
    expect(await fixture()).toEqual(repriced);
    await fixture("pause-ledger");
    try { expect((await usage(unpricedTrace, "persistence-retry")).status).toBe(503); }
    finally { await fixture("resume-ledger"); }
    expect((await usage(unpricedTrace, "persistence-retry")).status).toBe(200);
    expect(await fixture()).toEqual(repriced);

    expect(await complete()).toBe(200);
    const changedIdTrace = record((await calls()).at(-1)?.trace);
    expect((await usage(changedIdTrace, "unpriced-original-id", {})).body.deferred).toBe(1);
    const beforePromotion = rows((await fixture()).ledger).find((row) => row.external_job_id === changedIdTrace.openwork_request_id)!;
    expect((await usage({ ...changedIdTrace, usage_started_at: "2030-01-01T00:00:00Z" }, "priced-replacement-id")).body.ingested).toBe(1);
    const changedIdEntries = rows((await fixture()).ledger).filter((row) => row.external_job_id === changedIdTrace.openwork_request_id);
    expect(changedIdEntries).toHaveLength(1);
    expect(changedIdEntries[0]).toMatchObject({ id: beforePromotion.id, occurred_at: beforePromotion.occurred_at, external_event_id: "unpriced-original-id", cost_amount: 1 });
    evidence.recordAssertionEvidence("Pricing and delivery changes do not create a second ledger identity", "Missing costs stayed nullable; complete costs promoted one row in place. Changed event IDs, later timestamps, different costs and a cross-key event collision did not alter its identity/time or charge again. Malformed inherited OTLP usage was 400; a real persistence outage was retryable 503.", true);
  });

  await step("defer overlapping historical windows rather than selecting one arbitrarily", async () => {
    expect(await complete()).toBe(200);
    const trace = record((await calls()).at(-1)?.trace);
    const ambiguous = await fixture("ambiguous");
    try {
      const deferred = await usage(trace, "ambiguous-history");
      expect(deferred.status).toBe(200);
      expect(deferred.body.deferred).toBe(1);
      const retained = await fixture();
      expect(retained.buckets).toEqual(ambiguous.buckets);
      expect(retained.charges).toEqual(ambiguous.charges);
      expect(rows(retained.ledger).filter((row) => row.external_job_id === trace.openwork_request_id)).toHaveLength(1);
    } finally { await fixture("clear-ambiguous"); }
    expect((await usage(trace, "ambiguous-history")).body.ingested).toBe(1);
    const repaired = await fixture();
    expect((await usage(trace, "ambiguous-history")).body.ingested).toBe(1);
    expect(await fixture()).toEqual(repaired);
    evidence.recordAssertionEvidence("Ambiguous history is retained without guessing a charge destination", "Overlapping windows caused durable deferral with unchanged charges and bucket totals. After the fixture repaired that overlap, redelivery charged once using the original receipt.", true);
  });

  await step("attribute a provider-key delay to admission time, then settle after revocation and DPA", async () => {
    const boundary = new Date(Date.now() + 5_000);
    await fixture("boundary", { at: boundary.toISOString() });
    await fixture("hold-provider");
    const pending = complete();
    try {
      await probe.eventually(async () => (await fixture()).waitingForProvider, { within: 10_000, until: (waiting) => waiting === true, label: "admitted request waiting for provider lookup" });
      await probe.eventually(async () => Date.now() > boundary.getTime(), { within: 10_000, until: (crossed) => crossed, label: "provider lookup crosses window end" });
    } finally { await fixture("release-provider"); }
    expect(await pending).toBe(200);
    const delayed = record((await calls()).at(-1)?.trace);
    expect(new Date(text(delayed.usage_started_at)).getTime()).toBeLessThan(boundary.getTime());
    const old = await fixture();
    const rollover = await Promise.all([complete(), complete(), api("/v1/inference", "PATCH", { enabled: true, tier: "tier1" })]);
    expect(rollover.map((result) => typeof result === "number" ? result : result.response.status)).toEqual([200, 200, 200]);
    const current = await fixture();
    expect(rows(current.buckets)).toHaveLength(rows(old.buckets).length + 3);
    const currentIds = rows(current.buckets).map((row) => row.current_bucket_id);
    expect(rows(old.buckets).every((row) => !currentIds.includes(row.id))).toBe(true);
    await fixture("revoke", { at: new Date().toISOString() });
    expect((await api(`/v1/admin/organizations/${world.orgId}/dpa`, "PATCH", { dpaSigned: true, reason: "Accounting late-delivery boundary" })).response.status).toBe(200);
    const callsBefore = await calls();
    expect(await complete()).toBe(401);
    expect(await calls()).toEqual(callsBefore);
    expect((await usage(delayed, "late-revoked")).body.ingested).toBe(1);
    const late = await fixture();
    for (const bucket of rows(late.buckets)) {
      const before = rows(current.buckets).find((row) => row.id === bucket.id)!;
      expect(bucket).toEqual({ ...before, used_amount: Number(before.used_amount) + (currentIds.includes(bucket.id) ? 0 : 1) });
    }
    expect((await usage({ ...delayed, usage_started_at: "2030-01-01T00:00:00Z" }, "late-revoked")).body.ingested).toBe(1);
    expect(await fixture()).toEqual(late);
    evidence.recordAssertionEvidence("Late usage settles original windows without re-enabling revoked or DPA-blocked access", "The real provider-key SQL lookup crossed a window boundary; the server trace kept its earlier admission timestamp. After rollover, revocation and DPA marking, all three old buckets settled, current windows/limits stayed identical, replay used durable time and new generation made no upstream call.", true);
  });
});

test("voice reservations admit concurrent members without turning unknown cost into usage", async ({ world, evidence, probe, step }) => {
  const fixture = async (action = "state", body: Record<string, unknown> = {}) => {
    const response = await fetch(`${world.witnessUrl}/fixture/usage/${action}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    return record(await response.json());
  };
  const configure = async (body: Record<string, unknown>) => {
    expect((await fetch(`${world.witnessUrl}/fixture/voice`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })).status).toBe(200);
  };
  const calls = async () => rows(record(await fetch(`${world.witnessUrl}/fixture/requests`).then((r) => r.json())).calls);
  const voice = async (memberId = world.memberId, status = false) => {
    const response = await fetch(`${world.inferenceUrl}/api/v1/${status ? "voice" : "audio/speech"}`, {
      method: status ? "GET" : "POST", headers: { authorization: `Bearer ${world.fixtureKey(memberId)}`, "content-type": "application/json" },
      body: status ? undefined : JSON.stringify({ input: "One bounded voice packet" }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    return { status: response.status, body };
  };
  const api = (path: string) => denFetch(world.den.admin, path, { headers: { authorization: `Bearer ${world.den.admin.token}`, "x-openwork-org-id": world.orgId } });
  const context = record((await api("/v1/org")).body);
  const reset = () => denFetch(world.den.admin, `/v1/admin/users/${text(record(context.currentMember).userId)}/inference-usage/reset`, {
    method: "POST", headers: { authorization: `Bearer ${world.den.admin.token}` }, signal: AbortSignal.timeout(30_000),
  });
  const teammate = text(rows((await fixture()).keys).find((key) => key.org_membership_id !== world.memberId)!.org_membership_id);
  const usage = async (call: Record<string, unknown>, cost: number, override: Record<string, unknown> = {}) => {
    const trace = record(call.trace);
    const attrs = { ...Object.fromEntries(Object.entries(trace).map(([key, value]) => [`trace.${key}`, value])),
      "gen_ai.response.model": call.model, "gen_ai.usage.input_cost": cost, "gen_ai.usage.output_cost": 0,
      "gen_ai.response.id": call.generationId, event_id: `delivery-${call.generationId}`, ...override };
    const response = await fetch(`${world.inferenceUrl}/webhooks/openrouter`, {
      method: "POST", headers: { authorization: "Bearer paid-usage-fixture-secret", "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: "voice-receipt", attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) }] }] }] }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    return record(await response.json());
  };
  const entryFor = (state: Record<string, unknown>, call: Record<string, unknown>) => rows(state.ledger).find((entry) => entry.external_job_id === record(call.trace).openwork_request_id)!;
  const reservation = (entry: Record<string, unknown>) => record(record(entry.provider_usage).reservation);
  const chargesFor = (state: Record<string, unknown>, entry: Record<string, unknown>) => rows(state.charges).filter((charge) => charge.ledger_entry_id === entry.id);

  await step("two members dispatch concurrently and shared headroom admits only two durable holds", async () => {
    expect((await voice(world.memberId, true)).status).toBe(200);
    const before = await fixture("headroom", { amount: 16_000_000 });
    await configure({ hold: true, cost: null });
    const pending = [voice(), voice(teammate)];
    try {
      await probe.eventually(calls, { within: 10_000, until: (entries) => entries.length === 2, label: "both members reached upstream before either completed" });
      const held = await fixture();
      expect(held.buckets).toEqual(before.buckets);
      expect(held.charges).toEqual([]);
      expect(rows(held.ledger)).toHaveLength(2);
      expect(new Set(rows(held.ledger).map((entry) => entry.org_membership_id)).size).toBe(2);
      for (const entry of rows(held.ledger)) {
        expect(record(entry.provider_usage)).toMatchObject({ status: "unpriced", inputCost: null, outputCost: null });
        expect(reservation(entry)).toMatchObject({ amount: 8_000_000, bucketIds: expect.arrayContaining(rows(held.buckets).map((b) => b.id)) });
      }
      expect((await Promise.all([voice(), voice(teammate), voice(), voice(teammate)])).map((r) => r.status)).toEqual([429, 429, 429, 429]);
      expect(await fixture()).toEqual(held);
      expect(await calls()).toHaveLength(2);
    } finally { await configure({ hold: false, cost: 0.001 }); }
    const seen = await calls();
    await Promise.all(seen.flatMap((call) => [usage(call, 0.001), usage(call, 0.001)]));
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200]);
    const settled = await fixture();
    expect(rows(settled.charges)).toHaveLength(6);
    expect(rows(settled.charges).every((charge) => charge.amount === 100_000)).toBe(true);
    for (const bucket of rows(settled.buckets)) {
      expect(bucket.used_amount).toBe(Number(rows(before.buckets).find((b) => b.id === bucket.id)!.used_amount) + 200_000);
    }
    await Promise.all(seen.map((call) => usage(call, 0.5, { event_id: "changed-delivery" })));
    expect(await fixture()).toEqual(settled);
    expect(await calls()).toHaveLength(2);
    evidence.recordAssertionEvidence("Concurrent members share atomic reservation headroom, not an org-wide pending lock", "Both HTTP requests reached the witness before either finished. Four contenders were denied without rows or provider calls. Racing response/webhook receipts replaced two holds with exactly six actual charges, not estimates; replay left state identical.", true);
  });

  await step("unrecoverable receipts bound member debt across short rollover and reset forgives only its current buckets", async () => {
    await fixture("headroom", { amount: 200_000_000 });
    await configure({ receipt: false, cost: null });
    expect((await Promise.all(Array.from({ length: 4 }, () => voice()))).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const unknown = await fixture();
    const lost = (await calls()).slice(2);
    for (const call of lost) {
      expect(entryFor(unknown, call).external_event_id).toBeNull();
      expect(record(entryFor(unknown, call).provider_usage).status).toBe("unpriced");
      expect(chargesFor(unknown, entryFor(unknown, call))).toEqual([]);
    }
    expect((await voice()).status).toBe(429);
    expect(JSON.parse((await voice(world.memberId, true)).body)).toEqual({ access: "ready" });
    expect(await fixture()).toEqual(unknown);
    expect(await calls()).toHaveLength(6);
    expect((await voice(teammate)).status).toBe(200);
    const control = (await calls()).at(-1)!;
    await fixture("boundary", { at: new Date().toISOString(), window: "five_hour" });
    expect((await voice()).status).toBe(429); // Monthly hold debt survives a short-window rollover.
    expect(await calls()).toHaveLength(7);
    const beforeReset = await fixture();
    const controlEntry = entryFor(beforeReset, control);
    const [firstReset, secondReset] = await Promise.all([reset(), reset(), usage(lost[0]!, 0.2)]);
    expect([firstReset.response.status, secondReset.response.status]).toEqual([200, 200]);
    const forgiven = await fixture();
    expect(entryFor(forgiven, control)).toEqual(controlEntry);
    expect(chargesFor(forgiven, controlEntry)).toEqual([]);
    expect(entryFor(forgiven, lost[0]!).cost_amount).toBe(20_000_000); // Actual cost may exceed the $0.08 estimate.
    for (const call of lost) {
      const entry = entryFor(forgiven, call);
      const currentCharges = chargesFor(forgiven, entry).filter((charge) => rows(forgiven.buckets).some((b) => b.id === charge.bucket_id && b.current_bucket_id === b.id));
      expect(currentCharges).toHaveLength(2);
      expect(currentCharges.every((charge) => charge.amount === 0)).toBe(true);
      if (call !== lost[0]) expect(record(entry.provider_usage).status).toBe("unpriced");
    }
    expect((await usage(lost[0]!, 0.2)).ingested).toBe(1);
    expect(await fixture()).toEqual(forgiven);
    await configure({ reject: true });
    expect((await voice()).status).toBe(503);
    const rejected = entryFor(await fixture(), (await calls()).at(-1)!);
    expect(rejected.cost_amount).toBe(0);
    expect(record(rejected.provider_usage).status).toBe("priced");
    expect(chargesFor(await fixture(), rejected).map((c) => c.amount)).toEqual([0, 0, 0]);
    evidence.recordAssertionEvidence("Lost receipts reserve finite member capacity without becoming free usage or blocking other members", "Four lost receipts remained unpriced and uncharged; a fifth never dispatched, including after five-hour rollover. Another member succeeded. Concurrent reset and late settlement retained the actual above-estimate cost, preserved the other member, and kept current-window forgiveness through replay. A known provider rejection settled zero.", true);
  });

  await step("original hold windows expire automatically while late actual settlement remains deduplicated", async () => {
    await configure({ reject: false });
    expect((await voice()).status).toBe(200);
    const oldCall = (await calls()).at(-1)!;
    const original = entryFor(await fixture(), oldCall);
    const originalBucketIds = reservation(original).bucketIds;
    if (!Array.isArray(originalBucketIds)) throw new Error("Missing original reservation buckets");
    await fixture("boundary", { at: new Date().toISOString() });
    expect(JSON.parse((await voice(world.memberId, true)).body)).toEqual({ access: "ready" });
    expect((await voice()).status).toBe(200);
    const before = await fixture();
    const count = (await calls()).length;
    expect(entryFor(before, oldCall)).toEqual(original);
    expect(chargesFor(before, original)).toEqual([]);
    expect((await usage(oldCall, 0.005)).ingested).toBe(1);
    const late = await fixture();
    for (const bucket of rows(late.buckets)) {
      const prior = rows(before.buckets).find((b) => b.id === bucket.id)!;
      expect(bucket).toEqual({ ...prior, used_amount: Number(prior.used_amount) + (originalBucketIds.includes(bucket.id) ? 500_000 : 0) });
    }
    expect((await usage(oldCall, 10, { event_id: "redelivery", "trace.usage_started_at": "2030-01-01T00:00:00Z" })).ingested).toBe(1);
    expect((await usage(oldCall, 10, { "trace.org_membership_id": teammate })).skipped).toBe(1);
    expect(await fixture()).toEqual(late);
    expect(await calls()).toHaveLength(count);
    evidence.recordAssertionEvidence("Rollover recovers admission without clearing unknown facts or regenerating old audio", "Expired original bucket IDs no longer consumed new allowance. The old receipt remained unpriced until a late webhook charged exactly its three original buckets; current windows, replay, and a cross-member collision stayed unchanged, with no extra generation.", true);
  });
});
