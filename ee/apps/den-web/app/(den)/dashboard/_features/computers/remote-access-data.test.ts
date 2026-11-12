import assert from "node:assert/strict";
import { test } from "node:test";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import {
  RemoteAccessSettingsError,
  fetchRemoteAccessSettings,
  remoteAccessSettingsErrorStatus,
  remoteAccessSettingsQueryKey,
  saveRemoteAccessSettings,
} from "./remote-access-data";

type Call = { path: string; method: string | undefined; org: string | null; body: unknown };

/** Answers each request with the next reply and records what was sent. */
async function withDen<T>(replies: Array<{ status?: number; body: unknown }>, run: () => Promise<T>): Promise<{ calls: Call[]; result: T }> {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const reply = replies[calls.length] ?? replies.at(-1);
    calls.push({
      path: new URL(String(input), "http://den.test").pathname,
      method: init?.method,
      org: new Headers(init?.headers).get(ORG_SCOPE_HEADER),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(reply?.body ?? {}, { status: reply?.status ?? 200 });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function failure(run: () => Promise<unknown>): Promise<RemoteAccessSettingsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RemoteAccessSettingsError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

test("the organization's limit is read and saved as one access value, scoped to the organization on screen", async () => {
  const current = { settings: { access: "off" }, canEdit: true, allowsAll: false, optIn: true };
  const loaded = await withDen([{ body: current }], () => fetchRemoteAccessSettings("org_1"));
  assert.deepEqual(loaded.calls, [{ path: "/v1/org/remote-session-settings", method: "GET", org: "org_1", body: undefined }]);
  assert.deepEqual(loaded.result, current);
  for (const access of ["off", "created", "all"] as const) {
    const saved = await withDen([{ body: { settings: { access }, canEdit: true, allowsAll: true, optIn: false } }], () => saveRemoteAccessSettings("org_1", access));
    assert.deepEqual(saved.calls, [{ path: "/v1/org/remote-session-settings", method: "PATCH", org: "org_1", body: { access } }]);
    assert.equal(saved.result.settings.access, access);
  }
  assert.notDeepEqual(remoteAccessSettingsQueryKey("org_a"), remoteAccessSettingsQueryKey("org_b"));
});

test("an older API's answer, without allowsAll and optIn, reads as: everything can be chosen, and no opt-in", async () => {
  const older = { settings: { access: "created" }, canEdit: true };
  const loaded = await withDen([{ body: older }], () => fetchRemoteAccessSettings("org_1"));
  assert.deepEqual(loaded.result, { ...older, allowsAll: true, optIn: false });
  // And an API from before the setting was served on every Computers page: the row hides on this status.
  const missing = await failure(async () => (await withDen([{ status: 404, body: { error: "not_found" } }], () => fetchRemoteAccessSettings("org_1"))).result);
  assert.equal(missing.status, 404);
  assert.equal(remoteAccessSettingsErrorStatus(missing), 404);
  assert.equal(remoteAccessSettingsErrorStatus(new Error("x")), null);
});

test("a refusal shows Den's sentence, and never a bare code", async () => {
  const forbidden = await failure(async () => (await withDen([{ status: 403, body: { error: "forbidden", message: "You cannot edit organization settings." } }], () => saveRemoteAccessSettings("org_1", "all"))).result);
  assert.equal(forbidden.code, "forbidden");
  assert.equal(forbidden.message, "You cannot edit organization settings.");
  assert.equal(forbidden.status, 403);
  const disabled = await failure(async () => (await withDen([{ status: 409, body: { error: "feature_disabled" } }], () => saveRemoteAccessSettings("org_1", "all"))).result);
  assert.equal(disabled.code, "feature_disabled");
  assert.equal(disabled.message, "Couldn't save this setting. Try again.");
  const expired = await failure(async () => (await withDen([{ status: 401, body: {} }], () => fetchRemoteAccessSettings("org_1"))).result);
  assert.equal(expired.message, "Your session expired. Sign in again.");
  const invalid = await failure(async () => (await withDen([{ body: { settings: { access: "everything" }, canEdit: true } }], () => fetchRemoteAccessSettings("org_1"))).result);
  assert.equal(invalid.code, "unexpected_response");
  // A dropped connection reads as one, not as the browser's own error text.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    const dropped = await failure(() => fetchRemoteAccessSettings("org_1"));
    assert.equal(dropped.code, "network_error");
    assert.equal(dropped.message, "Couldn't reach OpenWork. Check your connection and try again.");
    assert.equal(dropped.status, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
