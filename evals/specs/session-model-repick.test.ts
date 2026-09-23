import { createServer, type Server } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";

import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import {
  createSessionModelActions,
  SessionModelTargetSetChangedError,
} from "../../apps/app/src/react-app/domains/session/control/session-model-actions";
import {
  applySharedSessionModelSelection,
  effectiveSessionModelSelection,
  useSessionModelStore,
} from "../../apps/app/src/react-app/domains/session/surface/session-model-store";

const previousServerUrl = process.env.OPENWORK_SERVER_URL;
const previousServerToken = process.env.OPENWORK_SERVER_TOKEN;
const servers: Server[] = [];

afterEach(async () => {
  useSessionModelStore.setState({ bySessionId: {} });
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (previousServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = previousServerUrl;
  if (previousServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = previousServerToken;
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

function localStorageWitness() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key);
        values.set(key, value);
      },
    },
  });
  useSessionModelStore.setState({ bySessionId: {} });
  return { values, writes };
}

test("a full-picker choice advances the shared default without replacing another session's memory", ({ evidence }) => {
  const storage = localStorageWitness();
  const previous = { model: { providerID: "fixture", modelID: "remembered" }, variant: "high" };
  const next = { providerID: "fixture", modelID: "next" };
  useSessionModelStore.getState().setModel("remembered-session", previous.model, previous.variant);
  let shared = { model: { providerID: "fixture", modelID: "old-default" }, variant: null as string | null };

  applySharedSessionModelSelection("picker-session", next, "low", (model, variant) => {
    shared = { model, variant: variant ?? null };
  });

  expect(useSessionModelStore.getState().bySessionId).toEqual({
    "remembered-session": previous,
    "picker-session": { model: next, variant: "low" },
  });
  expect(shared).toEqual({ model: next, variant: "low" });
  expect(effectiveSessionModelSelection(null, null, shared)).toEqual(shared);
  expect(storage.writes).toEqual(["openwork.sessionModels.v1", "openwork.sessionModels.v1"]);
  evidence.recordAssertionEvidence(
    "The full picker updates the shared default while preserving remembered sessions",
    "The selected session and shared fallback moved to fixture/next at low effort. A different session retained fixture/remembered at high effort, and an unbound session resolved to the new shared fallback.",
    true,
  );
});

test("headless repick previews exact targets and rejects membership drift without partial writes", async ({ evidence }) => {
  const storage = localStorageWitness();
  const workspace = { id: "workspace-fixture", path: "/synthetic/workspace" };
  const removed = { providerId: "fixture", modelId: "removed", variant: "high", displayName: "Removed", providerName: "Fixture" };
  const replacement = { providerId: "fixture", modelId: "replacement", displayName: "Replacement", providerName: "Fixture" };
  const sessions = [
    { id: "session-one", title: "One", directory: workspace.path, time: { archived: 0 }, model: { providerID: removed.providerId, id: removed.modelId, variant: removed.variant } },
    { id: "session-two", title: "Two", directory: workspace.path, time: { archived: 0 }, model: { providerID: removed.providerId, id: removed.modelId, variant: removed.variant } },
    { id: "session-archived", title: "Archived", directory: workspace.path, time: { archived: 1 }, model: { providerID: removed.providerId, id: removed.modelId, variant: removed.variant } },
  ];
  const actions = createSessionModelActions({
    workspaces: [workspace],
    catalog: async () => [replacement],
    directory: async () => workspace.path,
    sessions: async () => sessions,
    session: async (_workspace, sessionId) => sessions.find((session) => session.id === sessionId),
    statuses: async () => ({ data: {}, response: { status: 200 } }),
  });

  const preview = await actions.rebindModel({ workspaceId: workspace.id, from: removed, to: replacement, dryRun: true });
  expect(preview.sessions.map((session) => session.sessionId)).toEqual(["session-one", "session-two"]);
  expect(storage.writes).toEqual([]);

  sessions.push({ id: "session-three", title: "Three", directory: workspace.path, time: { archived: 0 }, model: { providerID: removed.providerId, id: removed.modelId, variant: removed.variant } });
  let drift: unknown;
  try {
    await actions.rebindModel({
      workspaceId: workspace.id,
      from: removed,
      to: replacement,
      expectedSessionIds: preview.sessions.map((session) => session.sessionId),
    });
  } catch (cause) {
    drift = cause;
  }
  expect(drift).toBeInstanceOf(SessionModelTargetSetChangedError);
  if (!(drift instanceof SessionModelTargetSetChangedError)) throw new Error("Expected exact target-set drift");
  expect(drift.expectedSessionIds).toEqual(["session-one", "session-two"]);
  expect(drift.currentSessionIds).toEqual(["session-one", "session-two", "session-three"]);
  expect(useSessionModelStore.getState().bySessionId).toEqual({});
  expect(storage.writes).toEqual([]);

  const refreshed = await actions.rebindModel({ workspaceId: workspace.id, from: removed, to: replacement, dryRun: true });
  await actions.rebindModel({
    workspaceId: workspace.id,
    from: removed,
    to: { ...replacement, variant: "low" },
    expectedSessionIds: refreshed.sessions.map((session) => session.sessionId),
  });
  expect(Object.keys(useSessionModelStore.getState().bySessionId)).toEqual(["session-one", "session-two", "session-three"]);
  expect(useSessionModelStore.getState().bySessionId["session-one"]).toEqual({
    model: { providerID: replacement.providerId, modelID: replacement.modelId },
    variant: "low",
  });
  expect(useSessionModelStore.getState().bySessionId["session-archived"]).toBeUndefined();
  expect(storage.writes).toEqual(["openwork.sessionModels.v1"]);
  evidence.recordAssertionEvidence(
    "Headless bulk repick requires the exact refreshed session set",
    "The first preview was read-only. When an unarchived match appeared, confirmation returned both the exact prior ids and refreshed ids and wrote nothing. Only a second preview plus confirmation persisted all three unarchived targets atomically; the archive stayed untouched.",
    true,
  );
});

test("headless send rejects a stale binding before writing and sends the explicit replacement after repick", async ({ evidence }) => {
  let allowReplacement = false;
  const prompts: unknown[] = [];
  const workspace = { id: "workspace-fixture", name: "Fixture", path: "/synthetic/workspace" };
  const session = {
    id: "session-fixture",
    title: "Fixture session",
    directory: workspace.path,
    time: { created: 1, updated: 2 },
    model: { providerID: "fixture", id: "removed", variant: "high" },
  };
  const replacement = { providerId: "fixture", modelId: "replacement", variant: "low", displayName: "Replacement", providerName: "Fixture" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    request.setEncoding("utf8");
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body: unknown = text ? JSON.parse(text) : null;
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/workspaces") return json(200, { items: [workspace] });
    if (url.pathname === `/workspace/${workspace.id}/opencode/session/${session.id}`) return json(200, session);
    if (url.pathname === "/experimental/ui-control/request") {
      if (!allowReplacement) return json(200, { ok: false, id: "session.model_preflight", code: "model_unavailable", error: "Removed model" });
      return json(200, {
        ok: true,
        id: "session.model_preflight",
        effects: { data: "read", ui: "none", external: false },
        result: { ok: true, workspaceId: workspace.id, sessionId: session.id, model: replacement },
      });
    }
    if (url.pathname === `/workspace/${workspace.id}/opencode/session/${session.id}/prompt_async`) {
      prompts.push(body);
      response.writeHead(204);
      return response.end();
    }
    return json(404, { message: "Not found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server address missing");
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "fixture-token";
  const plugin = await OpenWorkExtensionsPreview({ directory: workspace.path });
  const send = async () => record(JSON.parse(await plugin.tool.openwork_execute.execute({
    id: "session.send",
    args: { workspaceId: workspace.id, sessionId: session.id, text: "Synthetic prompt" },
  }, {})));

  expect(await send()).toMatchObject({ ok: false, id: "session.send", code: "model_unavailable" });
  expect(prompts).toEqual([]);
  allowReplacement = true;
  expect(await send()).toMatchObject({ ok: true, id: "session.send", result: { accepted: true, sessionId: session.id } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    model: { providerID: replacement.providerId, modelID: replacement.modelId },
    variant: replacement.variant,
    parts: [{ type: "text", text: "Synthetic prompt" }],
  });
  evidence.recordAssertionEvidence(
    "Headless send validates the exact next-send model before writing",
    "The stale engine binding returned model_unavailable with zero prompt writes. After preflight supplied the explicit local replacement, one prompt was accepted with canonical provider/model ids and low effort.",
    true,
  );
});
