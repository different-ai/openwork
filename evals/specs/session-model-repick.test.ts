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
async function fixture() {
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
  const reads: Array<{ workspaceId: string; sessionId?: string }> = [];
  let beforeCatalog = async () => {};
  const actions = createSessionModelActions({ workspaces,
    directory: async (workspace) => {
      const owner = directories.get(workspace.id);
      if (!owner) throw new Error("Fixture owner unavailable");
      return owner;
    },
    catalog: async () => { await beforeCatalog(); if (catalogFailure) throw new Error("Fixture catalog unavailable"); return catalog; },
    sessions: async (workspace) => { reads.push({ workspaceId: workspace.id }); if (offline.has(workspace.id)) throw new Error("Offline inventory"); return sessions; },
    session: async (workspace, sessionId) => { reads.push({ workspaceId: workspace.id, sessionId }); return sessions.find((session) => session.id === sessionId); },
    held: (_workspace, id) => held.has(id),
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
  return { actions, storage, storageWrites, sessions, requests, catalog, offline, held, reads, directories,
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

test("invalid targets, changed previews and unavailable replacements cannot partially save", async () => {
  const f = await fixture();
  await expect(f.actions.setModel({ sessionId: "session_archived", model: replacement })).rejects.toThrow("Archived");
  await expect(f.actions.setModel({ sessionId: "session_this", model: old })).rejects.toThrow("Unavailable");
  await expect(f.actions.rebindModel({ workspaceId: "missing", from: old, to: replacement })).rejects.toThrow("Workspace");
  await expect(f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement, expectedSessionIds: ["session_this"] })).rejects.toThrow("changed");
  expect(f.storageWrites).toEqual([]);
  expect(f.writes()).toEqual([]);
});

test("healthy fresh sessions preserve model-free sending, never substituting defaults for stale bindings", async () => {
  const f = await fixture();
  expect(await f.execute("session.send", { workspaceId: "workspace_fixture_one", sessionId: "session_fresh", text: "Fresh prompt" })).toMatchObject({ ok: true, result: { accepted: true } });
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]?.body).not.toHaveProperty("model");
  expect(f.writes()[0]?.body).not.toHaveProperty("variant");
  expect(await f.execute("session.send", { workspaceId: "workspace_fixture_one", sessionId: "session_this", text: "Must not send" })).toMatchObject({ ok: false, code: "model_unavailable" });
  expect(f.writes()).toHaveLength(1);
});

test("exact workspace repick bypasses unrelated offline inventories and rejects foreign targets", async () => {
  const f = await fixture();
  f.offline.add("workspace_fixture_two");
  expect(await f.execute("session.set_model", { workspaceId: "workspace_fixture_one", sessionId: "session_this", alias: replacement.displayName })).toMatchObject({ ok: true, result: { savedLocally: true } });
  expect(f.reads).toEqual([{ workspaceId: "workspace_fixture_one", sessionId: "session_this" }]);
  const before = f.storageWrites.length;
  await expect(f.actions.setModel({ workspaceId: "workspace_fixture_one", sessionId: "session_other_workspace", model: replacement })).rejects.toThrow("belong");
  expect(f.storageWrites).toHaveLength(before);
});

test("catalog waits cannot race an archive, hold or newer local selection into a repick", async () => {
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
});

test("confirmed pending choices survive ordinary selections beyond the old 200-entry cap", async () => {
  const f = await fixture();
  await f.actions.rebindModel({ workspaceId: "workspace_fixture_one", from: old, to: { ...replacement, variant: "low" } });
  const before = useSessionModelStore.getState().bySessionId;
  for (let index = 0; index < 250; index++) useSessionModelStore.getState().setModel(`fixture_new_${index}`, { providerID: alternate.providerId, modelID: alternate.modelId });
  for (const [id, choice] of Object.entries(before)) expect(useSessionModelStore.getState().bySessionId[id]).toBe(choice);
  expect(JSON.parse(f.storage.get("openwork.sessionModels.v1") ?? "{}")).toMatchObject(before);
  expect(f.writes()).toEqual([]);
});

test("queue catalog checks use renderer identity, not a remote runtime's colliding workspace id", async () => {
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
});

test("effective picker selection and slash commands honor engine binding, local repick and effort", async () => {
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
  expect(await f.actions.rebindModel(args)).toMatchObject({ savedLocally: true, count: 1 });
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

test("same-id effort changes and bulk selections publish model/variant atomically", async () => {
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
    await f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: { ...alternate, variant: "high" } });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      session_other: { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" },
      session_restored: { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" },
    });
    expect(f.writes()).toEqual([]);
  } finally { unsubscribe(); }
});

test("suggested replacements prefer the same provider family then available workspace default, never silently picking another model", async () => {
  expect(suggestOpenworkReplacement(old, [alternate, replacement], alternate)).toEqual(replacement);
  expect(suggestOpenworkReplacement({ ...old, providerId: "retired_provider" }, [alternate, replacement], alternate)).toEqual(replacement);
  expect(suggestOpenworkReplacement(old, [alternate], alternate)).toEqual(alternate);
  expect(suggestOpenworkReplacement(old, [alternate], old)).toBeNull();
  expect(suggestOpenworkReplacement(old, [], alternate)).toBeNull();
  expect(openworkSessionModelSchema.parse({ ...replacement, variant: null }).modelId).toBe(replacement.modelId);
});
