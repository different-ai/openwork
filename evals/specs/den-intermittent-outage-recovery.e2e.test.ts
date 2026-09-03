import { createServer, type ServerResponse } from "node:http";
import { expect } from "vitest";
import {
  control,
  createOrgConnection,
  evalIn,
  go,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  waitFor,
} from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  app,
  eventually,
  faultProxy,
  localMysqlIsRunning,
  mcpMock,
  needs,
  readConnectState,
  readDenClientState,
  server,
  test,
} from "@openwork/testkit";
import type { App, DesktopHandle, FaultProxy } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localMysqlRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const runnable = e2eTestsEnabled && (!localMysqlRequired || mysqlOpen);
const title = !e2eTestsEnabled
  ? "desktop intermittent Den connection loss skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localMysqlRequired && !mysqlOpen
    ? "desktop intermittent Den connection loss skipped — needs MySQL on 127.0.0.1:3306"
    : "desktop survives intermittent Den connection loss: engine stays up, health stays honest, Connect recovers";

const LOCAL_PROVIDER_ID = "den-outage-local-provider";
const LOCAL_MODEL_ID = "den-outage-local-model";
const LOCAL_RUN_MARKER = "DEN-OUTAGE-LOCAL-RUN-COMPLETE";
const OFFLINE_CONNECT_MARKER = "DEN-OUTAGE-OFFLINE-CONNECT";
const OFFLINE_FAILURE_MARKER = "DEN-OUTAGE-CONNECT-FAILED-OFFLINE";
const OFFLINE_FALSE_SUCCESS = "DEN-OUTAGE-CONNECT-SUCCEEDED";
const INTERRUPTED_TEXT = "The message was interrupted";

interface EngineIdentity {
  pid: number | null;
  baseUrl: string;
  lifecycleState: string;
}

interface SidebarState {
  runtimeState: string;
  connectState: string;
}

interface DiagnosticsState {
  reportText: string;
  overallText: string;
  overallFailed: boolean;
  firstFailure: string;
  running: boolean;
  errorText: string;
}

interface LocalRunProbe {
  disposes: Array<{ at: number }>;
  errors: Array<{ at: number; sessionID: string | null; name: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseLocalRunProbe(value: unknown): LocalRunProbe {
  if (!isRecord(value)) return { disposes: [], errors: [] };
  return {
    disposes: records(value.disposes).map((entry) => ({ at: typeof entry.at === "number" ? entry.at : 0 })),
    errors: records(value.errors).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : null,
      name: typeof entry.name === "string" ? entry.name : "",
      message: typeof entry.message === "string" ? entry.message : "",
    })),
  };
}

function newestSessionId(value: unknown): string {
  if (!Array.isArray(value) || !isRecord(value[0]) || typeof value[0].sessionId !== "string") {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0].sessionId;
}

function requestMessages(value: unknown): Record<string, unknown>[] {
  return isRecord(value) ? records(value.messages) : [];
}

function projectedTool(payload: Record<string, unknown>, predicate: (name: string) => boolean): string | null {
  for (const tool of records(payload.tools)) {
    const fn = isRecord(tool.function) ? tool.function : {};
    if (typeof fn.name === "string" && predicate(fn.name)) return fn.name;
  }
  return null;
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: `chatcmpl-den-outage-${Date.now()}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startLocalProvider(
  control: { offlineCapabilityName: string },
): Promise<AsyncDisposable & { baseUrl: string; offlineToolResults: string[] }> {
  const offlineToolResults: string[] = [];
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { rawBody += chunk; });
    request.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid JSON request body" } }));
        return;
      }
      const payload = isRecord(parsed) ? parsed : {};
      const messages = requestMessages(payload);
      const toolMessages = messages.filter((message) => message.role === "tool");
      if (rawBody.includes(LOCAL_RUN_MARKER)) {
        if (toolMessages.length === 0) {
          const bash = projectedTool(payload, (name) => name === "bash" || name.endsWith("_bash"));
          if (!bash) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "bash tool was not projected" } }));
            return;
          }
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({
              tool_calls: [{
                index: 0,
                id: "call_den_outage_sleep",
                type: "function",
                function: { name: bash, arguments: JSON.stringify({ command: "sleep 150 && echo den-outage-local-tool-done" }) },
              }],
            }),
            streamChunk({}, "tool_calls"),
          ]);
          return;
        }
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({ content: LOCAL_RUN_MARKER }),
          streamChunk({}, "stop"),
        ]);
        return;
      }
      if (rawBody.includes(OFFLINE_CONNECT_MARKER)) {
        if (toolMessages.length === 0) {
          const search = projectedTool(payload, (name) => name.endsWith("_search_capabilities"));
          if (!search) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "search_capabilities was not projected" } }));
            return;
          }
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({
              tool_calls: [{
                index: 0,
                id: "call_den_outage_search",
                type: "function",
                function: { name: search, arguments: JSON.stringify({ query: "mock echo", type: "mcp", limit: 5 }) },
              }],
            }),
            streamChunk({}, "tool_calls"),
          ]);
          return;
        }
        const toolResult = JSON.stringify(toolMessages.at(-1));
        const visiblyFailed = /isError.{0,20}true|needs_connection|503|failed|failure|offline|unavailable|timed out|refused|fetch failed|ECONN/i.test(toolResult);
        if (toolMessages.length === 1 && !visiblyFailed) {
          const execute = projectedTool(payload, (name) => name.endsWith("_execute_capability"));
          if (!execute || !control.offlineCapabilityName) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "execute_capability was not projected" } }));
            return;
          }
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({
              tool_calls: [{
                index: 0,
                id: "call_den_outage_execute",
                type: "function",
                function: {
                  name: execute,
                  arguments: JSON.stringify({
                    name: control.offlineCapabilityName,
                    body: { text: OFFLINE_CONNECT_MARKER },
                  }),
                },
              }],
            }),
            streamChunk({}, "tool_calls"),
          ]);
          return;
        }
        offlineToolResults.push(toolResult);
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({ content: visiblyFailed ? OFFLINE_FAILURE_MARKER : OFFLINE_FALSE_SUCCESS }),
          streamChunk({}, "stop"),
        ]);
        return;
      }
      sendStream(response, [streamChunk({ role: "assistant" }), streamChunk({ content: "ok" }), streamChunk({}, "stop")]);
    });
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Den outage provider did not bind a port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    offlineToolResults,
    async [Symbol.asyncDispose]() {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    },
  };
}

const assistantHasText = (text: string): string => `(() => [...document.querySelectorAll('[data-message-role="assistant"]')]
  .some((message) => (message.innerText ?? "").includes(${JSON.stringify(text)})))()`;

const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

const toolRunningExpression = (workspaceId: string, sessionId: string): string => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
    + "/opencode/session/" + encodeURIComponent(${JSON.stringify(sessionId)}) + "/message?limit=50", {
    headers: { Authorization: "Bearer " + token },
  });
  const payload = await response.json();
  return (Array.isArray(payload) ? payload : []).some((message) =>
    (Array.isArray(message?.parts) ? message.parts : []).some((part) =>
      part?.tool?.includes("bash") && (part.state?.status === "running" || part.state?.status === "pending")));
})()`;

async function readEngineIdentity(desktopApp: DesktopHandle): Promise<EngineIdentity> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("engineInfo");
    return {
      pid: typeof info?.pid === "number" ? info.pid : null,
      baseUrl: typeof info?.baseUrl === "string" ? info.baseUrl : "",
      lifecycleState: typeof info?.lifecycleState === "string" ? info.lifecycleState : "",
    };
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value)) throw new Error("engineInfo returned no identity snapshot");
  return {
    pid: typeof value.pid === "number" ? value.pid : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    lifecycleState: typeof value.lifecycleState === "string" ? value.lifecycleState : "",
  };
}

function sameEngine(actual: EngineIdentity, baseline: EngineIdentity): boolean {
  return actual.pid === baseline.pid
    && actual.baseUrl === baseline.baseUrl
    && actual.lifecycleState === "healthy";
}

async function waitForEngine(
  desktopApp: DesktopHandle,
  label: string,
  baseline?: EngineIdentity,
): Promise<EngineIdentity> {
  return eventually(() => readEngineIdentity(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label,
    until: (identity) => identity.baseUrl.length > 0
      && identity.lifecycleState === "healthy"
      && (baseline === undefined || sameEngine(identity, baseline)),
  });
}

async function readSidebarState(desktopApp: DesktopHandle): Promise<SidebarState> {
  const value = await evalIn(desktopApp, `(() => {
    const menu = document.querySelector('[data-testid="account-status-menu"]');
    return {
      runtimeState: menu?.getAttribute("data-runtime-state") ?? "",
      connectState: menu?.getAttribute("data-connect-state") ?? "",
    };
  })()`);
  if (!isRecord(value)) throw new Error("account status menu returned no state");
  return {
    runtimeState: typeof value.runtimeState === "string" ? value.runtimeState : "",
    connectState: typeof value.connectState === "string" ? value.connectState : "",
  };
}

async function readDiagnosticsState(desktopApp: DesktopHandle): Promise<DiagnosticsState> {
  const value = await evalIn(desktopApp, `(() => {
    const report = document.querySelector('[data-testid="agent-diagnostics-report"]');
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    const firstFailure = document.querySelector('[data-testid="agent-diagnostics-first-failure"]');
    const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
    const error = document.querySelector('[data-testid="agent-diagnostics-error"]');
    return {
      reportText: report?.textContent ?? "",
      overallText: overall?.textContent?.trim() ?? "",
      overallFailed: Boolean(overall?.querySelector(".text-red-11")),
      firstFailure: firstFailure?.textContent?.trim() ?? "",
      running: run instanceof HTMLButtonElement && run.disabled,
      errorText: error?.textContent?.trim() ?? "",
    };
  })()`);
  if (!isRecord(value)) throw new Error("agent diagnostics returned no report state");
  return {
    reportText: typeof value.reportText === "string" ? value.reportText : "",
    overallText: typeof value.overallText === "string" ? value.overallText : "",
    overallFailed: value.overallFailed === true,
    firstFailure: typeof value.firstFailure === "string" ? value.firstFailure : "",
    running: value.running === true,
    errorText: typeof value.errorText === "string" ? value.errorText : "",
  };
}

async function probeDenConnection(desktopApp: DesktopHandle, apiUrl: string): Promise<void> {
  await evalIn(desktopApp, `(async () => {
    const token = localStorage.getItem("openwork.den.authToken") ?? "";
    try {
      await fetch(${JSON.stringify(`${apiUrl}/v1/me/orgs`)}, {
        headers: { Authorization: "Bearer " + token },
      });
    } catch {}
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
}

async function runDiagnostics(desktopApp: DesktopHandle, label: string): Promise<DiagnosticsState> {
  const before = await readDiagnosticsState(desktopApp);
  // During the 503 storm a diagnostics run can occasionally fail outright and
  // render the error notice instead of a report; the claim is about a
  // completed live run, not first-click luck, so one bounded retry is allowed.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await waitFor(
      desktopApp,
      `(() => {
        const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
        return run instanceof HTMLButtonElement && !run.disabled;
      })()`,
      { timeoutMs: 120_000, label: `${label} run control (attempt ${attempt})` },
    );
    const clicked = await evalIn(desktopApp, `(() => {
      const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
      if (!(run instanceof HTMLButtonElement) || run.disabled) return false;
      run.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    try {
      return await eventually(() => readDiagnosticsState(desktopApp), {
        within: 120_000,
        intervalMs: 1_000,
        label: `${label} completed report (attempt ${attempt})`,
        until: (state) => !state.running
          && state.reportText.length > 0
          && state.reportText !== before.reportText,
      });
    } catch (error) {
      const lastState = await readDiagnosticsState(desktopApp);
      console.log(
        `[den-outage-spec] ${label} attempt ${attempt} produced no report; error notice: ${JSON.stringify(lastState.errorText)}`,
      );
      if (attempt === 2) throw error;
    }
  }
  throw new Error(`${label} produced no diagnostics report.`);
}

async function openDiagnostics(desktopApp: App): Promise<void> {
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/settings/debug`);
  await waitFor(
    desktopApp,
    `Boolean(document.querySelector('[data-testid="run-agent-diagnostics"]'))`,
    { timeoutMs: 120_000, label: "agent context diagnostics debug route" },
  );
}

async function openSession(desktopApp: App): Promise<void> {
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  await waitFor(
    desktopApp,
    `Boolean(document.querySelector('[data-testid="account-status-menu"]'))`,
    { timeoutMs: 120_000, label: "session account status menu" },
  );
}

async function revealDiagnosticsReport(desktopApp: DesktopHandle): Promise<void> {
  const found = await evalIn(desktopApp, `(() => {
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    overall?.scrollIntoView({ block: "start" });
    return Boolean(overall);
  })()`);
  expect(found).toBe(true);
  await waitFor(desktopApp, `(() => {
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    if (!overall) return false;
    const rect = overall.getBoundingClientRect();
    // Framed = the overall chip intersects the visible viewport at all; the
    // settings page scrolls an inner container behind a sticky header, so any
    // stricter offset predicate is unstable.
    return rect.bottom > 0 && rect.top < window.innerHeight;
  })()`, { timeoutMs: 15_000, label: "diagnostics report framed in viewport" });
}

async function waitForFaultedRequest(
  proxy: FaultProxy,
  since: number,
  label: string,
) {
  return eventually(
    async () => (await proxy.requestLog()).filter(
      (request) => request.faulted && request.status === 503 && request.at >= since,
    ),
    { within: 120_000, intervalMs: 5_000, label, until: (requests) => requests.length > 0 },
  );
}

async function waitForRecoveredRequest(
  proxy: FaultProxy,
  since: number,
  label: string,
) {
  return eventually(
    async () => (await proxy.requestLog()).filter(
      (request) => !request.faulted && request.status < 400 && request.at >= since,
    ),
    { within: 120_000, intervalMs: 5_000, label, until: (requests) => requests.length > 0 },
  );
}

test.skipIf(!runnable)(title, { timeout: 1_500_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" });

  const stamp = Date.now();
  const providerControl = { offlineCapabilityName: "" };
  await using localProvider = await startLocalProvider(providerControl);
  await using den = await server({
    place,
    mocks: { connector: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: {
      name: `Intermittent Outage ${stamp}`,
      admin: {
        email: `intermittent-outage-admin-${stamp}@openwork.test`,
        name: "Intermittent Outage Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await using connectorProxy = await faultProxy({
    webUrl: den.mocks.connector.url,
    apiUrl: den.mocks.connector.url,
  });
  const connection = await createOrgConnection(den.admin, {
    name: `Outage echo ${stamp}`,
    url: `${connectorProxy.ref.webUrl}/mcp`,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  providerControl.offlineCapabilityName = `mcp:${connection.id}:mock_echo`;
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  });
  await using desktopApp = await app({ den: { ...den, ref: proxy.ref }, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;
  const providerConfigured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const patch = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        opencode: {
          permission: { bash: "allow" },
          provider: {
            [${JSON.stringify(LOCAL_PROVIDER_ID)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Den outage local witness",
              options: { baseURL: ${JSON.stringify(localProvider.baseUrl)}, apiKey: "sk-den-outage-local" },
              models: { [${JSON.stringify(LOCAL_MODEL_ID)}]: { name: "Den outage local model" } },
            },
          },
        },
      }),
    });
    if (!patch.ok) return "patch:" + patch.status + ":" + (await patch.text()).slice(0, 300);
    const reload = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/engine/reload", {
      method: "POST",
      headers,
    });
    return reload.ok ? "ok" : "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(providerConfigured).toBe("ok");

  // Phase 0: establish a healthy signed-in baseline on the session route.
  console.log("[den-outage-spec] baseline start");
  const baselineDen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline Den authentication and organization",
    until: (state) => state.authTokenPresent && Boolean(state.activeOrgId),
  });
  expect(baselineDen.authTokenPresent).toBe(true);
  expect(baselineDen.activeOrgId).toBeTruthy();
  const orgId = baselineDen.activeOrgId;
  if (!orgId) throw new Error("The healthy baseline did not select an organization.");

  const baselineConnect = await eventually(() => readConnectState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline local Connect state",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  expect(baselineConnect).toMatchObject({ ok: true, connectEnabled: true });
  const baselineEngine = await waitForEngine(desktopApp, "baseline healthy engine identity");
  const baselineSidebar = await eventually(() => readSidebarState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline sidebar health",
    until: (state) => state.runtimeState !== "" && state.connectState === "ready",
  });
  expect(baselineSidebar.runtimeState).not.toBe("disconnected");
  evidence.recordAssertionEvidence(
    "The signed-in desktop began healthy without coupling Connect to the local engine",
    `Organization ${orgId}; Connect ok=${baselineConnect.ok}, enabled=${baselineConnect.connectEnabled}; engine=${JSON.stringify(baselineEngine)}; sidebar=${JSON.stringify(baselineSidebar)}.`,
    baselineDen.authTokenPresent
      && baselineConnect.ok
      && baselineConnect.connectEnabled === true
      && baselineEngine.lifecycleState === "healthy"
      && baselineSidebar.runtimeState !== "disconnected",
  );
  const baselineHealthyShot = await screenshot(desktopApp);
  const baselineHealthySeen = await validate(baselineHealthyShot, [
    "The desktop session surface is visibly rendered",
    "No application crash or disconnected local runtime screen is visible",
  ]);
  expect(baselineHealthySeen.ok, baselineHealthySeen.why).toBe(true);

  await evalIn(desktopApp, `localStorage.setItem("openwork.developerMode", "1"); true`);
  await openDiagnostics(desktopApp);
  const baselineDiagnostics = await runDiagnostics(desktopApp, "healthy baseline diagnostics");
  expect(baselineDiagnostics.overallFailed, JSON.stringify(baselineDiagnostics)).toBe(false);
  evidence.recordAssertionEvidence(
    "baseline diagnostics report no failed check",
    `Baseline diagnostics overall=${JSON.stringify(baselineDiagnostics.overallText)}, first failure=${JSON.stringify(baselineDiagnostics.firstFailure)}.`,
    !baselineDiagnostics.overallFailed,
  );
  await openSession(desktopApp);
  console.log("[den-outage-spec] baseline done");

  const authSamples = [baselineDen];
  const cycleWindows: Array<{ label: string; outageStart: number; recoveryStart: number; recoveryEnd: number }> = [];
  for (const label of ["A", "B"]) {
    await proxy.faults.status("/", 503, { times: 100_000 });
    const outageStart = Date.now();
    console.log(`[den-outage-spec] outage ${label} injected`);
    await probeDenConnection(desktopApp, proxy.ref.apiUrl);
    const outageWire = await waitForFaultedRequest(proxy, outageStart, `outage ${label} direct Den probe 503 request`);
    const outageEngine = await waitForEngine(desktopApp, `outage ${label} unchanged healthy engine`, baselineEngine);
    const outageConnectTransport = await eventually(() => readConnectState(desktopApp), {
      within: 120_000,
      intervalMs: 1_000,
      label: `outage ${label} local Connect transport`,
      until: (state) => state.ok,
    });
    const outageDen = await eventually(() => readDenClientState(desktopApp), {
      within: 120_000,
      intervalMs: 1_000,
      label: `outage ${label} retained authentication`,
      until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
    });
    authSamples.push(outageDen);
    const outageSidebar = await eventually(() => readSidebarState(desktopApp), {
      within: 15_000,
      intervalMs: 1_000,
      label: `outage ${label} unchanged sidebar runtime`,
      until: (state) => state.runtimeState.length > 0,
    });
    await openDiagnostics(desktopApp);
    const outageDiagnostics = await runDiagnostics(desktopApp, `outage ${label} diagnostics`);
    const outageReportedUnavailable = outageDiagnostics.reportText.includes("List failed")
      || outageDiagnostics.reportText.includes("Cloud unavailable");
    expect(outageWire.length).toBeGreaterThan(0);
    expect(outageEngine).toEqual(baselineEngine);
    expect(outageDen).toMatchObject({ authTokenPresent: true, activeOrgId: orgId });
    expect(outageSidebar.runtimeState).toBe(baselineSidebar.runtimeState);
    expect(outageReportedUnavailable, JSON.stringify(outageDiagnostics)).toBe(true);
    evidence.recordAssertionEvidence(
      `Outage ${label} is honest without restarting local work or destroying authentication`,
      `${outageWire.length} direct-probe faulted request(s); engine=${JSON.stringify(outageEngine)}; Connect transport ok=${outageConnectTransport.ok}; diagnostics reported Cloud unavailable=${outageDiagnostics.reportText.includes("Cloud unavailable")}; organization=${outageDen.activeOrgId}.`,
      sameEngine(outageEngine, baselineEngine)
        && outageConnectTransport.ok
        && outageDen.authTokenPresent
        && outageDen.activeOrgId === orgId
        && outageSidebar.runtimeState === baselineSidebar.runtimeState
        && outageReportedUnavailable,
    );
    if (label === "A") {
      await revealDiagnosticsReport(desktopApp);
      const shot = await screenshot(desktopApp);
      const seen = await validate(shot, [
        "The diagnostics report remains visibly rendered during the connection outage",
        "The report visibly shows a Warning overall status",
        "No application crash or disconnected local runtime screen is visible",
      ]);
      expect(seen.ok, seen.why).toBe(true);
    } else {
      await screenshot(desktopApp);
    }
    await openSession(desktopApp);

    await proxy.faults.clear();
    const recoveryStart = Date.now();
    console.log(`[den-outage-spec] recovery ${label} cleared`);
    await probeDenConnection(desktopApp, proxy.ref.apiUrl);
    const recoveryConnect = await eventually(() => readConnectState(desktopApp), {
      within: 120_000,
      intervalMs: 5_000,
      label: `recovery ${label} local Connect state`,
      until: (state) => state.ok && state.connectEnabled === true,
    });
    const recoveryDen = await eventually(() => readDenClientState(desktopApp), {
      within: 120_000,
      intervalMs: 1_000,
      label: `recovery ${label} retained authentication`,
      until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
    });
    authSamples.push(recoveryDen);
    const recoverySidebar = await eventually(() => readSidebarState(desktopApp), {
      within: 120_000,
      intervalMs: 5_000,
      label: `recovery ${label} sidebar ready`,
      until: (state) => state.connectState === "ready" && state.runtimeState !== "disconnected",
    });
    const recoveryWire = await waitForRecoveredRequest(proxy, recoveryStart, `recovery ${label} direct Den probe successful request`);
    await openDiagnostics(desktopApp);
    const recoveryDiagnostics = await runDiagnostics(desktopApp, `recovery ${label} diagnostics`);
    const diagnosticsMatch = !recoveryDiagnostics.overallFailed
      && recoveryDiagnostics.overallText === baselineDiagnostics.overallText
      && !recoveryDiagnostics.reportText.includes("List failed")
      && recoveryDiagnostics.firstFailure === baselineDiagnostics.firstFailure;
    expect(recoveryConnect).toMatchObject({ ok: true, connectEnabled: true });
    expect(recoveryDen).toMatchObject({ authTokenPresent: true, activeOrgId: orgId });
    expect(recoverySidebar.connectState).toBe("ready");
    expect(diagnosticsMatch, JSON.stringify(recoveryDiagnostics)).toBe(true);
    evidence.recordAssertionEvidence(
      `Connect recovers automatically after outage ${label} without re-authentication`,
      `${recoveryWire.length} diagnostics-triggered successful request(s); Connect=${JSON.stringify(recoveryConnect)}; sidebar=${JSON.stringify(recoverySidebar)}; diagnostics returned to ${JSON.stringify(baselineDiagnostics.overallText)}.`,
      recoveryWire.length > 0 && diagnosticsMatch && recoveryDen.activeOrgId === orgId,
    );
    if (label === "A") await screenshot(desktopApp);
    await openSession(desktopApp);
    cycleWindows.push({ label, outageStart, recoveryStart, recoveryEnd: Date.now() });
  }

  const shapedDenSession = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const token = localStorage.getItem("openwork.den.authToken") ?? "";
    const activeOrgId = localStorage.getItem("openwork.den.activeOrgId") ?? "";
    if (!info?.baseUrl || !info.hostToken || !token || !activeOrgId) return 0;
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/den-session", {
      method: "PUT",
      headers: { "x-openwork-host-token": String(info.hostToken), "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: ${JSON.stringify(proxy.ref.apiUrl)}, token, orgId: activeOrgId }),
    });
    return response.status;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(shapedDenSession).toBe(204);
  await eventually(() => readConnectState(desktopApp), {
    within: 60_000,
    label: "Connect re-armed through the shaped Den endpoint",
    until: (state) => state.ok && state.connectEnabled === true,
  });

  const availableModels = await readAvailableModels(desktopApp);
  expect(availableModels.some((model) => model.id === LOCAL_MODEL_ID && model.selectable)).toBe(true);
  await selectModel(desktopApp, LOCAL_MODEL_ID);
  expect(await evalIn(desktopApp, `(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return false;
    window.__denOutageRunProbe = { active: true, disposes: [], errors: [] };
    const record = (event) => {
      const probe = window.__denOutageRunProbe;
      const type = String(event?.type ?? "");
      if (type.includes("disposed")) probe.disposes.push({ at: Date.now() });
      if (type === "session.error") {
        const error = event?.properties?.error ?? {};
        probe.errors.push({
          at: Date.now(),
          sessionID: typeof event?.properties?.sessionID === "string" ? event.properties.sessionID : null,
          name: String(error?.name ?? ""),
          message: String(error?.data?.message ?? ""),
        });
      }
    };
    (async () => {
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/event", {
        headers: { Authorization: "Bearer " + token },
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (window.__denOutageRunProbe.active) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\\n\\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) for (const line of frame.split("\\n")) {
          if (!line.startsWith("data:")) continue;
          try { record(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    })();
    return true;
  })()`)).toBe(true);

  await control(desktopApp, "session.create_task");
  const localRunSessionId = newestSessionId(await control(desktopApp, "session.list_sessions"));
  const localRunStartedAt = Number(await evalIn(desktopApp, "Date.now()"));
  await sendComposerMessage(
    desktopApp,
    `Run a local bash sleep, wait for it, then reply with exactly ${LOCAL_RUN_MARKER}.`,
  );
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "local bash run became active" });
  await waitFor(desktopApp, toolRunningExpression(workspaceId, localRunSessionId), {
    awaitPromise: true,
    timeoutMs: 60_000,
    label: "local bash sleep is running",
  });

  await proxy.faults.status("/", 503, { times: 100_000 });
  await connectorProxy.faults.status("/", 503, { times: 100_000 });
  const localOutageStartedAt = Date.now();
  await probeDenConnection(desktopApp, proxy.ref.apiUrl);
  await control(desktopApp, "session.create_task");
  const offlineAttemptAt = new Date().toISOString();
  await sendComposerMessage(
    desktopApp,
    `Use search_capabilities to find mock_echo for ${OFFLINE_CONNECT_MARKER}; never claim ${OFFLINE_FALSE_SUCCESS} unless the tool succeeds.`,
  );
  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(OFFLINE_FAILURE_MARKER)})`, {
    timeoutMs: 90_000,
    label: "offline Connect failure became visible",
  });
  const localOutage = await eventually(async () => {
    const requests = await proxy.requestLog();
    return {
      elapsedMs: Date.now() - localOutageStartedAt,
      faults: requests.filter((request) => request.faulted && request.status === 503 && request.at >= localOutageStartedAt).length,
      runLive: (await evalIn(desktopApp, toolRunningExpression(workspaceId, localRunSessionId), {
        awaitPromise: true,
        timeoutMs: 15_000,
      })) === true,
    };
  }, {
    within: 120_000,
    intervalMs: 1_000,
    label: "offline Connect failure overlaps the local bash run",
    until: (state) => state.elapsedMs >= 30_000 && state.faults > 0 && state.runLive,
  });
  const offlineCalls = await den.mocks.connector.toolCalls({ name: "mock_echo", sinceIso: offlineAttemptAt });
  const connectorFaults = (await connectorProxy.requestLog()).filter((request) => request.faulted && request.status === 503);
  const falseSuccess = (await evalIn(desktopApp, assistantHasText(OFFLINE_FALSE_SUCCESS))) === true;
  expect(localProvider.offlineToolResults.some((result) => /isError.{0,20}true|needs_connection|503|failed|offline|unavailable|timed out|refused|fetch failed|ECONN/i.test(result))).toBe(true);
  expect(offlineCalls.filter((call) => String(call.args.text ?? "").includes(OFFLINE_CONNECT_MARKER))).toHaveLength(0);
  expect(connectorFaults.length).toBeGreaterThan(0);
  expect(falseSuccess).toBe(false);
  expect(localOutage.runLive).toBe(true);
  evidence.recordAssertionEvidence(
    "Connect fails visibly offline without a false success while local work continues",
    `${localOutage.faults} Den faults and ${connectorFaults.length} connector faults overlapped ${localOutage.elapsedMs}ms of session ${localRunSessionId}; the provider saw a failed tool result, mock_echo saw no marker call, and false success visible=${falseSuccess}.`,
    localOutage.runLive && connectorFaults.length > 0 && offlineCalls.length === 0 && !falseSuccess,
  );

  await proxy.faults.clear();
  await connectorProxy.faults.clear();
  await control(desktopApp, "session.open", { sessionId: localRunSessionId });
  await waitFor(desktopApp, assistantHasText(LOCAL_RUN_MARKER), {
    timeoutMs: 240_000,
    label: "local bash run completed after Den recovery",
  });
  const probe = parseLocalRunProbe(await evalIn(desktopApp, `(() => {
    const probe = window.__denOutageRunProbe ?? null;
    if (probe) probe.active = false;
    return probe ? JSON.parse(JSON.stringify(probe)) : null;
  })()`));
  const transcript = await control(desktopApp, "session.read_transcript", { count: 30 });
  const transcriptText = isRecord(transcript) && Array.isArray(transcript.messages)
    ? transcript.messages.filter(isRecord).map((message) => String(message.text ?? "")).join("\n")
    : "";
  const disposesDuringRun = probe.disposes.filter((dispose) => dispose.at >= localRunStartedAt);
  const abortErrors = probe.errors.filter((error) => error.sessionID === localRunSessionId
    && (error.name === "MessageAbortedError" || /message was interrupted/i.test(error.message)));
  expect(disposesDuringRun).toEqual([]);
  expect(abortErrors).toEqual([]);
  expect(transcriptText).not.toContain(INTERRUPTED_TEXT);
  evidence.recordAssertionEvidence(
    "An in-flight local bash run is never disposed or aborted by Den degradation",
    `Session ${localRunSessionId} completed ${LOCAL_RUN_MARKER}; dispose events after start=${JSON.stringify(disposesDuringRun)}; abort errors=${JSON.stringify(abortErrors)}.`,
    disposesDuringRun.length === 0 && abortErrors.length === 0 && !transcriptText.includes(INTERRUPTED_TEXT),
  );

  const finalEngine = await waitForEngine(desktopApp, "final unchanged healthy engine", baselineEngine);
  expect(finalEngine).toEqual(baselineEngine);
  const everyAuthSampleRetained = authSamples.every(
    (state) => state.authTokenPresent && state.activeOrgId === orgId,
  );
  expect(everyAuthSampleRetained).toBe(true);
  evidence.recordAssertionEvidence(
    "The local OpenCode engine never restarted across the outage and recovery cycles",
    `Baseline engine ${JSON.stringify(baselineEngine)} equals final engine ${JSON.stringify(finalEngine)}.`,
    sameEngine(finalEngine, baselineEngine),
  );
  evidence.recordAssertionEvidence(
    "No sampled phase required re-authentication or changed the active organization",
    `${authSamples.length} phase samples all retained an auth token and organization ${orgId}.`,
    everyAuthSampleRetained,
  );

  const finalLog = await proxy.requestLog();
  const phaseCounts = Object.fromEntries(cycleWindows.flatMap((cycle) => [
    [`outage${cycle.label}`, finalLog.filter((request) => request.faulted && request.status === 503
      && request.at >= cycle.outageStart && request.at < cycle.recoveryStart).length],
    [`recovery${cycle.label}`, finalLog.filter((request) => !request.faulted && request.status < 400
      && request.at >= cycle.recoveryStart && request.at <= cycle.recoveryEnd).length],
  ]));
  expect(Object.values(phaseCounts).every((count) => count > 0)).toBe(true);
  evidence.recordAssertionEvidence(
    "The wire log proves two distinct outage and recovery cycles",
    `Authoritative request-log phase counts: ${JSON.stringify(phaseCounts)}.`,
    Object.values(phaseCounts).every((count) => count > 0),
  );

  await openDiagnostics(desktopApp);
  const finalDiagnostics = await runDiagnostics(desktopApp, "final recovered diagnostics");
  expect(finalDiagnostics.overallFailed).toBe(false);
  await revealDiagnosticsReport(desktopApp);
  const recoveryBShot = await screenshot(desktopApp);
  const recoveryBSeen = await validate(recoveryBShot, [
    "The diagnostics report visibly shows an overall status with no failed check named",
    "The desktop remains usable without a restart or re-authentication screen",
  ]);
  expect(recoveryBSeen.ok, recoveryBSeen.why).toBe(true);
  console.log("[den-outage-spec] final assertions done");
});
