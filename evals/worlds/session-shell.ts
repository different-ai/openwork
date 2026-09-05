import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { engineSessionProbe, readAvailableModels, waitFor } from "@openwork/behaviors";
import { resolveEvalEngine } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { daytonaSandbox, desktop as launchDesktop } from "@openwork/hosts";

const stormProviderId = "active-session-storm-mock";
const stormModelId = "mock-agent-workload-model";

export interface ShellSession {
  sessionId: string;
  title: string;
}

export interface ShellWorkspace {
  workspaceId: string;
  route: string;
}

export interface StormPlan extends ShellSession, ShellWorkspace {
  index: number;
  path: string;
  filePath: string;
  marker: string;
  slowMarker: string;
  easyMarker: string;
  finalReply: string;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function streamReply(response: ServerResponse, id: string, reply: string): void {
  const chunks = [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function additionalWorkspace(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  path: string,
): Promise<ShellWorkspace> {
  const previous = await seed.evalIn(app, `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`);
  // TODO(primitive): seed.workspace should always create the requested additional workspace.
  const result = await seed.evalIn(app, `(path) => window.__openworkControl.execute("workspace.create", { path })`, {
    args: [path],
    awaitPromise: true,
    timeoutMs: 120_000,
  });
  if (!isRecord(result) || result.ok !== true) throw new Error(`Could not create workspace ${path}: ${JSON.stringify(result)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await seed.evalIn(app, `({
      workspaceId: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
      route: window.location.hash,
      ready: Boolean(window.__openworkControl),
    })`);
    if (isRecord(state)
      && typeof state.workspaceId === "string"
      && state.workspaceId
      && state.workspaceId !== previous
      && typeof state.route === "string"
      && state.ready === true) {
      return { workspaceId: state.workspaceId, route: state.route };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace ${path} did not become active after creation.`);
}

async function configureWorkspaceProvider(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceIds: readonly string[],
  options: {
    providerId: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    smallModel?: string;
    allowTools?: boolean;
  },
): Promise<void> {
  // TODO(primitive): seed.configureWorkspaceProvider should configure and reload a workspace model without raw renderer evaluation.
  const result = await seed.evalIn(app, `async (workspaceIdsJson, smallModel, allowTools, providerId, modelId, modelName, baseUrl, defaultModel) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const workspaceIds = JSON.parse(workspaceIdsJson);
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const outcomes = [];
    for (const workspaceId of workspaceIds) {
      const opencode = {
        provider: {
          [providerId]: {
            npm: "@ai-sdk/openai-compatible",
            name: modelName,
            options: { baseURL: baseUrl, apiKey: "sk-eval-fixture" },
            models: { [modelId]: { name: modelName, tool_call: allowTools } },
          },
        },
      };
      if (smallModel) opencode.small_model = smallModel;
      if (allowTools) opencode.permission = { edit: "allow", write: "allow", read: "allow", bash: "allow" };
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ opencode }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        outcomes.push({ workspaceId, stage: "config", status: response.status, text: (await response.text()).slice(0, 300) });
        continue;
      }
      const reload = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60000),
      });
      outcomes.push({ workspaceId, stage: "reload", status: reload.status, text: reload.ok ? "ok" : (await reload.text()).slice(0, 300) });
    }
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: providerId, modelID: modelId },
      modelVariant: null,
      providerStepCleaned: true,
    }));
    localStorage.setItem("openwork.defaultModel", defaultModel);
    for (const workspaceId of workspaceIds) localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return { outcomes };
  }`, {
    args: [
      JSON.stringify(workspaceIds),
      options.smallModel ?? null,
      options.allowTools ?? false,
      options.providerId,
      options.modelId,
      options.modelName,
      options.baseUrl,
      `${options.providerId}/${options.modelId}`,
    ],
    awaitPromise: true,
    timeoutMs: 240_000,
  });
  if (typeof result !== "object" || result === null || !("outcomes" in result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Workspace provider configuration failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) => (
    typeof outcome !== "object" || outcome === null || !("status" in outcome) || outcome.status !== 200
  ));
  if (failures.length > 0) throw new Error(`Workspace provider configuration failed: ${JSON.stringify(failures)}`);
}

async function oneWorkspace(seed: Seed, name: string, titles: readonly string[] = []) {
  const app = await seed.desktop({ name });
  const workspacePath = seed.tmpPath(name);
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = titles.length > 0 ? await seed.sessions(app, titles) : [];
  return { app, workspace, workspacePath, sessions };
}

export async function sidebarPrimaryActions(seed: Seed) {
  return oneWorkspace(seed, "sidebar-primary-actions");
}

export async function sidebarOverflow(seed: Seed) {
  const longTitle = "Reading Google Drive documents for the quarterly workspace review";
  const app = await seed.desktop({ name: "sidebar-title-overflow-fade" });
  const workspacePath = "/tmp/Yonder";
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = await seed.sessions(app, [longTitle]);
  return { app, workspace, workspacePath, sessions, longTitle };
}

export async function sidebarWorkspaceTitles(seed: Seed) {
  const runId = Date.now().toString(36);
  const shortName = `Yonder-${runId}`;
  const longName = `openwork-workspace-title-that-keeps-going-past-the-sidebar-${runId}`;
  const app = await seed.desktop({ name: "sidebar-workspace-title-fit" });
  const shortWorkspace = await seed.workspace(app, `/tmp/${shortName}`);
  return { app, shortName, longName, shortWorkspace };
}

export async function workspaceNewTask(seed: Seed) {
  return oneWorkspace(seed, `openwork-kitchen-vercel-env-hit-target-${Date.now()}`);
}

// TODO(primitive): seed.workspace should resolve only after the workspace's first session load settles; until then session.create_task returns no id (#4364).
async function waitForWorkspaceSessionsLoaded(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    lastState = await seed.evalIn(app, `(workspaceId) => {
      const route = window.__openwork?.slice?.("route");
      const workspace = (route?.workspaces ?? []).find((item) => item.id === workspaceId);
      return workspace ? { exists: true, loading: workspace.loading } : { exists: false, loading: null };
    }`, { args: [workspaceId] });
    if (isRecord(lastState) && lastState.exists === true && lastState.loading === false) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace ${workspaceId} did not finish its first session load within ${timeoutMs}ms. Last state: ${JSON.stringify(lastState)}`);
}

export async function pinnedSessions(seed: Seed) {
  const app = await seed.desktop({ name: "pinned-sessions-exposed" });
  const workspacePath = seed.tmpPath("pinned-sessions-exposed");
  const workspace = await seed.workspace(app, workspacePath);
  await waitForWorkspaceSessionsLoaded(seed, app, workspace.workspaceId);
  const [candidate, neighbor] = await seed.sessions(app, ["Candidate session", "Neighbor session"]);
  if (!candidate || !neighbor) throw new Error("Pinned world did not create both sessions.");

  // TODO(primitive): probe.context should expose the OpenWork context snapshot.
  async function context(): Promise<{ pinnedSessionIds: string[]; pinnedResourceRefs: string[] }> {
    const value = await seed.evalIn(app, `(() => {
      const c = window.__openworkControl?.context?.();
      return {
        pinnedSessionIds: c?.conversations?.pinnedSessionIds ?? null,
        pinnedResourceRefs: (c?.resources ?? [])
          .filter((r) => r.kind === "session" && r.state?.pinned === true)
          .map((r) => r.ref),
      };
    })()`);
    if (!isRecord(value)
      || !Array.isArray(value.pinnedSessionIds)
      || !value.pinnedSessionIds.every((id) => typeof id === "string")
      || !Array.isArray(value.pinnedResourceRefs)
      || !value.pinnedResourceRefs.every((ref) => typeof ref === "string")) {
      throw new Error(`OpenWork context pin state was malformed: ${JSON.stringify(value)}`);
    }
    return {
      pinnedSessionIds: value.pinnedSessionIds,
      pinnedResourceRefs: value.pinnedResourceRefs,
    };
  }

  // TODO(primitive): probe.sidebar complements user.see({ text: "Pinned" }) by exposing which rows the section contains.
  async function pinnedSidebarRows(): Promise<string[] | null> {
    const value = await seed.evalIn(app, `(() => {
      const section = document.querySelector("[data-global-pinned-sessions]");
      if (!section) return null;
      return [...section.querySelectorAll("[data-sidebar-session-id]")]
        .map((row) => row.getAttribute("data-sidebar-session-id"));
    })()`);
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((sessionId) => typeof sessionId === "string")) {
      throw new Error(`Global pinned sidebar rows were malformed: ${JSON.stringify(value)}`);
    }
    return value;
  }

  return { app, workspace, workspacePath, candidate, neighbor, context, pinnedSidebarRows };
}

export async function commandPaletteSearch(seed: Seed) {
  return oneWorkspace(seed, `command-palette-search-${Date.now()}`);
}

export async function archiveSessions(seed: Seed) {
  const stamp = `${Date.now()}-${process.pid}`;
  const app = await seed.desktop({ name: "session-archive-button" });
  const workspaceB = await seed.workspace(app, `/tmp/openwork-session-archive-${stamp}-b`);
  const [b1] = await seed.sessions(app, [`Archive B1 ${stamp}`]);
  const workspaceA = await additionalWorkspace(seed, app, `/tmp/openwork-session-archive-${stamp}-a`);
  const [a1, a2] = await seed.sessions(app, [`Archive A1 ${stamp}`, `Archive A2 ${stamp}`]);
  if (!a1 || !a2 || !b1) throw new Error("Archive world did not create all three sessions.");
  return {
    app,
    workspaceA,
    workspaceB,
    a1: { ...a1, workspaceId: workspaceA.workspaceId },
    a2: { ...a2, workspaceId: workspaceA.workspaceId },
    b1: { ...b1, workspaceId: workspaceB.workspaceId },
  };
}

export async function responsiveSessions(seed: Seed) {
  const titles = ["Responsive primary chat", "Responsive split chat"];
  const world = await oneWorkspace(seed, "responsive-session-layout", titles);
  const [primary, secondary] = world.sessions;
  if (!primary || !secondary) throw new Error("Responsive world did not create both sessions.");
  // TODO(primitive): seed.desktop should accept an initial viewport for Electron surfaces.
  await world.app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { ...world, primary, secondary };
}

export type SidebarRouteWorkspace = { id: string; name: string; loading: boolean; error: string | null };
export type SidebarRouteSession = { id: string; title: string };
export type SidebarRouteFacts = {
  selectedWorkspaceId: string;
  workspaces: SidebarRouteWorkspace[];
  sessionsByWorkspaceId: Record<string, SidebarRouteSession[]>;
};

function parseSidebarRouteFacts(value: unknown): SidebarRouteFacts {
  if (!isRecord(value) || typeof value.selectedWorkspaceId !== "string" || !Array.isArray(value.workspaces) || !isRecord(value.sessionsByWorkspaceId)) {
    throw new Error(`Route inspector slice was unavailable: ${JSON.stringify(value)}`);
  }
  const workspaces: SidebarRouteWorkspace[] = [];
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace) || typeof workspace.id !== "string" || typeof workspace.name !== "string" || typeof workspace.loading !== "boolean") {
      throw new Error(`Route inspector workspace was invalid: ${JSON.stringify(workspace)}`);
    }
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      loading: workspace.loading,
      error: typeof workspace.error === "string" ? workspace.error : null,
    });
  }
  const sessionsByWorkspaceId: Record<string, SidebarRouteSession[]> = {};
  for (const [workspaceId, sessions] of Object.entries(value.sessionsByWorkspaceId)) {
    if (!Array.isArray(sessions)) throw new Error(`Route inspector sessions for ${workspaceId} were invalid: ${JSON.stringify(sessions)}`);
    sessionsByWorkspaceId[workspaceId] = sessions.map((session) => {
      if (!isRecord(session) || typeof session.id !== "string" || typeof session.title !== "string") {
        throw new Error(`Route inspector session was invalid: ${JSON.stringify(session)}`);
      }
      return { id: session.id, title: session.title };
    });
  }
  return { selectedWorkspaceId: value.selectedWorkspaceId, workspaces, sessionsByWorkspaceId };
}

/**
 * Two empty workspaces on one desktop. `other` is created last, which selects
 * it and expands its sidebar group; the group stays expanded after the spec
 * returns to `home`, so `other`'s rows keep rendering while it is not selected.
 */
export async function externalSessionVisibility(seed: Seed) {
  const app = await seed.desktop({ name: "sidebar-external-session-visibility" });
  const repoRoot = app.workspaceRoot;
  if (!repoRoot) throw new Error("External session visibility needs a spawned desktop with a known workspace root.");
  // Real checkout directories avoid conflating session-list freshness with a
  // missing-directory cold start in OpenCode.
  const homePath = `${repoRoot}/apps/app`;
  const otherPath = `${repoRoot}/apps/server`;
  const home = await seed.workspace(app, homePath);
  const other = await additionalWorkspace(seed, app, otherPath);
  const workspaceDirectories = new Map([
    [home.workspaceId, homePath],
    [other.workspaceId, otherPath],
  ]);
  // TODO(primitive): seed.desktop should accept an initial viewport for Electron surfaces.
  // The sidebar renders its workspace rows only on a desktop-width viewport.
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1_400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // These empty workspaces do not send prompts. Let the model catalog settle
  // and explicitly close its picker before testing sidebar clicks: the missing
  // default-model prompt can otherwise appear between hit-testing and clicking.
  await readAvailableModels(app);
  await seed.evalIn(app, `(() => {
    const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (!(close instanceof HTMLElement)) throw new Error("Model picker close control unavailable");
    close.click();
  })()`);
  await waitFor(app, `!document.querySelector('[data-slot="dialog-overlay"]')`, {
    timeoutMs: 30_000,
    label: "model picker backdrop dismissed before sidebar interaction",
  });
  const rawServerInfo = await seed.evalIn(app, `window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo")`, {
    awaitPromise: true,
    timeoutMs: 30_000,
  });
  if (!isRecord(rawServerInfo) || typeof rawServerInfo.baseUrl !== "string") {
    throw new Error(`OpenWork server info was unavailable: ${JSON.stringify(rawServerInfo)}`);
  }
  const serverUrl = new URL(rawServerInfo.baseUrl);
  const serverToken = typeof rawServerInfo.ownerToken === "string"
    ? rawServerInfo.ownerToken
    : typeof rawServerInfo.clientToken === "string"
      ? rawServerInfo.clientToken
      : "";
  if (!serverToken) throw new Error("OpenWork server info did not include a token.");
  let externalServerUrl = serverUrl.origin;
  if (app.handle.hostKind === "daytona") {
    const sandboxId = app.handle.sandboxId?.trim();
    if (!sandboxId) throw new Error("Daytona desktop did not expose its sandbox id.");
    await using previewHost = daytonaSandbox(sandboxId);
    if (!previewHost.previewUrl) throw new Error("Daytona host cannot expose the OpenWork server port.");
    externalServerUrl = await previewHost.previewUrl(Number(serverUrl.port));
  }
  return {
    app,
    home,
    other,
    homePath,
    engine: resolveEvalEngine(),
    async observeWorkspaceEvents(workspaceId: string) {
      const abort = new AbortController();
      const url = new URL(`${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/event`);
      // A client-supplied location must not override its authenticated mount.
      url.searchParams.set("location[directory]", workspaceId === home.workspaceId ? otherPath : homePath);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`Workspace event stream returned ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      let failure: unknown;
      const finished = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          if (!abort.signal.aborted) failure = error;
        }
      })();
      return {
        snapshot() {
          if (failure) throw failure;
          return received;
        },
        async [Symbol.asyncDispose]() {
          abort.abort();
          await reader.cancel().catch(() => undefined);
          await finished;
        },
      };
    },
    async submitAttributedMessage(workspaceId: string, sessionId: string, text: string, source?: Record<string, string>) {
      const response = await fetch(`${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ noReply: true, parts: [{ type: "text", text, ...(source ? { metadata: { openworkSource: source } } : {}) }] }),
      });
      if (!response.ok) throw new Error(`Message submission returned HTTP ${response.status}: ${await response.text()}`);
    },
    async serverSessionIds(workspaceId: string): Promise<string[]> {
      const response = await engineSessionProbe({ engine: resolveEvalEngine(), serverUrl: externalServerUrl, token: serverToken, workspaceId }).list();
      if (!response.ok) throw new Error(`Session list returned HTTP ${response.status}`);
      return response.data.map((session) => session.id);
    },
    /** The sidebar's own per-workspace session lists and load state. */
    // TODO(primitive): probe.route should expose the sidebar's per-workspace session lists.
    async route(): Promise<SidebarRouteFacts> {
      return parseSidebarRouteFacts(await seed.evalIn(app, `(() => {
        const route = window.__openwork?.slice?.("route");
        if (!route) return null;
        return {
          selectedWorkspaceId: String(route.selectedWorkspaceId ?? ""),
          workspaces: (route.workspaces ?? []).map((workspace) => ({
            id: String(workspace.id),
            name: String(workspace.displayNameResolved ?? ""),
            loading: Boolean(workspace.loading),
            error: typeof workspace.error === "string" ? workspace.error : null,
          })),
          sessionsByWorkspaceId: Object.fromEntries(Object.entries(route.sessionsByWorkspaceId ?? {}).map(([workspaceId, sessions]) => [
            workspaceId,
            (sessions ?? []).map((session) => ({ id: String(session?.id ?? ""), title: String(session?.title ?? "") })),
          ])),
        };
      })()`));
    },
    /**
     * Creates a session the way another client would: straight against the
     * OpenWork server's workspace mount, never through the desktop's UI state.
     */
    // TODO(primitive): seed.externalSession should create a session on the server without touching the renderer.
    async createSessionOutsideWindow(workspaceId: string, title: string, requestedDirectory?: string): Promise<string> {
      const directory = requestedDirectory ?? workspaceDirectories.get(workspaceId);
      if (!directory) throw new Error(`No directory is registered for workspace ${workspaceId}.`);
      const probe = engineSessionProbe({
        engine: resolveEvalEngine(),
        serverUrl: externalServerUrl,
        token: serverToken,
        workspaceId,
      });
      const findCreatedSession = async (): Promise<string | null> => {
        try {
          const response = await probe.list();
          return response.ok ? response.data.find((session) => session.title === title)?.id ?? null : null;
        } catch {
          return null;
        }
      };

      let lastError = "no response";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await findCreatedSession();
        if (existing) return existing;
        try {
          const response = await probe.create(directory, title);
          if (response.ok && response.data) return response.data.id;
          lastError = `HTTP ${response.status}: ${JSON.stringify(response.body)}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        // A timed-out POST may have committed before its response was lost.
        // Check by unique title before the next non-idempotent attempt.
        const created = await findCreatedSession();
        if (created) return created;
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1_000));
      }
      throw new Error(`Creating a session outside the window failed after 4 attempts: ${lastError}`);
    },
  };
}

export async function crossWorkspaceSessions(seed: Seed) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const app = await seed.desktop({ name: "cross-workspace-split-view" });
  const workspaceA = await seed.workspace(app, `/tmp/openwork-cross-workspace-split-${runId}-a`);
  const [primary, sameWorkspacePeer] = await seed.sessions(app, [
    `Primary workspace anchor ${runId}`,
    `Primary workspace peer ${runId}`,
  ]);
  const workspaceB = await additionalWorkspace(seed, app, `/tmp/openwork-cross-workspace-split-${runId}-b`);
  const [crossWorkspacePeer] = await seed.sessions(app, [`Secondary workspace peer ${runId}`]);
  if (!primary || !sameWorkspacePeer || !crossWorkspacePeer) throw new Error("Split world did not create all sessions.");
  return {
    app,
    workspaceA,
    workspaceB,
    primary: { ...primary, workspaceId: workspaceA.workspaceId },
    sameWorkspacePeer: { ...sameWorkspacePeer, workspaceId: workspaceA.workspaceId },
    crossWorkspacePeer: { ...crossWorkspacePeer, workspaceId: workspaceB.workspaceId },
  };
}

export async function settingsRuntime(seed: Seed) {
  const stamp = Date.now();
  const firstName = `openwork-session-settings-a-${stamp}`;
  const secondName = `openwork-session-settings-b-${stamp}`;
  const app = await seed.desktop({ name: "session-switch-settings-runtime" });
  const firstWorkspace = await seed.workspace(app, `/tmp/${firstName}`);
  const secondWorkspace = await additionalWorkspace(seed, app, `/tmp/${secondName}`);
  // TODO(primitive): seed.runtimeErrorCapture should install a scoped renderer error witness.
  await seed.evalIn(app, `(() => {
    window.__sessionSettingsRuntimeErrors = [];
    window.addEventListener("error", (event) => window.__sessionSettingsRuntimeErrors.push(String(event.error?.message ?? event.message ?? "window error")));
    window.addEventListener("unhandledrejection", (event) => window.__sessionSettingsRuntimeErrors.push(String(event.reason?.message ?? event.reason ?? "unhandled rejection")));
    return true;
  })()`);
  return { app, firstWorkspace, secondWorkspace, firstName, secondName };
}

export async function macSidebar(seed: Seed) {
  const world = await oneWorkspace(seed, "mac-sidebar-toggle-clearance", ["Mac sidebar clearance"]);
  return world;
}

export async function rendererCrash(seed: Seed) {
  const app = await seed.desktop({ name: "desktop-renderer-crash-recovery" });
  return { app };
}

export async function renderCycle(seed: Seed, { place }: { place: import("@openwork/env").Place }) {
  // TODO(primitive): seed.desktop should accept environment overrides for instrumented renderer launches.
  const app = await launchDesktop({
    name: "desktop-render-cycle-stability",
    host: place.host(),
    env: { VITE_OPENWORK_PROFILER: "1" },
  });
  const workspacePath = seed.tmpPath("desktop-render-cycle");
  await mkdir(workspacePath, { recursive: true });
  // TODO(primitive): seed.storage should arrange persisted renderer preferences without raw evaluation.
  await seed.evalIn(app, `(() => {
    localStorage.setItem("openwork.debug.profilerOverlay", "1");
    location.reload();
    return true;
  })()`).catch(() => undefined);
  return {
    app,
    workspacePath,
    async [Symbol.asyncDispose]() {
      try {
        await app[Symbol.asyncDispose]();
      } finally {
        await rm(workspacePath, { recursive: true, force: true });
      }
    },
  };
}

export async function loadingIdle(seed: Seed) {
  const providerId = "session-loading-idle-mock";
  const modelId = "session-loading-idle-model";
  const reply = "session loading idle proof";
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      request.resume();
      request.on("end", () => setTimeout(() => streamReply(response, "chatcmpl-session-loading-idle", reply), 8_000));
      return;
    }
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const world = await oneWorkspace(seed, "session-loading-idle");
    await configureWorkspaceProvider(seed, world.app, [world.workspace.workspaceId], {
      providerId,
      modelId,
      modelName: "Session loading idle model",
      baseUrl,
    });
    const parking = await seed.session(world.app, { title: "Parking session" });
    const main = await seed.session(world.app, { title: "Main loading session" });
    return {
      ...world,
      parking,
      main,
      reply,
      renamedTitle: "Session loading stays idle",
      async [Symbol.asyncDispose]() {
        await closeServer(server);
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

export async function titleFailure(seed: Seed) {
  const providerId = "session-title-failure-mock";
  const modelId = "session-title-main-model";
  const inaccessibleTitleModelId = "session-title-inaccessible-model";
  const reply = "the conversation completes safely";
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        if (body.includes(`\"model\":\"${inaccessibleTitleModelId}\"`)) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "model is not accessible to this user" } }));
          return;
        }
        streamReply(response, "chatcmpl-session-title-failure", reply);
      });
      return;
    }
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const world = await oneWorkspace(seed, "session-title-failure-warning");
    await configureWorkspaceProvider(seed, world.app, [world.workspace.workspaceId], {
      providerId,
      modelId,
      modelName: "Session title main model",
      baseUrl,
      smallModel: `${providerId}/${inaccessibleTitleModelId}`,
    });
    const session = await seed.session(world.app);
    return {
      ...world,
      session,
      reply,
      warningTitle: "Automatic task title did not complete",
      warningBody: "Your conversation is safe.",
      async [Symbol.asyncDispose]() {
        await closeServer(server);
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

function stormMinutes(): number {
  const value = Number(process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES ?? "2");
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error("OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES must be a number from 1 through 5.");
  }
  return value;
}

function shellValue(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`Unsafe workload shell value: ${value}`);
  return value;
}

export async function activeSessionStorm(seed: Seed) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const slowToolMs = Math.round(stormMinutes() * 60_000);
  const plans = Array.from({ length: 3 }, (_, offset) => {
    const index = offset + 1;
    const path = `/tmp/openwork-active-session-storm-${runId}-w${index}`;
    const marker = `STORM-W${index}-${runId}`;
    return {
      index,
      path,
      filePath: `${path}/storm-output-w${index}.txt`,
      marker,
      slowMarker: `SLOW-${marker}`,
      easyMarker: `EASY-${marker}`,
      finalReply: `COMPLETE-${marker}`,
    };
  });
  const mock = seed.mock({
    agentWorkloads: plans.map((plan) => ({
      promptMarker: plan.marker,
      finalReply: plan.finalReply,
      steps: [
        { tool: "bash", arguments: { command: `printf '%s\\n' 'INITIAL-${shellValue(plan.marker)}' > '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Create workspace ${plan.index} output` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} initial output` } },
        { tool: "bash", arguments: { command: `sleep ${Math.ceil(slowToolMs / 1_000)} && printf '%s\\n' '${shellValue(plan.slowMarker)}' >> '${shellValue(plan.filePath)}'`, timeout: slowToolMs + 30_000, workdir: plan.path, description: `Hold workspace ${plan.index} live` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} slow output` } },
        { tool: "bash", arguments: { command: `printf '%s\\n' '${shellValue(plan.easyMarker)}' >> '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Append workspace ${plan.index} easy marker` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} completed output` } },
      ],
    })),
  });
  const den = await seed.den({
    mocks: { agent: mock },
    org: {
      name: "Active Session Workspace Storm",
      admin: { name: "Storm Admin" },
      members: { member: { name: "Storm Member" } },
    },
  });
  const app = await seed.desktop({
    den,
    as: "member",
    profileDir: process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_PROFILE_DIR?.trim(),
  });
  const seededPlans: StormPlan[] = [];
  for (const plan of plans) {
    const workspace = seededPlans.length === 0
      ? await seed.workspace(app, plan.path)
      : await additionalWorkspace(seed, app, plan.path);
    const session = await seed.session(app, { title: `Active storm workspace ${plan.index}` });
    seededPlans.push({ ...plan, ...workspace, ...session });
  }
  await configureWorkspaceProvider(seed, app, seededPlans.map((plan) => plan.workspaceId), {
    providerId: stormProviderId,
    modelId: stormModelId,
    modelName: "Active session storm model",
    baseUrl: `${den.mocks.agent.url}/v1`,
    allowTools: true,
  });
  await seed.evalIn(app, "location.reload(); true").catch(() => undefined);
  const reloadDeadline = Date.now() + 60_000;
  while (Date.now() < reloadDeadline) {
    const ready = await seed.evalIn(app, `Boolean(window.__openworkControl)
      && Boolean((localStorage.getItem("openwork.den.authToken") ?? "").trim())`)
      .catch(() => false);
    if (ready === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    app,
    den,
    mock: den.mocks.agent,
    plans: seededPlans,
    slowToolMs,
    routeStormMs: Math.min(60_000, Math.max(35_000, slowToolMs - 25_000)),
  };
}

export async function workspaceOrder(seed: Seed) {
  const profileDir = seed.tmpPath("workspace-sidebar-order-profile");
  const seededApp = await seed.desktop({ name: "workspace-order-seed", profileDir });
  const seededWorkspaceIds: string[] = [];
  for (const label of ["alpha", "beta", "gamma"]) {
    const workspace = seededWorkspaceIds.length === 0
      ? await seed.workspace(seededApp, `${profileDir}/${label}`)
      : await additionalWorkspace(seed, seededApp, `${profileDir}/${label}`);
    seededWorkspaceIds.push(workspace.workspaceId);
  }
  await seededApp[Symbol.asyncDispose]();
  const app = await seed.desktop({ name: "workspace-sidebar-order", profileDir });
  return { app, profileDir, seededWorkspaceIds };
}
