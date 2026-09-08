import { expect } from "vitest";
import { createDenClient } from "@openwork/sdk";
import { createHmac } from "node:crypto";
import { spec } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { modelsInferenceWorld } from "../worlds/models-analytics.ts";

const test = spec.world(modelsInferenceWorld, { timeout: 900_000, needs: {} });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an API object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an API array");
  return value.map(record);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

test("DPA policy blocks warm managed keys without revoking customer-owned models or another organization", async ({ world, evidence, probe }) => {
  const admin = world.den.admin;
  const teammate = world.den.members.teammate;
  if (!teammate) throw new Error("Missing non-platform-admin member");
  const api = (path: string, method = "GET", body?: unknown, session = admin, orgId = world.orgId) => denFetch(session, path, {
    method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const fixture = async (action = "state", body?: unknown) => {
    const response = await fetch(`${world.witnessUrl}/fixture/dpa/${action}`, {
      method: "POST", body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
    });
    expect(response.status, `fixture ${action}`).toBe(200);
    return record(await response.json());
  };
  const calls = async () => {
    const response = await fetch(`${world.witnessUrl}/fixture/requests`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    return list(record(await response.json()).calls);
  };
  const complete = async (key = world.fixtureKey(world.memberId), extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(`${world.inferenceUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-openwork-session-id": "warm-dpa-session", ...headers },
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Synthetic boundary request" }], stream: false, ...extra }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: record(await response.json()) };
  };
  const adminPath = `/v1/admin/organizations/${world.orgId}/dpa`;
  const sdk = createDenClient({ baseUrl: world.den.ref.apiUrl, token: admin.token, orgId: world.orgId });
  const setDpa = async (dpaSigned: boolean, reason: string) => {
    const response = await sdk.patchV1AdminOrganizationsByOrganizationIdDpa(
      { organizationId: world.orgId, dpaSigned, reason }, { signal: AbortSignal.timeout(30_000) },
    );
    expect(response.response.status, JSON.stringify(response.error)).toBe(200);
    expect(response.data).toEqual({ ok: true, organization: { id: world.orgId, dpaSigned } });
  };
  const blocked = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, status = 403) => {
    const before = await calls();
    const response = await complete(undefined, extra, headers);
    expect(response.status).toBe(status);
    expect(record(response.body.error).code).toBe(status === 403 ? "managed_models_disabled_for_dpa" : "managed_models_policy_unavailable");
    expect(await calls()).toEqual(before);
  };
  const context = record((await api("/v1/org")).body);
  const actorUserId = text(record(context.currentMember).userId);
  const teammateId = text(record(record((await api("/v1/org", "GET", undefined, teammate)).body).currentMember).id);
  const initialProviders = list(record((await api("/v1/llm-providers")).body).llmProviders);
  const managed = initialProviders.find((provider) => provider.source === "openwork");
  if (!managed) throw new Error("Missing provisioned managed provider");
  const managedId = text(managed.id);
  expect((await complete()).status).toBe(200);
  expect(await calls()).toEqual([expect.objectContaining({ route: "managed", authenticated: true })]);
  expect(list((await fixture()).audits)).toEqual([]);
  evidence.recordAssertionEvidence("Absent DPA flag permits real managed inference", "A pre-issued DB-backed key returned HTTP 200 and the independent upstream saw exactly one authenticated managed request.", true);

  // Keep the same user's bearer, but issue a different organization-bound key.
  const created = await api("/v1/org", "POST", { name: "Unrestricted Control" });
  expect(created.response.status, created.text).toBe(201);
  const otherOrgId = text(record(record(created.body).organization).id);
  await world.arrange("subscription", otherOrgId);
  expect((await api("/v1/inference", "PATCH", { enabled: true }, admin, otherOrgId)).response.status).toBe(200);
  await world.arrange("configure", otherOrgId);
  const otherContext = record((await api("/v1/org", "GET", undefined, admin, otherOrgId)).body);
  expect(record(otherContext.currentMember).userId).toBe(actorUserId);
  const otherKey = world.fixtureKey(text(record(otherContext.currentMember).id));
  const foreign = await world.anotherOrganization();

  // A normal workspace administrator is deliberately not a platform administrator.
  expect((await api(`/v1/members/${teammateId}/role`, "POST", { role: "admin" })).response.status).toBe(200);
  for (const session of [teammate, foreign.admin]) {
    const denied = await api(adminPath, "PATCH", { dpaSigned: true, reason: "unauthorized test" }, session);
    expect(denied.response.status).toBe(403);
  }
  const unauth = await fetch(`${world.den.ref.apiUrl}${adminPath}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dpaSigned: true, reason: "unauthenticated test" }), signal: AbortSignal.timeout(10_000) });
  expect(unauth.status).toBe(401);
  for (const body of [{ dpaSigned: "true", reason: "invalid boolean" }, { dpaSigned: true, reason: "x" }, { dpaSigned: true, reason: "unexpected field", extra: true }]) {
    expect((await api(adminPath, "PATCH", body)).response.status).toBe(400);
  }
  expect(list((await fixture()).audits)).toEqual([]);
  expect(record((await fixture()).metadata).dpaSigned).toBeUndefined();
  evidence.recordAssertionEvidence("Only allowlisted platform administrators may record DPA decisions", "Workspace admin and foreign admin received 403, anonymous caller 401, invalid payloads 400; independent storage still had no flag or audit events.", true);

  await setDpa(true, "boundary approved set");
  const marked = await fixture();
  expect(record(marked.metadata).dpaSigned).toBe(true);
  expect(list(marked.audits)).toEqual([expect.objectContaining({ actorUserId, action: "organization.dpa_signed.updated", payload: { previousDpaSigned: null, dpaSigned: true, reason: "boundary approved set" } })]);
  expect((await api(adminPath, "PATCH", { dpaSigned: false, reason: "unauthorized clear" }, teammate)).response.status).toBe(403);
  expect((await fixture()).audits).toEqual(marked.audits);
  expect(record((await fixture()).metadata).dpaSigned).toBe(true);
  await blocked();
  const models = await fetch(`${world.inferenceUrl}/api/v1/models`, { headers: { authorization: `Bearer ${world.fixtureKey(world.memberId)}` }, signal: AbortSignal.timeout(10_000) });
  expect(models.status).toBe(403);
  for (const extra of [
    { organizationId: otherOrgId, orgId: otherOrgId, dpaSigned: false },
    { models: ["z-ai/glm-5.2", "minimax/minimax-m3"], route: "fallback" },
    { provider: { allow_fallbacks: true }, model: "openrouter/auto" },
  ]) await blocked(extra, { "x-openwork-org-id": otherOrgId, "x-organization-id": otherOrgId, "x-openwork-member-id": text(record(otherContext.currentMember).id) });
  await blocked();
  const beforeOther = (await calls()).length;
  expect((await complete(otherKey)).status).toBe(200);
  expect((await calls()).length).toBe(beforeOther + 1);
  const foreignList = await api("/v1/llm-providers", "GET", undefined, foreign.admin);
  expect(foreignList.response.status).toBe(404);
  expect(record(foreignList.body).error).toBe("organization_not_found");
  evidence.recordAssertionEvidence("Warm-key denial is organization-bound and cannot be spoofed or retried around", "Same process, key, bearer and session: completion and models are 403, body/header scope spoofing, fallback payloads and retries add zero upstream calls. Same user in a second organization still completes with its own key; foreign membership does not confer access.", true);

  // There is no name-only managed-provider PATCH: the public write schema
  // requires a customer provider source. Arrange only the display name instead.
  expect((await api(`/v1/llm-providers/${managedId}`, "PATCH", { name: "Customer-looking renamed provider" })).response.status).toBe(400);
  await fixture("rename-managed");
  const renamed = list((await fixture()).providers).find((provider) => provider.id === managedId);
  expect(renamed).toMatchObject({ source: "openwork", name: "Customer-looking renamed provider" });

  for (const session of [admin, teammate]) {
    for (const scope of ["usable", "manageable"]) {
      const providers = await api(`/v1/llm-providers?scope=${scope}`, "GET", undefined, session);
      expect(providers.response.status).toBe(200);
      expect(list(record(providers.body).llmProviders).some((provider) => provider.source === "openwork")).toBe(false);
    }
  }
  const connect = await api(`/v1/llm-providers/${managedId}/connect`);
  expect(connect.response.status).toBe(200);
  expect(record(connect.body).llmProvider).toMatchObject({ apiKey: null, apiKeys: null, models: [], memberCredential: { state: "blocked" }, managedModelsPolicy: { allowed: false, code: "managed_models_disabled_for_dpa" } });
  expect(connect.text).not.toContain(world.fixtureKey(world.memberId));
  expect(record(record(connect.body).llmProvider).name).toBe("Customer-looking renamed provider");
  await blocked();
  evidence.recordAssertionEvidence("Managed denial follows source, not display name", "Name-only public PATCH is rejected with 400. A datastore-arranged rename preserves source=openwork; lists still hide it, direct connect stays redacted, and the warm inference key returns 403 with no upstream call. This does not claim public rename support.", true);
  const resources = await api("/v1/resources");
  expect(resources.response.status).toBe(200);
  expect(record(record(record(resources.body).resources).llmProviders)[managedId]).toBeUndefined();
  const beforePurchase = await fixture();
  for (const { path, method, body } of [
    { path: "/v1/inference", method: "PATCH", body: { enabled: true } },
    { path: "/v1/billing/stripe/checkout", method: "POST", body: {} },
    { path: "/v1/billing/stripe/checkout", method: "POST", body: { type: "inference" } },
  ]) {
    const denied = await api(path, method, body);
    expect(denied.response.status, denied.text).toBe(403);
    expect(record(denied.body).error).toBe("managed_models_disabled_for_dpa");
  }
  expect((await fixture()).egress).toEqual(beforePurchase.egress);
  expect((await fixture()).stripeRequests).toEqual(beforePurchase.stripeRequests);
  expect((await fixture()).keys).toEqual(beforePurchase.keys);
  evidence.recordAssertionEvidence("Managed inventory and purchase admission are disabled without breaking connect sync", "Usable/manageable lists and resource snapshot hide managed providers. Direct connect stays 200 with null credentials and no models. Enable and both checkout forms return policy 403 without new keys or external HTTP attempts.", true);

  await fixture("remove-member-access", { memberId: teammateId });
  const missing = await fixture();
  expect(list(missing.providers).some((provider) => provider.memberId === teammateId && provider.source === "openwork")).toBe(false);
  for (const session of [admin, teammate]) {
    expect((await api("/v1/inference", "GET", undefined, session)).response.status).toBe(200);
    expect((await api("/v1/llm-providers", "GET", undefined, session)).response.status).toBe(200);
  }
  expect((await fixture()).keys).toEqual(missing.keys);
  expect((await fixture()).providers).toEqual(missing.providers);
  await blocked();
  evidence.recordAssertionEvidence("GET repair cannot restore missing managed member access", "After arranging a missing member provider and revoked member key, both members' inference/list GETs returned 200 without changing stored keys/providers; the owner's pre-issued key remains 403.", true);

  const invitation = await api("/v1/invitations", "POST", { email: foreign.admin.email, role: "member" });
  expect(invitation.response.status, invitation.text).toBe(201);
  const accepted = await api("/v1/orgs/invitations/accept", "POST", { id: text(record(invitation.body).inviteToken) }, foreign.admin);
  expect(accepted.response.status, accepted.text).toBe(200);
  const newcomerContext = await api("/v1/org", "GET", undefined, foreign.admin);
  expect(newcomerContext.response.status).toBe(200);
  const newcomerId = text(record(record(newcomerContext.body).currentMember).id);
  const newcomerProviders = await api("/v1/llm-providers", "GET", undefined, foreign.admin);
  expect(newcomerProviders.response.status).toBe(200);
  expect(list(record(newcomerProviders.body).llmProviders)).toEqual([]);
  const joined = await fixture();
  expect(list(joined.keys).some((key) => key.memberId === newcomerId)).toBe(false);
  expect(list(joined.providers).some((provider) => provider.memberId === newcomerId)).toBe(false);
  evidence.recordAssertionEvidence("New member acceptance does not provision managed access under DPA", "An existing foreign account accepted a real invitation as an ordinary member; its scoped list is empty and independent storage contains no managed key or provider for that new membership.", true);

  const byok = await api("/v1/llm-providers", "POST", {
    name: "OpenWork OpenRouter Customer", source: "custom", apiKey: "fixture-customer-owned-key", allMembers: true,
    customConfig: { id: "openrouter", name: "OpenWork Customer Models", npm: "@ai-sdk/openai-compatible", env: ["CUSTOMER_MODEL_KEY"], api: `${world.witnessUrl}/byok`, models: [{ id: "z-ai/glm-5.2", name: "Customer GLM" }] },
  });
  expect(byok.response.status, byok.text).toBe(201);
  const byokId = text(record(record(byok.body).llmProvider).id);
  for (const session of [admin, teammate, foreign.admin]) {
    const inventory = await api("/v1/llm-providers", "GET", undefined, session);
    expect(list(record(inventory.body).llmProviders).map((provider) => provider.id)).toContain(byokId);
    expect(inventory.text).not.toContain("fixture-customer-owned-key");
    const delivered = await api(`/v1/llm-providers/${byokId}/connect`, "GET", undefined, session);
    expect(delivered.response.status).toBe(200);
    const provider = record(record(delivered.body).llmProvider);
    expect(provider.source).toBe("custom");
    const baseUrl = text(record(provider.providerConfig).api);
    expect(baseUrl).toBe(`${world.witnessUrl}/byok`);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${text(provider.apiKey)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: text(list(provider.models)[0].id), messages: [{ role: "user", content: "Customer route" }] }), signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(record(await response.json()).choices).toBeDefined();
  }
  expect((await calls()).filter((call) => call.route === "byok")).toEqual([
    expect.objectContaining({ authenticated: true, model: "z-ai/glm-5.2" }), expect.objectContaining({ authenticated: true, model: "z-ai/glm-5.2" }), expect.objectContaining({ authenticated: true, model: "z-ai/glm-5.2" }),
  ]);
  await blocked();
  evidence.recordAssertionEvidence("Customer-owned providers survive branding overlap and route with delivered credentials", "Owner and member list/connect the custom OpenRouter/OpenWork-branded provider, then use its delivered endpoint, model and credential for real HTTP completions witnessed as authenticated BYOK. Managed key stays blocked. This is a delivered-config client, not an OpenCode runtime claim.", true);

  for (const metadata of [{ dpaSigned: true }, { dpaSigned: false }, {}, JSON.stringify({ dpaSigned: false })]) {
    expect((await api("/v1/org", "PATCH", { metadata })).response.status).toBe(400);
  }
  expect((await api("/v1/org", "PATCH", { dpaSigned: false, name: "Protected" })).response.status).toBe(400);
  const signedIn = await denFetch(admin, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: admin.email, password: admin.password }) });
  const cookie = signedIn.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing BetterAuth cookie");
  for (const metadata of [{ dpaSigned: false }, {}, JSON.stringify({ dpaSigned: true })]) {
    const denied = await denFetch(admin, "/api/auth/organization/update", { method: "POST", headers: { cookie }, body: JSON.stringify({ organizationId: world.orgId, data: { metadata } }) });
    expect(denied.response.status, denied.text).toBe(403);
  }
  const rawCreate = await denFetch(admin, "/api/auth/organization/create", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Raw DPA", slug: `raw-${world.orgId}`, metadata: { dpaSigned: true } }) });
  expect(rawCreate.response.status, rawCreate.text).toBe(403);
  expect(record((await fixture()).metadata).dpaSigned).toBe(true);
  expect(list((await fixture()).audits)).toHaveLength(1);
  await blocked();
  evidence.recordAssertionEvidence("Ordinary and raw BetterAuth metadata writes cannot set or erase the flag", "Strict Den writes rejected extra metadata/flag with 400; raw BetterAuth replacement and creation attempts returned 403. Flag remains true with exactly one approved audit event.", true);

  await setDpa(false, "boundary approved unset");
  const unset = await fixture();
  expect(record(unset.metadata).dpaSigned).toBe(false);
  expect(list(unset.audits)).toHaveLength(2);
  expect(list(unset.audits)[1]).toMatchObject({ actorUserId, payload: { previousDpaSigned: true, dpaSigned: false, reason: "boundary approved unset" } });
  expect((await complete()).status).toBe(200);
  evidence.recordAssertionEvidence("Approved unset restores the original key and records the transition", "The warm key returned 200 with explicit false; datastore audit identifies the approving actor, previous true, new false and reason.", true);
  const memberSdk = createDenClient({ baseUrl: world.den.ref.apiUrl, token: teammate.token, orgId: world.orgId });
  const forbiddenSdk = await memberSdk.patchV1AdminOrganizationsByOrganizationIdDpa(
    { organizationId: world.orgId, dpaSigned: true, reason: "SDK unauthorized mutation" },
    { signal: AbortSignal.timeout(30_000) },
  );
  expect(forbiddenSdk.response.status).toBe(403);
  expect(forbiddenSdk.data).toBeUndefined();
  expect(record((await fixture()).metadata).dpaSigned).toBe(false);
  expect((await fixture()).audits).toEqual(unset.audits);
  evidence.recordAssertionEvidence("Generated SDK carries the DPA body and preserves admin authorization", "Generated typed set/unset calls send the flag and reason and return the declared success body, verified against persisted metadata and audit transitions. A workspace admin using the same generated method receives 403 with no mutation or new audit.", true);

  await fixture("audit-failure");
  try {
    expect((await api(adminPath, "PATCH", { dpaSigned: true, reason: "must roll back" })).response.status).toBe(500);
  } finally { await fixture("audit-restore"); }
  expect(record((await fixture()).metadata).dpaSigned).toBe(false);
  expect(list((await fixture()).audits)).toHaveLength(2);
  expect((await complete()).status).toBe(200);
  evidence.recordAssertionEvidence("Audit insertion and DPA mutation are atomic", "A real audit column outage caused admin PATCH 500; after storage recovery no event was added and the flag stayed false with the original key usable.", true);

  const priorAuditCount = list((await fixture()).audits).length;
  for (let index = 0; index < 3; index++) {
    const outcomes = await Promise.all([
      api("/v1/org", "PATCH", { brandAppName: `Boundary ${index}` }),
      api(adminPath, "PATCH", { dpaSigned: true, reason: `concurrent set ${index}` }),
      api(`/v1/admin/organizations/${world.orgId}/capabilities`, "PUT", { capabilities: { modelsAnalytics: false } }),
    ]);
    expect(outcomes.map((outcome) => outcome.response.status)).toEqual([200, 200, 200]);
    const metadata = record((await fixture()).metadata);
    expect(metadata).toMatchObject({ dpaSigned: true, brandAppName: `Boundary ${index}`, fixtureNested: { keep: { value: "unchanged" } }, capabilities: { modelsAnalytics: false } });
    await blocked();
  }
  expect(list((await fixture()).audits)).toHaveLength(priorAuditCount + 3);
  evidence.recordAssertionEvidence("Concurrent ordinary/admin metadata changes preserve DPA and unrelated nested data", "Three concurrent rounds of branding, capability and DPA updates all returned 200, preserved nested fixture metadata and all requested changes, added one audit each, and kept inference blocked.", true);

  for (const input of [
    { mode: "string-true" },
    { value: "{malformed" },
    { value: [] },
    { value: 42 },
  ]) {
    await fixture("metadata", input);
    await blocked({}, {}, "mode" in input ? 403 : 503);
  }
  await fixture("metadata", { mode: "restore" });
  await fixture("read-failure");
  try { await blocked({}, {}, 503); } finally { await fixture("read-restore"); }
  await fixture("metadata", { mode: "nonboolean" });
  await blocked({}, {}, 503);
  for (const dpaSigned of [null, 0, 1, "false", {}, []]) {
    await fixture("metadata", { value: { dpaSigned } });
    // The datastore witness confirms falsy and structured values were not
    // defaulted away by fixture arrangement before exercising the real policy.
    expect(record((await fixture()).metadata).dpaSigned).toEqual(dpaSigned);
    await blocked({}, {}, 503);
  }
  await fixture("metadata", { mode: "restore" });
  expect(record((await fixture()).metadata).dpaSigned).toBeUndefined();
  expect((await complete()).status).toBe(200);
  evidence.recordAssertionEvidence("Policy parsing and unavailable storage fail closed", "Serialized object true returns 403; malformed JSON, array, scalar, non-boolean flags and real missing metadata column return 503 with zero upstream calls. Restoring absent flag permits the original key.", true);

  // A real SQL table lock pauses a dependency after the initial policy read.
  await fixture("hold");
  const beforeRace = await calls();
  const inFlight = complete();
  try {
    await probe.eventually(async () => (await fixture()).waitingForLimits, { within: 10_000, label: "inference admitted and blocked on limits SQL", until: (waiting) => waiting === true });
    await setDpa(true, "changed during admission");
  } finally { await fixture("release"); }
  const raced = await inFlight;
  expect(raced.status).toBe(403);
  expect(record(raced.body.error).code).toBe("managed_models_disabled_for_dpa");
  expect(await calls()).toEqual(beforeRace);
  await setDpa(false, "race recovery");
  expect((await complete()).status).toBe(200);
  evidence.recordAssertionEvidence("Policy is re-read immediately before dispatch", "Independent SQL processlist proved a request had passed initial admission and was blocked on limits. An approved policy change committed before releasing that lock. Same in-flight request returned 403 with zero upstream calls; unset restored 200.", true);

  // A checkout completed earlier can reach Den after managed access is disabled.
  // Hold the real Stripe SDK's HTTP response across the approved policy change.
  const disabled = await api("/v1/inference", "PATCH", { enabled: false });
  expect(disabled.response.status, disabled.text).toBe(200);
  expect(record(record(disabled.body).inference).enabled).toBe(false);
  const beforeDelayed = await fixture();
  expect(list(beforeDelayed.keys).every((key) => key.status === "revoked")).toBe(true);
  expect(list(beforeDelayed.providers).some((provider) => provider.source === "openwork")).toBe(false);
  const beforeDelayedCalls = await calls();
  await fixture("stripe-hold");
  const delayedSync = api("/v1/billing/stripe/checkout/sync", "POST", { sessionId: "cs_fixture_dpa" });
  try {
    await probe.eventually(async () => (await fixture()).stripeInFlight, { within: 10_000, label: "real Stripe checkout retrieval held", until: (waiting) => waiting === true });
    await setDpa(true, "DPA signed before delayed checkout returns");
  } finally { await fixture("stripe-release"); }
  const synced = await delayedSync;
  expect(synced.response.status, synced.text).toBe(200);
  expect(synced.body).toMatchObject({ synced: true });
  const afterDelayed = await fixture();
  expect(afterDelayed.subscriptions).toEqual([{ type: "inference", status: "active", quantity: 7, lastEventId: "checkout-session-sync:cs_fixture_dpa" }]);
  expect(afterDelayed.keys).toEqual(beforeDelayed.keys);
  expect(afterDelayed.providers).toEqual(beforeDelayed.providers);
  expect(record(afterDelayed.metadata)).toMatchObject({ dpaSigned: true });
  expect(record(afterDelayed.metadata).inference).toEqual(record(beforeDelayed.metadata).inference);
  expect(list(afterDelayed.stripeRequests).slice(list(beforeDelayed.stripeRequests).length)).toEqual([
    { method: "GET", path: "/v1/checkout/sessions/cs_fixture_dpa", authenticated: true },
    { method: "GET", path: `/v1/subscriptions/sub_fixture_${world.orgId}`, authenticated: true },
    { method: "GET", path: `/v1/subscriptions/sub_fixture_${world.orgId}`, authenticated: true },
  ]);
  expect(await calls()).toEqual(beforeDelayedCalls);
  evidence.recordAssertionEvidence("Delayed checkout sync records purchase history without reactivation", "A real SDK checkout retrieval was held over the approved DPA transition. Release returned sync 200 and persisted active purchase quantity 7 plus checkout event ID. Revoked keys, absent managed providers and disabled inference metadata stayed unchanged; zero inference calls.", true);

  const webhook = async (type: string, validSignature: boolean) => {
    const payload = JSON.stringify({ id: `evt_fixture_${type.replaceAll(".", "_")}`, object: "event", type, data: { object: { id: "cs_fixture_dpa", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", subscription: `sub_fixture_${world.orgId}`, metadata: { org_id: world.orgId, subscription_type: "inference" } } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", validSignature ? "whsec_models_dpa_fixture_not_real" : "wrong_fixture_secret").update(`${timestamp}.${payload}`).digest("hex");
    return fetch(`${world.den.ref.apiUrl}/v1/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload, signal: AbortSignal.timeout(15_000) });
  };
  expect((await webhook("checkout.session.completed", false)).status).toBe(400);
  expect((await fixture()).subscriptions).toEqual(afterDelayed.subscriptions);
  expect((await fixture()).stripeRequests).toEqual(afterDelayed.stripeRequests);
  for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
    const beforeEvent = await fixture();
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await webhook(type, true);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, type });
      const afterEvent = await fixture();
      expect(afterEvent.subscriptions).toEqual([{ type: "inference", status: "active", quantity: 7, lastEventId: `evt_fixture_${type.replaceAll(".", "_")}` }]);
      expect(afterEvent.keys).toEqual(beforeDelayed.keys);
      expect(afterEvent.providers).toEqual(beforeDelayed.providers);
      expect(record(afterEvent.metadata).dpaSigned).toBe(true);
      expect(record(afterEvent.metadata).inference).toEqual(record(beforeDelayed.metadata).inference);
      expect(await calls()).toEqual(beforeDelayedCalls);
    }
    expect(list((await fixture()).stripeRequests).length).toBe(list(beforeEvent.stripeRequests).length + 4);
  }
  const afterWebhooks = await api("/v1/inference");
  expect(afterWebhooks.response.status).toBe(200);
  expect(record(record(afterWebhooks.body).inference).enabled).toBe(false);
  expect(list(record((await api("/v1/llm-providers")).body).llmProviders).some((provider) => provider.source === "openwork")).toBe(false);
  evidence.recordAssertionEvidence("Signed delayed Stripe webhooks retain history without managed reactivation", "Invalid HMAC was rejected with 400 before any SDK read or history change. Real signature verification accepted completed and async-payment-success events, including repeated deliveries, with event IDs persisted. Keys/providers and disabled inference remained unchanged; no inference upstream calls.", true);
  const final = await fixture();
  expect(final.egress).toEqual([]);
  expect(list(final.stripeRequests).every((request) => request.authenticated === true && request.method === "GET")).toBe(true);
  expect((await calls()).every((call) => call.authenticated === true)).toBe(true);
  evidence.recordAssertionEvidence("Synthetic providers only", "Den/inference child environments blank real provider, Stripe and telemetry credentials. Stripe uses only a fixture key and loopback SDK transport. Preload refuses non-loopback HTTP; zero external attempts were recorded and every provider request carried the expected synthetic credential.", true);
});
