import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudProviderDenSession } from "../src/cloud-provider-sync.js";
import { shareDeviceProvider } from "../src/device-provider-share.js";
import { ApiError } from "../src/errors.js";

const session: CloudProviderDenSession = { baseUrl: "https://den.example.invalid", token: "den-session-token", orgId: "org_test" };
const DEVICE_KEY = "sk-device-key-0001";

type Call = { method: string; url: string; authorization: string | null; orgId: string | null; body: unknown };

/** A Den that answers the options read and the create with whatever the test set. */
function den(answers: { options?: { status: number; body: unknown }; create?: { status: number; body: unknown } }) {
  const calls: Call[] = [];
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    calls.push({ method, url, authorization: headers.get("authorization"), orgId: headers.get("x-openwork-org-id"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    assert.equal(init?.redirect, "error", "a key is never followed to another address");
    const answer = method === "GET" ? answers.options : answers.create;
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return Response.json(answer.body, { status: answer.status });
  }, { preconnect: fetch.preconnect });
  return { calls, fetchImpl };
}

const shareable = (status = "shareable") => ({
  status: 200,
  body: { canShare: true, blocker: null, managerName: null, verificationRequired: false, providers: [{ providerId: "anthropic", name: "Anthropic", status, ...(status === "shared" ? { sharedAs: "Team Anthropic" } : {}) }] },
});

async function refusal(run: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try { await run; } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return { status: error.status, code: error.code, message: error.message };
  }
  throw new Error("expected the share to be refused");
}

test("a confirmed share asks Den first, then sends this computer's key for everyone", async () => {
  const { calls, fetchImpl } = den({ options: shareable(), create: { status: 201, body: { inferenceProvider: { id: "ipr_01", name: "Anthropic" } } } });
  const read: string[] = [];
  const result = await shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async (id) => { read.push(id); return ` ${DEVICE_KEY}\n`; } });

  assert.deepEqual(result, { inferenceProviderId: "ipr_01", name: "Anthropic" });
  assert.ok(!JSON.stringify(result).includes(DEVICE_KEY), "the key is never returned to the app");
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "https://den.example.invalid/v1/inference-providers/device-share-options?providerIds=anthropic"],
    ["POST", "https://den.example.invalid/v1/inference-providers"],
  ]);
  assert.ok(calls.every((call) => call.authorization === "Bearer den-session-token" && call.orgId === "org_test"));
  assert.equal(calls[0]?.body, null, "the question carries no key");
  assert.deepEqual(calls[1]?.body, { name: "Anthropic", providerId: "anthropic", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true, shareFromDevice: true });
  assert.deepEqual(read, ["anthropic"]);
});

test("the key is not read when Den says no", async () => {
  const cases: Array<{ name: string; options: { status: number; body: unknown }; expected: [number, string] }> = [
    { name: "feature off", options: { status: 404, body: { error: "feature_disabled", feature: "shareDeviceProvider" } }, expected: [404, "feature_disabled"] },
    { name: "a member", options: { status: 200, body: { canShare: false, blocker: "no_permission", managerName: "Avery Owner", verificationRequired: false, providers: [] } }, expected: [403, "forbidden"] },
    { name: "no AI Gateway", options: { status: 200, body: { canShare: false, blocker: "gateway_unavailable", managerName: null, verificationRequired: false, providers: [] } }, expected: [409, "gateway_unavailable"] },
    { name: "already shared", options: shareable("shared"), expected: [409, "already_shared"] },
    { name: "needs more than one key", options: shareable("unsupported"), expected: [409, "not_shareable"] },
    { name: "signed out", options: { status: 401, body: { error: "unauthorized" } }, expected: [401, "no_session"] },
    { name: "an answer in another shape", options: { status: 200, body: { canShare: true } }, expected: [502, "share_failed"] },
  ];
  for (const entry of cases) {
    const { calls, fetchImpl } = den({ options: entry.options });
    let read = 0;
    const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => { read += 1; return DEVICE_KEY; } }));
    assert.deepEqual([error.status, error.code], entry.expected, entry.name);
    assert.equal(read, 0, `${entry.name}: the key stays unread`);
    assert.deepEqual(calls.map((call) => call.method), ["GET"], `${entry.name}: nothing is created`);
  }
});

test("only a provider connected on this computer can be shared", async () => {
  for (const providerId of ["ipr_01abc", "lpr_01abc", "openwork", "openwork-free", "../auth", "", "has space"]) {
    const { calls, fetchImpl } = den({});
    const error = await refusal(shareDeviceProvider({ session, providerId, fetchImpl, readApiKey: async () => DEVICE_KEY }));
    assert.deepEqual([error.status, error.code], [400, "invalid_provider"], providerId);
    assert.equal(calls.length, 0, `${providerId}: Den is not asked`);
  }
});

test("a provider without a saved key shares nothing", async () => {
  const { calls, fetchImpl } = den({ options: shareable() });
  const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => null }));
  assert.deepEqual([error.status, error.code], [409, "no_device_key"]);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("Den's refusals of the create come back as what the person can do, never with the key", async () => {
  const cases: Array<{ create: { status: number; body: unknown }; expected: [number, string] }> = [
    { create: { status: 403, body: { error: "reauth", reason: "fresh_auth_required", message: "For security, confirm it's you before changing workspace settings." } }, expected: [403, "verification_required"] },
    { create: { status: 403, body: { error: "forbidden" } }, expected: [403, "forbidden"] },
    { create: { status: 403, body: { error: "gateway_not_enabled" } }, expected: [409, "gateway_unavailable"] },
    { create: { status: 500, body: { error: "internal_error", message: `failed for ${DEVICE_KEY}` } }, expected: [502, "share_unconfirmed"] },
    { create: { status: 201, body: { inferenceProvider: {} } }, expected: [502, "share_unconfirmed"] },
  ];
  for (const entry of cases) {
    const { fetchImpl } = den({ options: shareable(), create: entry.create });
    const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => DEVICE_KEY }));
    assert.deepEqual([error.status, error.code], entry.expected);
    assert.ok(!error.message.includes(DEVICE_KEY), "Den's own text is never passed on");
  }
});

test("an unreachable Den shares nothing", async () => {
  const fetchImpl = Object.assign(async () => { throw new Error(`connect ECONNREFUSED with ${DEVICE_KEY}`); }, { preconnect: fetch.preconnect });
  const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => DEVICE_KEY }));
  assert.deepEqual([error.status, error.code], [502, "den_unreachable"]);
  assert.ok(!error.message.includes(DEVICE_KEY));
});

test("an older sign-in never even reads the device key before verification", async () => {
  const answer = shareable();
  answer.body.verificationRequired = true;
  const { calls, fetchImpl } = den({ options: answer });
  let reads = 0;
  const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => { reads++; return DEVICE_KEY; } }));
  assert.equal(error.code, "verification_required");
  assert.equal(reads, 0);
  assert.equal(calls.length, 1);
});

test("a verification token cannot substitute a different account", async () => {
  for (const matches of [true, false]) {
    const { calls, fetchImpl: providerFetch } = den({ options: shareable(), create: { status: 201, body: { inferenceProvider: { id: "ipr_verified", name: "Anthropic" } } } });
    const fetchImpl = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/me")) {
        const isOriginal = new Headers(init?.headers).get("authorization") === `Bearer ${session.token}`;
        return Response.json({ user: { id: isOriginal || matches ? "usr_original" : "usr_other" } });
      }
      return providerFetch(url, init);
    }, { preconnect: fetch.preconnect });
    let reads = 0;
    const run = shareDeviceProvider({ session, providerId: "anthropic", verifiedToken: "fresh-token", fetchImpl, readApiKey: async () => { reads++; return DEVICE_KEY; } });
    if (matches) {
      assert.equal((await run).inferenceProviderId, "ipr_verified");
      assert.equal(reads, 1);
      assert.ok(calls.every((call) => call.authorization === "Bearer fresh-token"));
    } else {
      assert.equal((await refusal(run)).code, "account_mismatch");
      assert.equal(reads, 0);
      assert.equal(calls.length, 0);
    }
  }
});

test("switching the active account or organization during the read sends nothing", async () => {
  let current = true;
  const { calls, fetchImpl } = den({ options: shareable() });
  const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, isCurrentSession: () => current,
    readApiKey: async () => { current = false; return DEVICE_KEY; },
  }));
  assert.equal(error.code, "organization_mismatch");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("a lost create response is unconfirmed, never a claim that nothing was shared", async () => {
  const { fetchImpl: optionsFetch } = den({ options: shareable() });
  const fetchImpl = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("response lost after commit");
    return optionsFetch(url, init);
  }, { preconnect: fetch.preconnect });
  const error = await refusal(shareDeviceProvider({ session, providerId: "anthropic", fetchImpl, readApiKey: async () => DEVICE_KEY }));
  assert.equal(error.code, "share_unconfirmed");
  assert.ok(!error.message.includes("Nothing was shared"));
});
