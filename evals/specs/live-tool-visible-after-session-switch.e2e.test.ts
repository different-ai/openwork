import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  engineSessionProbe,
  evalIn,
  go,
  selectModel,
  waitFor,
  waitForText,
  writeComposerText,
} from "@openwork/behaviors";
import { resolveEvalEngine } from "@openwork/env";
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
const evalEngine = resolveEvalEngine();
const shellToolName = evalEngine === "v2" ? "shell" : "bash";
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
  tool: string;
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
  const result = await evalIn(appSurface, browserScript(async (workspaceIds, providerId, modelName, value, modelId, inputModelName, inputProviderId, inputModelId, inputValue) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return "local_server_unavailable";
    const root = String(info.baseUrl).replace(/\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    for (const workspaceId of workspaceIds) {
      const configured = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { bash: "allow" },
            provider: {
              [providerId]: {
                npm: "@ai-sdk/openai-compatible",
                name: modelName,
                options: { baseURL: value, apiKey: "sk-live-tool-switch" },
                models: {
                  [modelId]: { name: inputModelName, tool_call: true },
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
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: inputProviderId, modelID: inputModelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", inputValue);
    return "ok";
  }, [workspaceIds, providerId, modelName, `${baseUrl}/v1`, modelId, modelName, providerId, modelId, `${providerId}/${modelId}`]), { awaitPromise: true, timeoutMs: 120_000 });
  expect(result).toBe("ok");

  await evalIn(appSurface, () => { location.reload(); return true; });
  await waitFor(appSurface, () => (Boolean(window.__openworkControl)), {
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

async function openNewTask(appSurface: App, workspaceId: string): Promise<void> {
  await go(appSurface, `/workspace/${workspaceId}/session`);
  await waitForText(appSurface, "What do you need done?", { timeoutMs: 60_000 });
}

async function clickSessionRow(appSurface: App, workspaceId: string, sessionId: string): Promise<void> {
  const clicked = await evalIn(appSurface, browserScript((value, inputValue) => {
    const row = document.querySelector<HTMLElement>(value);
    const control = row?.querySelector<HTMLElement>(inputValue);
    if (!(row instanceof HTMLElement) || !(control instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    control.click();
    return true;
  }, [`[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]`, `[data-session-tab-id="${sessionId}"]`]));
  expect(clicked).toBe(true);
  await waitFor(appSurface, browserScript((sessionId, workspaceId) => {
    const surface = document.querySelector<HTMLElement>("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === sessionId
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === workspaceId;
  }, [sessionId, workspaceId]), { timeoutMs: 60_000, label: `workspace ${workspaceId} session ${sessionId} visible after sidebar click` });
}

async function readSessionFacts(appSurface: App, workspaceId: string, sessionId: string): Promise<SessionFacts> {
  const probe = engineSessionProbe({
    engine: evalEngine,
    surface: appSurface,
    workspaceId,
  });
  const snapshot = await probe.snapshot(sessionId);
  if (!snapshot.ok) return { sessionId: "", text: "", tools: [] };
  const parts = snapshot.data.messages.flatMap((message) => message.parts);
  return {
    sessionId: snapshot.data.session?.id ?? "",
    text: parts.flatMap((part) => part.text ? [part.text] : []).join("\n"),
    tools: parts.flatMap((part) => {
      if (!part.tool) return [];
      return [{
        tool: part.tool,
        callId: part.callId,
        status: part.status,
        command: typeof part.input.command === "string" ? part.input.command : "",
        description: typeof part.input.description === "string" ? part.input.description : "",
      }];
    }),
  };
}

async function approvePendingPermission(appSurface: App, workspaceId: string, sessionId: string): Promise<number> {
  const statuses = await engineSessionProbe({
    engine: evalEngine,
    surface: appSurface,
    workspaceId,
  }).approvePendingPermissions(sessionId);
  if (statuses.some((status) => status < 200 || status >= 300)) {
    throw new Error(`Permission approval failed: ${JSON.stringify(statuses)}`);
  }
  return statuses.length;
}

async function expectLeftSessionIndicator(appSurface: App, sessionId: string, kind: "loading" | "attention"): Promise<void> {
  const fact = await eventually(() => evalIn(appSurface, browserScript((sessionId, value) => {
    const row = document.querySelector<HTMLElement>('[data-sidebar-session-id="' + CSS.escape(sessionId) + '"]');
    const title = row?.querySelector<HTMLElement>("[data-session-title-slot]");
    const indicators = row?.querySelectorAll<HTMLElement>("[data-session-loading-indicator], [data-session-attention-indicator]");
    const indicator = row?.querySelector<HTMLElement>(value);
    if (!(title instanceof HTMLElement) || !(indicator instanceof HTMLElement)) return false;
    const box = indicator.getBoundingClientRect();
    const style = getComputedStyle(indicator);
    return indicators?.length === 1 && box.width > 0 && box.height > 0
      && box.right <= title.getBoundingClientRect().left
      && style.visibility === "visible" && style.opacity === "1";
  }, [sessionId, `[data-session-${kind}-indicator]`])), {
    within: 15_000,
    intervalMs: 250,
    label: `exactly one visible ${kind} indicator before the session title`,
    until: (value) => value === true,
  });
  expect(fact).toBe(true);
}

async function readVisibleTool(
  appSurface: App,
  sessionId: string,
  toolCallId: string,
): Promise<VisibleToolFact> {
  const value = await evalIn(appSurface, browserScript((value, toolCallId) => {
    const surface = document.querySelector<HTMLElement>(value);
    const currentSessionId = document.querySelector<HTMLElement>("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "";
    if (!(surface instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, text: "" };
    const row = surface.querySelector<HTMLElement>('[data-tool-aggregate="' + CSS.escape(toolCallId) + '"]');
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
  }, [`[data-session-surface-id="${sessionId}"]`, toolCallId]));
  return parseVisibleToolFact(value);
}

async function readTranscript(appSurface: App, sessionId: string) {
  return evalIn(appSurface, browserScript((sessionId) => {
    const surface = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
    return {
      sessionId: surface?.getAttribute("data-session-surface-id") ?? "",
      text: surface?.innerText ?? "",
      userText: [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="user"]') ?? [])]
        .map((message) => message.innerText).join("\n"),
      assistantText: [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="assistant"]') ?? [])]
        .map((message) => message.innerText).join("\n"),
    };
  }, [sessionId]));
}

async function queueFollowUp(appSurface: App, sessionId: string, text: string, count: number) {
  await writeComposerText(appSurface, text);
  // Enter is the user-facing queue action while busy; composer.send would steer.
  expect(await evalIn(appSurface, browserScript((sessionId) => {
    const editor = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"] [contenteditable="true"]`);
    if (!editor) return false;
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  }, [sessionId]))).toBe(true);
  await waitForText(appSurface, `${count} queued`, { timeoutMs: 10_000 });
  expect((await readTranscript(appSurface, sessionId)).text).toContain(text);
}

// Run the identical journey with OPENWORK_EVAL_ENGINE=v1 and v2. Keep the
// cross-workspace regression as well as creating a second task in one workspace.
for (const scope of ["same workspace", "different workspaces"]) {
test.skipIf(!runnable)(
  `two long-running chats restore live transcripts and drain isolated queues — ${scope}, ${evalEngine}${skipSuffix}`,
  { timeout: 12 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const promptMarker = `LIVE-TOOL-SWITCH-${runId}`;
    const firstMarker = `FIRST-${promptMarker}`;
    const firstToolDescription = `First tool in chat A — ${promptMarker}`;
    const toolDescription = `Waiting in chat A — ${promptMarker}`;
    const completionMarker = `DONE-${promptMarker}`;
    const replyA = `REPLY-A-${runId}`;
    const promptB = `SECOND-CHAT-${runId}`;
    const replyB = `REPLY-B-${runId}`;
    const progressA = `PROGRESS-A-${runId}`;
    const continuedProgressA = `CONTINUED-A-${runId}`;
    const progressB = `PROGRESS-B-${runId}`;
    const queuedA = [`FOLLOW-UP-A1-${runId}`, `FOLLOW-UP-A2-${runId}`];
    const queuedB = `FOLLOW-UP-B-${runId}`;
    const queuedRepliesA = [`ANSWER-A1-${runId}`, `ANSWER-A2-${runId}`];
    const queuedReplyB = `ANSWER-B-${runId}`;
    const commandB = `sleep 180 && printf '%s\\n' 'TOOL-B-${runId}'`;
    const firstCommand = `sleep 45 && printf '%s\\n' '${firstMarker}'`;
    const command = `sleep 45 && printf '%s\\n' '${completionMarker}'`;
    const continuedCommand = `sleep 30 && printf '%s\\n' 'LAST-TOOL-A-${runId}'`;
    const matchesDescription = (tool: ToolFact, description: string) =>
      evalEngine === "v2" || tool.description === description;

    await using den = await server({
      place,
      mocks: {
        agent: mcpMock({
          agentWorkloads: [{
            promptMarker,
            latestUserTurn: true,
            finalReply: replyA,
            finalReplyChunkSize: 4,
            steps: [
              {
                tool: shellToolName,
                arguments: {
                  command: firstCommand,
                  timeout: 90_000,
                  ...(evalEngine === "v1" ? { description: firstToolDescription } : {}),
                },
              },
              {
                tool: shellToolName,
                text: progressA,
                arguments: {
                  command,
                  timeout: 90_000,
                  ...(evalEngine === "v1" ? { description: toolDescription } : {}),
                },
              },
              {
                tool: shellToolName,
                text: continuedProgressA,
                arguments: {
                  command: continuedCommand,
                  timeout: 90_000,
                  ...(evalEngine === "v1" ? { description: "Chat A continues after returning" } : {}),
                },
              },
            ],
          }, {
            promptMarker: promptB,
            latestUserTurn: true,
            finalReply: replyB,
            finalReplyChunkSize: 4,
            steps: [{
              tool: shellToolName,
              text: progressB,
              arguments: {
                command: commandB,
                timeout: 240_000,
                ...(evalEngine === "v1" ? { description: "Long-running tool in chat B" } : {}),
              },
            }],
          }, ...queuedA.map((promptMarker, index) => ({
            promptMarker,
            latestUserTurn: true,
            finalReply: queuedRepliesA[index],
            finalReplyDelayMs: 1000,
            steps: [],
          })), {
            promptMarker: queuedB,
            latestUserTurn: true,
            finalReply: queuedReplyB,
            steps: [],
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

    const workspaceA = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-live-tool-switch-${runId}-a`,
    });
    const workspaceB = scope === "same workspace" ? workspaceA : await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-live-tool-switch-${runId}-b`,
      create: true,
    });
    expect(workspaceA.workspaceId === workspaceB.workspaceId).toBe(scope === "same workspace");
    await configureWorkspaces(desktopApp, [...new Set([workspaceA.workspaceId, workspaceB.workspaceId])], den.mocks.agent.url);
    await openNewTask(desktopApp, workspaceA.workspaceId);
    const chatA = await createSession(desktopApp);
    await control(desktopApp, "session.rename", { sessionId: chatA, title: "Chat A" });

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
      label: `chat A first ${shellToolName} tool running`,
      until: ({ approved, facts }) => approved === 0
        && facts.sessionId === chatA
        && facts.tools.some((tool) =>
        tool.tool === shellToolName
          && tool.status === "running"
          && tool.command === firstCommand
          && matchesDescription(tool, firstToolDescription)),
    });
    expect(running.facts.sessionId).toBe(chatA);
    const runningTool = running.facts.tools.find((tool) => tool.command === firstCommand);
    if (!runningTool?.callId) throw new Error(`The running ${shellToolName} tool had no call ID: ${JSON.stringify(running.facts)}`);

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
    await expectLeftSessionIndicator(desktopApp, chatA, "loading");

    // The second session must not exist until A is observably still loading.
    await openNewTask(desktopApp, workspaceB.workspaceId);
    const chatB = await createSession(desktopApp);
    expect(chatB).not.toBe(chatA);
    await control(desktopApp, "session.rename", { sessionId: chatB, title: "Chat B" });
    await clickSessionRow(desktopApp, workspaceB.workspaceId, chatB);
    expect((await selectModel(desktopApp, modelId)).id).toBe(modelId);
    await writeComposerText(desktopApp, `Run the deterministic tool identified by ${promptB}.`);
    await control(desktopApp, "composer.send", undefined, { timeoutMs: 120_000 });
    const runningB = await eventually(async () => {
      await approvePendingPermission(desktopApp, workspaceB.workspaceId, chatB);
      return readSessionFacts(desktopApp, workspaceB.workspaceId, chatB);
    }, {
      within: 60_000,
      intervalMs: 500,
      label: "newly created chat B has its own long-running tool",
      until: (facts) => facts.sessionId === chatB && facts.tools.some((tool) =>
        tool.tool === shellToolName && tool.status === "running" && tool.command === commandB),
    });
    const toolB = runningB.tools.find((tool) => tool.command === commandB);
    if (!toolB?.callId) throw new Error("Chat B's running tool has no call ID");
    const overlappingA = await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    expect(overlappingA.tools.some((tool) => tool.status === "running")).toBe(true);
    await expectLeftSessionIndicator(desktopApp, chatA, "loading");
    await expectLeftSessionIndicator(desktopApp, chatB, "loading");
    evidence.recordAssertionEvidence(
      "Creating a second long-running session does not stop the first",
      `${evalEngine}, ${scope}: B was created after A's first tool was visibly running; both sessions have running tools and loading indicators.`,
      true,
    );
    const absentFromChatB = await readVisibleTool(desktopApp, chatB, runningTool.callId);
    expect(absentFromChatB.currentSessionId).toBe(chatB);
    expect(absentFromChatB.found).toBe(false);
    expect((await readTranscript(desktopApp, chatB)).text).not.toContain(promptMarker);
    await queueFollowUp(desktopApp, chatB, queuedB, 1);
    expect((await readSessionFacts(desktopApp, workspaceB.workspaceId, chatB)).text).not.toContain(queuedB);

    const laterRunning = await eventually(async () => {
      await approvePendingPermission(desktopApp, workspaceA.workspaceId, chatA);
      return readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    }, {
      within: 60_000,
      intervalMs: 500,
      label: "second chat A tool started while workspace B is visible",
      until: (facts) => facts.tools.some((tool) => tool.tool === shellToolName
        && tool.status === "completed" && tool.callId === runningTool.callId)
        && facts.tools.some((tool) => tool.tool === shellToolName
          && tool.status === "running" && tool.command === command && matchesDescription(tool, toolDescription)),
    });
    const laterTool = laterRunning.tools.find((tool) => tool.command === command);
    if (!laterTool?.callId) throw new Error(`The later ${shellToolName} tool had no call ID: ${JSON.stringify(laterRunning)}`);
    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
    const stillRunning = await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    expect(stillRunning.tools.some((tool) =>
      tool.tool === shellToolName
        && tool.status === "running"
        && tool.callId === laterTool.callId
        && matchesDescription(tool, toolDescription)), JSON.stringify(stillRunning)).toBe(true);

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
    expect((await readVisibleTool(desktopApp, chatA, toolB.callId)).found).toBe(false);
    const beforeCompletion = await eventually(() => readTranscript(desktopApp, chatA), {
      within: 10_000,
      intervalMs: 250,
      label: "user message and intermediate assistant text restored before completion",
      until: (fact) => fact.userText.includes(promptMarker) && fact.assistantText.includes(progressA),
    });
    expect(beforeCompletion.userText).toContain(promptMarker);
    expect(beforeCompletion.assistantText).toContain(progressA);
    expect(beforeCompletion.text).not.toContain(promptB);
    expect(beforeCompletion.assistantText).not.toContain(replyA);
    expect(beforeCompletion.assistantText).not.toContain(replyB);
    // Check AFTER the DOM assertions: waiting until completion must not pass.
    expect((await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA)).tools
      .some((tool) => tool.callId === laterTool.callId && tool.status === "running")).toBe(true);
    await queueFollowUp(desktopApp, chatA, queuedA[0], 1);
    await queueFollowUp(desktopApp, chatA, queuedA[1], 2);
    const heldA = await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA);
    expect(heldA.text).not.toContain(queuedA[0]);
    expect(heldA.text).not.toContain(queuedA[1]);
    expect(heldA.tools.some((tool) => tool.status === "running")).toBe(true);
    evidence.recordAssertionEvidence(
      "A tool that started while away is visible when the user returns to its chat",
      `The first tool completed and tool ${laterTool.callId} started while workspace B chat ${chatB} was visible; after returning to workspace A chat ${chatA}, scoped CDP found its visible row with text ${JSON.stringify(visibleAfterReturn.text)}.`,
      true,
    );
    await screenshot(desktopApp);

    const continuedTool = await eventually(() => readSessionFacts(desktopApp, workspaceA.workspaceId, chatA), {
      within: 60_000,
      intervalMs: 250,
      label: "a new tool starts after returning to A without another navigation",
      until: (facts) => facts.tools.some((tool) => tool.command === continuedCommand && tool.status === "running"),
    });
    const continuedCall = continuedTool.tools.find((tool) => tool.command === continuedCommand);
    if (!continuedCall?.callId) throw new Error("Chat A's next live tool has no call ID");
    expect((await eventually(() => readVisibleTool(desktopApp, chatA, continuedCall.callId), {
      within: 10_000,
      intervalMs: 250,
      label: "the resumed stream renders the new tool while it runs",
      until: (fact) => fact.visible,
    })).visible).toBe(true);
    const liveContinuation = await eventually(() => readTranscript(desktopApp, chatA), {
      within: 10_000,
      intervalMs: 250,
      label: "the resumed stream renders new assistant progress before completion",
      until: (fact) => fact.assistantText.includes(continuedProgressA),
    });
    expect(liveContinuation.assistantText).toContain(continuedProgressA);
    expect(liveContinuation.assistantText).not.toContain(replyA);
    expect((await readSessionFacts(desktopApp, workspaceA.workspaceId, chatA)).tools
      .some((tool) => tool.callId === continuedCall.callId && tool.status === "running")).toBe(true);
    await screenshot(desktopApp);

    const completed = await eventually(
      () => readSessionFacts(desktopApp, workspaceA.workspaceId, chatA),
      {
        within: 90_000,
        intervalMs: 500,
        label: `chat A unique ${shellToolName} tool completed`,
        until: (facts) => facts.text.includes(replyA)
          && facts.tools.some((tool) => tool.tool === shellToolName
            && tool.status === "completed" && tool.command === command),
      },
    );
    expect(completed.tools).toHaveLength(3);
    expect(completed.tools.every((tool) => tool.status === "completed")).toBe(true);
    expect(completed.text).not.toContain(replyB);
    const continuedA = await eventually(() => readTranscript(desktopApp, chatA), {
      within: 30_000,
      intervalMs: 250,
      label: "returned chat A receives its new assistant reply without another navigation or reload",
      until: (fact) => fact.sessionId === chatA && fact.assistantText.includes(replyA),
    });
    expect(continuedA.assistantText.split(replyA)).toHaveLength(2);
    expect(continuedA.text).not.toContain(replyB);
    const drainedA = await eventually(() => readTranscript(desktopApp, chatA), {
      within: 45_000,
      intervalMs: 250,
      label: "both queued A follow-ups execute as separate turns in order",
      until: (fact) => queuedRepliesA.every((reply) => fact.assistantText.includes(reply)),
    });
    for (const prompt of queuedA) expect(drainedA.userText.split(prompt)).toHaveLength(2);
    for (const reply of queuedRepliesA) expect(drainedA.assistantText.split(reply)).toHaveLength(2);
    expect(drainedA.assistantText.indexOf(replyA)).toBeLessThan(drainedA.assistantText.indexOf(queuedRepliesA[0]));
    expect(drainedA.assistantText.indexOf(queuedRepliesA[0])).toBeLessThan(drainedA.assistantText.indexOf(queuedRepliesA[1]));
    expect(drainedA.text).not.toMatch(/\d+ queued/);
    expect(drainedA.text).not.toContain(queuedB);
    expect(drainedA.text).not.toContain(queuedReplyB);
    const queuedRequestsA = (await den.mocks.agent.agentRequests())
      .filter((request) => request.kind === "final" && queuedA.includes(request.promptMarker ?? ""));
    expect(queuedRequestsA.map((request) => request.promptMarker)).toEqual(queuedA);
    evidence.recordAssertionEvidence(
      "The returned transcript continues live, without duplicates or the other chat's content",
      `${evalEngine}, ${scope}: A restored its prompt, assistant progress and running tool, then rendered new assistant progress and a third running tool before completion without navigating or reloading. All three tools completed and the final answer appeared exactly once; B's content was absent from A.`,
      true,
    );
    await screenshot(desktopApp);

    await clickSessionRow(desktopApp, workspaceB.workspaceId, chatB);
    const stillRunningB = await readSessionFacts(desktopApp, workspaceB.workspaceId, chatB);
    expect(stillRunningB.tools.some((tool) => tool.callId === toolB.callId && tool.status === "running")).toBe(true);
    const visibleB = await eventually(() => readVisibleTool(desktopApp, chatB, toolB.callId), {
      within: 15_000,
      intervalMs: 250,
      label: "chat B also restores its own in-flight tool",
      until: (fact) => fact.currentSessionId === chatB && fact.visible,
    });
    expect(visibleB.visible).toBe(true);
    const restoredB = await readTranscript(desktopApp, chatB);
    expect(restoredB.userText).toContain(promptB);
    expect(restoredB.assistantText).toContain(progressB);
    expect(restoredB.text).toContain("1 queued");
    expect(restoredB.text).toContain(queuedB);
    expect(restoredB.text).not.toContain(replyA);
    expect((await readSessionFacts(desktopApp, workspaceB.workspaceId, chatB)).tools
      .some((tool) => tool.callId === toolB.callId && tool.status === "running")).toBe(true);
    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
    const completedB = await eventually(() => readSessionFacts(desktopApp, workspaceB.workspaceId, chatB), {
      within: 150_000,
      intervalMs: 500,
      label: "chat B completes in the background",
      until: (facts) => facts.text.includes(replyB) && facts.text.includes(queuedReplyB) && facts.tools.some((tool) =>
        tool.callId === toolB.callId && tool.status === "completed"),
    });
    expect(completedB.tools).toHaveLength(1);
    expect(completedB.text).not.toContain(replyA);
    for (const prompt of queuedA) expect(completedB.text).not.toContain(prompt);
    for (const reply of queuedRepliesA) expect(completedB.text).not.toContain(reply);
    await expectLeftSessionIndicator(desktopApp, chatB, "attention");
    expect((await readTranscript(desktopApp, chatA)).text).not.toContain(replyB);
    await screenshot(desktopApp);
    await clickSessionRow(desktopApp, workspaceB.workspaceId, chatB);
    const continuedB = await eventually(() => readTranscript(desktopApp, chatB), {
      within: 30_000,
      intervalMs: 250,
      label: "chat B restores its completed transcript",
      until: (fact) => fact.sessionId === chatB && fact.assistantText.includes(replyB) && fact.assistantText.includes(queuedReplyB),
    });
    expect(continuedB.assistantText.split(replyB)).toHaveLength(2);
    expect(continuedB.text).toContain(promptB);
    expect(continuedB.text).not.toContain(promptMarker);
    expect(continuedB.text).not.toContain(replyA);
    expect(continuedB.userText.split(queuedB)).toHaveLength(2);
    expect(continuedB.assistantText.split(queuedReplyB)).toHaveLength(2);
    expect(continuedB.assistantText.indexOf(replyB)).toBeLessThan(continuedB.assistantText.indexOf(queuedReplyB));
    expect(continuedB.text).not.toMatch(/\d+ queued/);
    const queuedRequestsB = (await den.mocks.agent.agentRequests({ promptMarker: queuedB }))
      .filter((request) => request.kind === "final");
    expect(queuedRequestsB).toHaveLength(1);
    evidence.recordAssertionEvidence(
      "Queued follow-ups wait for completion, drain exactly once in order, and stay in their own session",
      `${evalEngine}, ${scope}: A held two follow-ups while busy, then rendered each prompt and answer once in order. B preserved its queue across navigation and delivered its follow-up while unmounted. Neither session received the other's queued content.`,
      true,
    );
    evidence.recordAssertionEvidence(
      "The second chat survives switching and background completion without mixing transcripts",
      `${evalEngine}, ${scope}: B restored its original running tool, completed it exactly once while A was visible, showed one left-side attention indicator, and restored exactly one final assistant reply with no A prompt or reply.`,
      true,
    );
    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
    // Follow-up turns can legitimately push the earlier tool above the viewport.
    await evalIn(desktopApp, browserScript((sessionId, callId) => {
      document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"] [data-tool-aggregate="${callId}"]`)
        ?.scrollIntoView({ block: "center" });
    }, [chatA, laterTool.callId]));
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
}
