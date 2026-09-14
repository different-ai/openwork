import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { openworkModelSessionSchema, openworkSessionModelSchema, suggestOpenworkReplacement } from "@openwork/types/openwork-affordance";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { createSessionModelActions } from "../../apps/app/src/react-app/domains/session/control/session-model-actions";
import { useSessionModelStore } from "../../apps/app/src/react-app/domains/session/surface/session-model-store";

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
function session(id: string, modelId = old.modelId, archived = 0, directory = "/synthetic/one") {
  return { id, title: id, directory, time: { archived }, model: { providerID: old.providerId, id: modelId, variant: "high" } };
}
async function fixture() {
  const storage = new Map<string, string>();
  const storageWrites: string[] = [];
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storageWrites.push(key); storage.set(key, value); },
  } });
  useSessionModelStore.setState({ bySessionId: {} });
  const sessions = [session("session_this"), session("session_other"), session("session_archived", old.modelId, 1), session("session_restored", old.modelId, 0), session("session_other_model", replacement.modelId), session("session_other_workspace", old.modelId, 0, "/synthetic/two")];
  const catalog = [replacement, alternate];
  let hostFailure: "none" | "missing" | "wrong_workspace" | "wrong_session" = "none";
  let catalogFailure = false;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const actions = createSessionModelActions({ workspaces,
    catalog: async () => { if (catalogFailure) throw new Error("Fixture catalog unavailable"); return catalog; },
    sessions: async () => sessions,
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
    const matched = /^\/workspace\/([^/]+)\/opencode\/session\/([^/]+)(\/prompt_async)?$/.exec(url.pathname);
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
  return { actions, storage, storageWrites, sessions, requests, catalog,
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

test("invalid targets, changed previews, unavailable replacements and capacity errors cannot partially save", async () => {
  const f = await fixture();
  await expect(f.actions.setModel({ sessionId: "session_archived", model: replacement })).rejects.toThrow("Archived");
  await expect(f.actions.setModel({ sessionId: "session_this", model: old })).rejects.toThrow("Unavailable");
  await expect(f.actions.rebindModel({ workspaceId: "missing", from: old, to: replacement })).rejects.toThrow("Workspace");
  await expect(f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement, expectedSessionIds: ["session_this"] })).rejects.toThrow("changed");
  expect(f.storageWrites).toEqual([]);
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`fixture_remembered_${index}`, { model: { providerID: alternate.providerId, modelID: alternate.modelId }, variant: "high" }]));
  useSessionModelStore.setState({ bySessionId: entries });
  await expect(f.actions.rebindModel({ workspaceId: workspaces[0]?.id, from: old, to: replacement })).rejects.toThrow("full");
  expect(useSessionModelStore.getState().bySessionId).toBe(entries);
  expect(f.storageWrites).toEqual([]);
  expect(f.writes()).toEqual([]);
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
