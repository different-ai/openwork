import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import {
  control,
  engineSessionProbe,
  evalIn,
  go,
  selectModel,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { resolveEvalEngine } from "@openwork/env";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  app,
  eventually,
  localMysqlIsRunning,
  localRedisIsRunning,
  mcpMock,
  needs,
  readCloudMcpHealth,
  readConnectState,
  readDenClientState,
  server,
  sleep,
  test,
} from "@openwork/testkit";
import type { App } from "@openwork/testkit";

const providerId = "active-session-storm-mock";
const modelId = "mock-agent-workload-model";
const modelName = "Active session storm model";
const evalEngine = resolveEvalEngine();
const shellToolName = evalEngine === "v2" ? "shell" : "bash";
const workspaceCount = 3;
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localServicesRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const runnable = e2eTestsEnabled && (!localServicesRequired || (mysqlOpen && redisOpen));
const skipSuffix = !e2eTestsEnabled
  ? " skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localServicesRequired && !mysqlOpen
    ? " skipped — needs MySQL on 127.0.0.1:3306"
    : localServicesRequired && !redisOpen
      ? " skipped — needs Redis on 127.0.0.1:6379"
      : "";

function workloadMinutes(): number {
  const value = Number(process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES ?? "2");
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error("OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES must be a number from 1 through 5.");
  }
  return value;
}

const configuredMinutes = workloadMinutes();
const slowToolMs = Math.round(configuredMinutes * 60_000);
// At the default two-minute workload, prove a full minute in which all three
// slow tools overlap. A one-minute override remains useful for quick iteration
// and gets a 35-second switching window so startup skew cannot make it flaky.
const routeStormMs = Math.min(60_000, Math.max(35_000, slowToolMs - 25_000));
const diagnosticProfileDir = process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_PROFILE_DIR?.trim();

interface WorkspacePlan {
  index: number;
  path: string;
  filePath: string;
  marker: string;
  slowMarker: string;
  easyMarker: string;
  finalReply: string;
  workspaceId: string;
  sessionId: string;
}

interface WorkspaceListing {
  ids: string[];
  activeId: string | null;
}

interface ToolFact {
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output: string;
}

interface SessionFacts {
  ok: boolean;
  status: number;
  sessionId: string;
  text: string;
  tools: ToolFact[];
}

interface SurfaceFacts {
  route: string;
  sessionId: string;
  authActions: string[];
  crash: boolean;
  bodyHasMarker: boolean;
  bodyHasToolActivity: boolean;
}

interface EngineGenerationFact {
  role: string;
  pid: number | null;
  port: number | null;
}

interface EngineRuntimeFacts {
  lifecycleState: string;
  enginePid: number | null;
  engineRollover: boolean;
  generations: EngineGenerationFact[];
}

interface WorkspaceFileFacts {
  status: number;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseSurfaceFacts(value: unknown): SurfaceFacts {
  if (!isRecord(value)) throw new Error(`Invalid session surface facts: ${JSON.stringify(value)}`);
  return {
    route: typeof value.route === "string" ? value.route : "",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    authActions: stringArray(value.authActions),
    crash: value.crash === true,
    bodyHasMarker: value.bodyHasMarker === true,
    bodyHasToolActivity: value.bodyHasToolActivity === true,
  };
}

function parseEngineRuntimeFacts(value: unknown): EngineRuntimeFacts {
  const root = isRecord(value) ? value : {};
  const engine = isRecord(root.engine) ? root.engine : {};
  const openworkServer = isRecord(root.openworkServer) ? root.openworkServer : {};
  const pool = isRecord(root.enginePool) ? root.enginePool : {};
  const generations: EngineGenerationFact[] = [];
  if (Array.isArray(pool.generations)) {
    for (const generation of pool.generations) {
      if (!isRecord(generation) || typeof generation.role !== "string") continue;
      generations.push({
        role: generation.role,
        pid: typeof generation.pid === "number" ? generation.pid : null,
        port: typeof generation.port === "number" ? generation.port : null,
      });
    }
  }
  return {
    lifecycleState: typeof root.lifecycleState === "string" ? root.lifecycleState : "",
    enginePid: typeof engine.pid === "number" ? engine.pid : null,
    engineRollover: openworkServer.engineRollover === true,
    generations,
  };
}

function shellValue(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`Unsafe workload shell value: ${value}`);
  return value;
}

function buildPlans(runId: string): WorkspacePlan[] {
  return Array.from({ length: workspaceCount }, (_, offset) => {
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
      workspaceId: "",
      sessionId: "",
    };
  });
}

function agentWorkloads(plans: WorkspacePlan[]) {
  const workloads = plans.map((plan) => ({
    promptMarker: plan.marker,
    finalReply: plan.finalReply,
    steps: [
      {
        tool: "bash",
        arguments: {
          command: `printf '%s\\n' 'INITIAL-${shellValue(plan.marker)}' > '${shellValue(plan.filePath)}'`,
          timeout: 30_000,
          workdir: plan.path,
          description: `Create the unique output for workspace ${plan.index}`,
        },
      },
      {
        tool: "bash",
        arguments: {
          command: `cat '${shellValue(plan.filePath)}'`,
          timeout: 30_000,
          workdir: plan.path,
          description: `Check the initial output for workspace ${plan.index}`,
        },
      },
      {
        tool: "bash",
        arguments: {
          command: `sleep ${Math.ceil(slowToolMs / 1_000)} && printf '%s\\n' '${shellValue(plan.slowMarker)}' >> '${shellValue(plan.filePath)}'`,
          timeout: slowToolMs + 30_000,
          workdir: plan.path,
          description: `Hold workspace ${plan.index} live, then append its slow marker`,
        },
      },
      {
        tool: "bash",
        arguments: {
          command: `cat '${shellValue(plan.filePath)}'`,
          timeout: 30_000,
          workdir: plan.path,
          description: `Check the slow output for workspace ${plan.index}`,
        },
      },
      {
        tool: "bash",
        arguments: {
          command: `printf '%s\\n' '${shellValue(plan.easyMarker)}' >> '${shellValue(plan.filePath)}'`,
          timeout: 30_000,
          workdir: plan.path,
          description: `Append the easy marker for workspace ${plan.index}`,
        },
      },
      {
        tool: "bash",
        arguments: {
          command: `cat '${shellValue(plan.filePath)}'`,
          timeout: 30_000,
          workdir: plan.path,
          description: `Read the completed output for workspace ${plan.index}`,
        },
      },
    ],
  }));
  if (evalEngine === "v1") return workloads;
  return workloads.map((workload) => ({
    ...workload,
    steps: workload.steps.map((step) => ({
      tool: shellToolName,
      arguments: {
        command: step.arguments.command,
        timeout: step.arguments.timeout,
        workdir: step.arguments.workdir,
      },
    })),
  }));
}

async function listWorkspaces(desktopApp: App): Promise<WorkspaceListing> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/workspaces", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      ok: response.ok,
      ids: items.map((item) => String(item?.id ?? "")).filter(Boolean),
      activeId: typeof body?.activeId === "string" ? body.activeId : null,
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.ids)) {
    throw new Error(`Listing workspaces failed: ${JSON.stringify(value)}`);
  }
  return {
    ids: value.ids.filter((id): id is string => typeof id === "string"),
    activeId: typeof value.activeId === "string" ? value.activeId : null,
  };
}

async function createWorkspace(desktopApp: App, path: string): Promise<string> {
  const before = await listWorkspaces(desktopApp);
  await control(desktopApp, "workspace.create", { path }, { timeoutMs: 90_000 });
  const after = await eventually(() => listWorkspaces(desktopApp), {
    within: 90_000,
    intervalMs: 500,
    label: `workspace ${path} registered`,
    until: (listing) => listing.ids.length === before.ids.length + 1,
  });
  const created = after.ids.find((id) => !before.ids.includes(id));
  if (!created) throw new Error(`workspace.create produced no new id for ${path}.`);
  return created;
}

async function configureWorkspaces(desktopApp: App, plans: WorkspacePlan[], baseUrl: string): Promise<void> {
  const result = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const outcomes = [];
    for (const workspaceId of ${JSON.stringify(plans.map((plan) => plan.workspaceId))}) {
      const config = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { edit: "allow", write: "allow", read: "allow", bash: "allow" },
            provider: {
              [${JSON.stringify(providerId)}]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Active session storm mock",
                options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-active-session-storm" },
                models: {
                  [${JSON.stringify(modelId)}]: { name: ${JSON.stringify(modelName)}, tool_call: true },
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!config.ok) {
        outcomes.push({ workspaceId, stage: "config", status: config.status, text: (await config.text()).slice(0, 300) });
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
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    return { outcomes };
  })()`, { awaitPromise: true, timeoutMs: 240_000 });
  if (!isRecord(result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Workspace provider configuration failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) => !isRecord(outcome) || outcome.status !== 200);
  if (failures.length > 0) throw new Error(`Workspace provider configuration failures: ${JSON.stringify(failures)}`);
}

async function openExactSessionRoute(desktopApp: App, plan: WorkspacePlan): Promise<void> {
  const route = `/workspace/${plan.workspaceId}/session/${plan.sessionId}`;
  await go(desktopApp, route, { timeoutMs: 60_000 });
  await waitFor(desktopApp, `(() => {
    const current = window.__openworkControl?.snapshot().route.split("?")[0].replace(/\\/+$/, "") ?? "";
    return current === ${JSON.stringify(route)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(plan.workspaceId)}
      && document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") === ${JSON.stringify(plan.sessionId)};
  })()`, { timeoutMs: 60_000, label: `exact route ${route}` });
}

async function readSessionFacts(desktopApp: App, workspaceId: string, sessionId: string): Promise<SessionFacts> {
  const probe = engineSessionProbe({
    engine: evalEngine,
    surface: desktopApp,
    workspaceId,
  });
  const snapshot = await probe.snapshot(sessionId);
  if (!snapshot.ok) return { ok: false, status: snapshot.status, sessionId, text: "", tools: [] };
  const parts = snapshot.data.messages.flatMap((message) => message.parts);
  return {
    ok: true,
    status: snapshot.status,
    sessionId: snapshot.data.session?.id ?? "",
    text: parts.flatMap((part) => part.text ? [part.text] : []).join("\n"),
    tools: parts.flatMap((part) => part.tool ? [{
      tool: part.tool,
      status: part.status,
      input: part.input,
      output: part.output,
    }] : []),
  };
}

async function readSurfaceFacts(desktopApp: App, marker: string): Promise<SurfaceFacts> {
  const value = await evalIn(desktopApp, `(() => {
    const body = document.body.innerText ?? "";
    const authActions = [...document.querySelectorAll("button, a")]
      .map((element) => (element.textContent ?? "").trim())
      .filter((text) => /^(sign in|reconnect|connect again|log in)$/i.test(text));
    return {
      route: window.__openworkControl?.snapshot().route ?? window.location.hash,
      sessionId: document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "",
      authActions,
      crash: /aw, snap|renderer process gone|application error|uncaught exception/i.test(body),
      bodyHasMarker: body.includes(${JSON.stringify(marker)}),
      bodyHasToolActivity: body.includes("Hold workspace") || body.includes("sleep "),
    };
  })()`);
  return parseSurfaceFacts(value);
}

async function readEngineRuntimeFacts(desktopApp: App): Promise<EngineRuntimeFacts> {
  return parseEngineRuntimeFacts(await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("runtimeStatus")`,
    { awaitPromise: true, timeoutMs: 15_000 },
  ));
}

async function readWorkspaceFileFacts(desktopApp: App, plan: WorkspacePlan): Promise<WorkspaceFileFacts> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, content: "" };
    const response = await fetch(
      String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(plan.workspaceId)})
        + "/files/content?path=" + encodeURIComponent(${JSON.stringify(plan.filePath.split("/").pop() ?? "")}),
      {
        headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.json().catch(() => ({}));
    return { status: response.status, content: typeof body?.content === "string" ? body.content : "" };
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value) || typeof value.status !== "number") {
    throw new Error(`Invalid workspace file facts: ${JSON.stringify(value)}`);
  }
  return {
    status: value.status,
    content: typeof value.content === "string" ? value.content : "",
  };
}

async function readEngineLogSignals(desktopApp: App): Promise<string[]> {
  if (desktopApp.handle.hostKind !== "local") return [];
  const logPath = desktopApp.handle.meta?.log;
  if (!logPath) return [];
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n")
    .filter((line) => /engine|dispose|drain|reload|activate|session/i.test(line))
    .slice(-80)
    .map((line) => line.slice(0, 500));
}

function slowToolRunning(facts: SessionFacts): boolean {
  return facts.tools.some((tool) => tool.tool.endsWith(shellToolName)
    && (tool.status === "running" || tool.status === "pending")
    && typeof tool.input.command === "string"
    && tool.input.command.includes("sleep "));
}

function sessionCorpus(facts: SessionFacts): string {
  return `${facts.text}\n${JSON.stringify(facts.tools)}`;
}

async function allowVisibleToolPermission(desktopApp: App): Promise<boolean> {
  const clicked = await evalIn(desktopApp, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === "Allow for session" && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (clicked === true) await sleep(250);
  return clicked === true;
}

async function approvePendingToolPermissions(desktopApp: App, plan: WorkspacePlan): Promise<number> {
  const statuses = await engineSessionProbe({
    engine: evalEngine,
    surface: desktopApp,
    workspaceId: plan.workspaceId,
  }).approvePendingPermissions(plan.sessionId);
  const failures = statuses.filter((status) => status < 200 || status >= 300);
  if (failures.length > 0) throw new Error(`Permission replies failed for ${plan.sessionId}: ${JSON.stringify(failures)}`);
  return statuses.length;
}

async function waitForSlowTool(desktopApp: App, plan: WorkspacePlan): Promise<SessionFacts> {
  const deadline = Date.now() + 90_000;
  let latest: SessionFacts | null = null;
  while (Date.now() < deadline) {
    const clicked = await allowVisibleToolPermission(desktopApp);
    const approved = clicked ? 0 : await approvePendingToolPermissions(desktopApp, plan);
    latest = await readSessionFacts(desktopApp, plan.workspaceId, plan.sessionId);
    // A tool part is already labelled running while it waits for permission.
    // Require one clean poll with no request left to approve before treating
    // the slow command as an actually in-flight workload.
    if (slowToolRunning(latest) && approved === 0 && !clicked) return latest;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for workspace ${plan.index} slow tool to start after permission approval; latest=${JSON.stringify(latest)}`);
}

test.skipIf(!runnable)(
  `three workspaces keep independent live tool runs through exact-route switching${skipSuffix}`,
  { timeout: 25 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const plans = buildPlans(runId);
    await using den = await server({
      place,
      mocks: { agent: mcpMock({ agentWorkloads: agentWorkloads(plans) }) },
      org: {
        name: "Active Session Workspace Storm",
        admin: { name: "Storm Admin" },
        members: { member: { name: "Storm Member" } },
      },
    });
    await using desktopApp = await app({
      den,
      as: "member",
      place,
      ...(diagnosticProfileDir ? { profileDir: diagnosticProfileDir } : {}),
    });

    const initialDen = await eventually(() => readDenClientState(desktopApp), {
      within: 60_000,
      label: "initial authenticated organization",
      until: (state) => state.authTokenPresent && Boolean(state.activeOrgId),
    });
    const initialConnect = await eventually(() => readConnectState(desktopApp), {
      within: 120_000,
      intervalMs: 1_000,
      label: "initial Connect availability",
      until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
    });
    const orgId = initialDen.activeOrgId;
    if (!orgId) throw new Error("The signed-in baseline has no active organization.");
    evidence.recordAssertionEvidence(
      "The workload begins with coherent Den auth, organization, and Connect state",
      `authTokenPresent=${initialDen.authTokenPresent}; activeOrgId=${orgId}; Connect=${initialConnect.status}/${initialConnect.connectEnabled}.`,
      initialDen.authTokenPresent && initialConnect.ok && initialConnect.status === "available" && initialConnect.connectEnabled === true,
    );

    for (const plan of plans) plan.workspaceId = await createWorkspace(desktopApp, plan.path);
    expect(new Set(plans.map((plan) => plan.workspaceId)).size).toBe(workspaceCount);
    await configureWorkspaces(desktopApp, plans, den.mocks.agent.url);
    // The already-mounted model store predates these workspace configs. Reload
    // once, before any session exists, so every workspace sees the same mock
    // provider without perturbing an in-flight engine event subscription.
    await evalIn(desktopApp, "location.reload(); true");
    await waitFor(desktopApp, "Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "desktop reloaded with the storm model preference",
    });
    await eventually(() => readDenClientState(desktopApp), {
      within: 60_000,
      label: "Den session restored after provider setup reload",
      until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
    });

    const workloadStartedAt = new Date().toISOString();
    for (const plan of plans) {
      await go(desktopApp, `/workspace/${plan.workspaceId}/session`);
      await waitFor(desktopApp, `(localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(plan.workspaceId)}`, {
        timeoutMs: 60_000,
        label: `workspace ${plan.index} active before task creation`,
      });
      const selected = await selectModel(desktopApp, modelId);
      expect(selected.id).toBe(modelId);
      const created = await control(desktopApp, "session.create_task", undefined, { timeoutMs: 60_000 });
      if (typeof created !== "string" || !created.startsWith("ses_")) {
        throw new Error(`Workspace ${plan.index} did not create a session: ${JSON.stringify(created)}`);
      }
      plan.sessionId = created;
      await control(desktopApp, "session.rename", {
        sessionId: plan.sessionId,
        title: `Active storm workspace ${plan.index}`,
      }, { timeoutMs: 30_000 });
      await openExactSessionRoute(desktopApp, plan);
      const prompt = `Run the deterministic active-session workload identified by ${plan.marker}. You may run its shell commands and create, append, and read its workspace file. Keep working through every step and report only when complete.`;
      await writeComposerText(desktopApp, prompt);
      await control(desktopApp, "composer.send", undefined, { timeoutMs: 120_000 });
      // Under a remote Daytona renderer the message list can lag behind the
      // composer transition even though the turn is already admitted (the UI
      // visibly says Thinking). Use the workspace-scoped server snapshot as
      // the authoritative admission witness instead of waiting for a DOM row.
      await eventually(
        () => readSessionFacts(desktopApp, plan.workspaceId, plan.sessionId),
        {
          within: 60_000,
          intervalMs: 500,
          label: `workspace ${plan.index} prompt admitted to its session`,
          until: (facts) => facts.text.includes(plan.marker),
        },
      );
      const running = await waitForSlowTool(desktopApp, plan);
      expect(running.ok).toBe(true);
      expect(running.sessionId).toBe(plan.sessionId);
    }

    evidence.recordAssertionEvidence(
      "All three originating workspaces reached a live slow tool concurrently",
      `${plans.map((plan) => `${plan.workspaceId}/${plan.sessionId}`).join(", ")} each exposed a pending or running ${shellToolName} sleep before route switching began; configured slow duration=${slowToolMs}ms.`,
      plans.length === workspaceCount && plans.every((plan) => Boolean(plan.workspaceId && plan.sessionId)),
    );
    const engineBeforeStorm = await readEngineRuntimeFacts(desktopApp);

    await openExactSessionRoute(desktopApp, plans[0]);
    const liveSurface = await readSurfaceFacts(desktopApp, plans[0].marker);
    expect(liveSurface.bodyHasMarker).toBe(true);
    expect(liveSurface.bodyHasToolActivity).toBe(true);
    expect(liveSurface.sessionId).toBe(plans[0].sessionId);
    expect(liveSurface.authActions).toEqual([]);
    const liveShot = await screenshot(desktopApp);
    const liveValidation = await validate(liveShot, [
      "The active workspace session visibly shows its deterministic workload prompt or marker",
      "The session visibly shows live agent activity such as Thinking, a running tool, or a shell command",
      "No sign-in, reconnect, or application crash screen is visible",
    ]);
    expect(liveValidation.ok, liveValidation.why).toBe(true);

    const authDrops: string[] = [];
    const orgChanges: string[] = [];
    const connectFailures: string[] = [];
    const reconnectSurfaces: string[] = [];
    const nonLiveSamples: string[] = [];
    const liveSamples = new Map(plans.map((plan) => [plan.sessionId, 0]));
    const stormStartedAt = Date.now();
    let switches = 0;
    while (Date.now() - stormStartedAt < routeStormMs) {
      for (const plan of plans) {
        await openExactSessionRoute(desktopApp, plan);
        switches += 1;
        const [facts, denState, surface] = await Promise.all([
          readSessionFacts(desktopApp, plan.workspaceId, plan.sessionId),
          readDenClientState(desktopApp),
          readSurfaceFacts(desktopApp, plan.marker),
        ]);
        if (slowToolRunning(facts)) {
          liveSamples.set(plan.sessionId, (liveSamples.get(plan.sessionId) ?? 0) + 1);
        } else {
          nonLiveSamples.push(`switch ${switches}: ${plan.sessionId} tools=${JSON.stringify(facts.tools)}`);
        }
        if (!denState.authTokenPresent) authDrops.push(`switch ${switches}: ${plan.sessionId}`);
        if (denState.activeOrgId !== orgId) orgChanges.push(`switch ${switches}: ${String(denState.activeOrgId)}`);
        if (surface.authActions.length > 0 || surface.crash || !surface.bodyHasMarker) {
          reconnectSurfaces.push(`switch ${switches}: ${JSON.stringify(surface)}`);
        }
        await sleep(250);
      }
      const connect = await readConnectState(desktopApp);
      if (!connect.ok || connect.status !== "available" || connect.connectEnabled !== true) {
        connectFailures.push(`after switch ${switches}: ${JSON.stringify(connect)}`);
      }
    }

    expect(switches).toBeGreaterThanOrEqual(9);
    expect([...liveSamples.values()].every((count) => count >= 3), JSON.stringify([...liveSamples])).toBe(true);
    expect(nonLiveSamples).toEqual([]);
    expect(authDrops).toEqual([]);
    expect(orgChanges).toEqual([]);
    expect(connectFailures).toEqual([]);
    expect(reconnectSurfaces).toEqual([]);
    evidence.recordAssertionEvidence(
      "Repeated exact-session-route switching preserves every in-flight turn and Cloud identity",
      `${switches} exact route switches over ${Date.now() - stormStartedAt}ms; live samples=${JSON.stringify([...liveSamples])}; non-live=${JSON.stringify(nonLiveSamples)}; auth drops=${JSON.stringify(authDrops)}; org changes=${JSON.stringify(orgChanges)}; Connect failures=${JSON.stringify(connectFailures)}; reconnect/crash surfaces=${JSON.stringify(reconnectSurfaces)}.`,
      switches >= 9
        && [...liveSamples.values()].every((count) => count >= 3)
        && nonLiveSamples.length === 0
        && authDrops.length === 0
        && orgChanges.length === 0
        && connectFailures.length === 0
        && reconnectSurfaces.length === 0,
    );
    const engineAfterStorm = await readEngineRuntimeFacts(desktopApp);
    evidence.recordAssertionEvidence(
      "The route storm records the managed engine generation topology",
      `Before=${JSON.stringify(engineBeforeStorm)}; after=${JSON.stringify(engineAfterStorm)}.`,
      engineBeforeStorm.enginePid !== null && engineAfterStorm.enginePid !== null,
    );

    const expectedTools = Array.from({ length: 6 }, () => shellToolName);
    for (const plan of plans) {
      await openExactSessionRoute(desktopApp, plan);
      const complete = await eventually(
        async () => {
          const facts = await readSessionFacts(desktopApp, plan.workspaceId, plan.sessionId);
          if (!facts.text.includes(plan.finalReply)) {
            const clicked = await allowVisibleToolPermission(desktopApp);
            if (!clicked) await approvePendingToolPermissions(desktopApp, plan);
          }
          return facts;
        },
        {
          within: slowToolMs + 60_000,
          intervalMs: 1_000,
          label: `workspace ${plan.index} independent completion`,
          until: (facts) => facts.text.includes(plan.finalReply)
            && facts.tools.length === expectedTools.length
            && facts.tools.every((tool) => tool.status === "completed"),
        },
      ).catch(async (error: unknown) => {
        const [stuck, file, engine, logSignals] = await Promise.all([
          readSessionFacts(desktopApp, plan.workspaceId, plan.sessionId),
          readWorkspaceFileFacts(desktopApp, plan),
          readEngineRuntimeFacts(desktopApp),
          readEngineLogSignals(desktopApp),
        ]);
        evidence.recordAssertionEvidence(
          `Workspace ${plan.index} independently completes after route switching`,
          `Completion exceeded its strict bound; origin=${plan.workspaceId}/${plan.sessionId}; last snapshot=${JSON.stringify(stuck)}; file=${JSON.stringify(file)}; engine=${JSON.stringify(engine)}; engine log signals=${JSON.stringify(logSignals)}.`,
          false,
        );
        throw error;
      });
      const corpus = sessionCorpus(complete);
      expect(complete.sessionId).toBe(plan.sessionId);
      expect(complete.tools.map((tool) => tool.tool)).toEqual(expectedTools);
      expect(corpus).toContain(plan.filePath);
      expect(corpus).toContain(`INITIAL-${plan.marker}`);
      expect(corpus).toContain(plan.slowMarker);
      expect(corpus).toContain(plan.easyMarker);
      expect(corpus).toContain(plan.finalReply);
      for (const other of plans.filter((candidate) => candidate.index !== plan.index)) {
        expect(corpus).not.toContain(other.marker);
        expect(corpus).not.toContain(other.filePath);
      }

      const providerRequests = await den.mocks.agent.agentRequests({
        promptMarker: plan.marker,
        sinceIso: workloadStartedAt,
      });
      const mainRequests = providerRequests.filter((request) => request.kind !== "utility");
      expect(mainRequests.map((request) => request.kind)).toEqual([
        "tool", "tool", "tool", "tool", "tool", "tool", "final",
      ]);
      expect(mainRequests.filter((request) => request.kind === "tool").map((request) => request.toolName)).toEqual(expectedTools);
      expect(mainRequests.every((request) => request.matchedMarkers.length === 1
        && request.matchedMarkers[0] === plan.marker)).toBe(true);
      expect(mainRequests.filter((request) => request.kind === "tool")
        .every((request) => JSON.stringify(request.arguments).includes(plan.filePath))).toBe(true);

      const wrongWorkspaceStatuses: number[] = [];
      for (const other of plans.filter((candidate) => candidate.index !== plan.index)) {
        wrongWorkspaceStatuses.push((await readSessionFacts(desktopApp, other.workspaceId, plan.sessionId)).status);
      }
      expect(wrongWorkspaceStatuses.every((status) => status === 404)).toBe(true);

      const finalSurface = await readSurfaceFacts(desktopApp, plan.marker);
      expect(finalSurface.sessionId).toBe(plan.sessionId);
      expect(finalSurface.bodyHasMarker).toBe(true);
      expect(finalSurface.authActions).toEqual([]);
      expect(finalSurface.crash).toBe(false);
      const completeShot = await screenshot(desktopApp);
      const completeValidation = await validate(completeShot, [
        `The session visibly shows the completed workload for workspace ${plan.index}`,
        "The session transcript visibly contains agent or tool activity rather than an empty New session screen",
        "No sign-in, reconnect, or application crash screen is visible",
      ]);
      expect(completeValidation.ok, completeValidation.why).toBe(true);
      evidence.recordAssertionEvidence(
        `Workspace ${plan.index} completed only its own six-step workload in its originating session`,
        `Origin=${plan.workspaceId}/${plan.sessionId}; tools=${JSON.stringify(complete.tools)}; provider=${JSON.stringify(mainRequests)}; wrong-workspace snapshot statuses=${JSON.stringify(wrongWorkspaceStatuses)}; transcript=${JSON.stringify(complete.text)}.`,
        complete.text.includes(plan.finalReply)
          && complete.tools.map((tool) => tool.tool).join(",") === expectedTools.join(",")
          && plans.filter((candidate) => candidate.index !== plan.index).every((other) => !corpus.includes(other.marker))
          && wrongWorkspaceStatuses.every((status) => status === 404),
      );
    }

    const finalDen = await readDenClientState(desktopApp);
    const finalConnect = await eventually(() => readConnectState(desktopApp), {
      within: 120_000,
      intervalMs: 1_000,
      label: "Connect available after all active sessions complete",
      until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
    });
    expect(finalDen.authTokenPresent).toBe(true);
    expect(finalDen.activeOrgId).toBe(orgId);
    expect(finalConnect.status).toBe("available");
    expect(finalConnect.connectEnabled).toBe(true);

    const healthSummaries = [];
    for (const plan of plans) {
      healthSummaries.push(await eventually(
        () => readCloudMcpHealth(desktopApp, plan.workspaceId, { probe: true, timeoutMs: 30_000 }),
        {
          within: 180_000,
          intervalMs: 3_000,
          label: `workspace ${plan.index} Cloud MCP usable after completion`,
          until: (health) => health.ok && health.usable === true,
        },
      ));
    }
    expect(healthSummaries.every((health) => health.ok && health.usable === true)).toBe(true);
    evidence.recordAssertionEvidence(
      "Den auth, organization selection, and Connect remain coherent after every session completes",
      `Final authTokenPresent=${finalDen.authTokenPresent}; activeOrgId=${String(finalDen.activeOrgId)}; Connect=${finalConnect.status}/${finalConnect.connectEnabled}; per-workspace Cloud MCP health=${JSON.stringify(healthSummaries)}.`,
      finalDen.authTokenPresent
        && finalDen.activeOrgId === orgId
        && finalConnect.ok
        && finalConnect.status === "available"
        && finalConnect.connectEnabled === true
        && healthSummaries.every((health) => health.ok && health.usable === true),
    );
  },
);
