import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  selectModel,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/test-evidence";
import {
  app,
  eventually,
  localMysqlIsRunning,
  localRedisIsRunning,
  mcpMock,
  needs,
  server,
  test,
} from "@openwork/testkit";
import type { App } from "@openwork/testkit";

const providerId = "live-tool-switch-mock";
const modelId = "live-tool-switch-model";
const modelName = "Live tool switch model";
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

interface ToolFact {
  callId: string;
  status: string;
  command: string;
  description: string;
}

interface SessionFacts {
  sessionId: string;
  text: string;
  tools: ToolFact[];
}

interface VisibleToolFact {
  currentSessionId: string;
  found: boolean;
  visible: boolean;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionFacts(value: unknown): SessionFacts {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.text !== "string") {
    throw new Error(`Invalid session facts: ${JSON.stringify(value)}`);
  }
  const tools: ToolFact[] = [];
  if (Array.isArray(value.tools)) {
    for (const candidate of value.tools) {
      if (!isRecord(candidate)) continue;
      tools.push({
        callId: typeof candidate.callId === "string" ? candidate.callId : "",
        status: typeof candidate.status === "string" ? candidate.status : "",
        command: typeof candidate.command === "string" ? candidate.command : "",
        description: typeof candidate.description === "string" ? candidate.description : "",
      });
    }
  }
  return { sessionId: value.sessionId, text: value.text, tools };
}

function parseVisibleToolFact(value: unknown): VisibleToolFact {
  if (!isRecord(value)) throw new Error(`Invalid visible tool fact: ${JSON.stringify(value)}`);
  return {
    currentSessionId: typeof value.currentSessionId === "string" ? value.currentSessionId : "",
    found: value.found === true,
    visible: value.visible === true,
    text: typeof value.text === "string" ? value.text : "",
  };
}

async function configureWorkspaces(appSurface: App, workspaceIds: string[], baseUrl: string): Promise<void> {
  const result = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return "local_server_unavailable";
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      const configured = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { bash: "allow" },
            provider: {
              [${JSON.stringify(providerId)}]: {
                npm: "@ai-sdk/openai-compatible",
                name: ${JSON.stringify(modelName)},
                options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-live-tool-switch" },
                models: {
                  [${JSON.stringify(modelId)}]: { name: ${JSON.stringify(modelName)}, tool_call: true },
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!configured.ok) return "config:" + configured.status + ":" + (await configured.text()).slice(0, 300);
      const reloaded = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (!reloaded.ok) return "reload:" + reloaded.status + ":" + (await reloaded.text()).slice(0, 300);
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
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(result).toBe("ok");

  await evalIn(appSurface, "location.reload(); true");
  await waitFor(appSurface, "Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "desktop restored after mock provider configuration",
  });
}

async function createSession(appSurface: App): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const created = await control(appSurface, "session.create_task", undefined, { timeoutMs: 30_000 });
      if (typeof created === "string" && created.startsWith("ses_")) return created;
      lastError = new Error(`session.create_task returned ${JSON.stringify(created)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`session.create_task did not return a session id: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function clickSessionRow(appSurface: App, workspaceId: string, sessionId: string): Promise<void> {
  const clicked = await evalIn(appSurface, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]`)});
    const control = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${sessionId}"]`)});
    if (!(row instanceof HTMLElement) || !(control instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    control.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
  await waitFor(appSurface, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)};
  })()`, { timeoutMs: 60_000, label: `workspace ${workspaceId} session ${sessionId} visible after sidebar click` });
}

async function readSessionFacts(appSurface: App, workspaceId: string, sessionId: string): Promise<SessionFacts> {
  const value = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { sessionId: "", text: "", tools: [] };
    const base = String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
      + "/opencode/session";
    const encodedSessionId = encodeURIComponent(${JSON.stringify(sessionId)});
    const options = {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    };
    const responses = await Promise.all([
      fetch(base + "/" + encodedSessionId, options),
      fetch(base + "/" + encodedSessionId + "/message?limit=50", options),
      fetch(base + "/" + encodedSessionId + "/todo", options),
      fetch(base + "/status", options),
    ]);
    if (responses.some((response) => !response.ok)) return { sessionId: "", text: "", tools: [] };
    const [session, messageWires, todos, statuses] = await Promise.all(responses.map((response) => response.json()));
    const item = { session, messages: messageWires, todos, status: statuses?.[session?.id] ?? { type: "idle" } };
    const messages = Array.isArray(item.messages) ? item.messages : [];
    const parts = messages.flatMap((message) => Array.isArray(message?.parts) ? message.parts : []);
    return {
      sessionId: typeof item?.session?.id === "string" ? item.session.id : "",
      text: parts.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("\\n"),
      tools: parts.flatMap((part) => {
        if (!part || typeof part.tool !== "string") return [];
        const state = part.state && typeof part.state === "object" ? part.state : {};
        const input = state.input && typeof state.input === "object" ? state.input : {};
        return [{
          callId: typeof part.callID === "string" ? part.callID : "",
          status: typeof state.status === "string" ? state.status : "",
          command: typeof input.command === "string" ? input.command : "",
          description: typeof input.description === "string" ? input.description : "",
        }];
      }),
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  return parseSessionFacts(value);
}

async function approvePendingPermission(appSurface: App, workspaceId: string, sessionId: string): Promise<number> {
  const value = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return [];
    const root = String(info.baseUrl).replace(/\\/+$/, "")
      + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode";
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const sessionId = ${JSON.stringify(sessionId)};
    const pending = await fetch(root + "/api/session/" + encodeURIComponent(sessionId) + "/permission", {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!pending.ok) return [];
    const requests = await pending.json();
    const statuses = [];
    for (const request of Array.isArray(requests) ? requests : []) {
      if (typeof request?.id !== "string") continue;
      const response = await fetch(
        root + "/api/session/" + encodeURIComponent(sessionId) + "/permission/" + encodeURIComponent(request.id) + "/reply",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ reply: "once" }),
          signal: AbortSignal.timeout(10000),
        },
      );
      statuses.push(response.status);
    }
    return statuses;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!Array.isArray(value) || value.some((status) => typeof status !== "number" || status < 200 || status >= 300)) {
    throw new Error(`Permission approval failed: ${JSON.stringify(value)}`);
  }
  return value.length;
}

async function readVisibleTool(
  appSurface: App,
  sessionId: string,
  toolCallId: string,
): Promise<VisibleToolFact> {
  const value = await evalIn(appSurface, `(() => {
    const surface = document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionId}"]`)});
    const currentSessionId = document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "";
    if (!(surface instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, text: "" };
    const row = surface.querySelector('[data-tool-aggregate="' + CSS.escape(${JSON.stringify(toolCallId)}) + '"]');
    if (!(row instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, text: "" };
    const style = getComputedStyle(row);
    const rect = row.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const visible = row.isConnected
      && rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && rect.bottom > Math.max(0, surfaceRect.top)
      && rect.top < Math.min(window.innerHeight, surfaceRect.bottom)
      && rect.right > Math.max(0, surfaceRect.left)
      && rect.left < Math.min(window.innerWidth, surfaceRect.right);
    return { currentSessionId, found: true, visible, text: row.innerText ?? "" };
  })()`);
  return parseVisibleToolFact(value);
}

test.skipIf(!runnable)(
  `a tool started while away is visible after returning to its chat${skipSuffix}`,
  { timeout: 12 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const promptMarker = `LIVE-TOOL-SWITCH-${runId}`;
    const firstMarker = `FIRST-${promptMarker}`;
    const firstToolDescription = `First tool in chat A — ${promptMarker}`;
    const toolDescription = `Waiting in chat A — ${promptMarker}`;
    const completionMarker = `DONE-${promptMarker}`;
    const firstCommand = `sleep 15 && printf '%s\\n' '${firstMarker}'`;
    const command = `sleep 45 && printf '%s\\n' '${completionMarker}'`;

    await using den = await server({
      place,
      mocks: {
        agent: mcpMock({
          agentWorkloads: [{
            promptMarker,
            finalReply: completionMarker,
            steps: [
              {
                tool: "bash",
                arguments: {
                  command: firstCommand,
                  timeout: 30_000,
                  description: firstToolDescription,
                },
              },
              {
                tool: "bash",
                arguments: {
                  command,
                  timeout: 90_000,
                  description: toolDescription,
                },
              },
            ],
          }],
        }),
      },
      org: {
        name: "Live Tool Switch",
        admin: { name: "Switch Admin" },
        members: { member: { name: "Switch Member" } },
      },
    });
    await using desktopApp = await app({ den, as: "member", place });

    const workspaceB = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-live-tool-switch-${runId}-b`,
    });
    const chatB = await createSession(desktopApp);
    await control(desktopApp, "session.rename", { sessionId: chatB, title: "Chat B" });

    const workspaceA = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-live-tool-switch-${runId}-a`,
    });
    await configureWorkspaces(desktopApp, [workspaceA.workspaceId, workspaceB.workspaceId], den.mocks.agent.url);
    const chatA = await createSession(desktopApp);
    await control(desktopApp, "session.rename", { sessionId: chatA, title: "Chat A" });
    expect(chatA).not.toBe(chatB);

    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
    const selected = await selectModel(desktopApp, modelId);
    expect(selected.id).toBe(modelId);
    await writeComposerText(desktopApp, `Run the deterministic tool identified by ${promptMarker}.`);
    await control(desktopApp, "composer.send", undefined, { timeoutMs: 120_000 });

    const running = await eventually(async () => {
      const approved = await approvePendingPermission(desktopApp, workspaceA.workspaceId, chatA);
      const facts = await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
      return { approved, facts };
    }, {
      within: 90_000,
      intervalMs: 500,
      label: "chat A first bash tool running",
      until: ({ approved, facts }) => approved === 0
        && facts.sessionId === chatA
        && facts.tools.some((tool) =>
        tool.status === "running"
          && tool.command === firstCommand
          && tool.description === firstToolDescription),
    });
    expect(running.facts.sessionId).toBe(chatA);
    const runningTool = running.facts.tools.find((tool) => tool.command === firstCommand);
    if (!runningTool?.callId) throw new Error(`The running bash tool had no call ID: ${JSON.stringify(running.facts)}`);

    const visibleBeforeSwitch = await eventually(
      () => readVisibleTool(desktopApp, chatA, runningTool.callId),
      {
        within: 30_000,
        intervalMs: 250,
        label: "running tool visibly rendered before switching",
        until: (fact) => fact.currentSessionId === chatA && fact.found && fact.visible,
      },
    );
    expect(visibleBeforeSwitch.visible).toBe(true);

    await clickSessionRow(desktopApp, workspaceB.workspaceId, chatB);
    const absentFromChatB = await readVisibleTool(desktopApp, chatB, runningTool.callId);
    expect(absentFromChatB.currentSessionId).toBe(chatB);
    expect(absentFromChatB.found).toBe(false);

    const laterRunning = await eventually(async () => {
      await approvePendingPermission(desktopApp, workspaceA.workspaceId, chatA);
      return readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    }, {
      within: 30_000,
      intervalMs: 500,
      label: "second chat A tool started while workspace B is visible",
      until: (facts) => facts.tools.some((tool) => tool.status === "completed" && tool.callId === runningTool.callId)
        && facts.tools.some((tool) => tool.status === "running" && tool.command === command && tool.description === toolDescription),
    });
    const laterTool = laterRunning.tools.find((tool) => tool.command === command);
    if (!laterTool?.callId) throw new Error(`The later bash tool had no call ID: ${JSON.stringify(laterRunning)}`);
    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
    const stillRunning = await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    expect(stillRunning.tools.some((tool) =>
      tool.status === "running"
        && tool.callId === laterTool.callId
        && tool.description === toolDescription), JSON.stringify(stillRunning)).toBe(true);

    const visibleAfterReturn = await eventually(
      () => readVisibleTool(desktopApp, chatA, laterTool.callId),
      {
        within: 30_000,
        intervalMs: 250,
        label: "tool started while away visibly rendered after returning",
        until: (fact) => fact.currentSessionId === chatA && fact.found && fact.visible,
      },
    );
    expect(visibleAfterReturn.currentSessionId).toBe(chatA);
    expect(visibleAfterReturn.found, JSON.stringify(visibleAfterReturn)).toBe(true);
    expect(visibleAfterReturn.visible, JSON.stringify(visibleAfterReturn)).toBe(true);
    expect(visibleAfterReturn.text).toContain(completionMarker);
    evidence.recordAssertionEvidence(
      "A tool that started while away is visible when the user returns to its chat",
      `The first tool completed and tool ${laterTool.callId} started while workspace B chat ${chatB} was visible; after returning to workspace A chat ${chatA}, scoped CDP found its visible row with text ${JSON.stringify(visibleAfterReturn.text)}.`,
      true,
    );
    await screenshot(desktopApp);

    const completed = await eventually(
      () => readSessionFacts(desktopApp, workspaceA.workspaceId, chatA),
      {
        within: 90_000,
        intervalMs: 500,
        label: "chat A unique bash tool completed",
        until: (facts) => facts.text.includes(completionMarker)
          && facts.tools.some((tool) => tool.status === "completed" && tool.command === command),
      },
    );
    expect(completed.text).toContain(completionMarker);
    const visibleAfterCompletion = await eventually(
      () => readVisibleTool(desktopApp, chatA, laterTool.callId),
      {
        within: 30_000,
        intervalMs: 250,
        label: "completed tool remains visibly rendered",
        until: (fact) => fact.currentSessionId === chatA && fact.found && fact.visible,
      },
    );
    expect(visibleAfterCompletion.visible).toBe(true);
  },
);
