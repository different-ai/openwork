import { expect } from "vitest";
import { assertNoLiveSecret, go, liveOpenAiEnabled } from "@openwork/behaviors";
import { observeTranscript, readTranscriptMessages, spec } from "@openwork/testkit";
import { workspaceEngineUpgrade } from "../worlds/chat.ts";

const live = liveOpenAiEnabled();
const test = spec.world(workspaceEngineUpgrade, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "Engine ownership and sidecar persistence must survive Settings switches in one running Electron profile.",
  },
  needs: live ? { env: ["OPENAI_API_KEY"] } : {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeItems(body: unknown): Record<string, unknown>[] {
  assertNoLiveSecret(body);
  const items = isRecord(body) ? body.data : body;
  if (!Array.isArray(items) || !items.every(isRecord)) throw new Error("Unexpected native list response");
  return items;
}

function messageInfo(message: Record<string, unknown>) {
  return isRecord(message.info) ? message.info : message;
}

function role(message: Record<string, unknown>) {
  const info = messageInfo(message);
  return info.role ?? info.type;
}

function messageText(message: Record<string, unknown>) {
  const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [message];
  return parts.filter(isRecord).filter(part => part.type === "text" && !part.synthetic)
    .map(part => typeof part.text === "string" ? part.text : "").join("\n");
}

type Engine = "v1" | "v2";
interface Conversation {
  workspaceId: string;
  sessionId: string;
  engine: Engine;
  prompt: string;
  native: Record<string, unknown>[];
  finalAnswers: { id: string; text: string }[];
}

test(`${live ? "real LLM" : "deterministic"}: completed workspace history survives v1/v2 switches and sidecar restart`, async ({ world, user, agent, probe, step, evidence }) => {
  const primaryId = world.primary.workspaceId;
  const conversations: Conversation[] = [];
  const readRoute = async () => (await probe.hash()).replace(/^#/, "");
  const sessionsPath = (workspaceId: string, engine: Engine) => `/workspace/${workspaceId}/${engine === "v2" ? "opencode2/api" : "opencode"}/session`;
  const readSessions = async (workspaceId: string, engine: Engine) => {
    const result = await probe.desktopApi(sessionsPath(workspaceId, engine));
    expect(result.status).toBe(200);
    return nativeItems(result.body).map(session => {
      if (typeof session.id !== "string") throw new Error("Native session omitted its ID");
      return session.id;
    }).sort();
  };
  const readNative = async (conversation: { workspaceId: string; engine: Engine; sessionId: string }) => {
    const result = await probe.desktopApi(`${sessionsPath(conversation.workspaceId, conversation.engine)}/${conversation.sessionId}/message`);
    expect(result.status).toBe(200);
    return nativeItems(result.body);
  };
  const visible = async () => ({
    user: await readTranscriptMessages(probe, "user"),
    assistant: await world.readFinalAnswerRows(),
  });
  const workspaceName = async (workspaceId: string) => {
    const response = await probe.desktopApi("/workspaces");
    expect(response.status).toBe(200);
    const workspace = isRecord(response.body) && Array.isArray(response.body.items)
      ? response.body.items.filter(isRecord).find(item => item.id === workspaceId) : null;
    if (!workspace || typeof workspace.name !== "string") throw new Error("Workspace name missing");
    return workspace.name;
  };
  const runtime = async () => {
    const response = await probe.desktopApi("/experimental/engine-v2-preview/status");
    expect(response.status).toBe(200);
    if (!isRecord(response.body)) throw new Error("Engine status missing");
    return response.body;
  };
  const switchEngine = async (engine: Engine) => {
    await go(world.app, `/workspace/${primaryId}/settings/advanced`);
    await user.click({ text: engine === "v2" ? "OpenCode v2 (preview)" : "OpenCode v1 (default)" });
    const status = await probe.eventually(runtime, {
      within: 120_000, label: `${engine} Settings selection settled`,
      until: status => engine === "v2"
        ? status.enabled === true && status.chatRouting === true && status.running === true && typeof status.pid === "number"
        : status.enabled === false && status.chatRouting === false && status.running === false,
    });
    expect(await probe.storage("openwork.preferences")).toMatchObject({
      defaultModel: { providerID: world.providerId, modelID: world.modelId },
    });
    return status;
  };
  const verify = async (conversation: Conversation) => {
    const route = `/workspace/${conversation.workspaceId}/session/${conversation.sessionId}`;
    await probe.eventually(readRoute, { within: 30_000, label: `same session route ${conversation.sessionId}`, until: hash => hash === route });
    await probe.eventually(visible, {
      within: 60_000, label: `same prompt and native-ID final answers ${conversation.sessionId}`,
      until: value => value.user.length === 1 && value.user[0]?.includes(conversation.prompt) === true
        && JSON.stringify(value.assistant) === JSON.stringify(conversation.finalAnswers),
    });
    expect(await readNative(conversation)).toEqual(conversation.native);
    const result = await probe.desktopApi(`${sessionsPath(conversation.workspaceId, conversation.engine)}/${conversation.sessionId}`);
    expect(result.status).toBe(200);
    const session = isRecord(result.body) && isRecord(result.body.data) ? result.body.data : result.body;
    expect(session).toMatchObject({ id: conversation.sessionId });
    expect(await readSessions(conversation.workspaceId, conversation.engine)).toContain(conversation.sessionId);
    expect(await probe.storage("openwork.react.activeWorkspace")).toBe(conversation.workspaceId);
    const surface = await probe.dom(`[data-session-surface-id="${conversation.sessionId}"]`);
    expect(surface.elements.some(node => node.rect.width > 0 && node.rect.height > 0)).toBe(true);
    const otherSurfaces = await probe.dom(`[data-session-surface-id]:not([data-session-surface-id="${conversation.sessionId}"])`);
    expect(otherSurfaces.elements.filter(node => node.rect.width > 0 && node.rect.height > 0)).toEqual([]);
    for (const other of conversations.filter(other => other.sessionId !== conversation.sessionId)) {
      expect((await visible()).user.join("\n")).not.toContain(other.prompt);
    }
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
    await user.see("Run task");
    expect(await readRoute()).toBe(route);
  };
  const reopen = async (conversation: Conversation) => {
    if ((await readRoute()).includes("/settings/")) {
      await user.click({ role: "button", label: "Back to app" });
      await probe.eventually(readRoute, {
        within: 30_000, label: "Back to app restores the workspace sidebar",
        until: route => !route.includes("/settings/"),
      });
    }
    // Select the workspace and its actual persisted row; never repair a missing row with go().
    await user.click({ role: "button", label: await workspaceName(conversation.workspaceId) });
    await user.click({ testId: `sidebar-session-${conversation.sessionId}` });
    await verify(conversation);
  };
  const createChat = async (workspaceId: string, engine: Engine, entry: "button" | "palette" | "sidebar", marker: string) => {
    const before = await readSessions(workspaceId, engine);
    if (entry === "palette") {
      const input = { placeholder: "Search actions, settings, and sessions…" };
      await user.press(world.paletteShortcut);
      await user.type(input, "New session", { replace: true });
      await user.click({ role: "option", label: /^New session\b/ });
      await user.notSee(input);
    } else if (entry === "sidebar") {
      const name = await workspaceName(workspaceId);
      await user.hover({ role: "button", label: name });
      await user.click({ role: "button", label: `New session · ${name}` });
    } else {
      await user.click({ role: "button", label: "New session" });
    }
    const sessionlessRoute = `/workspace/${workspaceId}/session`;
    const empty = await probe.eventually(() => probe.composer(), {
      within: 60_000, label: entry === "palette" ? "palette opens one allocated empty session" : "New session opens the sessionless composer",
      until: state => (entry === "palette"
        ? state.route.replace(/^#/, "").startsWith(`${sessionlessRoute}/ses_`)
        : state.route.replace(/^#/, "") === sessionlessRoute) && state.composerEditable && !state.modelUnavailable
        && state.draftText.trim() === "" && state.userMessageCount === 0,
    });
    const allocatedId = entry === "palette" ? empty.route.replace(/^#/, "").slice(sessionlessRoute.length + 1) : null;
    if (allocatedId !== null) {
      expect(allocatedId).toMatch(/^ses_[^/?#]+$/);
      expect(before).not.toContain(allocatedId);
      expect(await readSessions(workspaceId, engine)).toEqual([...before, allocatedId].sort());
    } else {
      expect(await readSessions(workspaceId, engine)).toEqual(before);
    }
    const prompt = `For upgrade conversation ${marker}, explain in one short plain-text sentence why keeping notes is useful. Do not use tools or markdown.`;
    await using transcript = await observeTranscript(probe, [{ role: "user", text: prompt }]);
    await user.type("composer", prompt);
    await probe.eventually(() => probe.composer(), {
      within: 30_000, label: "the selected model can submit the first prompt",
      until: state => state.runTaskEnabled && state.draftText.trim() === prompt,
    });
    await user.click("Run task");
    const route = await probe.eventually(readRoute, {
      within: 30_000, label: "first send uses a session in the selected workspace",
      until: hash => hash.startsWith(`${sessionlessRoute}/ses_`),
    });
    const sessionId = route.slice(sessionlessRoute.length + 1);
    expect(sessionId).toMatch(/^ses_[^/?#]+$/);
    if (allocatedId !== null) expect(sessionId).toBe(allocatedId);
    const identity = { workspaceId, engine, sessionId };
    const native = await probe.eventually(() => readNative(identity), {
      within: 150_000, intervalMs: 500, label: `${engine} completed native assistant response`,
      until: messages => messages.some(message => {
        const info = messageInfo(message);
        if (info.error || info.finish === "error") throw new Error("Native model request failed");
        return role(message) === "assistant" && info.finish === "stop" && isRecord(info.time)
          && typeof info.time.completed === "number" && messageText(message).trim().length > 0;
      }),
    });
    expect(native.filter(message => role(message) === "user").map(messageText)).toEqual([prompt]);
    const assistants = native.filter(message => role(message) === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const message of native) {
      const info = messageInfo(message);
      expect(typeof info.id).toBe("string");
      expect(info.error).toBeUndefined();
      if (role(message) !== "assistant") continue;
      expect(info.finish).toBe("stop");
      if (engine === "v1") expect(info).toMatchObject({ providerID: world.providerId, modelID: world.modelId });
      else expect(info.model).toMatchObject({ providerID: world.providerId, id: world.modelId });
      if (world.live) {
        if (!isRecord(info.tokens)) throw new Error("Real model response omitted token usage");
        expect(info.tokens.output).toBeGreaterThan(0);
      }
    }
    const finalAnswers = assistants.filter(message => messageText(message).trim()).map(message => {
      const id = messageInfo(message).id;
      if (typeof id !== "string") throw new Error("Native assistant omitted its ID");
      return { id, text: messageText(message).replace(/\s+/g, " ").trim() };
    });
    expect(finalAnswers.length).toBeGreaterThan(0);
    await probe.eventually(visible, {
      within: 30_000, label: "native-ID final answer text rendered separately from reasoning steps",
      until: value => value.user.length === 1 && value.user[0]?.includes(prompt) === true
        && JSON.stringify(value.assistant) === JSON.stringify(finalAnswers),
    });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(await transcript.finish()).toMatchObject({ seen: [true], violations: [], stopped: false });
    const conversation = { ...identity, prompt, native, finalAnswers };
    conversations.push(conversation);
    expect(await readSessions(workspaceId, engine)).toEqual([...before, sessionId].sort());
    // A disabled v2 sidecar is unavailable, not an ownership witness. Check old
    // v1 IDs against it only after Settings has actually started it below.
    if (engine === "v2") expect((await probe.desktopApi(`${sessionsPath(workspaceId, "v1")}/${sessionId}`)).status).toBe(404);
    await verify(conversation);
    evidence.recordAssertionEvidence(`${engine} completed composer-created conversation ${marker}`,
      JSON.stringify({ ...conversation, providerId: world.providerId, modelId: world.modelId, live: world.live }), true);
    return conversation;
  };

  const rendererOrigin = (await world.readRendererLifetime()).timeOrigin;
  expect(await runtime()).toMatchObject({ chatRouting: false });
  await go(world.app, `/workspace/${primaryId}/session`);
  const first = await step("workspace A completes its first v1 conversation through New session", () => createChat(primaryId, "v1", "button", "amber"));
  const second = await step("workspace A completes another v1 conversation through the chat palette", () => createChat(primaryId, "v1", "palette", "birch"));
  const v1Inventory = await readSessions(primaryId, "v1");
  const firstV2Runtime = await switchEngine("v2");
  for (const conversation of [first, second]) {
    expect((await probe.desktopApi(`${sessionsPath(primaryId, "v2")}/${conversation.sessionId}`)).status).toBe(404);
  }
  const saved = await step("Settings New session completes a v2 conversation in the existing workspace A", async () => {
    expect(await readRoute()).toBe(`/workspace/${primaryId}/settings/advanced`);
    await user.see({ role: "button", label: "Back to app" });
    return createChat(primaryId, "v2", "palette", "cedar");
  });
  const pendingRowDeadline = (await world.readRendererLifetime()).now + 31_000;
  const other = await step("create workspace B only after the v2 switch, then chat through its sidebar", async () => {
    const workspace = await world.createOtherWorkspace();
    expect(workspace.workspaceId).not.toBe(primaryId);
    return createChat(workspace.workspaceId, "v2", "sidebar", "dune");
  });
  const primaryV2Inventory = await readSessions(primaryId, "v2");
  const otherV2Inventory = await readSessions(other.workspaceId, "v2");

  await step("after pending-row grace, the sidebar reopens A's same v2 ID and full transcript without reloading", async () => {
    await probe.eventually(() => world.readRendererLifetime(), {
      within: 35_000, intervalMs: 500, label: "outlive the 30-second optimistic session-row grace",
      until: lifetime => lifetime.now >= pendingRowDeadline,
    });
    const otherRoute = `/workspace/${other.workspaceId}/session/${other.sessionId}`;
    expect(await readRoute()).toBe(otherRoute);
    const refreshStartedAt = (await world.readRendererLifetime()).now;
    // Visibility refresh skips loaded inventories. Use the existing targeted
    // refresh action without selecting A, and do not issue probe GETs to A here.
    await agent.run("workspace.reload_sessions", { workspaceId: primaryId });
    const refresh = await probe.eventually(() => world.readWorkspaceInventoryRefresh(primaryId, "v2", refreshStartedAt), {
      within: 30_000, intervalMs: 250, label: "renderer completes A's post-grace v2 list while B remains selected",
      until: value => value.requests.length > 0 && value.loading === false && !value.error,
    });
    expect(refresh.route).toBe(otherRoute);
    expect(refresh.selectedWorkspaceId).toBe(other.workspaceId);
    expect(refresh.sessionIds).toEqual(primaryV2Inventory);
    expect(refresh.sessionIds).toContain(saved.sessionId);
    expect(refresh.sessionIds).not.toContain(other.sessionId);
    for (const sessionId of v1Inventory) expect(refresh.sessionIds).not.toContain(sessionId);
    evidence.recordAssertionEvidence("A's persisted v2 sidebar inventory survives an authoritative post-grace refresh before selecting A",
      JSON.stringify({ refreshStartedAt, ...refresh, sessionId: saved.sessionId }), true);
    await reopen(saved);
    expect((await world.readRendererLifetime()).timeOrigin).toBe(rendererOrigin);
    expect((await runtime()).pid).toBe(firstV2Runtime.pid);
    expect(await readSessions(primaryId, "v1")).toEqual(v1Inventory);
    for (const conversation of conversations) {
      const wrongWorkspace = conversation.workspaceId === primaryId ? other.workspaceId : primaryId;
      expect((await probe.desktopApi(`${sessionsPath(wrongWorkspace, conversation.engine)}/${conversation.sessionId}`)).status).toBe(404);
    }
    await user.screenshot();
  });

  await step("returning to v1 restores both original IDs and their complete native and visible histories", async () => {
    await switchEngine("v1");
    await reopen(first);
    await reopen(second);
    expect(await readSessions(primaryId, "v1")).toEqual(v1Inventory);
  });

  await step("enabling v2 again starts a new sidecar and restores its saved histories", async () => {
    const restarted = await switchEngine("v2");
    expect(restarted.pid).not.toBe(firstV2Runtime.pid);
    await reopen(other);
    await reopen(saved);
    expect((await world.readRendererLifetime()).timeOrigin).toBe(rendererOrigin);
    evidence.recordAssertionEvidence("Settings stopped and restarted the v2 sidecar without replacing the renderer",
      JSON.stringify({ beforePid: firstV2Runtime.pid, afterPid: restarted.pid, sessionIds: [saved.sessionId, other.sessionId] }), true);
  });

  await step("renderer reload retains the saved v2 transcript and both workspaces' native histories", async () => {
    const beforeReload = await runtime();
    await user.reload();
    await verify(saved);
    expect((await world.readRendererLifetime()).timeOrigin).not.toBe(rendererOrigin);
    expect((await runtime()).pid).toBe(beforeReload.pid);
    await reopen(other);
    await reopen(saved);
    for (const conversation of conversations) expect(await readNative(conversation)).toEqual(conversation.native);
    expect(new Set(conversations.map(conversation => conversation.sessionId)).size).toBe(4);
    expect(await readSessions(primaryId, "v1")).toEqual(v1Inventory);
    expect(await readSessions(primaryId, "v2")).toEqual(primaryV2Inventory);
    expect(await readSessions(other.workspaceId, "v2")).toEqual(otherV2Inventory);
    evidence.recordAssertionEvidence("Completed histories retain their native messages and IDs through engine switches and renderer reload",
      JSON.stringify({ v1: [first.sessionId, second.sessionId], v2: [saved.sessionId, other.sessionId],
        primaryId, otherWorkspaceId: other.workspaceId, unchangedSidecarPidAfterReload: beforeReload.pid }), true);
    await user.screenshot();
  });
});
