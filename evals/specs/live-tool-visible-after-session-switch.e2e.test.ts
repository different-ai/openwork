import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  engineSessionProbe,
  evalIn,
  selectModel,
  waitFor,
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
  spec,
  test,
} from "@openwork/testkit";
import type { App } from "@openwork/testkit";
import { sessionSwitchLatency } from "../worlds/session-switch-latency.ts";

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
    const matchesDescription = (tool: ToolFact, description: string) =>
      evalEngine === "v2" || tool.description === description;

    await using den = await server({
      place,
      mocks: {
        agent: mcpMock({
          agentWorkloads: [{
            promptMarker,
            finalReply: completionMarker,
            steps: [
              {
                tool: shellToolName,
                arguments: {
                  command: firstCommand,
                  timeout: 30_000,
                  ...(evalEngine === "v1" ? { description: firstToolDescription } : {}),
                },
              },
              {
                tool: shellToolName,
                arguments: {
                  command,
                  timeout: 90_000,
                  ...(evalEngine === "v1" ? { description: toolDescription } : {}),
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
    evidence.recordAssertionEvidence(
      "A tool that started while away is visible when the user returns to its chat",
      `The first tool completed and tool ${laterTool.callId} started while workspace B chat ${chatB} was visible; after returning to workspace A chat ${chatA}, scoped CDP found its visible row with text ${JSON.stringify(visibleAfterReturn.text)}.`,
      true,
    );
    await screenshot(desktopApp);

    await clickSessionRow(desktopApp, workspaceB.workspaceId, chatB);
    const completed = await eventually(
      () => readSessionFacts(desktopApp, workspaceA.workspaceId, chatA),
      {
        within: 90_000,
        intervalMs: 500,
        label: `chat A unique ${shellToolName} tool completed`,
        until: (facts) => facts.text.includes(completionMarker)
          && facts.tools.some((tool) => tool.tool === shellToolName
            && tool.status === "completed" && tool.command === command),
      },
    );
    expect(completed.text).toContain(completionMarker);
    await expectLeftSessionIndicator(desktopApp, chatA, "attention");
    evidence.recordAssertionEvidence(
      "Session activity and unread completion use the same left indicator slot",
      "During the run and after completion in another chat, exactly one visible indicator was positioned before chat A's title; no second status indicator remained on the right.",
      true,
    );
    await screenshot(desktopApp);
    await clickSessionRow(desktopApp, workspaceA.workspaceId, chatA);
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

const latencyTest = spec.world(sessionSwitchLatency, { timeout: 8 * 60_000 });

latencyTest("SWITCH-10 opens ten persisted conversations within the normal and warm latency ceilings", {
  timeout: 12 * 60_000,
}, async ({ world, user, probe, step, evidence }) => {
  const measurements: Awaited<ReturnType<typeof world.readMeasurement>>[] = [];
  type SidebarTargetState = Awaited<ReturnType<typeof world.sidebarTargetState>>;
  const sidebarExpansions: Array<{
    phase: string;
    clickedLabels: string[];
    states: SidebarTargetState[];
    before: SidebarTargetState;
    after: SidebarTargetState;
  }> = [];
  const normalized = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  const nativeBodies = (state: Awaited<ReturnType<typeof world.nativeState>>) => state.sessions
    .map(({ sessionId, status, body }) => ({ sessionId, status, body }));
  const exposeOldestSidebarRow = async (phase: string) => {
    const oldest = world.targets[0]!;
    const states: SidebarTargetState[] = [];
    const clickedLabels: string[] = [];
    try {
      let current = await probe.eventually(() => world.sidebarTargetState(oldest.sessionId), {
        within: 15_000,
        intervalMs: 50,
        label: `${phase} oldest row or scoped Show N more control available`,
        until: (state) => state.targetPresent || state.showMoreControls.length > 0,
      });
      states.push(current);
      const before = current;
      for (let attempt = 0; !current.targetPresent && attempt < 20; attempt += 1) {
        expect(current.showMoreControls).toHaveLength(1);
        const control = current.showMoreControls[0];
        if (!control) throw new Error(`${phase}: the scoped Show N more control disappeared`);
        expect(control).toMatchObject({
          tagName: "a",
          dataSidebar: "menu-sub-button",
          dataSlot: "sidebar-menu-sub-button",
          ariaDisabled: null,
        });
        expect(control.label).toMatch(/^Show \d+ more$/);
        const visibleBefore = current.visibleSessionCount;
        const controlsBefore = JSON.stringify(current.showMoreControls);
        clickedLabels.push(control.label);
        await user.click({ text: control.label });
        current = await probe.eventually(() => world.sidebarTargetState(oldest.sessionId), {
          within: 10_000,
          intervalMs: 25,
          label: `${phase} explicit ${control.label} click advances the capped sidebar`,
          until: (state) => state.targetPresent || state.visibleSessionCount > visibleBefore
            || JSON.stringify(state.showMoreControls) !== controlsBefore,
        });
        states.push(current);
      }
      if (!current.targetPresent) throw new Error(`${phase}: oldest row stayed hidden after ${clickedLabels.length} bounded Show N more clicks`);
      await user.see({ text: oldest.title }, { timeoutMs: 10_000 });
      expect(clickedLabels.length).toBeGreaterThan(0);
      const expansion = { phase, clickedLabels, states, before, after: current };
      sidebarExpansions.push(expansion);
      console.info(`[SWITCH-10] sidebar-expansion=${JSON.stringify(expansion)}`);
      return expansion;
    } catch (error) {
      const current = await world.sidebarTargetState(oldest.sessionId);
      evidence.recordJsonArtifact(`SWITCH-10 ${phase} sidebar exposure failure`, {
        error: error instanceof Error ? error.message : String(error),
        oldest: { sessionId: oldest.sessionId, title: oldest.title },
        clickedLabels,
        states,
        current,
      });
      await user.screenshot();
      throw error;
    }
  };
  const measure = async (target: (typeof world.targets)[number], phase: "first" | "warm" | "reload", ceilingMs: number) => {
    await user.see({ text: target.title }, { timeoutMs: 10_000 });
    const outgoing = await world.current();
    expect(outgoing.sessionId, `${phase} target ${target.index + 1} was already current`).not.toBe(target.sessionId);
    await world.armMeasurement(target, phase);
    await user.click({ text: target.title });
    const observation = await probe.eventually(() => world.readMeasurement(), {
      within: 7_000,
      intervalMs: 10,
      label: `${phase} conversation ${target.index + 1} latest answer visibly restored`,
      until: (sample) => sample.completed || sample.expired,
    });
    measurements.push(observation);
    console.info(`[SWITCH-10] ${phase} target=${target.index + 1} firstDisplay=${observation.firstDisplayMs ?? "missing"}ms stable=${observation.elapsedMs ?? "missing"}ms frames=${observation.stableFrames}`);
    const valid = observation.actionCaptured && observation.completed && !observation.expired
      && observation.ownerSessionId === target.sessionId
      && observation.ownerWorkspaceId === world.workspace.workspaceId
      && observation.finalAnswerCount === 1
      && observation.lastAssistantText === normalized(target.answer)
      && observation.lastLineVisible
      && observation.violations.length === 0
      && observation.promptPostsAtEnd === observation.promptPostsAtArm
      && observation.firstDisplayMs !== null && observation.firstDisplayMs < ceilingMs
      && observation.stableFrames >= 2;
    if (!valid) evidence.recordJsonArtifact(`SWITCH-10 ${phase} failure`, {
      target: { index: target.index, sessionId: target.sessionId, lastLine: target.lastLine },
      outgoing,
      ceilingMs,
      observation,
      sidebarExpansions,
      controllerCounts: await world.controllerCounts(),
    });
    expect([
      `[data-sidebar-session-id="${target.sessionId}"]`,
      `[data-session-tab-id="${target.sessionId}"]`,
    ]).toContain(observation.matchedClickTarget);
    expect(observation.actionCaptured).toBe(true);
    expect(observation.completed).toBe(true);
    expect(observation.expired).toBe(false);
    expect(observation.ownerSessionId).toBe(target.sessionId);
    expect(observation.ownerWorkspaceId).toBe(world.workspace.workspaceId);
    expect(observation.finalAnswerCount).toBe(1);
    expect(observation.lastAssistantText).toBe(normalized(target.answer));
    expect(observation.lastLineVisible).toBe(true);
    expect(observation.violations).toEqual([]);
    expect(observation.promptPostsAtEnd).toBe(observation.promptPostsAtArm);
    expect(observation.stableFrames).toBeGreaterThanOrEqual(2);
    expect(observation.snapshots.length).toBeLessThanOrEqual(20);
    expect(observation.sampleIntervalsMs.length).toBeLessThanOrEqual(20);
    if (observation.firstDisplayMs === null) throw new Error(`${phase} target ${target.index + 1} did not capture first-display latency.`);
    expect(observation.firstDisplayMs).toBeLessThan(ceilingMs);
    return observation;
  };

  const arranged = await step("the real web engine restores one of ten completed native histories after reload", async () => {
    await user.reload();
    const sidebarExpansion = await exposeOldestSidebarRow("first reload");
    const restored = world.targets.at(-1)!;
    await user.see({ text: restored.lastLine }, { timeoutMs: 60_000 });
    const current = await world.current();
    const runtime = await world.runtimeFacts();
    const native = await world.nativeState();
    const counts = await world.controllerCounts();
    evidence.recordJsonArtifact("SWITCH-10 arrangement", {
      runtime,
      restoredSessionId: current.sessionId,
      targets: world.targets.map(({ index, sessionId, title, prompt, lastLine }) => ({ index, sessionId, title, prompt, lastLine })),
      sidebarExpansion,
      native: world.compactNativeState(native),
      controllerCounts: counts,
    });
    expect(runtime).toMatchObject({
      surface: "web",
      electronBridge: false,
      origin: runtime.expectedOrigin,
      engine: world.engine,
      healthStatus: 200,
      engineStatus: 200,
      engineEnabled: world.engine === "v2",
      chatRouting: world.engine === "v2",
      nativeStatus: 200,
      nativeRoute: world.engine === "v2" ? "/opencode2/api/model" : "/opencode/session",
      modelVisible: true,
      viewport: { width: 1280, height: 900, devicePixelRatio: 1 },
    });
    if (runtime.hostKind === "daytona") expect(runtime.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    else if (runtime.actualSourceSha !== null) expect(runtime.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    if (world.engine === "v2") expect(runtime.engineRunning).toBe(true);
    expect(current.sessionId).toBe(restored.sessionId);
    expect(current.workspaceId).toBe(world.workspace.workspaceId);
    expect(new Set(world.targets.map((target) => target.sessionId)).size).toBe(10);
    expect(new Set(world.targets.map((target) => target.prompt)).size).toBe(10);
    expect(new Set(world.targets.map((target) => target.answer)).size).toBe(10);
    expect(world.targets.every((target) => !target.prompt.includes(target.lastLine))).toBe(true);
    expect(native.inventory.status).toBe(200);
    expect(native.active.status).toBe(200);
    expect(native.activeTargetIds).toEqual([]);
    expect(native.sessions.every((session) => session.status === 200 && session.promptOccurrences === 1
      && session.finalLineOccurrences === 1 && session.oldBeforeFinal)).toBe(true);
    expect(native.sessions[0]?.oldAnswerOccurrences).toBe(1);
    expect(counts.providerFinalRequests).toBe(world.expectedProviderFinalRequests);
    expect(counts.providerModels).toEqual([world.modelId]);
    expect(Object.values(counts.providerByMarker).every((count) => count === 1)).toBe(true);
    expect(counts.promptPosts).toBe(0);
    return { restored, current, runtime, native, counts };
  });

  const firstSamples = await step("nine unvisited histories and the already-restored history each display in under two seconds", async () => {
    const order = world.firstVisitOrder(arranged.current.sessionId);
    expect(order.map((target) => target.index)).toEqual([0, 8, 1, 7, 2, 6, 3, 5, 4, 9]);
    const samples = [];
    for (const target of order) samples.push(await measure(target, "first", 2_000));
    expect(samples.filter((sample) => sample.targetSessionId === arranged.current.sessionId)).toHaveLength(1);
    expect(samples.filter((sample) => sample.targetSessionId !== arranged.current.sessionId)).toHaveLength(9);
    return samples;
  });
  const countsAfterFirst = await world.controllerCounts();
  expect(countsAfterFirst.providerRequests).toBe(arranged.counts.providerRequests);
  expect(countsAfterFirst.promptPosts).toBe(0);

  const warmSamples = await step("all ten warm revisits visibly restore in under 500 milliseconds", async () => {
    const order = world.warmVisitOrder();
    expect(order[0]?.sessionId).not.toBe(firstSamples.at(-1)?.targetSessionId);
    const samples = [];
    for (const target of order) samples.push(await measure(target, "warm", 500));
    return samples;
  });

  const countsAfterWarm = await world.controllerCounts();
  const nativeAfterWarm = await world.nativeState();
  expect(countsAfterWarm.providerRequests).toBe(arranged.counts.providerRequests);
  expect(countsAfterWarm.providerFinalRequests).toBe(arranged.counts.providerFinalRequests);
  expect(countsAfterWarm.promptPosts).toBe(0);
  expect(nativeBodies(nativeAfterWarm)).toEqual(nativeBodies(arranged.native));

  const reloadSample = await step("after another reload an old conversation still visibly restores its latest answer in under two seconds", async () => {
    await user.reload();
    await user.see({ text: world.targets.at(-1)!.lastLine }, { timeoutMs: 60_000 });
    await exposeOldestSidebarRow("second reload");
    return measure(world.targets[0]!, "reload", 2_000);
  });
  const finalCounts = await world.controllerCounts();
  const finalNative = await world.nativeState();
  expect(finalCounts.providerRequests).toBe(arranged.counts.providerRequests);
  expect(finalCounts.providerFinalRequests).toBe(arranged.counts.providerFinalRequests);
  expect(finalCounts.promptPosts).toBe(0);
  expect(nativeBodies(finalNative)).toEqual(nativeBodies(arranged.native));

  const coldSamples = firstSamples.filter((sample) => sample.targetSessionId !== arranged.current.sessionId);
  const summaries = {
    first: world.summary(firstSamples),
    cold: world.summary(coldSamples),
    warm: world.summary(warmSamples),
    reload: world.summary([reloadSample]),
    all: world.summary(measurements),
  };
  const report = {
    engine: world.engine,
    viewport: arranged.runtime.viewport,
    restoredSessionId: arranged.current.sessionId,
    sidebarExpansions,
    samples: measurements,
    summaries,
    controllerCounts: { arranged: arranged.counts, afterFirst: countsAfterFirst, afterWarm: countsAfterWarm, final: finalCounts },
    native: { arranged: world.compactNativeState(arranged.native), final: world.compactNativeState(finalNative) },
  };
  console.info(`[SWITCH-10] measurements=${JSON.stringify(report)}`);
  evidence.recordJsonArtifact("SWITCH-10 measurements and controller counts", report);
  evidence.recordAssertionEvidence(
    "SWITCH-10 ten persisted conversations meet strict first-visit and warm switch latency ceilings",
    `Twenty-one capture-phase first-display measurements, each retained for two stable paint frames: first max/p50/p95=${summaries.first.max}/${summaries.first.p50}/${summaries.first.p95}ms, warm=${summaries.warm.max}/${summaries.warm.p50}/${summaries.warm.p95}ms, reload=${summaries.reload.max}ms; nine first visits were cold and one was already restored; no prompt POST, provider replay, foreign-owner paint, starter, duplicate, reversal, or post-display regression. Observer snapshots are diagnostic references, not visual validation.`,
    true,
  );
});
