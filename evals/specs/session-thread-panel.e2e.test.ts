import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
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

const providerId = "thread-panel-mock";
const modelId = "thread-panel-model";
const modelName = "Thread panel model";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ThreadPanelFileFact {
  file: string;
  additions: number;
  deletions: number;
}

interface ThreadPanelCommandFact {
  command: string;
  status: string;
  exitCode: string;
}

interface ThreadPanelFacts {
  panelOpen: boolean;
  totalAdditions: number;
  totalDeletions: number;
  files: ThreadPanelFileFact[];
  commands: ThreadPanelCommandFact[];
}

function parseThreadPanelFacts(value: unknown): ThreadPanelFacts {
  if (!isRecord(value)) throw new Error(`Invalid thread panel facts: ${JSON.stringify(value)}`);
  const files: ThreadPanelFileFact[] = [];
  if (Array.isArray(value.files)) {
    for (const candidate of value.files) {
      if (!isRecord(candidate)) continue;
      files.push({
        file: typeof candidate.file === "string" ? candidate.file : "",
        additions: typeof candidate.additions === "number" ? candidate.additions : Number.NaN,
        deletions: typeof candidate.deletions === "number" ? candidate.deletions : Number.NaN,
      });
    }
  }
  const commands: ThreadPanelCommandFact[] = [];
  if (Array.isArray(value.commands)) {
    for (const candidate of value.commands) {
      if (!isRecord(candidate)) continue;
      commands.push({
        command: typeof candidate.command === "string" ? candidate.command : "",
        status: typeof candidate.status === "string" ? candidate.status : "",
        exitCode: typeof candidate.exitCode === "string" ? candidate.exitCode : "",
      });
    }
  }
  return {
    panelOpen: value.panelOpen === true,
    totalAdditions: typeof value.totalAdditions === "number" ? value.totalAdditions : Number.NaN,
    totalDeletions: typeof value.totalDeletions === "number" ? value.totalDeletions : Number.NaN,
    files,
    commands,
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
          permission: { bash: "allow", edit: "allow" },
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: ${JSON.stringify(modelName)},
              options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-thread-panel" },
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

interface SessionToolFact {
  tool: string;
  status: string;
  error: string;
}

interface SessionRunFacts {
  text: string;
  status: string;
  tools: SessionToolFact[];
}

function parseSessionRunFacts(value: unknown): SessionRunFacts {
  if (!isRecord(value)) throw new Error(`Invalid session run facts: ${JSON.stringify(value)}`);
  const tools: SessionToolFact[] = [];
  if (Array.isArray(value.tools)) {
    for (const candidate of value.tools) {
      if (!isRecord(candidate)) continue;
      tools.push({
        tool: typeof candidate.tool === "string" ? candidate.tool : "",
        status: typeof candidate.status === "string" ? candidate.status : "",
        error: typeof candidate.error === "string" ? candidate.error : "",
      });
    }
  }
  return {
    text: typeof value.text === "string" ? value.text : "",
    status: typeof value.status === "string" ? value.status : "",
    tools,
  };
}

async function readSessionRunFacts(appSurface: App, workspaceId: string, sessionId: string): Promise<SessionRunFacts> {
  const value = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { text: "", status: "server_unavailable", tools: [] };
    const root = String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
      + "/opencode/session";
    const options = {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    };
    const encodedSessionId = encodeURIComponent(${JSON.stringify(sessionId)});
    const [messagesResponse, statusResponse] = await Promise.all([
      fetch(root + "/" + encodedSessionId + "/message?limit=50", options),
      fetch(root + "/status", options),
    ]);
    if (!messagesResponse.ok) return { text: "", status: "messages:" + messagesResponse.status, tools: [] };
    const messages = await messagesResponse.json();
    const statuses = statusResponse.ok ? await statusResponse.json() : {};
    const sessionStatus = statuses?.[${JSON.stringify(sessionId)}];
    const parts = (Array.isArray(messages) ? messages : []).flatMap((message) => Array.isArray(message?.parts) ? message.parts : []);
    return {
      text: parts.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("\\n"),
      status: JSON.stringify(sessionStatus ?? null),
      tools: parts.flatMap((part) => {
        if (!part || typeof part.tool !== "string") return [];
        const state = part.state && typeof part.state === "object" ? part.state : {};
        return [{
          tool: part.tool,
          status: typeof state.status === "string" ? state.status : "",
          error: typeof state.error === "string" ? state.error.slice(0, 200) : "",
        }];
      }),
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  return parseSessionRunFacts(value);
}

async function readThreadPanelFacts(appSurface: App, sessionId: string): Promise<ThreadPanelFacts> {
  const value = await evalIn(appSurface, `(() => {
    const panel = document.querySelector(${JSON.stringify(`[data-thread-panel="${sessionId}"]`)});
    if (!(panel instanceof HTMLElement)) {
      return { panelOpen: false, totalAdditions: -1, totalDeletions: -1, files: [], commands: [] };
    }
    const totals = panel.querySelector("[data-thread-additions]");
    const files = Array.from(panel.querySelectorAll("[data-thread-file]")).map((row) => ({
      file: row.getAttribute("data-thread-file") ?? "",
      additions: Number(row.getAttribute("data-additions") ?? "-1"),
      deletions: Number(row.getAttribute("data-deletions") ?? "-1"),
    }));
    const commands = Array.from(panel.querySelectorAll("[data-thread-command]")).map((row) => ({
      command: row.querySelector("code")?.textContent ?? "",
      status: row.getAttribute("data-status") ?? "",
      exitCode: row.getAttribute("data-exit-code") ?? "",
    }));
    return {
      panelOpen: true,
      totalAdditions: Number(totals?.getAttribute("data-thread-additions") ?? "-1"),
      totalDeletions: Number(totals?.getAttribute("data-thread-deletions") ?? "-1"),
      files,
      commands,
    };
  })()`);
  return parseThreadPanelFacts(value);
}

test.skipIf(!runnable)(
  `the thread panel aggregates a session's file changes and terminal commands${skipSuffix}`,
  { timeout: 12 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const promptMarker = `THREAD-PANEL-${runId}`;
    const completionMarker = `DONE-${promptMarker}`;
    const workspacePath = `/tmp/openwork-thread-panel-${runId}`;
    const notesContent = "one\ntwo\nthree\nfour\nfive";
    const notesLineCount = notesContent.split("\n").length;
    const command = `printf 'alpha\\nbeta\\ngamma\\n' > thread-panel-proof.txt`;

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
                  command,
                  timeout: 30_000,
                  description: `Create the thread panel proof file — ${promptMarker}`,
                },
              },
              {
                tool: "write",
                arguments: {
                  filePath: "thread-panel-notes.md",
                  content: notesContent,
                },
              },
            ],
          }],
        }),
      },
      org: {
        name: "Thread Panel",
        admin: { name: "Thread Admin" },
        members: { member: { name: "Thread Member" } },
      },
    });
    await using desktopApp = await app({ den, as: "member", place });

    const workspace = await createAndSelectWorkspace(desktopApp, { path: workspacePath });
    await configureWorkspace(desktopApp, workspace.workspaceId, den.mocks.agent.url);
    const sessionId = await createSession(desktopApp);
    // The scripted provider was written as the default model before reload;
    // require the composer to show it instead of driving the model picker.
    await waitFor(
      desktopApp,
      `document.body.innerText.includes(${JSON.stringify(modelId)})`,
      { timeoutMs: 60_000, label: `composer shows default model ${modelId}` },
    );
    await writeComposerText(desktopApp, `Run the deterministic tools identified by ${promptMarker}.`);
    await control(desktopApp, "composer.send", undefined, { timeoutMs: 120_000 });

    // Prove the engine actually called the scripted provider before waiting
    // on the run, so a config failure surfaces as its own step.
    const agentRequests = await den.mocks.agent.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 120_000 });
    expect(agentRequests.length).toBeGreaterThanOrEqual(1);

    // The scripted run: bash creates the proof file, write adds the notes
    // file, and the final reply publishes the completion marker.
    const finalFacts = await eventually(async () => {
      await approvePendingPermission(desktopApp, workspace.workspaceId, sessionId);
      return readSessionRunFacts(desktopApp, workspace.workspaceId, sessionId);
    }, {
      within: 180_000,
      intervalMs: 500,
      label: "scripted bash + write run completed",
      until: (facts) => facts.text.includes(completionMarker),
    });
    expect(finalFacts.text).toContain(completionMarker);

    // Make the session surface the visible route before using its panel
    // affordances; task creation alone does not guarantee navigation.
    await control(desktopApp, "session.open", { sessionId }, { timeoutMs: 30_000 });
    await waitFor(desktopApp, `(() => {
      const surface = document.querySelector("[data-session-surface-id]");
      return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)};
    })()`, { timeoutMs: 60_000, label: "session surface visible before opening the thread panel" });
    await waitFor(
      desktopApp,
      "Boolean(window.__openworkControl?.listActions?.().some((action) => action.id === \"thread.panel.open\"))",
      { timeoutMs: 30_000, label: "thread.panel.open control action registered" },
    );

    const opened = await control(desktopApp, "thread.panel.open", undefined, { timeoutMs: 30_000 });
    expect(opened).toMatchObject({ open: true });

    const facts = await eventually(
      () => readThreadPanelFacts(desktopApp, sessionId),
      {
        within: 30_000,
        intervalMs: 250,
        label: "thread panel shows the session's changed file and command",
        until: (candidate) => candidate.panelOpen
          && candidate.files.some((file) => file.file.endsWith("thread-panel-notes.md") && file.additions >= 1)
          && candidate.commands.some((entry) => entry.command.includes("thread-panel-proof.txt") && entry.exitCode === "0"),
      },
    );

    const changedFile = facts.files.find((file) => file.file.endsWith("thread-panel-notes.md"));
    if (!changedFile) throw new Error(`The written file never appeared in the thread panel: ${JSON.stringify(facts)}`);
    expect(changedFile.additions).toBe(notesLineCount);
    expect(changedFile.deletions).toBe(0);
    expect(facts.totalAdditions).toBeGreaterThanOrEqual(changedFile.additions);
    const bashRow = facts.commands.find((entry) => entry.command.includes("thread-panel-proof.txt"));
    if (!bashRow) throw new Error(`The bash command never appeared in the thread panel: ${JSON.stringify(facts)}`);
    expect(bashRow.status).toBe("completed");
    expect(bashRow.exitCode).toBe("0");

    evidence.recordAssertionEvidence(
      "The thread panel aggregates the session's changes and terminal activity",
      `After a scripted run in session ${sessionId}, thread.panel.open rendered the panel with ${JSON.stringify(changedFile)} `
        + `under Changes (totals +${facts.totalAdditions} −${facts.totalDeletions}) and the creating bash command with exit code 0 under Terminal.`,
      true,
    );
    await screenshot(desktopApp);

    const closed = await control(desktopApp, "thread.panel.close", undefined, { timeoutMs: 30_000 });
    expect(closed).toMatchObject({ open: false });
    const afterClose = await readThreadPanelFacts(desktopApp, sessionId);
    expect(afterClose.panelOpen).toBe(false);
  },
);
