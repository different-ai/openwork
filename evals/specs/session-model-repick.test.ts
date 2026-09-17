import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { openworkModelSessionSchema, openworkSessionModelSchema, suggestOpenworkReplacement } from "@openwork/types/openwork-affordance";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { createSessionModelActions } from "../../apps/app/src/react-app/domains/session/control/session-model-actions";
import { preflightQueuedSessionModel } from "../../apps/app/src/react-app/domains/session/sync/queued-send-context";
import { createClient } from "../../apps/app/src/app/lib/opencode";
import { sendSessionCommand } from "../../apps/app/src/app/lib/opencode-interruption";
import { effectiveSessionModelSelection, sessionCommandModelFields, useSessionModelStore } from "../../apps/app/src/react-app/domains/session/surface/session-model-store";

const old = { providerId: "provider_fixture", modelId: "removed_fixture", variant: "high", displayName: "Fixture Previous", providerName: "Fixture Family" };
const replacement = { providerId: "provider_fixture", modelId: "available_fixture", displayName: "Fixture Next", providerName: "Fixture Family" };
const alternate = { providerId: "alternate_fixture", modelId: "alternate_model", displayName: "Fixture Alternate", providerName: "Alternate Family" };
const workspaces = [{ id: "workspace_fixture_one", path: "/synthetic/one", name: "One" }, { id: "workspace_fixture_two", path: "/synthetic/two", name: "Two" }];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  useSessionModelStore.setState({ bySessionId: {} });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object");
  return Object.fromEntries(Object.entries(value));
}
function session(id: string, modelId: string | null = old.modelId, archived = 0, directory = "/synthetic/one") {
  return { id, title: id, directory, time: { archived }, ...(modelId ? { model: { providerID: old.providerId, id: modelId, variant: "high" } } : {}) };
}
async function fixture(now?: () => number) {
  const storage = new Map<string, string>();
  const storageWrites: string[] = [];
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storageWrites.push(key); storage.set(key, value); },
  } });
  useSessionModelStore.setState({ bySessionId: {} });
  const sessions = [session("session_this"), session("session_other"), session("session_archived", old.modelId, 1), session("session_restored", old.modelId, 0), session("session_other_model", replacement.modelId), session("session_other_workspace", old.modelId, 0, "/synthetic/two"), session("session_fresh", null)];
  const directories = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
  const catalog = [replacement, alternate];
  let hostFailure: "none" | "missing" | "wrong_workspace" | "wrong_session" = "none";
  let catalogFailure = false;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const offline = new Set<string>();
  const held = new Set<string>();
  const working = new Set<string>();
  const engineStatuses: Record<string, unknown> = {};
  let statusResult: { data?: unknown; error?: unknown; response?: { status: number } } = { data: engineStatuses, response: { status: 200 } };
  const statusReads: string[] = [];
  const reads: Array<{ workspaceId: string; sessionId?: string }> = [];
  let beforeCatalog = async () => {};
  let beforeRead = async (_kind: string) => {};
  const actions = createSessionModelActions({ workspaces, now,
    directory: async (workspace) => {
      await beforeRead("directory");
      const owner = directories.get(workspace.id);
      if (!owner) throw new Error("Fixture owner unavailable");
      return owner;
    },
    catalog: async () => { await beforeRead("catalog"); await beforeCatalog(); if (catalogFailure) throw new Error("Fixture catalog unavailable"); return catalog; },
    sessions: async (workspace) => { reads.push({ workspaceId: workspace.id }); await beforeRead("sessions"); if (offline.has(workspace.id)) throw new Error("Offline inventory"); return sessions; },
    session: async (workspace, sessionId) => { reads.push({ workspaceId: workspace.id, sessionId }); await beforeRead("session"); return sessions.find((session) => session.id === sessionId); },
    statuses: async (workspace) => { statusReads.push(workspace.id); await beforeRead("statuses"); return statusResult; },
    held: (_workspace, id) => held.has(id),
    working: (_workspace, id) => working.has(id),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    request.setEncoding("utf8");
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body: unknown = text ? JSON.parse(text) : null;
    const method = request.method ?? "GET";
    requests.push({ path: url.pathname, method, body });
    if (url.pathname === "/workspaces") return json(200, { items: workspaces });
    if (url.pathname === "/experimental/ui-control/request") {
      const input = record(record(body).input);
      if (hostFailure === "missing") return json(200, { ok: false, id: input.id, code: "unavailable", error: "Fixture host unavailable" });
      try {
        const result = input.id === "session.model_preflight" ? await actions.preflight(input.args)
          : input.id === "session.set_model" ? await actions.setModel(input.args)
          : input.id === "session.rebind_model" ? await actions.rebindModel(input.args) : null;
        return json(200, { ok: true, id: input.id, effects: { data: "read", ui: "none", external: false }, result: {
          ...result,
          ...(hostFailure === "wrong_workspace" ? { workspaceId: "unrelated_workspace" } : {}),
          ...(hostFailure === "wrong_session" ? { sessionId: "unrelated_session" } : {}),
        } });
      } catch {
        return json(200, { ok: false, id: input.id, code: "failed", error: "Fixture selection unavailable" });
      }
    }
    const matched = /^\/workspace\/([^/]+)\/opencode\/session\/([^/]+)(\/(?:prompt_async|command))?$/.exec(url.pathname);
    const workspace = workspaces.find((entry) => entry.id === matched?.[1]);
    const selected = sessions.find((entry) => entry.id === matched?.[2] && entry.directory === workspace?.path);
    if (selected && method === "GET") return json(200, selected);
    if (selected && method === "POST" && matched?.[3]) return json(200, { ok: true });
    return json(404, { message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  vi.stubEnv("OPENWORK_SERVER_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OPENWORK_SERVER_TOKEN", "fixture-token");
  const plugin = await OpenWorkExtensionsPreview({ directory: "/synthetic/one" });
  const engineClient = createClient(`http://127.0.0.1:${address.port}/workspace/workspace_fixture_one/opencode`, "/synthetic/one", { mode: "openwork", token: "fixture-token" });
  return { actions, storage, storageWrites, sessions, requests, catalog, offline, held, working, reads, directories, engineStatuses, statusReads,
    setStatusResult: (value: typeof statusResult) => { statusResult = value; },
    setBeforeRead: (hook: (kind: string) => Promise<void>) => { beforeRead = hook; },
    setBeforeCatalog: (hook: () => Promise<void>) => { beforeCatalog = hook; },
    command: (model: Parameters<typeof sessionCommandModelFields>[0], variant: string | null) => sendSessionCommand(`http://127.0.0.1:${address.port}/workspace/workspace_fixture_one/opencode`, engineClient, {
      sessionID: "session_this", messageID: "msg_fixture_command", command: "fixture", arguments: "synthetic", ...sessionCommandModelFields(model, variant),
    }),
    setHostFailure: (value: typeof hostFailure) => { hostFailure = value; },
    setCatalogFailure: (value: boolean) => { catalogFailure = value; },
    writes: () => requests.filter((entry) => entry.method === "POST" && entry.path !== "/experimental/ui-control/request"),
    execute: async (id: string, args: Record<string, unknown>) => record(JSON.parse(await plugin.tool.openwork_execute.execute({ id, args }, {}))),
  };
}

test("repick previews effective bindings, saves only confirmed scope, and preserves engine/default identities", async ({ evidence }) => {
  const f = await fixture();
  const before = JSON.stringify(f.sessions);
  const initial = await f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement, dryRun: true });
  expect(initial.sessions.map((entry) => entry.sessionId)).toEqual(["session_this", "session_other", "session_restored"]);
  expect(f.storageWrites).toEqual([]);
  const single = await f.execute("session.set_model", { sessionId: "session_this", alias: replacement.displayName });
  expect(single).toMatchObject({ ok: true, result: { count: 1, savedLocally: true, appliesOn: "next_send", engineBindingUpdated: false } });
  expect(Object.keys(useSessionModelStore.getState().bySessionId)).toEqual(["session_this"]);
  expect(f.writes()).toEqual([]);
  useSessionModelStore.getState().setModel("session_other_model", { providerID: old.providerId, modelID: old.modelId }, "low");
  const preview = await f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement, dryRun: true });
  expect(preview.sessions.map((entry) => entry.sessionId)).toEqual(["session_other", "session_restored", "session_other_model"]);
  const thisSelection = useSessionModelStore.getState().bySessionId.session_this;
  const bulk = await f.execute("session.rebind_model", { workspaceId: workspaces[0]?.id, from: old, to: { ...alternate, variant: "low" }, expectedSessionIds: preview.sessions.map((entry) => entry.sessionId) });
  expect(bulk).toMatchObject({ ok: true, result: { count: 3, savedLocally: true, engineBindingUpdated: false } });
  expect(useSessionModelStore.getState().bySessionId.session_this).toBe(thisSelection);
  for (const id of ["session_other", "session_restored", "session_other_model"]) expect(useSessionModelStore.getState().bySessionId[id]).toEqual({ model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "low" });
  expect(useSessionModelStore.getState().bySessionId.session_archived).toBeUndefined();
  expect(useSessionModelStore.getState().bySessionId.session_other_workspace).toBeUndefined();
  expect(f.storageWrites.every((key) => key === "openwork.sessionModels.v1")).toBe(true);
  expect(JSON.parse(f.storage.get("openwork.sessionModels.v1") ?? "{}")).toEqual(useSessionModelStore.getState().bySessionId);
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("This-session and opt-in all-session scope use effective local-first bindings", "Dry-run wrote nothing; one and three choices persisted atomically with variants. Archives, other workspace, unrelated override, engine records and defaults were unchanged.", true);
});

test("headless stale sends write zero prompts; an explicit repick applies canonical ids and variant on next send", async ({ evidence }) => {
  const f = await fixture();
  const send = () => f.execute("session.send", { workspaceId: workspaces[0]?.id, sessionId: "session_this", text: "Synthetic prompt" });
  expect(await send()).toMatchObject({ ok: false, code: "model_unavailable", issues: [{ path: "model", code: "model_unavailable" }] });
  expect(f.writes()).toEqual([]);
  await f.execute("session.set_model", { sessionId: "session_this", model: { ...replacement, variant: "low" } });
  expect(f.writes()).toEqual([]);
  expect(await send()).toMatchObject({ ok: true, result: { accepted: true, sessionId: "session_this" } });
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]?.body).toMatchObject({ model: { providerID: replacement.providerId, modelID: replacement.modelId }, variant: "low", parts: [{ type: "text", text: "Synthetic prompt" }] });
  expect(openworkModelSessionSchema.parse(f.sessions[0]).model?.id).toBe(old.modelId);
  await f.actions.setModel({ sessionId: "session_this", model: { ...replacement, variant: null } });
  expect(await send()).toMatchObject({ ok: true, result: { accepted: true } });
  expect(f.writes()[1]?.body).toMatchObject({ variant: "default" });
  for (const failure of ["missing", "wrong_workspace", "wrong_session"]) {
    if (failure === "missing" || failure === "wrong_workspace" || failure === "wrong_session") f.setHostFailure(failure);
    expect(await send()).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(f.writes()).toHaveLength(2);
  }
  f.setHostFailure("none");
  f.setCatalogFailure(true);
  expect(await send()).toMatchObject({ ok: false, code: "model_unavailable" });
  expect(f.writes()).toHaveLength(2);
  f.setCatalogFailure(false);
  f.catalog.splice(0, 1);
  expect(await send()).toMatchObject({ ok: false, code: "model_unavailable" });
  expect(f.writes()).toHaveLength(2);
  expect(f.requests.some((entry) => entry.path.includes("workspace_fixture_two/opencode"))).toBe(false);
  evidence.recordAssertionEvidence("Stale headless send is rejected before prompt writes", "The real facade rejected missing model, host, catalog and mismatched identities with model_unavailable; only the two explicit sends after local repick wrote canonical model/effort payloads and returned accepted:true.", true);
});

test("invalid targets, changed previews and unavailable replacements cannot partially save", async ({ evidence }) => {
  const f = await fixture();
  await expect(f.actions.setModel({ sessionId: "session_archived", model: replacement })).rejects.toThrow("Archived");
  await expect(f.actions.setModel({ sessionId: "session_this", model: old })).rejects.toThrow("Unavailable");
  await expect(f.actions.rebindModel({ workspaceId: "missing", from: old, to: replacement, expectedSessionIds: [] })).rejects.toThrow("Workspace");
  await expect(f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement, expectedSessionIds: ["session_this"] })).rejects.toThrow("changed");
  expect(f.storageWrites).toEqual([]);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Invalid repicks cannot partially save", "Archived targets, unavailable replacements, missing workspaces and changed preview sets all rejected; neither local storage nor engine writes occurred.", f.storageWrites.length === 0 && f.writes().length === 0);
});

test("bulk mutations fail closed without confirmation while dry-runs remain read-only", async ({ evidence }) => {
  const f = await fixture();
  const args = { workspaceId: "workspace_fixture_one", from: old, to: replacement };
  const before = JSON.stringify(f.sessions);
  const preview = await f.actions.rebindModel({ ...args, dryRun: true });
  expect(preview.sessions.map((entry) => entry.sessionId)).toEqual(["session_this", "session_other", "session_restored"]);
  for (const dryRun of [undefined, false]) {
    await expect(f.actions.rebindModel({ ...args, dryRun })).rejects.toThrow("expectedSessionIds is required");
    expect(await f.execute("session.rebind_model", { ...args, dryRun })).toMatchObject({ ok: false });
  }
  for (const expectedSessionIds of [[], ["session_this", "session_other", "session_other"], ["session_this", "session_other", "session_restored", "session_archived"]]) {
    await expect(f.actions.rebindModel({ ...args, expectedSessionIds })).rejects.toThrow("Matching sessions changed");
  }
  expect(f.storageWrites).toEqual([]);
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  expect(await f.execute("session.rebind_model", { ...args, expectedSessionIds: preview.sessions.map((entry) => entry.sessionId).reverse() })).toMatchObject({ ok: true, result: { count: 3, savedLocally: true } });
  evidence.recordAssertionEvidence("Bulk writes require the exact confirmed preview set", "Missing confirmation rejected in both the action and facade; empty, duplicate and extra ids rejected without persistence. Dry-run required no confirmation, and the confirmed set saved regardless of order.", true);
});

test("bulk repick rejects a source restored to the current catalog after preview", async ({ evidence }) => {
  const f = await fixture();
  const args = { workspaceId: "workspace_fixture_one", from: old, to: replacement };
  const preview = await f.actions.rebindModel({ ...args, dryRun: true });
  f.catalog.push({ ...old, displayName: "Renamed restored model" });
  for (const dryRun of [true, false]) {
    const request = { ...args, dryRun, expectedSessionIds: preview.sessions.map((entry) => entry.sessionId) };
    await expect(f.actions.rebindModel(request)).rejects.toThrow("Source model is still available");
    expect(await f.execute("session.rebind_model", request)).toMatchObject({ ok: false });
  }
  expect(f.storageWrites).toEqual([]);
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Bulk repick is limited to an unavailable exact source model", "Restoring the source's provider/model ids under a different label after preview blocked both fresh preview and confirmed mutation; no local or engine writes occurred.", true);
});

test("bulk matching uses exact provider and model ids, not labels", async ({ evidence }) => {
  const f = await fixture();
  f.catalog.push({ ...old, providerId: "different_provider" });
  f.sessions.push({ ...session("session_same_model_other_provider"), model: { providerID: "different_provider", id: old.modelId, variant: "high" } });
  const before = JSON.stringify(f.sessions);
  const args = { workspaceId: "workspace_fixture_one", from: old, to: replacement };
  const preview = await f.actions.rebindModel({ ...args, dryRun: true });
  expect(preview.sessions.map((entry) => entry.sessionId)).toEqual(["session_this", "session_other", "session_restored"]);
  expect(await f.actions.rebindModel({ ...args, expectedSessionIds: preview.sessions.map((entry) => entry.sessionId) })).toMatchObject({ count: 3, savedLocally: true });
  expect(Object.keys(useSessionModelStore.getState().bySessionId).sort()).toEqual(["session_other", "session_restored", "session_this"]);
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Other providers' matching model ids do not widen or block the confirmed scope", "An available model with the same id and label but another provider did not block replacement of the removed source; its session and all engine records stayed untouched.", true);
});

test("healthy fresh sessions preserve model-free sending, never substituting defaults for stale bindings", async ({ evidence }) => {
  const f = await fixture();
  expect(await f.execute("session.send", { workspaceId: "workspace_fixture_one", sessionId: "session_fresh", text: "Fresh prompt" })).toMatchObject({ ok: true, result: { accepted: true } });
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]?.body).not.toHaveProperty("model");
  expect(f.writes()[0]?.body).not.toHaveProperty("variant");
  expect(await f.execute("session.send", { workspaceId: "workspace_fixture_one", sessionId: "session_this", text: "Must not send" })).toMatchObject({ ok: false, code: "model_unavailable" });
  expect(f.writes()).toHaveLength(1);
  evidence.recordAssertionEvidence("Fresh sessions retain model-free sending without rescuing stale bindings", "The fresh session received one accepted prompt with no model or variant fields; the stale bound session returned model_unavailable and added no prompt write.", f.writes().length === 1);
});

test("exact workspace repick bypasses unrelated offline inventories and rejects foreign targets", async ({ evidence }) => {
  const f = await fixture();
  f.offline.add("workspace_fixture_two");
  expect(await f.execute("session.set_model", { workspaceId: "workspace_fixture_one", sessionId: "session_this", alias: replacement.displayName })).toMatchObject({ ok: true, result: { savedLocally: true } });
  expect(f.reads).toEqual([{ workspaceId: "workspace_fixture_one", sessionId: "session_this" }]);
  const before = f.storageWrites.length;
  await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_other_workspace", model: replacement })).rejects.toThrow("belong");
  expect(f.storageWrites).toHaveLength(before);
  evidence.recordAssertionEvidence("Exact workspace repick isolates unavailable and foreign workspaces", "The scoped repick saved locally while the other inventory was offline and read only its target session; attempting a foreign target rejected without another storage write.", f.storageWrites.length === before);
});

test("catalog waits cannot race an archive, hold or newer local selection into a repick", async ({ evidence }) => {
  const f = await fixture();
  const target = f.sessions.find((session) => session.id === "session_this");
  if (!target) throw new Error("Fixture target missing");
  for (const race of ["archive", "hold", "repick"]) {
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.setBeforeCatalog(async () => { entered(); await wait; });
    const pending = f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
    await started;
    if (race === "archive") target.time.archived = 1;
    if (race === "hold") f.held.add(target.id);
    if (race === "repick") useSessionModelStore.getState().setModel(target.id, { providerID: alternate.providerId, modelID: alternate.modelId }, "high");
    const before = f.storageWrites.length;
    release();
    await expect(pending).rejects.toThrow(race === "repick" ? "selection changed" : "Archived or held");
    expect(f.storageWrites).toHaveLength(before);
    target.time.archived = 0;
    f.held.clear();
  }
  expect(useSessionModelStore.getState().bySessionId.session_this).toEqual({ model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" });
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Repick waits cannot overwrite archive state or a newer local choice", "Each suspended catalog lookup was raced with an archive, hold or newer repick; all rejected without an additional save, the newer high-effort choice survived, and no engine writes occurred.", f.writes().length === 0);
});

test("exhausted queued repicks reject before reads even when args claim a fresh timestamp", async ({ evidence }) => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const reads: string[] = [];
  f.setBeforeRead(async (kind) => { reads.push(kind); });
  const before = JSON.stringify(f.sessions);
  for (const age of [4_000, 5_001, 20_000]) {
    for (const bulk of [false, true]) {
      const helpers = { requestCreatedAt: Date.now() - age };
      const spoofed = { createdAt: Date.now(), requestCreatedAt: Date.now() };
      const pending = bulk
        ? f.actions.rebindModel({ ...spoofed, workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] }, helpers)
        : f.actions.setModel({ ...spoofed, workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement }, helpers);
      await expect(pending).rejects.toThrow("timed out");
    }
  }
  expect(reads).toEqual([]);
  expect(f.storageWrites).toEqual([]);
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Queued request age is charged before model handlers read or mutate", "At exactly 4s, after mailbox expiry and after a long queue, single and bulk repicks rejected before all reads. Fresh timestamps in user args could not reset the deadline; local and engine state remained unchanged.", true);
});

test("invalid and future internal timestamps fail closed for single and bulk repicks", async ({ evidence }) => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const reads: string[] = [];
  f.setBeforeRead(async (kind) => { reads.push(kind); });
  for (const requestCreatedAt of [NaN, Infinity, -Infinity, -1, 0, Date.now() - 0.5, Date.now() + 1, Date.now() + 60_000]) {
    await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement }, { requestCreatedAt })).rejects.toThrow("timed out");
    await expect(f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] }, { requestCreatedAt })).rejects.toThrow("timed out");
  }
  expect(reads).toEqual([]);
  expect(f.storageWrites).toEqual([]);
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Invalid timestamps never grant a fresh model mutation budget", "Non-finite, non-positive, fractional and future timestamps rejected before reads in both handlers with zero local or engine writes.", true);
});

test("near-expiry queued repicks time out on the remaining budget and late reads cannot save", async ({ evidence }) => {
  const f = await fixture();
  vi.useFakeTimers();
  const before = JSON.stringify(f.sessions);
  for (const bulk of [false, true]) {
    for (const delayed of ["catalog", "directory", bulk ? "sessions" : "session", "statuses"]) {
      let release = () => {};
      let entered = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      f.setBeforeRead(async (kind) => { if (kind === delayed) { entered(); await wait; } });
      const helpers = { requestCreatedAt: Date.now() - 3_900 };
      const pending = bulk
        ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] }, helpers)
        : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement }, helpers);
      let settled = false;
      const rejected = expect(pending.finally(() => { settled = true; })).rejects.toThrow("timed out");
      await started;
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(f.storageWrites).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(useSessionModelStore.getState().bySessionId).toEqual({});
      expect(f.storageWrites).toEqual([]);
    }
  }
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Near-expiry queued repicks have only their remaining 100ms", "All single/bulk catalog, directory, target and authoritative status reads stayed pending at 99ms and rejected at 100ms. Releasing abandoned reads after the mailbox deadline caused no local persistence or engine writes.", true);
});

test("queued repicks keep a monotonic remaining budget across wall-clock rollback", async ({ evidence }) => {
  let now = 0;
  const f = await fixture(() => now);
  vi.useFakeTimers();
  const wallNow = new Date("2026-01-01T00:00:00Z").getTime();
  for (const bulk of [false, true]) {
    for (const elapsed of [100, 99]) {
      now = 0;
      vi.setSystemTime(wallNow);
      useSessionModelStore.setState({ bySessionId: {} });
      f.setBeforeRead(async (kind) => {
        if (kind === "statuses") {
          now = elapsed;
          vi.setSystemTime(wallNow - 60_000);
        }
      });
      const before = f.storageWrites.length;
      const helpers = { requestCreatedAt: wallNow - 3_900 };
      const pending = bulk
        ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] }, helpers)
        : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement }, helpers);
      if (elapsed === 100) {
        await expect(pending).rejects.toThrow("timed out");
        expect(f.storageWrites).toHaveLength(before);
        expect(useSessionModelStore.getState().bySessionId).toEqual({});
      } else {
        expect(await pending).toMatchObject({ savedLocally: true, count: bulk ? 3 : 1 });
        expect(f.storageWrites).toHaveLength(before + 1);
      }
    }
  }
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Queued remaining time stays monotonic after handler entry", "With 100ms remaining and timers unfired, the final read at 100ms rejected despite a one-minute wall-clock rollback; the 99ms control saved successfully for both handlers. No engine writes occurred.", true);
});

test("direct repick handlers retain their four-second bound and abandoned reads never save later", async ({ evidence }) => {
  const f = await fixture();
  vi.useFakeTimers();
  const before = JSON.stringify(f.sessions);
  for (const bulk of [false, true]) {
    for (const delayed of ["catalog", "directory", bulk ? "sessions" : "session", "statuses"]) {
      let release = () => {};
      let entered = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      f.setBeforeRead(async (kind) => { if (kind === delayed) { entered(); await wait; } });
      const pending = bulk
        ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })
        : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
      const rejected = expect(pending).rejects.toThrow("timed out");
      await started;
      await vi.advanceTimersByTimeAsync(4_000);
      await rejected;
      expect(f.storageWrites).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(useSessionModelStore.getState().bySessionId).toEqual({});
      expect(f.storageWrites).toEqual([]);
    }
  }
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Repick deadlines prevent post-timeout local mutations", "Single and bulk catalog, directory, target and authoritative status reads all rejected at four seconds before the five-second mailbox; releasing every abandoned read afterward produced no local or engine writes.", true);
});

test("repick uses one absolute budget and checks elapsed time even before timers run", async ({ evidence }) => {
  let now = 0;
  const f = await fixture(() => now);
  for (const bulk of [false, true]) {
    now = 0;
    f.setBeforeRead(async () => { now += 1_500; });
    const pending = bulk
      ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })
      : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
    await expect(pending).rejects.toThrow("timed out");
    expect(f.storageWrites).toEqual([]);
  }
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Repick checks the absolute deadline after awaited reads", "Three individually short reads consumed 4.5 seconds of the injected monotonic clock without firing a timer; both single and bulk repicks rejected with no persistence or engine writes.", true);
});

test("activity starting during the final read prevents single and atomic bulk repicks", async ({ evidence }) => {
  const f = await fixture();
  for (const bulk of [false, true]) {
    f.working.clear();
    f.setBeforeRead(async (kind) => { if (kind === "statuses") f.working.add("session_this"); });
    const pending = bulk
      ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })
      : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
    await expect(pending).rejects.toThrow("Working sessions");
    expect(f.storageWrites).toEqual([]);
    expect(useSessionModelStore.getState().bySessionId).toEqual({});
  }
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Final-read activity prevents any repick persistence", "Local activity began inside the final authoritative status read. Single and bulk repicks both refused; idle bulk peers, local storage and engine state remained untouched.", true);
});

test("authoritative busy and retry states reject repicks even when local activity is empty", async ({ evidence }) => {
  const f = await fixture();
  const before = JSON.stringify(f.sessions);
  for (const status of [{ type: "busy" }, { type: "retry", attempt: 1, message: "Retrying", next: 123 }]) {
    f.engineStatuses.session_this = status;
    for (const dryRun of [true, false]) {
      await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement, dryRun })).rejects.toThrow("Working sessions");
      await expect(f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"], dryRun })).rejects.toThrow("Working sessions");
      expect(f.working.size).toBe(0);
      expect(f.storageWrites).toEqual([]);
      expect(useSessionModelStore.getState().bySessionId).toEqual({});
    }
  }
  expect(f.statusReads).toEqual(Array(8).fill("workspace_fixture_one"));
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Authoritative engine activity vetoes stale-cache repicks", "Busy and retry engine responses rejected single/bulk previews and confirmations with empty local activity. Idle peers, local persistence and engine records were untouched; only the target workspace's status was read.", true);
});

test("unreadable and malformed authoritative statuses cannot authorize any local model save", async ({ evidence }) => {
  const f = await fixture();
  const attempt = async () => {
    await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement })).rejects.toThrow();
    await expect(f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })).rejects.toThrow();
    expect(f.storageWrites).toEqual([]);
    expect(useSessionModelStore.getState().bySessionId).toEqual({});
  };
  f.setBeforeRead(async (kind) => { if (kind === "statuses") throw new Error("Status transport unavailable"); });
  await attempt();
  f.setBeforeRead(async () => {});
  for (const result of [
    {}, { data: {} }, { data: {}, response: { status: 206 } }, { data: {}, error: "unavailable", response: { status: 200 } },
    ...[undefined, null, [], "idle", { session_this: null }, { session_this: {} }, { session_this: { type: "unknown" } }, { unrelated: { type: "retry" } }].map((data) => ({ data, response: { status: 200 } })),
  ]) {
    f.setStatusResult(result);
    await attempt();
  }
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Status verification fails closed", "Transport rejection, missing response/data, partial HTTP success, errors, and malformed maps (including unrelated entries) all prevented single and atomic bulk saves without engine mutations.", true);
});

test("authoritative idle and omitted-idle maps permit local-only single and bulk repicks", async ({ evidence }) => {
  const f = await fixture();
  const before = JSON.stringify(f.sessions);
  for (const statuses of [{}, { session_this: { type: "idle" }, unrelated: { type: "busy" } }]) {
    f.setStatusResult({ data: statuses, response: { status: 200 } });
    for (const bulk of [false, true]) {
      useSessionModelStore.setState({ bySessionId: {} });
      const reads: string[] = [];
      f.setBeforeRead(async (kind) => { reads.push(kind); });
      const writes = f.storageWrites.length;
      const result = bulk
        ? await f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })
        : await f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
      expect(result).toMatchObject({ savedLocally: true, count: bulk ? 3 : 1, engineBindingUpdated: false });
      expect(f.storageWrites).toHaveLength(writes + 1);
      expect(reads).toEqual(["catalog", "directory", bulk ? "sessions" : "session", "statuses"]);
    }
  }
  expect(JSON.stringify(f.sessions)).toBe(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Exact 200 valid idle maps allow local-only persistence", "Explicit idle and omitted-idle maps allowed both handlers with one atomic local write each; unrelated engine activity did not veto the target. Status was the final awaited read, and no engine record changed.", true);
});

test("status waits recheck local holds and selections before single and bulk persistence", async ({ evidence }) => {
  const f = await fixture();
  for (const bulk of [false, true]) {
    for (const race of ["hold", "selection", "scope"]) {
      useSessionModelStore.setState({ bySessionId: {} });
      f.held.clear();
      let release = () => {};
      let entered = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      f.setBeforeRead(async (kind) => { if (kind === "statuses") { entered(); await wait; } });
      const pending = bulk
        ? f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: replacement, expectedSessionIds: ["session_this", "session_other", "session_restored"] })
        : f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement });
      await started;
      if (race === "hold") f.held.add("session_this");
      else if (race === "scope" && bulk) useSessionModelStore.getState().setModel("session_other_model", { providerID: old.providerId, modelID: old.modelId }, "low");
      else useSessionModelStore.getState().setModel("session_this", { providerID: alternate.providerId, modelID: alternate.modelId }, "high");
      const writes = f.storageWrites.length;
      const saved = useSessionModelStore.getState().bySessionId;
      release();
      await expect(pending).rejects.toThrow();
      expect(f.storageWrites).toHaveLength(writes);
      expect(useSessionModelStore.getState().bySessionId).toBe(saved);
    }
  }
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Status waits cannot overwrite local state changes", "While the final authoritative read waited, a hold, newer target choice or newly matching bulk peer appeared. Each handler rejected without additional persistence and preserved the newer choice; no engine writes occurred.", true);
});

test("confirmed pending choices survive ordinary selections beyond the old 200-entry cap", async ({ evidence }) => {
  const f = await fixture();
  await f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: { ...replacement, variant: "low" }, expectedSessionIds: ["session_this", "session_other", "session_restored"] });
  const before = useSessionModelStore.getState().bySessionId;
  for (let index = 0; index < 250; index++) useSessionModelStore.getState().setModel(`fixture_new_${index}`, { providerID: alternate.providerId, modelID: alternate.modelId });
  for (const [id, choice] of Object.entries(before)) expect(useSessionModelStore.getState().bySessionId[id]).toBe(choice);
  expect(JSON.parse(f.storage.get("openwork.sessionModels.v1") ?? "{}")).toMatchObject(before);
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Pending choices survive ordinary selection churn", "After 250 additional selections, every confirmed choice retained its object identity and persisted model/variant; no engine writes occurred.", Object.entries(before).every(([id, choice]) => useSessionModelStore.getState().bySessionId[id] === choice) && f.writes().length === 0);
});

test("queue catalog checks use renderer identity, not a remote runtime's colliding workspace id", async ({ evidence }) => {
  const calls: unknown[] = [];
  const context = { workspaceId: "ws_remote_runtime", rendererWorkspaceId: "rem_fixture" };
  const query = async (request: { args?: Record<string, unknown> }) => {
    calls.push(request);
    expect(request.args?.workspaceId).toBe("rem_fixture");
    return { ok: true, id: "session.model_preflight", effects: { data: "read", ui: "none", external: false }, result: { ok: true, workspaceId: "rem_fixture", sessionId: "session_fixture", model: { ...replacement, variant: "low" } } };
  };
  expect(await preflightQueuedSessionModel(context, "session_fixture", old, query)).toMatchObject({ modelId: replacement.modelId });
  await expect(preflightQueuedSessionModel({}, "session_fixture", old, query)).rejects.toThrow("Renderer workspace");
  expect(calls).toHaveLength(1);
  await expect(preflightQueuedSessionModel(context, "session_fixture", old, async () => ({ ok: true, id: "session.model_preflight", effects: { data: "read", ui: "none", external: false }, result: { ok: true, workspaceId: "ws_remote_runtime", sessionId: "session_fixture", model: { ...replacement, variant: null } } }))).rejects.toThrow("identity mismatch");
  evidence.recordAssertionEvidence("Queued model preflight uses renderer workspace identity", "The query used rem_fixture and returned the replacement; missing renderer identity made no query, and a response bearing the colliding runtime workspace id was rejected.", calls.length === 1);
});

test("effective picker selection and slash commands honor engine binding, local repick and effort", async ({ evidence }) => {
  const f = await fixture();
  const engine = { model: { providerID: old.providerId, modelID: old.modelId }, variant: "high" };
  const fallback = { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: null };
  expect(effectiveSessionModelSelection(null, engine, fallback)).toBe(engine);
  await f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: { ...replacement, variant: "low" } });
  const selected = effectiveSessionModelSelection(useSessionModelStore.getState().bySessionId.session_this, engine, fallback);
  if (!selected) throw new Error("Selection missing");
  await f.command(selected.model, selected.variant);
  expect(f.writes()[0]?.body).toMatchObject({ model: `${replacement.providerId}/${replacement.modelId}`, variant: "low", command: "fixture" });
  expect(effectiveSessionModelSelection(null, null, fallback)).toBe(fallback);
  expect(sessionCommandModelFields(selected.model, null)).toEqual({ model: `${replacement.providerId}/${replacement.modelId}`, variant: "default" });
  evidence.recordAssertionEvidence("Picker precedence and slash commands preserve selected model and effort", "Engine binding won over the default until local repick; the observed command HTTP payload carried replacement ids and low effort. Missing bindings used the fallback, and null effort produced explicit default rather than retaining old effort.", true);
});

test("canonical workspace aliases allow single and bulk repick but never admit neighboring directories", async ({ evidence }) => {
  const f = await fixture();
  const canonical = "/engine/canonical/workspace-one";
  f.directories.set("workspace_fixture_one", canonical);
  for (const item of f.sessions) {
    if (item.directory === "/synthetic/one") item.directory = canonical;
    if (item.id === "session_restored") item.time.archived = 1;
  }
  f.sessions.push(session("session_nested", old.modelId, 0, `${canonical}/nested`), session("session_neighbor", old.modelId, 0, `${canonical}-neighbor`));
  const args = { workspaceId: "workspace_fixture_one", from: old, to: replacement };
  const preview = await f.actions.rebindModel({ ...args, dryRun: true });
  expect(preview.sessions.map((item) => item.sessionId)).toEqual(["session_this", "session_other"]);
  expect(f.storageWrites).toEqual([]);
  expect(await f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_this", model: replacement })).toMatchObject({ savedLocally: true, count: 1 });
  expect(await f.actions.rebindModel({ ...args, expectedSessionIds: ["session_other"] })).toMatchObject({ savedLocally: true, count: 1 });
  const saved = useSessionModelStore.getState().bySessionId;
  expect(Object.keys(saved).sort()).toEqual(["session_other", "session_this"]);
  for (const id of ["session_nested", "session_neighbor", "session_other_workspace"]) {
    await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: id, model: replacement })).rejects.toThrow("belong");
    expect(useSessionModelStore.getState().bySessionId).toBe(saved);
  }
  f.directories.delete("workspace_fixture_one");
  await expect(f.actions.rebindModel({ ...args, dryRun: true })).rejects.toThrow("owner unavailable");
  expect(f.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Repick ownership is exact against the engine's canonical workspace directory", "A different registered path produced a two-session preview and successful single/bulk local saves; archives, another workspace, nested paths and prefix neighbors were excluded. Missing canonical ownership failed closed.", true);
});

test("same-id effort changes and bulk selections publish model/variant atomically", async ({ evidence }) => {
  const f = await fixture();
  const model = { providerID: replacement.providerId, modelID: replacement.modelId };
  const store = useSessionModelStore.getState();
  store.setModel("session_this", model, "high");
  store.setModel("session_this", model, "low");
  const selected = useSessionModelStore.getState().bySessionId.session_this;
  expect(selected).toEqual({ model, variant: "low" });
  store.setModel("session_this", model);
  expect(useSessionModelStore.getState().bySessionId.session_this).toBe(selected);
  store.setModel("session_this", model, null);
  expect(useSessionModelStore.getState().bySessionId.session_this?.variant).toBeNull();
  const observations: unknown[] = [];
  const unsubscribe = useSessionModelStore.subscribe((state) => observations.push(state.bySessionId));
  try {
    await f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: { ...alternate, variant: "high" }, expectedSessionIds: ["session_other", "session_restored"] });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      session_other: { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" },
      session_restored: { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" },
    });
    expect(f.writes()).toEqual([]);
    evidence.recordAssertionEvidence("Same-id effort edits and bulk repicks publish atomically", "Explicit effort edits changed high to low and then null; an omitted effort preserved the same choice. Bulk repick emitted exactly one store update containing both target model/variant pairs and no engine writes.", observations.length === 1 && f.writes().length === 0);
  } finally { unsubscribe(); }
});

test("suggested replacements prefer the same provider family then available workspace default, never silently picking another model", async ({ evidence }) => {
  expect(suggestOpenworkReplacement(old, [alternate, replacement], alternate)).toEqual(replacement);
  expect(suggestOpenworkReplacement({ ...old, providerId: "retired_provider" }, [alternate, replacement], alternate)).toEqual(replacement);
  expect(suggestOpenworkReplacement(old, [alternate], alternate)).toEqual(alternate);
  expect(suggestOpenworkReplacement(old, [alternate], old)).toBeNull();
  expect(suggestOpenworkReplacement(old, [], alternate)).toBeNull();
  expect(openworkSessionModelSchema.parse({ ...replacement, variant: null }).modelId).toBe(replacement.modelId);
  evidence.recordAssertionEvidence("Replacement suggestions preserve provider preference and availability", "Same-provider and same-family candidates outranked the workspace default; an available default was used only without a family match. An unavailable default or empty catalog returned null rather than an unrelated model, and schema parsing preserved the replacement id.", true);
});
