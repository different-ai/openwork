import assert from "node:assert/strict";
import { test } from "node:test";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { configureWorkshop, WORKSHOP_CONNECTIONS, WORKSHOP_MODEL } from "./workshop-setup.ts";

const upstreamKey = "fixture-upstream-secret-not-real";
const ref = { apiUrl: "https://den-api.workshop.invalid", webUrl: "https://den.workshop.invalid" };
const session = (key: string): DenSession => ({ ...ref, email: `${key}@workshop.invalid`, password: `private-password-${key}`, token: `private-token-${key}` });
function fixture(): Den {
  return {
    ref, admin: session("owner"), members: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`seat-${i}`, session(`seat-${i}`)])),
    gateway: { publicUrl: "https://gateway.workshop.invalid" }, mocks: {},
    async apiLog() { throw new Error("No live Den in this test"); },
    async [Symbol.asyncDispose]() {},
  };
}

interface Call { path: string; method: string; body: unknown; seat: string; org: string | null }
function mockDen(options: { elevatedSeat?: string; overrideBudget?: boolean; leakedKey?: boolean; errorBody?: boolean; extraMember?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(typeof input, "string", "Den uses its supplied API URL, not another service");
    const url = new URL(String(input));
    assert.equal(url.origin, ref.apiUrl, "no upstream, OAuth, model, or infrastructure network calls");
    const headers = new Headers(init?.headers);
    const seat = (headers.get("authorization") ?? "").replace("Bearer private-token-", "");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path: `${url.pathname}${url.search}`, method, body, seat, org: headers.get("x-openwork-org-id") });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === "/v1/org") return json({
      organization: { id: "org_workshop" },
      members: [{ id: "member_owner" }, ...Array.from({ length: 20 }, (_, i) => ({ id: `member_seat-${i}` })), ...(options.extraMember ? [{ id: "member_unapproved" }] : [])],
      currentMember: { id: `member_${seat}`, userId: `user_${seat}`, role: seat === "owner" ? "owner" : options.elevatedSeat === seat ? "admin" : "member", directRole: seat === "owner" ? "owner" : "member", isOwner: seat === "owner", permissions: [] },
      deploymentCapabilities: { version: 1, aiGateway: true }, canManageDeploymentServices: seat === "owner",
    });
    if (url.pathname === "/v1/gateway/usage-limit-policies") return json({ id: "policy_workshop" });
    if (url.pathname.endsWith("/assignments")) return json({ id: "policy_workshop" });
    if (url.pathname === "/v1/gateway/usage-limits/me") return json({
      memberId: `member_${seat}`, organizationId: "org_workshop", state: "within_limit", providers: [],
      buckets: [{ id: `bucket_${seat}`, policyId: "policy_workshop", timeframe: "week", baseAllowanceMicroUsd: 5_000_000,
        allowanceMicroUsd: options.overrideBudget ? 10_000_000 : 5_000_000, extensionMicroUsd: 0, hardLimit: true, allowRequestReset: false }],
    });
    if (url.pathname === "/v1/inference-providers" && method === "POST") {
      if (options.errorBody) return json({ error: "invalid_key", message: upstreamKey }, 400);
      return json({ inferenceProvider: { id: "provider_workshop" } }, 201);
    }
    const provider = { id: "provider_workshop", source: "openwork_gateway", credentialStatus: "ready",
      models: [{ id: "gwm_workshop", name: "Sol 6.1", upstreamModelId: WORKSHOP_MODEL }],
      apiKey: options.leakedKey ? upstreamKey : `private-gateway-key-${seat}` };
    if (url.pathname === "/v1/inference-providers" && method === "GET") return json({ inferenceProviders: [provider] });
    if (url.pathname.endsWith("/connect")) return json({ inferenceProvider: provider });
    if (url.pathname.startsWith("/v1/mcp-connections/by-key/")) {
      assert.equal(method, "PUT");
      return json({ id: `connection_${url.pathname.split("/").at(-1)}` }, 201);
    }
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  };
  return { calls, fetchMock };
}

test("workshop setup uses real managed-provider payload, twenty member-ID budgets, and five keyed per-member OAuth connections", async (t) => {
  const den = fixture();
  const { calls, fetchMock } = mockDen();
  t.mock.method(globalThis, "fetch", fetchMock);
  const result = await configureWorkshop(den, { upstreamKey, allowanceUsd: 5 });
  const writes = calls.filter((call) => call.method !== "GET");
  assert.deepEqual(writes[0]?.body, { name: "Workshop weekly allowance", hardLimit: true, allowRequestReset: false, limits: [{ timeframe: "week", costUsd: "5" }] });
  const assignments = writes.filter((call) => call.path.endsWith("/assignments"));
  assert.equal(assignments.length, 20);
  assert.deepEqual(assignments.map((call) => call.body), Array.from({ length: 20 }, (_, i) => ({ memberId: `member_seat-${i}` })));
  assert.ok(writes.every((call) => call.seat === "owner" && call.org === "org_workshop"));
  assert.ok(calls.slice(1).every((call) => call.org === "org_workshop"), "all subsequent calls are scoped to the same organization");
  assert.deepEqual(writes.find((call) => call.path === "/v1/inference-providers")?.body, {
    name: "Workshop Sol 6.1", providerId: "openai", modelIds: ["gpt-6.1-sol"],
    credential: { kind: "api_key", secret: upstreamKey }, settings: { upstreamBaseUrl: "https://api.openai.com/v1" },
    memberIds: Array.from({ length: 20 }, (_, i) => `member_seat-${i}`),
  });
  assert.ok(!JSON.stringify(writes.find((call) => call.path === "/v1/inference-providers")?.body).includes("allMembers"), "no organization-wide grant: later members get no unbudgeted access");
  const providerIndex = calls.findIndex((call) => call.path === "/v1/inference-providers" && call.method === "POST");
  assert.equal(calls.slice(0, providerIndex).filter((call) => call.path === "/v1/gateway/usage-limits/me").length, 20, "verify every effective budget before granting the real provider");
  assert.equal(calls.filter((call) => call.path.endsWith("/connect")).length, 20);
  const connections = calls.filter((call) => call.path.startsWith("/v1/mcp-connections/"));
  assert.equal(connections.length, 5);
  assert.deepEqual(connections.map((call) => call.body), WORKSHOP_CONNECTIONS.map((connection) => ({
    kind: "external_mcp", name: connection.name, url: connection.url, authType: "oauth", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true },
  })));
  assert.equal(result.members.length, 20);
  assert.equal(result.totalEstimatedAllowanceUsd, 100);
  assert.equal(result.inferenceRequestVerified, false, "a GET connect payload is not proof of paid model inference");
  assert.match(result.budgetCaveat, /in-flight requests can overshoot/);
  const publicJson = JSON.stringify(result);
  for (const secret of [upstreamKey, den.admin.password, den.admin.token, ...Object.values(den.members).flatMap((member) => [member.password, member.token]), "private-gateway-key-"]) {
    assert.ok(!publicJson.includes(secret), "public result contains no controller or member secrets");
  }
});

test("owners/admins or duplicate attendee sessions are rejected before writes", async (t) => {
  const den = fixture();
  const { calls, fetchMock } = mockDen({ elevatedSeat: "seat-19" });
  t.mock.method(globalThis, "fetch", fetchMock);
  await assert.rejects(configureWorkshop(den, { upstreamKey, allowanceUsd: 5 }), /ordinary member/);
  assert.ok(calls.every((call) => call.method === "GET"));
  den.members["seat-19"] = den.admin;
  calls.length = 0;
  await assert.rejects(configureWorkshop(den, { upstreamKey, allowanceUsd: 5 }), /owner\/admin session/);
  assert.equal(calls.length, 0);
  den.members["seat-19"] = den.members["seat-0"]!;
  await assert.rejects(configureWorkshop(den, { upstreamKey, allowanceUsd: 5 }), /unique ordinary members/);
  assert.equal(calls.length, 0);
});

test("an extra organization member is refused before an all-members grant can bypass the approved budgets", async (t) => {
  const { calls, fetchMock } = mockDen({ extraMember: true });
  t.mock.method(globalThis, "fetch", fetchMock);
  await assert.rejects(configureWorkshop(fixture(), { upstreamKey, allowanceUsd: 5 }), /only the controller/);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("a competing effective budget prevents enabling paid inference", async (t) => {
  const { calls, fetchMock } = mockDen({ overrideBudget: true });
  t.mock.method(globalThis, "fetch", fetchMock);
  await assert.rejects(configureWorkshop(fixture(), { upstreamKey, allowanceUsd: 5 }), /effective allowance/);
  assert.ok(!calls.some((call) => call.path === "/v1/inference-providers"));
});

test("upstream credentials never escape through error bodies or a raw-key connect payload", async (t) => {
  for (const option of [{ errorBody: true }, { leakedKey: true }]) {
    const { fetchMock } = mockDen(option);
    const mock = t.mock.method(globalThis, "fetch", fetchMock);
    await assert.rejects(configureWorkshop(fixture(), { upstreamKey, allowanceUsd: 5 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(upstreamKey));
      return true;
    });
    mock.mock.restore();
  }
});

test("unapproved attendee count, allowance, or a missing real Gateway fails without network", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden"); });
  for (const allowanceUsd of [0, -1, 5.01, Number.NaN, 0.0000001]) {
    await assert.rejects(configureWorkshop(fixture(), { upstreamKey, allowanceUsd }), /allowance/);
  }
  const den = fixture();
  delete den.members["seat-19"];
  await assert.rejects(configureWorkshop(den, { upstreamKey, allowanceUsd: 5 }), /exactly 20/);
  delete den.gateway;
  await assert.rejects(configureWorkshop(den, { upstreamKey, allowanceUsd: 5 }), /real co-located Gateway/);
});
