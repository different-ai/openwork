import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createJSONStorage } from "zustand/middleware";
import { isProviderCredentialRejection, presentOpencodeSessionError, sessionErrorAnalyticsProperties } from "../src/react-app/domains/session/sync/session-error";
import { captureAnalyticsEvent, initAnalytics, markTaskRunStart, takeTaskRunStart } from "../src/app/lib/analytics";
import { taskRunQuality } from "../src/app/lib/analytics";
import { dispatchDenSessionUpdated } from "../src/app/lib/den-session-events";

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

test("analytics init is idempotent and sign-in state reaches captures", () => {
  initAnalytics();
  captureAnalyticsEvent("test_launch");
  const first = globalThis.__openwork?.events().findLast((event) => event.name === "analytics.test_launch")?.data;
  initAnalytics();
  captureAnalyticsEvent("test_launch_again");
  const second = globalThis.__openwork?.events().findLast((event) => event.name === "analytics.test_launch_again")?.data;
  expect(second).toEqual(first);
  expect(first).toMatchObject({ run_number: 1, install_age_days: 0, signed_in: false, official_build: false });
  expect(first && typeof first === "object" && "$session_id" in first && typeof first.$session_id === "string").toBe(true);
  dispatchDenSessionUpdated({ status: "success" });
  expect(globalThis.__openwork?.events().findLast((event) => event.name === "analytics.cloud_signed_in")?.data).toMatchObject({ signed_in: true });
  dispatchDenSessionUpdated({ status: "signed_out" });
  captureAnalyticsEvent("test_signed_out");
  expect(globalThis.__openwork?.events().findLast((event) => event.name === "analytics.test_signed_out")?.data).toMatchObject({ signed_in: false });
});

test("an analytics property failure cannot interrupt the product action", () => {
  expect(() => captureAnalyticsEvent("test_unavailable", {
    get count(): number { throw new Error("unavailable telemetry context"); },
  })).not.toThrow();
});

test("a run rejected before the engine starts retains the submitted model identity", () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/early-rejection/opencode2", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "early-rejection";
  try {
    markTaskRunStart(sessionID);
    taskRunQuality.start(sessionID, { providerID: provider, modelID: "submitted-model" });
    __applySessionSyncEventForTest(sync, { type: "session.execution.failed", properties: {
      sessionID, error: { name: "APIError", data: { statusCode: 429, message: "private error" } },
    } });
    const captured = globalThis.__openwork?.events().findLast(event => event.name === "analytics.task_run_errored")?.data;
    expect(captured).toMatchObject({ provider_id: provider, model_id: "submitted-model", error_kind: "rate-limited" });
    expect(JSON.stringify(captured)).not.toContain("private error");
  } finally { dispose(); taskRunQuality.finish(sessionID); takeTaskRunStart(sessionID); }
});

for (const [error, expected] of [
  [{ name: "APIError", data: { statusCode: 429, message: "secret /private/path prompt" } }, "rate-limited"],
  [{ name: "TimeoutError", message: "secret /private/path prompt" }, "provider-timeout"],
  [{ name: "UnknownError", message: "secret /private/path prompt" }, "generic"],
  [{ name: "APIError", data: { statusCode: 401, message: "secret /private/path prompt" } }, "provider-credentials"],
] satisfies Array<[unknown, string]>) test(`send failure classification captures only fixed error kind: ${expected}`, () => {
  captureAnalyticsEvent("task_send_failed", sessionErrorAnalyticsProperties(presentOpencodeSessionError(error).kind, { providerId: "provider-fixture", modelId: "model-fixture" }));
  const captured = globalThis.__openwork?.events().findLast((event) => event.name === "analytics.task_send_failed")?.data;
  expect(captured).toMatchObject({ error_kind: expected, provider_id: "provider-fixture", model_id: "model-fixture" });
  expect(JSON.stringify(captured)).not.toContain("secret");
  expect(JSON.stringify(captured)).not.toContain("/private/path");
});

for (const native of [false, true]) test(`run error analytics classify the actual ${native ? "v2" : "v1"} lifecycle without copying error text`, () => {
  const sync = { workspaceId: workspace, baseUrl: `http://127.0.0.1:9/w/analytics/opencode${native ? "2" : ""}`, openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = `analytics-session-${native}`;
  try {
    markTaskRunStart(sessionID);
    if (native) {
      __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, timestamp: now, model: { providerID: provider, id: "model-fixture" } } });
    } else {
      __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "busy" } } });
      __applySessionSyncEventForTest(sync, { type: "message.updated", properties: { info: { id: "message-analytics", sessionID, role: "assistant", providerID: provider, modelID: "model-fixture" } } });
    }
    now += 25;
    __applySessionSyncEventForTest(sync, { type: native ? "session.execution.failed" : "session.error", properties: { sessionID, error: { name: "APIError", data: { statusCode: 429, message: "secret /private/path prompt", providerID: "untrusted-error-field" } } } });
    const captured = globalThis.__openwork?.events().findLast((event) => event.name === "analytics.task_run_errored")?.data;
    expect(captured).toMatchObject({ duration_ms: 25, error_kind: "rate-limited", provider_id: provider, model_id: "model-fixture" });
    expect(JSON.stringify(captured)).not.toContain("secret");
    expect(JSON.stringify(captured)).not.toContain("/private/path");
    expect(JSON.stringify(captured)).not.toContain("untrusted-error-field");
  } finally { dispose(); }
});

for (const native of [false, true]) test(`run quality reaches the inspector from ${native ? "v2" : "v1"} output, tool, permission, and terminal events`, () => {
  const sync = { workspaceId: workspace, baseUrl: `http://127.0.0.1:9/w/quality/opencode${native ? "2" : ""}`, openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = `quality-session-${native}`;
  const first = taskRunQuality.isFirstRun();
  try {
    markTaskRunStart(sessionID);
    taskRunQuality.start(sessionID);
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "busy" } } });
    __applySessionSyncEventForTest(sync, { type: "message.part.delta", properties: { sessionID, messageID: "unknown-role", partID: "unknown-text", delta: "private unclassified content" } });
    __applySessionSyncEventForTest(sync, { type: "message.updated", properties: { info: { id: "user", sessionID, role: "user" } } });
    now += 5;
    __applySessionSyncEventForTest(sync, { type: "message.part.delta", properties: { sessionID, messageID: "user", partID: "user-text", delta: "private user content" } });
    __applySessionSyncEventForTest(sync, { type: "message.updated", properties: { info: { id: "assistant", sessionID, role: "assistant" } } });
    now += 15;
    __applySessionSyncEventForTest(sync, { type: "message.part.delta", properties: { sessionID, messageID: "assistant", partID: "text", delta: "private assistant content" } });
    for (let index = 0; index < 2; index++) {
      __applySessionSyncEventForTest(sync, { type: "message.part.updated", properties: { part: { id: "tool-part", sessionID, messageID: "assistant", type: "tool", callID: "tool-call", tool: "read", state: { status: "pending", input: {}, raw: "" } } } });
      __applySessionSyncEventForTest(sync, { type: native ? "permission.v2.asked" : "permission.asked", properties: { sessionID, id: "permission", permission: "read", patterns: ["private path"], metadata: {}, always: [] } });
    }
    now += 80;
    const eventName = native ? "task_run_completed" : "task_run_errored";
    const terminal = native
      ? { type: "session.execution.succeeded", properties: { sessionID } }
      : { type: "session.error", properties: { sessionID, error: { name: "APIError", data: { message: "private error", statusCode: 500 } } } };
    __applySessionSyncEventForTest(sync, terminal);
    const captured = globalThis.__openwork?.events().findLast((event) => event.name === `analytics.${eventName}`)?.data;
    expect(captured).toMatchObject({ duration_ms: 100, time_to_first_output_ms: 20, tool_call_count: 1, permission_prompt_count: 1, is_first_run_on_install: first });
    expect(JSON.stringify(captured)).not.toContain("private");
    const count = globalThis.__openwork?.events().filter((event) => event.name === `analytics.${eventName}`).length;
    __applySessionSyncEventForTest(sync, terminal);
    expect(globalThis.__openwork?.events().filter((event) => event.name === `analytics.${eventName}`).length).toBe(count);
  } finally { dispose(); taskRunQuality.finish(sessionID); takeTaskRunStart(sessionID); }
});

test("a stop in flight and a nonterminal v2 idle do not consume a successful completion", () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/quality/opencode2", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "quality-stop";
  try {
    markTaskRunStart(sessionID);
    taskRunQuality.start(sessionID);
    const before = globalThis.__openwork?.events().filter((event) => event.name === "analytics.task_run_completed").length;
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    taskRunQuality.stopping(sessionID, true);
    __applySessionSyncEventForTest(sync, { type: "session.execution.succeeded", properties: { sessionID } });
    expect(globalThis.__openwork?.events().filter((event) => event.name === "analytics.task_run_completed").length).toBe(before);
    expect(takeTaskRunStart(sessionID)).toBe(now);
    expect(taskRunQuality.finish(sessionID).time_to_first_output_ms).toBeNull();
  } finally { dispose(); taskRunQuality.finish(sessionID); takeTaskRunStart(sessionID); }
});

test("unavailable browser persistence cannot interrupt a chat outcome", () => {
  if (!defaultStorage) throw new Error("Missing default health persistence");
  useProviderCredentialHealth.persist.setOptions({ storage: defaultStorage });
  spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage quota exceeded"); });
  expect(() => useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now)).not.toThrow();
  expect(health()).toBe("rejected");
});
