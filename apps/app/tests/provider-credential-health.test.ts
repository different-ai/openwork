import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createJSONStorage } from "zustand/middleware";
import { isProviderCredentialRejection } from "../src/react-app/domains/session/sync/session-error";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { credentialHealthKey, useProviderCredentialHealth } = await import("../src/react-app/domains/connections/provider-auth/credential-health");
const { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, observeProviderCredentialMessages } = await import("../src/react-app/domains/session/sync/session-sync");
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store");
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

const defaultStorage = useProviderCredentialHealth.persist.getOptions().storage;
const workspace = "workspace-fixture";
const provider = "openrouter";
const key = credentialHealthKey(workspace, provider);
let now = 100;
let stored = "";
const clock = () => now;

beforeEach(() => {
  now = 100;
  stored = "";
  spyOn(Date, "now").mockImplementation(clock);
  useProviderCredentialHealth.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => stored || null,
    setItem: (_key, value) => { stored = value; },
    removeItem: () => { stored = ""; },
  })) });
  useProviderCredentialHealth.setState({ entries: {}, revisions: {}, configurations: {}, workspaceScopes: {} });
});
afterEach(() => { mock.restore(); });

function health() { return useProviderCredentialHealth.getState().entries[key]?.status ?? "unverified"; }

test("a saved key is unverified, rejected after an authentication failure, verified only after success", () => {
  const state = useProviderCredentialHealth.getState();
  state.changed(workspace, provider);
  expect(health()).toBe("unverified");
  now++;
  state.observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  now++;
  state.observe(workspace, provider, "verified", now);
  expect(health()).toBe("verified");
  now++;
  state.observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  now++;
  state.changed(workspace, provider);
  expect(health()).toBe("unverified");
});

test("an old in-flight request cannot reject or verify a replacement key", () => {
  const state = useProviderCredentialHealth.getState();
  const startedAt = now;
  now++;
  state.changed(workspace, provider);
  state.observe(workspace, provider, "rejected", startedAt);
  state.observe(workspace, provider, "verified", startedAt);
  expect(health()).toBe("unverified");
  state.observe(workspace, provider, "verified", now);
  expect(health()).toBe("unverified");
});

test("a failure is specific to the runtime provider and workspace", () => {
  useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  expect(useProviderCredentialHealth.getState().entries[credentialHealthKey(workspace, "anthropic")]).toBeUndefined();
  expect(useProviderCredentialHealth.getState().entries[credentialHealthKey("other-workspace", provider)]).toBeUndefined();
});

test("a changed organization configuration clears evidence, but refresh does not", () => {
  const state = useProviderCredentialHealth.getState();
  state.configure(workspace, provider, "version-1");
  state.observe(workspace, provider, "rejected", now);
  state.configure(workspace, provider, "version-1");
  expect(health()).toBe("rejected");
  now++;
  state.configure(workspace, provider, "version-2");
  expect(health()).toBe("unverified");
});

test("rejection survives a reload without storing any raw error or credential", async () => {
  useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now);
  const snapshot = stored;
  useProviderCredentialHealth.setState({ entries: {}, revisions: {}, configurations: {}, workspaceScopes: {} });
  stored = snapshot;
  await useProviderCredentialHealth.persist.rehydrate();
  expect(health()).toBe("rejected");
  expect(JSON.parse(snapshot).state).toEqual({ entries: { [key]: { status: "rejected", revision: 0, observedAt: now } }, revisions: {}, configurations: {}, workspaceScopes: {} });
});

for (const error of [
  { name: "APIError", data: { statusCode: 401, message: "User not found.", responseBody: '{"error":{"message":"User not found.","code":401}}' } },
  { name: "UnknownError", data: { message: "Provider request failed with HTTP 401: User not found." } },
  { name: "APIError", data: { message: "Invalid API key" } },
  { name: "APIError", data: { statusCode: 403, responseBody: '{"error":{"code":"invalid_api_key"}}' } },
  { name: "APIError", data: { responseBody: '{"error":{"code":"invalid_api_key"}}' } },
]) test(`recognized inference rejection: ${JSON.stringify(error)}`, () => {
  expect(isProviderCredentialRejection(error)).toBe(true);
});

for (const error of [
  { name: "APIError", data: { statusCode: 403, message: "Access denied" } },
  { name: "APIError", data: { statusCode: 429, message: "Invalid API key" } },
  { name: "APIError", data: { statusCode: 500, message: "Invalid API key" } },
  { name: "APIError", data: { statusCode: 401, responseBody: '{"error":{"code":"openwork_auth_required"}}' } },
  { name: "APIError", data: { statusCode: 401, message: "Invalid OpenWork Gateway key.", responseBody: '{"error":{"code":"invalid_api_key"}}' } },
  { name: "APIError", data: { statusCode: 401, message: "An OpenWork Models key is required." } },
  { name: "APIError", data: { message: "ECONNRESET" } },
  { name: "TimeoutError", data: { message: "Request timed out" } },
  { name: "MessageAbortedError" },
  { name: "ProviderAuthError", data: { message: "Missing API key" } },
  { name: "APIError", data: { message: "An unrelated error mentioning an invalid API key in prose" } },
]) test(`not upstream credential rejection: ${JSON.stringify(error)}`, () => {
  expect(isProviderCredentialRejection(error)).toBe(false);
});

for (const providerId of ["openrouter", "ipr_fixture"]) test(`native lifecycle updates only the provider that actually ran: ${providerId}`, () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/fixture/opencode2", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "session-fixture";
  const evidenceKey = credentialHealthKey(workspace, providerId);
  try {
    __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, timestamp: now, model: { providerID: providerId, id: "http-401" } } });
    __applySessionSyncEventForTest(sync, { type: "session.execution.failed", properties: { sessionID, error: { name: "APIError", data: { statusCode: 401, message: "User not found." } } } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("rejected");
    // A following idle is not proof of success.
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("rejected");
    now++;
    __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, timestamp: now, model: { providerID: providerId, id: "ok" } } });
    __applySessionSyncEventForTest(sync, { type: "session.execution.succeeded", properties: { sessionID } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("verified");
    expect(useProviderCredentialHealth.getState().entries[credentialHealthKey(workspace, "unrelated")]).toBeUndefined();
  } finally { dispose(); }
});

test("v1 idle without a completed assistant response is not credential verification", () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/fixture/opencode", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "session-v1-fixture";
  try {
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "busy" } } });
    __applySessionSyncEventForTest(sync, { type: "message.updated", properties: { info: { id: "message-fixture", sessionID, role: "assistant", providerID: provider } } });
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    expect(health()).toBe("unverified");
    now++;
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "busy" } } });
    __applySessionSyncEventForTest(sync, { type: "message.updated", properties: { info: { id: "message-success", sessionID, role: "assistant", providerID: provider, time: { created: now, completed: 200 } } } });
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    expect(health()).toBe("verified");
  } finally { dispose(); }
});

test("replacing a shared device credential invalidates every workspace using it, not a remote host", () => {
  const state = useProviderCredentialHealth.getState();
  state.bindWorkspace(workspace, "device");
  state.bindWorkspace("second-local", "device");
  state.bindWorkspace("remote", "https://worker.example");
  for (const id of [workspace, "second-local", "remote"]) state.observe(id, provider, "verified", now);
  now++;
  state.changed(workspace, provider);
  expect(health()).toBe("unverified");
  expect(state.entries[key]).toBeUndefined();
  const latest = useProviderCredentialHealth.getState();
  expect(latest.entries[credentialHealthKey("second-local", provider)]).toBeUndefined();
  expect(latest.entries[credentialHealthKey("remote", provider)]?.status).toBe("verified");
  state.observe("second-local", provider, "rejected", now - 1);
  expect(useProviderCredentialHealth.getState().entries[credentialHealthKey("second-local", provider)]).toBeUndefined();
});

test("a delayed native start using the old key cannot reject its replacement", () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/fixture/opencode2", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "session-delayed";
  const oldStart = now;
  now++;
  useProviderCredentialHealth.getState().changed(workspace, provider);
  try {
    __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, timestamp: oldStart, model: { providerID: provider, id: "http-401" } } });
    __applySessionSyncEventForTest(sync, { type: "session.execution.failed", properties: { sessionID, error: { name: "APIError", data: { statusCode: 401, message: "User not found." } } } });
    expect(health()).toBe("unverified");
  } finally { dispose(); }
});

test("the native adapter retains a confirmed 401 even when the engine omits the response body", async () => {
  const { mapV2SessionError } = await import("../src/app/lib/opencode-v2-adapter");
  for (const raw of [
    { status: 401, message: "User not found." },
    { statusCode: 401, data: { message: "User not found." } },
    { response: { status: 401 }, data: { message: "User not found." } },
  ]) {
    const mapped = mapV2SessionError(raw);
    expect(mapped.name).toBe("APIError");
    expect(isProviderCredentialRejection(mapped)).toBe(true);
  }
});

test("durable assistant outcomes recover missed lifecycle events without reviving stale verdicts", () => {
  const failure = { info: { role: "assistant", providerID: provider, time: { created: 101, completed: 102 }, error: { name: "APIError", data: { statusCode: 401, message: "User not found." } } } };
  observeProviderCredentialMessages(workspace, [failure]);
  expect(health()).toBe("rejected");
  const oldSuccess = { info: { role: "assistant", providerID: provider, time: { created: 90, completed: 99 }, finish: "stop" } };
  observeProviderCredentialMessages(workspace, [oldSuccess]);
  expect(health()).toBe("rejected");
  const success = { info: { role: "assistant", providerID: provider, time: { created: 103, completed: 104 }, finish: "stop" } };
  observeProviderCredentialMessages(workspace, [success]);
  expect(health()).toBe("verified");
  now = 105;
  useProviderCredentialHealth.getState().changed(workspace, provider);
  observeProviderCredentialMessages(workspace, [failure, success]);
  expect(health()).toBe("unverified");
});

test("unavailable browser persistence cannot interrupt a chat outcome", () => {
  if (!defaultStorage) throw new Error("Missing default health persistence");
  useProviderCredentialHealth.persist.setOptions({ storage: defaultStorage });
  spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage quota exceeded"); });
  expect(() => useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now)).not.toThrow();
  expect(health()).toBe("rejected");
});
