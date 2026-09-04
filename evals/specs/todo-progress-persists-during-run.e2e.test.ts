import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  selectModel,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
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

const providerId = "todo-progress-mock";
const modelId = "todo-progress-model";
const modelName = "Todo progress model";
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

// TanStack Query used to garbage-collect the zero-observer todo cache entry
// 15s after the first todowrite, which hid the panel mid-run. Sample well
// past that window.
const gcWindowMs = 15_000;
const observeForMs = 22_000;
const sampleIntervalMs = 500;

interface PanelFact {
  currentSessionId: string;
  found: boolean;
  visible: boolean;
  completed: number;
  total: number;
  label: string;
}

interface SessionFacts {
  sessionId: string;
  runningBash: boolean;
  todoCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePanelFact(value: unknown): PanelFact {
  if (!isRecord(value)) throw new Error(`Invalid panel fact: ${JSON.stringify(value)}`);
  return {
    currentSessionId: typeof value.currentSessionId === "string" ? value.currentSessionId : "",
    found: value.found === true,
    visible: value.visible === true,
    completed: typeof value.completed === "number" ? value.completed : -1,
    total: typeof value.total === "number" ? value.total : -1,
    label: typeof value.label === "string" ? value.label : "",
  };
}

function parseSessionFacts(value: unknown): SessionFacts {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error(`Invalid session facts: ${JSON.stringify(value)}`);
  }
  return {
    sessionId: value.sessionId,
    runningBash: value.runningBash === true,
    todoCount: typeof value.todoCount === "number" ? value.todoCount : 0,
  };
}

async function configureWorkspace(appSurface: App, workspaceId: string, baseUrl: string): Promise<void> {
  const result = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return "local_server_unavailable";
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const configured = await fetch(root + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        opencode: {
          permission: { bash: "allow", todowrite: "allow" },
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: ${JSON.stringify(modelName)},
              options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-todo-progress" },
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
    const reloaded = await fetch(root + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/engine/reload", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60000),
    });
    if (!reloaded.ok) return "reload:" + reloaded.status + ":" + (await reloaded.text()).slice(0, 300);
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
        { method: "POST", headers, body: JSON.stringify({ reply: "once" }), signal: AbortSignal.timeout(10000) },
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

async function readSessionFacts(appSurface: App, workspaceId: string, sessionId: string, command: string): Promise<SessionFacts> {
  const value = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { sessionId: "", runningBash: false, todoCount: 0 };
    const base = String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
      + "/opencode/session/" + encodeURIComponent(${JSON.stringify(sessionId)});
    const options = {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    };
    const [messagesResponse, todosResponse] = await Promise.all([
      fetch(base + "/message?limit=50", options),
      fetch(base + "/todo", options),
    ]);
    if (!messagesResponse.ok || !todosResponse.ok) return { sessionId: "", runningBash: false, todoCount: 0 };
    const [messages, todos] = await Promise.all([messagesResponse.json(), todosResponse.json()]);
    const parts = (Array.isArray(messages) ? messages : []).flatMap((message) => Array.isArray(message?.parts) ? message.parts : []);
    const runningBash = parts.some((part) => part?.tool === "bash"
      && part?.state?.status === "running"
      && part?.state?.input?.command === ${JSON.stringify(command)});
    return {
      sessionId: ${JSON.stringify(sessionId)},
      runningBash,
      todoCount: Array.isArray(todos) ? todos.length : 0,
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  return parseSessionFacts(value);
}

async function expandTodoPanel(appSurface: App, sessionId: string, expectedItems: string[]): Promise<void> {
  const clicked = await evalIn(appSurface, `(() => {
    const surface = document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionId}"]`)});
    const button = surface?.querySelector("[data-todo-progress-panel] button");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  expect(clicked, "todo panel toggle button present").toBe(true);
  await waitFor(appSurface, `(() => {
    const panel = document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionId}"] [data-todo-progress-panel]`)});
    const text = panel instanceof HTMLElement ? panel.innerText : "";
    return ${JSON.stringify(expectedItems)}.every((item) => text.includes(item));
  })()`, { timeoutMs: 10_000, label: "todo panel expanded with every item listed" });
}

async function readTodoPanel(appSurface: App, sessionId: string): Promise<PanelFact> {
  const value = await evalIn(appSurface, `(() => {
    const currentSessionId = document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "";
    const surface = document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionId}"]`)});
    if (!(surface instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, completed: -1, total: -1, label: "" };
    const panel = surface.querySelector("[data-todo-progress-panel]");
    if (!(panel instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, completed: -1, total: -1, label: "" };
    const style = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    const visible = panel.isConnected
      && rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0";
    return {
      currentSessionId,
      found: true,
      visible,
      completed: Number(panel.getAttribute("data-todo-progress-completed")),
      total: Number(panel.getAttribute("data-todo-progress-total")),
      label: panel.querySelector("button")?.innerText ?? "",
    };
  })()`);
  return parsePanelFact(value);
}

test.skipIf(!runnable)(
  `the todo progress panel stays above the composer for the whole run${skipSuffix}`,
  { timeout: 10 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const promptMarker = `TODO-PROGRESS-${runId}`;
    const completionMarker = `DONE-${promptMarker}`;
    const holdSeconds = Math.ceil((observeForMs + 15_000) / 1000);
    const command = `sleep ${holdSeconds} && printf '%s\\n' '${completionMarker}'`;
    const todos = [
      { id: "todo-1", content: `Plan the work for ${promptMarker}`, status: "completed", priority: "high" },
      { id: "todo-2", content: `Run the long step for ${promptMarker}`, status: "in_progress", priority: "high" },
      { id: "todo-3", content: `Report back for ${promptMarker}`, status: "pending", priority: "medium" },
    ];

    await using den = await server({
      place,
      mocks: {
        agent: mcpMock({
          agentWorkloads: [{
            promptMarker,
            finalReply: completionMarker,
            steps: [
              { tool: "todowrite", arguments: { todos } },
              { tool: "bash", arguments: { command, timeout: 120_000, description: `Hold the run — ${promptMarker}` } },
            ],
          }],
        }),
      },
      org: {
        name: "Todo Progress",
        admin: { name: "Todo Admin" },
        members: { member: { name: "Todo Member" } },
      },
    });
    await using desktopApp = await app({ den, as: "member", place });

    const workspace = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-todo-progress-${runId}`,
    });
    await configureWorkspace(desktopApp, workspace.workspaceId, den.mocks.agent.url);
    const chat = await createSession(desktopApp);
    const selected = await selectModel(desktopApp, modelId);
    expect(selected.id).toBe(modelId);

    const beforeSend = await readTodoPanel(desktopApp, chat);
    expect(beforeSend.found, "no todo panel before the agent writes todos").toBe(false);

    await writeComposerText(desktopApp, `Run the deterministic plan identified by ${promptMarker}.`);
    await control(desktopApp, "composer.send", undefined, { timeoutMs: 120_000 });

    const appeared = await eventually(async () => {
      await approvePendingPermission(desktopApp, workspace.workspaceId, chat);
      const panel = await readTodoPanel(desktopApp, chat);
      const facts = await readSessionFacts(desktopApp, workspace.workspaceId, chat, command);
      return { panel, facts };
    }, {
      within: 120_000,
      intervalMs: 500,
      label: "todo panel visible while the held bash tool runs",
      until: ({ panel, facts }) => panel.currentSessionId === chat
        && panel.found
        && panel.visible
        && panel.total === todos.length
        && facts.runningBash,
    });
    expect(appeared.panel.completed).toBe(1);
    expect(appeared.panel.total).toBe(todos.length);
    expect(appeared.panel.label).toContain(`1/${todos.length}`);
    expect(appeared.facts.todoCount).toBe(todos.length);
    await expandTodoPanel(desktopApp, chat, todos.map((todo) => todo.content));
    const midRunShot = await screenshot(desktopApp);
    const midRunValidation = await validate(midRunShot, [
      "A chat session is open with a message composer at the bottom",
      "A Progress panel above the composer lists three todo items",
      "Exactly one todo item is shown as completed (checked) and the other two are not completed",
      "One todo item is shown as in progress and one as pending",
      "The agent is visibly still working, e.g. a running bash tool or Thinking indicator",
      "No error, sign-in, or crash screen is visible",
    ]);
    expect(midRunValidation.ok, midRunValidation.why).toBe(true);

    // Sample continuously past the old 15s GC window while the run is still
    // busy. Every sample must show the panel with unchanged counts; the run
    // must still be holding so a disappearance cannot be explained by
    // completion.
    const startedAt = Date.now();
    const samples: Array<{ elapsedMs: number; panel: PanelFact }> = [];
    while (Date.now() - startedAt < observeForMs) {
      const panel = await readTodoPanel(desktopApp, chat);
      samples.push({ elapsedMs: Date.now() - startedAt, panel });
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
    const stillHolding = await readSessionFacts(desktopApp, workspace.workspaceId, chat, command);
    expect(stillHolding.runningBash, "the held bash tool must still be running after the observation window").toBe(true);

    const missing = samples.filter(({ panel }) => !(panel.found && panel.visible && panel.completed === 1 && panel.total === todos.length));
    const lastSample = samples[samples.length - 1];
    expect(lastSample?.elapsedMs ?? 0).toBeGreaterThan(gcWindowMs);
    expect(missing, `todo panel disappeared or changed at ${JSON.stringify(missing.map((sample) => ({ at: sample.elapsedMs, ...sample.panel })))}`).toEqual([]);
    evidence.recordAssertionEvidence(
      "The todo progress panel does not disappear during a running turn",
      `Sampled the panel ${samples.length} times over ${lastSample?.elapsedMs ?? 0}ms (past the ${gcWindowMs}ms GC window) while bash was still running; every sample showed a visible panel at 1/${todos.length}.`,
      true,
    );

    const completed = await eventually(async () => {
      const facts = await readSessionFacts(desktopApp, workspace.workspaceId, chat, command);
      const panel = await readTodoPanel(desktopApp, chat);
      return { facts, panel };
    }, {
      within: 120_000,
      intervalMs: 500,
      label: "held bash tool completes with the todo panel still shown",
      until: ({ facts }) => !facts.runningBash,
    });
    expect(completed.panel.found, "todo panel remains after the run finishes").toBe(true);
    expect(completed.panel.visible).toBe(true);
    expect(completed.panel.total).toBe(todos.length);
    const afterRunShot = await screenshot(desktopApp);
    const afterRunValidation = await validate(afterRunShot, [
      "A Progress panel above the composer still lists three todo items after the agent finished",
      "Exactly one todo item is shown as completed and the other two are not completed",
      "The agent's final reply is visible in the chat and no tool is still running",
    ]);
    expect(afterRunValidation.ok, afterRunValidation.why).toBe(true);
  },
);
