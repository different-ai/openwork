import { browserScript, listTargets } from "@openwork/cdp";
import { createServer } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine } from "@openwork/env";
import { SkipError } from "@openwork/env";
import type { EvalEngine, Place, Seed } from "@openwork/env";
import { evalIn, go, waitFor as waitForBehavior } from "@openwork/behaviors";
import { allocateFreePort } from "@openwork/cdp";
import { checkedExec, chrome, daytonaSandbox, defaultDaytonaExec, deleteSandboxes, desktop, localHost, provisionDesktopSandbox } from "@openwork/hosts";
import { startEgressLab, startMockMcp } from "@openwork/labs";
import { diagnoseEgressLabProduct } from "@openwork/behaviors";
import { configureProvider } from "./chat.ts";
import { sessionlessTransition } from "./sessionless-transition.ts";
import { close, listen, readBody, sendJson, sendMockError } from "./openwork-server-cli.ts";
import { matchVerdictExpectations } from "@openwork/matchers";
import { assignPluginToMarketplace, createMarketplace, createPluginWithSkill, grantMarketplaceAccess, readResolvedMarketplace } from "@openwork/behaviors";

// Transitional helpers for journeys whose product-specific mechanics do not yet
// have spec primitives. Specs still import through their owned world module.
export {
  control,
  enabledButtons,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  visibleText,
  waitFor,
} from "@openwork/behaviors";
export {
  checkedExec,
  chrome,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  enterpriseTlsEdgeDaytonaCommands,
  provisionDesktopSandbox,
} from "@openwork/hosts";

export async function emptyInfraWorld(_seed: Seed) {
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function appSmokeWorld(seed: Seed) {
  const packaged = Boolean(process.env.OPENWORK_EVAL_ELECTRON_BINARY);
  const app = packaged
    ? await desktop({ name: "app-smoke", prepareSharedResources: false, timeoutMs: 60_000,
      env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" } })
    : await seed.desktop({ name: "app-smoke" });
  const workspace = packaged ? null : await seed.workspace(app, seed.tmpPath("app-smoke"));
  return {
    app, workspace, packaged,
    async packagedRuntime() {
      return evalIn(app, async () => {
        const bridge = window.__OPENWORK_ELECTRON__;
        if (typeof bridge?.invokeDesktop !== "function") return { bridge: false };
        const info = await bridge.invokeDesktop("openworkServerInfo");
        const health = await fetch(info.baseUrl + "/health", { signal: AbortSignal.timeout(5000) });
        return { bridge: true, protocol: location.protocol, health: health.status,
          emptySession: /^#\/workspace\/[^/]+\/session$/.test(location.hash)
            && Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')),
          signedOut: !localStorage.getItem("openwork.den.authToken") && !localStorage.getItem("openwork.den.activeOrgId"),
          onboarding: /Welcome to OpenWork|Power your first task|How did you hear about OpenWork\?/.test(document.body.innerText),
          crash: /Something went wrong|Cannot find module|Maximum update depth exceeded/.test(document.body.innerText) };
      }, { awaitPromise: true });
    },
    async packagedToolIds() {
      return evalIn(app, async () => {
        const workspaces = await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap");
        const workspace = workspaces.workspaces.find((entry) => entry.id === workspaces.selectedId);
        if (workspaces.workspaces.length !== 1 || !workspace?.path?.endsWith("OpenWork Chat")) {
          throw new Error("Packaged startup did not select its default chat workspace.");
        }
        const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
        const headers = { Authorization: "Bearer " + info.ownerToken, "Content-Type": "application/json" };
        const tools = await fetch(info.baseUrl + "/workspace/" + workspace.id + "/opencode/experimental/tool/ids", {
          headers, signal: AbortSignal.timeout(30000),
        });
        if (!tools.ok) throw new Error("Engine tool discovery failed: " + tools.status);
        return tools.json();
      }, { awaitPromise: true, timeoutMs: 60_000 });
    },
    async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
  };
}

export async function localFirstRunWorld(seed: Seed) {
  const prompt = "Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.";
  const reply = "Your workspace is ready. You can draft a document next.";
  const den = await seed.den({
    provision: false,
    mocks: { starter: seed.mock({ agentWorkloads: [{ promptMarker: prompt, finalReply: reply, steps: [] }] }) },
  });
  const mock = den.mocks.starter;
  // Only replace the provider transport. Do not seed a workspace, session,
  // sign-in, onboarding preference, or selected model: the app must supply them.
  const app = await seed.desktop({
    name: "first-run-local",
    signIn: false,
    env: {
      DAYTONA_SECRETS_ENV: "/tmp/openwork-first-run-no-secrets",
      OPENWORK_DESKTOP_DISTRIBUTION: "public",
      OPENWORK_EVAL_MODEL: "",
      VITE_DISABLE_OPENWORK_MODELS: "0",
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ["opencode"],
        small_model: "opencode/big-pickle",
        provider: {
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${mock.url}/v1`, apiKey: "sk-eval-fixture" },
            whitelist: ["big-pickle"],
            models: {
              "big-pickle": {
                name: "Big Pickle",
                provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
              },
            },
          },
        },
      }),
    },
  });
  return { app, mock, prompt, reply };
}

/**
 * The app in headless Chrome with one workspace. Pass `surface: "electron"`
 * only when the claim needs the desktop shell (native menus, the bridge).
 */
export async function workspaceWorld(seed: Seed, options: { surface?: "electron" | "web" } = {}) {
  const workspacePath = seed.tmpPath("workspace-spec");
  const app = options.surface === "electron"
    ? await seed.desktop({ name: "workspace-spec" })
    : await seed.appWeb({ name: "workspace-spec", workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  return { app, workspace, workspacePath };
}

export async function sessionWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const session = await seed.session(base.app);
  return { ...base, session };
}

/**
 * A workspace with a mock model and NO session: the person lands on the
 * sessionless New task route and the first Run task must create the session
 * and deliver the prompt through whichever engine (v1 or v2) is selected.
 */
export async function sessionlessFirstSendWorld(seed: Seed, options: { engine?: EvalEngine } = {}) {
  return sessionlessFirstSend(seed, { ...options, mobileLayout: false });
}

async function sessionlessFirstSend(seed: Seed, options: { engine?: EvalEngine; mobileLayout: boolean }) {
  const engine = options.engine ?? resolveEvalEngine();
  const providerId = "first-send-mock";
  const modelId = "first-send-model";
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const prompt = `Summarize this workspace in one sentence. FIRST-SEND-${nonce}`;
  const reply = options.mobileLayout
    ? Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 1}: This is a deterministic response for checking conversation layout and reading position.`).join("\n\n")
    : `Workspace summary finished ${nonce}.`;
  const followupPrompt = `Give me a short follow-up. MOBILE-FOLLOWUP-${nonce}`;
  const followupReply = `Follow-up complete ${nonce}.`;
  const mockBoot = seed.mock({
    isolatedProcessEnv: true,
    agentWorkloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] },
      { promptMarker: followupPrompt, latestUserTurn: true, finalReply: followupReply, steps: [] },
    ],
  });
  const workspacePath = seed.tmpPath("sessionless-first-send");
  const app = await seed.appWeb({ name: "sessionless-first-send", workspacePath, engine, headless: true, mocks: { agent: mockBoot } });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing first-send model witness");
  const workspace = await seed.workspace(app, workspacePath);
  const documentStartedAt = await evalIn(app, () => performance.timeOrigin);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "First send mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-first-send" },
        models: { [modelId]: { name: "First send model" } },
      },
    },
  }, engine);
  await waitForBehavior(app, browserScript((startedAt) => performance.timeOrigin !== startedAt
    && Boolean(window.__openworkControl), [documentStartedAt]), {
    timeoutMs: 60_000, label: "provider-configured replacement document mounted",
  });
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}`;
  return {
    app,
    workspace,
    workspacePath,
    engine,
    prompt,
    reply,
    followupPrompt,
    followupReply,
    transition: (evidenceDirectory: string) => sessionlessTransition(seed, app, workspace.workspaceId, engine, evidenceDirectory),
    route: () => seed.evalIn(app, () => location.hash || `#${location.pathname}`),
    recovery: () => seed.evalIn(app, () => {
      const restore = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Clear the current draft to restore the unsent message"));
      return {
        error: document.querySelector('[role="alert"]')?.textContent ?? "",
        starting: Boolean(document.querySelector('[data-loading-message="starting"]')),
        restoreVisible: Boolean(restore), restoreDisabled: restore?.disabled ?? false,
      };
    }),
    requests: async () => (await mock.agentRequests({ promptMarker: prompt })).filter((request) => request.kind === "final"),
    readNative: (path: string) => seed.evalIn(app, browserScript(async (path) => {
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + path, {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    }, [path]), { awaitPromise: true, timeoutMs: 20_000 }),
    sessionlessRoute: `#/workspace/${workspace.workspaceId}/session`,
    /** Engine-native message list for one session, on the selected engine's mount. */
    messagesPath: (sessionId: string) => engine === "v2"
      ? `${mount}/opencode2/api/session/${encodeURIComponent(sessionId)}/message`
      : `${mount}/opencode/session/${encodeURIComponent(sessionId)}/message`,
    /** Engine-native session list on the selected engine's mount. */
    sessionsPath: engine === "v2" ? `${mount}/opencode2/api/session` : `${mount}/opencode/session?limit=100`,
    openNewTask: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}

export async function mobileChatInteractionWorld(seed: Seed, options: { engine?: EvalEngine } = {}) {
  return sessionlessFirstSend(seed, { ...options, mobileLayout: true });
}

export async function parentChildPermissionWorld(seed: Seed) {
  const base = await sessionWorld(seed);
  // TODO(primitive): seed a child-session permission request and parent activity row.
  const seeded = await seed.evalIn(base.app, async () => {
    const child = await window.__openworkControl.execute("eval.child_permission.seed", null);
    if (!child?.ok || !child.result || typeof child.result !== "object" || !("childSessionId" in child.result) || typeof child.result.childSessionId !== "string") return { child, activity: null };
    const activity = await window.__openworkControl.execute("eval.task_activity.seed", {
      childSessionId: child.result.childSessionId,
    });
    return { child, activity };
  }, { awaitPromise: true });
  if (!isRecord(seeded) || !isRecord(seeded.child) || seeded.child.ok !== true
    || !isRecord(seeded.activity) || seeded.activity.ok !== true) {
    throw new Error(`Child permission seed failed: ${JSON.stringify(seeded)}`);
  }
  return base;
}

export async function parentChildHeldToolWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("The held MCP response witness needs local placement (--local).");
  const engine = resolveEvalEngine();
  const providerId = "descendant-mock";
  const modelId = "descendant-model";
  const delegationTool = engine === "v2" ? "subagent" : "task";
  const toolName = "descendant_hold";
  const marker = `descendant-${Date.now()}-${process.pid}`;
  const prompt = "Delegate preparing an isolated investigation, then confirm it is ready.";
  const childPrompt = "Prepare the isolated investigation.";
  const followup = "Run the held investigation tool, then report its result.";
  const reply = "The delegated investigation is ready.";
  const toolReply = `Investigation released ${marker}.`;
  await using setup = new AsyncDisposableStack();
  const mock = setup.use(await startMockMcp({
    port: await allocateFreePort(), isolatedProcessEnv: true, allowUnauthenticatedMcp: true,
    tools: [{ name: "hold", description: "Run the held investigation", inputSchema: {
      type: "object", properties: { marker: { type: "string" } }, required: ["marker"],
    }, result: { content: [{ type: "text", text: toolReply }] } }],
    agentWorkloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [{ tool: delegationTool, arguments: {
        description: "Prepare isolated investigation", prompt: childPrompt,
        ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
      } }] },
      { promptMarker: childPrompt, latestUserTurn: true, finalReply: "Investigation prepared.", steps: [] },
      { promptMarker: followup, latestUserTurn: true, finalReply: toolReply, finalReplyFrom: "last-tool-text",
        steps: [{ tool: toolName, arguments: { marker } }] },
    ],
  }));
  const gate = Promise.withResolvers<void>();
  const state = { held: 0, released: false, timedOut: false, delivered: 0 };
  const release = () => { state.released = true; gate.resolve(); };
  const proxy = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") return sendJson(response, 405, {});
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      const held = isRecord(body) && body.method === "tools/call" && isRecord(body.params)
        && body.params.name === "hold" && isRecord(body.params.arguments) && body.params.arguments.marker === marker;
      const upstream = await fetch(mock.mcpUrl, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: raw, signal: AbortSignal.timeout(15_000),
      });
      const text = await upstream.text();
      if (held) {
        state.held += 1;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([gate.promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              state.timedOut = true;
              reject(new Error("Descendant MCP response was not explicitly released"));
            }, 90_000);
          })]);
        } finally { clearTimeout(timer); }
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(text);
      if (held) state.delivered += 1;
    } catch (error) { sendMockError(response, error); }
  });
  const mcpUrl = await listen(proxy);
  setup.defer(async () => { release(); await close(proxy); });
  const workspacePath = seed.tmpPath("descendant-held-tool");
  const app = await seed.appWeb({ name: "descendant-held-tool", workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { task: "allow", "descendant_*": "allow" },
    mcp: { descendant: { type: "remote", url: mcpUrl, enabled: true, oauth: false, timeout: 120_000 } },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Descendant mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-descendant-fixture" },
      models: { [modelId]: { name: "Descendant model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Idle parent with delegated work" });
  const resources = setup.move();
  return {
    app, workspace, session, engine, delegationTool, toolName, marker, prompt, followup, reply, toolReply, mock,
    mount: `/workspace/${encodeURIComponent(workspace.workspaceId)}/${engine === "v2" ? "opencode2/api" : "opencode"}`,
    promptBody: engine === "v2" ? { text: followup }
      : { model: { providerID: providerId, modelID: modelId }, parts: [{ type: "text", text: followup }] },
    heldTool: () => ({ ...state }), release,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

export async function scopedPermissionRefreshWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const sessions = await seed.sessions(base.app, Array.from({ length: 8 }, (_, index) => `Permission scope ${index}`));
  const [unrelated, selected] = sessions;
  if (!unrelated || !selected) throw new Error("Permission scope sessions were not created");
  const engine = resolveEvalEngine();
  const prefix = `/workspace/${encodeURIComponent(base.workspace.workspaceId)}/${engine === "v2" ? "opencode2" : "opencode"}`;
  const debuggerUrl = base.app.client.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("Permission witness needs the app's CDP endpoint");
  const socket = new WebSocket(debuggerUrl);
  const ready = Promise.withResolvers<void>();
  const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const reads: { sessionId: string; networkId: string; calibration: boolean; held: boolean }[] = [];
  const finished = new Set<string>();
  let nextId = 1;
  let failure: Error | undefined;
  const command = async (method: string, params = {}) => {
    const id = nextId++;
    const result = Promise.withResolvers<void>();
    commands.set(id, result);
    const timeout = setTimeout(() => result.reject(new Error(`Permission witness timed out: ${method}`)), 15_000);
    try {
      socket.send(JSON.stringify({ id, method, params }));
      await result.promise;
    } finally {
      clearTimeout(timeout);
      commands.delete(id);
    }
  };
  const readyTimeout = setTimeout(() => ready.reject(new Error("Permission witness did not connect")), 15_000);
  socket.addEventListener("open", () => ready.resolve());
  socket.addEventListener("error", () => {
    failure = new Error("Permission witness connection failed");
    ready.reject(failure);
  });
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = commands.get(message.id);
      if (message.error) pending?.reject(new Error("Permission witness command failed"));
      else pending?.resolve();
    }
    const params = message.params;
    if (!isRecord(params)) return;
    if (message.method === "Network.loadingFinished" && typeof params.requestId === "string") finished.add(params.requestId);
    if (message.method !== "Fetch.requestPaused" || typeof params.requestId !== "string") return;
    const request = params.request;
    if (!isRecord(request) || typeof request.url !== "string") return;
    const url = new URL(request.url);
    const match = url.pathname.slice(prefix.length).match(/^\/api\/session\/([^/]+)\/permission$/);
    const sessionId = match?.[1] ? decodeURIComponent(match[1]) : "";
    if (request.method === "GET" && sessionId && typeof params.networkId === "string") {
      // Hold every read of one unrelated root, not just a single lucky request.
      // The calibration proves the fault is active without relying on timing.
      const held = sessionId === unrelated.sessionId;
      reads.push({ sessionId, networkId: params.networkId, calibration: url.searchParams.has("scope-calibration"), held });
      if (held) return;
    }
    void command("Fetch.continueRequest", { requestId: params.requestId }).catch((error: Error) => { failure = error; });
  });
  const dispose = async () => {
    clearTimeout(readyTimeout);
    try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
    finally { socket.close(); }
  };
  try {
    await ready.promise;
    clearTimeout(readyTimeout);
    await command("Network.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: `*${prefix}/api/session/*/permission*`, requestStage: "Request" }] });
    await seed.evalIn(base.app, browserScript(async (path) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      void fetch(base + path, {
        headers: { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}` }, signal: AbortSignal.timeout(120_000),
      }).catch(() => undefined);
    }, [`${prefix}/api/session/${encodeURIComponent(unrelated.sessionId)}/permission?scope-calibration=1`]), { awaitPromise: true });
    return {
      ...base, selected, unrelated, engine,
      permissionReads() {
        if (failure) throw failure;
        return reads.map((read) => ({ sessionId: read.sessionId, calibration: read.calibration, held: read.held, completed: finished.has(read.networkId) }));
      },
      async [Symbol.asyncDispose]() { await dispose(); },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** A one-page text-only PDF whose whole page is a link to `url`; the tall page covers the viewer's center at any zoom. */
function linkedPdf(url: string) {
  const text = "BT /F1 28 Tf 72 2300 Td (Open the release notes) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 2400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Link /Rect [0 0 612 2400] /Border [0 0 0] /A << /S /URI /URI (${url}) >> >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function artifactCodeBrowserWorld(seed: Seed) {
  const tableMarkdown = [
    "# Table interactions",
    "",
    "| Name | Details |",
    "| --- | --- |",
    "| First row | [Documentation](https://example.com/docs) |",
    `| Second row | ${"wide-column-".repeat(40)} |`,
    "",
    "After the table",
  ].join("\n");
  const pdfLinkUrl = "https://example.com/openwork-pdf-link";
  // Asserts the native Electron context menu and the desktop PDF viewer, which a browser does not have.
  const base = await workspaceWorld(seed, { surface: "electron" });
  const [session] = await seed.sessions(base.app, ["Artifact code browser proof"]);
  if (!session) throw new Error("Could not seed the artifact code browser session.");
  await go(base.app, `/workspace/${base.workspace.workspaceId}/session/${session.sessionId}`);
  // TODO(primitive): write workspace files through the local server fixture.
  const wrote = await seed.evalIn(base.app, browserScript(async (workspaceId, tableMarkdown, linkedPdfContent) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return false;
    const write = (path: string, content: string) => fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, baseUpdatedAt: null }),
      },
    );
    const responses = await Promise.all([
      write("restricted/hidden-proof.ts", "export const restricted = true;"),
      write("src/openwork-artifact-proof.ts", "export const artifactEditor = true;\n"),
      write("config/openwork-artifact-settings.json", "{\"artifactEditor\":true}\n"),
      write("docs/table-interactions.md", tableMarkdown),
      fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/raw", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "docs/release-notes.pdf", dataBase64: btoa(linkedPdfContent), baseUpdatedAt: null }),
      }),
    ]);
    return responses.every((response) => response.ok);
  }, [base.workspace.workspaceId, tableMarkdown, linkedPdf(pdfLinkUrl)]), { awaitPromise: true });
  if (wrote !== true) throw new Error("Could not seed artifact code files.");
  await waitForBehavior(
    base.app,
    () => window.__openworkControl.listActions().some((action) => action.id === "eval.markdown_primitive.seed_chat" && !action.disabled),
    { timeoutMs: 30_000, label: "chat markdown seed action enabled" },
  );
  const fileLinkPath = `${base.workspacePath}/docs/Unlisted Report.pdf`;
  const fileLinkMarkdown = `[Unlisted report](file://${encodeURI(fileLinkPath)}) and [Relative report](docs/Unlisted-Relative.pdf)`;
  const chat = await seed.evalIn(base.app, browserScript((text) => window.__openworkControl.execute("eval.markdown_primitive.seed_chat", { text }), [fileLinkMarkdown]), { awaitPromise: true });
  if (!isRecord(chat) || chat.ok !== true) throw new Error("Could not seed chat file links.");
  // TODO(primitive): open an initial built-in browser artifact tab.
  await seed.evalIn(base.app, () => (window.__openworkControl.execute("browser.open_url", { url: "about:blank" })), { awaitPromise: true });
  await waitForBehavior(
    base.app,
    () => (window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)),
    { timeoutMs: 30_000, label: "artifact seed action enabled" },
  );
  // TODO(primitive): seed artifact tabs through a first-class artifact fixture.
  const tabs = await seed.evalIn(base.app, () => (window.__openworkControl.execute("eval.artifact_tabs.seed_overflow", { count: 12 })), { awaitPromise: true });
  if (!isRecord(tabs) || tabs.ok !== true) throw new Error(`Could not seed artifact tabs: ${JSON.stringify(tabs)}`);
  return {
    ...base,
    tableMarkdown,
    pdfLinkUrl,
    fileLinkPath,
    // Native Electron menus are OS widgets without DOM/CDP targets. Use the
    // existing development bridge to observe and dismiss the real popup.
    nativeMenu: () => seed.evalIn(base.app, () => window.__OPENWORK_ELECTRON__.contextMenu.inspect(), { awaitPromise: true }),
    dismissMenu: () => seed.evalIn(base.app, () => window.__OPENWORK_ELECTRON__.contextMenu.dismiss(), { awaitPromise: true }),
    // Pierre's token styles and render errors live inside its shadow root.
    async artifactCodePresentation() {
      return seed.evalIn(base.app, () => {
        const shadow = document.querySelector("[data-artifact-code-view] diffs-container")?.shadowRoot;
        const tokens = [...(shadow?.querySelectorAll("[data-line] span") ?? [])]
          .filter((node) => node.textContent?.trim() && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
        return {
          colors: [...new Set(tokens.map((node) => getComputedStyle(node).color))],
          error: shadow?.querySelector("[data-error-message]")?.textContent ?? null,
        };
      });
    },
    async visibleArtifactCode() {
      return seed.evalIn(base.app, () => {
        const root = document.querySelector<HTMLElement>("[data-artifact-code-view]");
        if (!root || root.getBoundingClientRect().height === 0) return "";
        const text = (node: Node): string => [...node.childNodes].map((child) =>
          child.nodeType === Node.TEXT_NODE ? child.textContent :
          child instanceof Element ? text(child.shadowRoot || child) : ""
        ).join("");
        return text(root);
      });
    },
    async setCatalogFolderRestricted(restricted: boolean) {
      const path = join(base.workspacePath, "restricted");
      const mode = restricted ? "000" : "700";
      const sandbox = base.app.handle.sandboxId;
      if (sandbox) {
        await checkedExec(defaultDaytonaExec, remoteCommand(sandbox, `chmod ${mode} ${shellQuote(path)}`), "set synthetic catalog folder permissions");
      } else {
        await chmod(path, restricted ? 0 : 0o700);
      }
    },
  };
}

const compatibleRecoveryCatalog = [
  { version: "2.4.0", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://releases.openwork.test/v2.4.0/OpenWork-darwin-arm64.dmg" } },
  { version: "2.3.1", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://releases.openwork.test/v2.3.1/OpenWork-darwin-arm64.dmg" } },
  { version: "2.3.0", channel: "stable", artifact: { platform: "linux", arch: "x64", distribution: "public", url: "https://incompatible.invalid/OpenWork.AppImage" } },
  { version: "2.2.9", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "enterprise", url: "https://wrong-flavor.invalid/OpenWork.dmg" } },
  { version: "2.2.8-beta.1", channel: "prerelease", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://prerelease.invalid/OpenWork.dmg" } },
];

/**
 * A desktop whose bootstrap fails fatally on a seeded profile. By default the
 * recovery list holds one verified and one unverified candidate; with
 * `catalog: true` it is a release catalog mixing compatible, wrong-platform,
 * wrong-flavor and prerelease builds for darwin-arm64-public.
 */
export async function reliableRecoveryWorld(_seed: Seed, { place }: { place: Place }, options: { catalog?: boolean } = {}) {
  const profileDir = `/tmp/openwork-reliable-recovery-${process.pid}-${Date.now()}`;
  const provisioned = place.kind === "daytona"
    ? await provisionDesktopSandbox({
        ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
        name: "reliable-app-recovery",
        reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      })
    : null;
  const host = provisioned ? daytonaSandbox(provisioned.sandbox) : localHost();
  const seeded = await desktop({ name: "recovery-profile-seed", host, profileDir });
  const names = await evalIn(seeded, browserScript((value) => (window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
    folderPath: value, name: "reliable-recovery-profile-marker"
  }).then((state) => state.workspaces.map((workspace) => workspace.displayName))), [`${profileDir}/continuity-workspace`]), { awaitPromise: true });
  if (!Array.isArray(names) || !names.includes("reliable-recovery-profile-marker")) throw new Error("Could not seed recovery profile.");
  await seeded.stop();
  const app = await desktop({
    name: "fatal-bootstrap-recovery",
    host,
    profileDir,
    timeoutMs: 30_000,
    env: {
      OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: "EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: dlopen(/private/tmp/runtime.node): invalid code signature",
      ...(options.catalog
        ? { OPENWORK_EVAL_RECOVERY_TARGET: "darwin-arm64-public", OPENWORK_EVAL_RECOVERY_RELEASES: JSON.stringify(compatibleRecoveryCatalog) }
        : { OPENWORK_EVAL_RECOVERY_CANDIDATES: JSON.stringify([
          { version: "1.8.2", verified: true, artifactUrl: "https://releases.openwork.test/v1.8.2/OpenWork-darwin-arm64.dmg" },
          { version: "1.8.1", verified: false, artifactUrl: "https://tampered.invalid/OpenWork.dmg" },
        ]) }),
    },
  });
  const snapshot = () => evalIn(app, () => (window.__openworkRecoveryControl.snapshot()), { awaitPromise: true });
  const workspaceNames = () => evalIn(
    app,
    () => (window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap").then((state) => state.workspaces.map((entry) => entry.displayName))),
    { awaitPromise: true },
  );
  return {
    app,
    snapshot,
    workspaceNames,
    async [Symbol.asyncDispose]() {
      await app.stop();
      if (provisioned) {
        await checkedExec(
          defaultDaytonaExec,
          ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
          `remove caller-owned recovery profile ${profileDir}`,
          { timeoutMs: 30_000 },
        );
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
      await host[Symbol.asyncDispose]();
      if (provisioned?.created) await deleteSandboxes([provisioned.sandbox]);
    },
  };
}

/**
 * A healthy desktop whose render tree is about to throw. The spec triggers the
 * throw through the dev-only `eval.app.render_throw` control action and reads
 * back what the recovery screen put on the clipboard.
 */
export async function renderCrashWorld(seed: Seed) {
  const app = await seed.desktop({ name: "render-crash" });
  return {
    app,
    readClipboard: () => seed.evalIn(app, () => (navigator.clipboard.readText()), { awaitPromise: true }),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function remoteCommand(sandbox: string, command: string): string[] {
  return ["exec", sandbox, "--", `bash -lc ${shellQuote(command)}`];
}

export async function appDenTlsFaultWorld(_seed: Seed, { place }: { place: Place }) {
  const edge = await startEgressLab({ profile: "intercept" });
  const app = await desktop({
    name: "den-tls-fault",
    host: place.host(),
    bootstrap: { baseUrl: edge.url, requireSignin: false },
  });
  const diagnose = async () => {
    const verdict = await diagnoseEgressLabProduct(edge);
    return { ...verdict, expectationMatched: matchVerdictExpectations(verdict.text, "intercept").ok };
  };
  return {
    app,
    diagnose,
    async [Symbol.asyncDispose]() {
      await app.stop();
      await edge[Symbol.asyncDispose]();
    },
  };
}

export async function firstRunCloudShareWorld(seed: Seed, { place }: { place: Place }) {
  const den = await seed.den({
    org: {
      name: "Acme",
      admin: { email: `first-run-cloud-admin-${Date.now()}@openwork.test`, name: "Alex" },
      members: { colleague: { email: `first-run-cloud-colleague-${Date.now()}@openwork.test`, name: "Jordan" } },
    },
  });
  const app = await desktop({
    name: "first-run-cloud-share",
    host: place.host(),
    bootstrap: { baseUrl: den.ref.webUrl, requireSignin: false },
  });
  const web = await seed.web({
    den,
    startPath: "/",
    headless: true,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  });
  const shareSkill = async () => {
    const stamp = Date.now();
    const skillName = `shared-standup-${stamp}`;
    const marketplace = await createMarketplace(den.admin, { name: `Team Marketplace ${stamp}` });
    const plugin = await createPluginWithSkill(den.admin, {
      name: `Standup Kit ${stamp}`,
      skillName,
      skillBody: "Summarise yesterday, today, and blockers in three short bullets.",
      marketplaceId: marketplace.id,
    });
    await assignPluginToMarketplace(den.admin, marketplace.id, plugin.id).catch(async (error: unknown) => {
      const resolved = await readResolvedMarketplace(den.admin, marketplace.id);
      if (!resolved.pluginNames.includes(plugin.name)) throw error;
    });
    await grantMarketplaceAccess(den.admin, marketplace.id, { orgWide: true });
    const visible = await readResolvedMarketplace(den.members.colleague, marketplace.id);
    return { plugin, skillName, visible };
  };
  return {
    app,
    web,
    den,
    shareSkill,
    async [Symbol.asyncDispose]() { await app.stop(); },
  };
}

function toolResultJson(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content.map((entry) => typeof entry.text === "string" ? entry.text : "").join("\n");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

export async function toolTesterWorld(seed: Seed) {
  const connectorBoot = seed.mock();
  const den = await seed.den({
    org: { name: `Tool Tester Eval ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: { connector: connectorBoot },
  });
  const connector = den.mocks.connector;
  const connection = await seed.orgConnection(den.admin, {
    name: `Tool Tester Probe ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const orgs = await seed.api(den.admin, "/v1/me/orgs");
  const organizations = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!orgId) throw new Error("Could not resolve the Tool Tester organization.");
  const tokenResult = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": orgId },
    body: JSON.stringify({}),
  });
  const mcpToken = isRecord(tokenResult.body) && typeof tokenResult.body.token === "string" ? tokenResult.body.token : "";
  if (!mcpToken.startsWith("ow_mcp_at_")) throw new Error("Could not mint the Tool Tester MCP token.");
  const web = await seed.web({
    den,
    signedInAs: "admin",
    startPath: `/dashboard/mcp-connections/${encodeURIComponent(connection.id)}`,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  let requestId = 0;
  const callTool = async (name: "search_capabilities" | "execute_capability", args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!data) throw new Error(`MCP tools/call returned no data frame: ${raw.slice(0, 500)}`);
    const frame: unknown = JSON.parse(data.slice(5));
    return isRecord(frame) ? frame.result : null;
  };
  const search = async () => {
    const result = await callTool("search_capabilities", { query: "mock echo", limit: 20 });
    const payload = toolResultJson(result);
    return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
  };
  return {
    web,
    den,
    connector,
    connection,
    toolTesterUrl: `${den.ref.webUrl}/dashboard/tool-tester?connectionId=${encodeURIComponent(connection.id)}`,
    search,
    execute: (schemaDigest: string, text: string) => callTool("execute_capability", {
      name: `mcp:${connection.id}:mock_echo`, schemaDigest, body: { text },
    }),
    /** Return to the connector page after the mock OAuth flow finishes. */
    async closeSignInTab(): Promise<void> {
      const targets = await listTargets(web.handle.cdpUrl);
      for (const target of targets) {
        if (target.type === "page" && target.id !== web.client.targetId
          && target.url.startsWith(`${den.ref.webUrl}/connect/oauth`)) {
          await web.client.send("Target.closeTarget", { targetId: target.id });
        }
      }
      await web.client.send("Page.bringToFront");
    },
    /** The Tool Tester link destination for this connection. */
    // TODO(primitive): read a visible link destination by test id.
    async testToolsHref(): Promise<string> {
      const value = await seed.evalIn(web, browserScript((connectionId) => document.querySelector<HTMLElement>('a[href*="/tool-tester?connectionId=' + encodeURIComponent(connectionId) + '"]')?.getAttribute("href") ?? "", [connection.id]));
      return typeof value === "string" ? value : "";
    },
    /** Whether Tool Tester appears in Manage rather than Settings. */
    // TODO(primitive): identify a nav item's containing sidebar group.
    async toolTesterSidebarPlacement(): Promise<{ inManage: boolean; inSettings: boolean }> {
      const value = await seed.evalIn(web, () => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="den-org-sidebar"]');
        const links = sidebar ? [...sidebar.querySelectorAll('a')] : [];
        const toolTester = links.find((link) => link.textContent?.trim() === "Tool Tester");
        const settings = links.find((link) => link.textContent?.trim() === "Settings");
        return {
          inManage: toolTester?.closest('[data-sidebar-section="manage"]') != null,
          inSettings: settings?.parentElement?.contains(toolTester ?? null) ?? false,
        };
      });
      if (!isRecord(value) || typeof value.inManage !== "boolean" || typeof value.inSettings !== "boolean") {
        throw new Error(`Expected Tool Tester sidebar placement booleans, received ${JSON.stringify(value)}.`);
      }
      return { inManage: value.inManage, inSettings: value.inSettings };
    },
    /** The current web location. */
    async location(): Promise<string> {
      const value = await seed.evalIn(web, () => (location.href));
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    /** The checked states of the arguments editor modes by label. */
    // TODO(primitive): assert selected and unselected radio state.
    async argumentsEditorModes(): Promise<Record<string, string | null>> {
      const value = await seed.evalIn(web, () => {
        const editor = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
        return Object.fromEntries(radios.map((radio) => [(radio.textContent ?? "").trim(), radio.getAttribute("aria-checked")]));
      });
      if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string" || entry === null)) {
        throw new Error(`Expected arguments editor modes, received ${JSON.stringify(value)}.`);
      }
      const modes: Record<string, string | null> = {};
      for (const [label, checked] of Object.entries(value)) {
        if (typeof checked === "string" || checked === null) modes[label] = checked;
      }
      return modes;
    },
    /** The selected Tool call inspection tab's label. */
    // TODO(primitive): assert the selected result tab state.
    async selectedInspectionTab(): Promise<string> {
      const value = await seed.evalIn(web, () => (document.querySelector<HTMLElement>('[aria-label="Tool call inspection"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""));
      return typeof value === "string" ? value : "";
    },
    /** The organization tools switch's checked state. */
    // TODO(primitive): assert a visible switch's checked state.
    async orgToolsSwitchChecked(): Promise<string | null> {
      const value = await seed.evalIn(web, () => (document.querySelector<HTMLElement>('[role="switch"][aria-label="Tools enabled for your organization"]')?.getAttribute("aria-checked")));
      return typeof value === "string" ? value : null;
    },
    /** The arguments editor's nested-schema fallback state. */
    // TODO(primitive): assert disabled and selected radio state.
    async argumentsEditorFallback(): Promise<{ formDisabled: boolean; jsonChecked: string }> {
      const value = await seed.evalIn(web, () => {
        const editor = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
        const form = radios.find((radio) => (radio.textContent ?? "").trim() === "Form");
        const json = radios.find((radio) => (radio.textContent ?? "").trim() === "JSON");
        return { formDisabled: form?.hasAttribute("disabled") ?? false, jsonChecked: json?.getAttribute("aria-checked") ?? "" };
      });
      if (!isRecord(value) || typeof value.formDisabled !== "boolean" || typeof value.jsonChecked !== "string") {
        throw new Error(`Expected arguments editor fallback state, received ${JSON.stringify(value)}.`);
      }
      return { formDisabled: value.formDisabled, jsonChecked: value.jsonChecked };
    },
    /** Whether the Run tool button is disabled. */
    // TODO(primitive): assert a visible button's disabled state.
    async runToolDisabled(): Promise<boolean> {
      return await seed.evalIn(web, () => ([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Run tool" && button.disabled))) === true;
    },
  };
}

declare global {
  interface Window {
    __backgroundUpdateInstallAttempts: number;
  }
}

export async function backgroundUpdateWorld(seed: Seed) {
  const app = await seed.desktop({ name: "background-update", signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("background-update"));
  await evalIn(app, async () => {
    const currentVersion = "0.18.0";
    const now = Date.now.bind(Date);
    const state: Window["__backgroundUpdateWitness"] = { checks: 0, downloads: 0, installs: 0, offset: 0, finishDownload: null, intervalCheck: null };
    window.__backgroundUpdateWitness = state;
    window.__backgroundUpdateInstallAttempts = 0;
    const schedule = window.setInterval.bind(window);
    // The browser timer returns a numeric handle; Node's merged ambient overload does not apply here.
    const browserWindow: Window = window;
    browserWindow.setInterval = (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15 * 60 * 1000 && typeof callback === "function") state.intervalCheck = () => callback(...args);
      return schedule(callback, delay, ...args);
    };
    Date.now = () => now() + state.offset;
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0", latestAppVersion: "9.9.9", publishedDesktopVersions: ["9.9.9"],
    });
    window.__openworkApplyDesktopConfig?.({});
    window.__openworkSetDesktopConfigRefreshResult?.({});
    // Like the main process, report which build is staged to checks that must preserve it.
    let stagedVersion: string | null = null;
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: "stable", currentVersion }),
      setChannel: async (channel) => ({ channel, currentVersion }),
      check: async (_channel?: string, _targetVersion?: string, options?: { preserveStaged?: boolean }) => {
        state.checks++;
        return {
          available: state.checks >= 4, channel: "stable", currentVersion, latestVersion: state.checks >= 4 ? "9.9.9" : currentVersion,
          ...(options?.preserveStaged ? { stagedVersion } : {}),
        };
      },
      download: async () => {
        state.downloads++;
        const attempt = state.downloads;
        stagedVersion = null;
        return new Promise((resolve, reject) => {
          state.finishDownload = () => {
            state.finishDownload = null;
            if (attempt === 1) resolve({ ok: false, reason: "Update native preparation failed." });
            else if (attempt === 2) reject(new Error("Update download connection failed."));
            else {
              stagedVersion = "9.9.9";
              resolve({ ok: true });
            }
          };
        });
      },
      // Witness renderer handling of bridge outcomes, not native installer behavior.
      installAndRestart: async () => {
        const attempt = ++window.__backgroundUpdateInstallAttempts;
        if (attempt === 1) return { ok: false, reason: "Update installer could not start." };
        if (attempt === 2) throw new Error("Update installer connection failed.");
        state.installs++;
        return { ok: true };
      },
      onDownloadProgress: () => () => {},
    };
    state.offset += 16 * 60 * 1000;
    window.dispatchEvent(new Event("focus"));
  }, { awaitPromise: true });
  return {
    app,
    snapshot: () => evalIn(app, () => {
      const { checks, downloads, installs } = window.__backgroundUpdateWitness;
      return {
        checks, downloads, installs, route: location.hash,
        installAttempts: window.__backgroundUpdateInstallAttempts,
        automaticChecksEnabled: localStorage.getItem("openwork.react.settings.update-auto-check") !== "0",
        updateInTitlebar: Boolean(document.querySelector<HTMLElement>('header [data-update-button]')),
        updateInSidebar: Boolean(document.querySelector<HTMLElement>('[data-sidebar="footer"] [data-update-button]')),
        sidebarName: document.querySelector<HTMLElement>('[data-sidebar-brand]')?.textContent?.trim() ?? null,
        customLogoLoaded: Boolean(document.querySelector<HTMLImageElement>('[data-testid="brand-logo"] img')?.naturalWidth),
      };
    }),
    setCustomBranding: () => evalIn(app, () => {
      const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="5" fill="#25262b"/><text x="12" y="22" font-family="sans-serif" font-size="18" fill="white">Studio</text></svg>');
      const config = { brandAppName: "Studio", brandLogoUrl: logo };
      window.__openworkApplyDesktopConfig(config);
      window.__openworkSetDesktopConfigRefreshResult(config);
    }),
    tickUpdateInterval: () => evalIn(app, () => {
      const state = window.__backgroundUpdateWitness;
      if (!state.intervalCheck) throw new Error("Update interval was not registered");
      state.offset += 15 * 60 * 1000;
      state.intervalCheck();
    }),
    finishDownload: () => evalIn(app, () => {
      const finish = window.__backgroundUpdateWitness.finishDownload;
      if (!finish) throw new Error("No update download is pending");
      finish();
    }),
    returnToApp: () => evalIn(app, () => {
      window.__backgroundUpdateWitness.offset += 16 * 60 * 1000;
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    }),
    openSettings: () => go(app, `/workspace/${workspace.workspaceId}/settings/updates`),
    openWorkspace: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}

/** A desktop signed in to a real Den whose organization pins allowed desktop
 * versions. The fake feed offers 9.9.9; the pin decides whether it installs. */
export async function savedUpdatePolicyWorld(seed: Seed) {
  const den = await seed.den({
    org: { name: `Update policy ${Date.now()}`, admin: { name: "Update Policy Admin" } },
  });
  const allowVersions = async (versions: string[]) => {
    const result = await seed.api(den.admin, "/v1/org", {
      method: "PATCH", body: JSON.stringify({ allowedDesktopVersions: versions }),
    });
    if (!result.response.ok) throw new Error(`Setting allowed desktop versions failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  };
  await allowVersions(["9.9.9"]);
  const app = await seed.desktop({ name: "revoked-update", den, as: "admin" });
  const workspace = await seed.workspace(app, seed.tmpPath("revoked-update"));
  await evalIn(app, async () => {
    // Report the real installed version: a different one would re-key the
    // background auto-check and start a second check beside the manual one.
    const { currentVersion } = await window.__OPENWORK_ELECTRON__.updater.getChannel();
    const state: Window["__backgroundUpdateWitness"] = { checks: 0, downloads: 0, installs: 0, offset: 0, finishDownload: null, intervalCheck: null };
    window.__backgroundUpdateWitness = state;
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0", latestAppVersion: "9.9.9", publishedDesktopVersions: ["9.9.9"],
    });
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: "stable", currentVersion }),
      setChannel: async (channel) => ({ channel, currentVersion }),
      check: async () => {
        state.checks++;
        return { available: true, channel: "stable", currentVersion, latestVersion: "9.9.9" };
      },
      download: async () => {
        state.downloads++;
        return { ok: true };
      },
      installAndRestart: async () => {
        state.installs++;
        return { ok: true };
      },
      onDownloadProgress: () => () => {},
    };
  }, { awaitPromise: true });
  return {
    app,
    den,
    allowVersions,
    snapshot: () => evalIn(app, () => {
      const { downloads, installs } = window.__backgroundUpdateWitness;
      const installButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Install & restart");
      return { downloads, installs, installEnabled: installButton != null && !installButton.disabled };
    }),
    openSettings: () => go(app, `/workspace/${workspace.workspaceId}/settings/updates`),
    openWorkspace: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}
