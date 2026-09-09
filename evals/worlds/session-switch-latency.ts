import { addInitScript, browserScript, evaluate, setViewport } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

const WIDTH = 1280;
const HEIGHT = 900;

export interface SessionSwitchTarget {
  index: number;
  sessionId: string;
  title: string;
  prompt: string;
  answer: string;
  lastLine: string;
  expectedMessages: Array<{ role: "user" | "assistant"; text: string }>;
}

interface SwitchSnapshot {
  source: "initial" | "capture" | "frame" | "mutation" | "timeout";
  elapsedMs: number | null;
  ownerSessionId: string;
  ownerWorkspaceId: string;
  lastAssistantPrefix: string;
  foreignContent: string[];
  starters: boolean;
  loader: boolean;
}

export interface SessionSwitchMeasurement {
  phase: "first" | "warm" | "reload";
  targetIndex: number;
  targetSessionId: string;
  ownerAtArm: string;
  ownerSessionId: string;
  ownerWorkspaceId: string;
  matchedClickTarget: string;
  actionCaptured: boolean;
  ownerCommitted: boolean;
  completed: boolean;
  expired: boolean;
  elapsedMs: number | null;
  firstDisplayMs: number | null;
  stableFrames: number;
  frames: number;
  mutations: number;
  sampleIntervalsMs: number[];
  snapshots: SwitchSnapshot[];
  finalAnswerCount: number;
  lastAssistantText: string;
  lastLineVisible: boolean;
  loaderSeen: boolean;
  violations: string[];
  promptPostsAtArm: number;
  promptPostsAtEnd: number;
}

interface TransportObservation {
  promptPosts: number;
  promptPaths: string[];
  restore(): void;
}

declare global {
  interface Window {
    __sessionSwitchLatencyTransport?: TransportObservation;
    __sessionSwitchLatencyMeasurement?: { state: SessionSwitchMeasurement; stop(): void };
  }
}

function installTransportObservation(): void {
  if (window.__sessionSwitchLatencyTransport) return;
  const originalFetch = window.fetch.bind(window);
  const state: TransportObservation = {
    promptPosts: 0,
    promptPaths: [],
    restore() {
      window.fetch = originalFetch;
      delete window.__sessionSwitchLatencyTransport;
    },
  };
  window.fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    if (method === "POST" && /\/(?:opencode|opencode2\/api)\/session\/[^/]+\/(?:prompt_async|prompt)$/.test(path)) {
      state.promptPosts += 1;
      if (state.promptPaths.length < 20) state.promptPaths.push(path);
    }
    return originalFetch(input, init);
  };
  window.__sessionSwitchLatencyTransport = state;
}

function alternatingColdOrder(targets: SessionSwitchTarget[], restoredSessionId: string): SessionSwitchTarget[] {
  const restored = targets.find((target) => target.sessionId === restoredSessionId);
  if (!restored) throw new Error(`Reload restored an unknown conversation ${restoredSessionId}.`);
  const cold = targets.filter((target) => target.sessionId !== restoredSessionId);
  const ordered: SessionSwitchTarget[] = [];
  let oldest = 0;
  let recent = cold.length - 1;
  while (oldest <= recent) {
    ordered.push(cold[oldest]!);
    if (oldest !== recent) ordered.push(cold[recent]!);
    oldest += 1;
    recent -= 1;
  }
  return [...ordered, restored];
}

function summary(samples: readonly SessionSwitchMeasurement[]) {
  const values = samples.map((sample) => sample.firstDisplayMs ?? Number.POSITIVE_INFINITY).sort((left, right) => left - right);
  const percentile = (value: number) => values[Math.max(0, Math.ceil(values.length * value) - 1)] ?? Number.POSITIVE_INFINITY;
  return { max: values.at(-1) ?? Number.POSITIVE_INFINITY, p50: percentile(0.5), p95: percentile(0.95) };
}

function requestedPlacement(place: Place): Place["kind"] {
  const value = process.env.OPENWORK_WORLD_PLACE?.trim();
  if (value === undefined || value === "") return place.kind;
  if (value !== "local" && value !== "daytona") {
    throw new Error(`OPENWORK_WORLD_PLACE must be local or daytona; received ${JSON.stringify(value)}.`);
  }
  return value;
}

export async function sessionSwitchLatency(seed: Seed, context: { place: Place }) {
  const requestedSurface = process.env.OPENWORK_EVAL_APP_SURFACE?.trim() || "electron";
  if (requestedSurface !== "electron" && requestedSurface !== "web") {
    throw new Error(`OPENWORK_EVAL_APP_SURFACE must be web or electron; received ${JSON.stringify(requestedSurface)}.`);
  }
  if (requestedSurface !== "web") throw new SkipError("app-web session-switch latency contract (OPENWORK_EVAL_APP_SURFACE=web)");
  const declaredPlacement = requestedPlacement(context.place);

  const engine = resolveEvalEngine();
  const providerId = "switch-10-provider-fixture";
  const modelId = "switch-10-model-fixture";
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const drafts = Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const prompt = `SWITCH-10-PROMPT-${number}-${nonce}: summarize the saved checkpoint for conversation ${number}.`;
    const lastLine = `SWITCH-10-FINAL-LINE-${number}-${nonce}`;
    return {
      index,
      title: `SWITCH-10 conversation ${number} ${nonce}`,
      prompt,
      answer: `Conversation ${number} has its own completed checkpoint and remains available after navigation.\n\n${lastLine}`,
      lastLine,
    };
  });
  const oldPrompt = `SWITCH-10-OLDER-TURN-${nonce}: record the earlier checkpoint before the final update.`;
  const oldLastLine = `SWITCH-10-OLDER-ANSWER-${nonce}`;
  const oldAnswer = `This is the deliberately older answer in conversation 01.\n\n${oldLastLine}`;
  const workloads = [
    ...drafts.map((target) => ({ promptMarker: target.prompt, latestUserTurn: true, finalReply: target.answer, steps: [] })),
    { promptMarker: oldPrompt, latestUserTurn: true, finalReply: oldAnswer, steps: [] },
  ];
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: workloads });
  const workspacePath = seed.tmpPath("switch-10-session-latency");
  const app = await seed.appWeb({
    name: "switch-10-session-latency",
    workspacePath,
    mocks: { agent: mock },
    headless: process.env.OPENWORK_EVAL_CHROME_HEADLESS === "1",
  });
  await setViewport(app, { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The isolated app-web model witness did not boot.");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "SWITCH-10 fixture provider",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-switch-10-fixture-only" },
        models: { [modelId]: { name: "SWITCH-10 fixture model" } },
      },
    },
  }, engine);
  const sessions = await seed.sessions(app, drafts.map((target) => target.title));
  const targets: SessionSwitchTarget[] = drafts.map((target, index) => {
    const session = sessions[index];
    if (!session) throw new Error(`Session ${index + 1} was not created.`);
    const expectedMessages: SessionSwitchTarget["expectedMessages"] = index === 0
      ? [
          { role: "user", text: oldPrompt },
          { role: "assistant", text: oldAnswer },
          { role: "user", text: target.prompt },
          { role: "assistant", text: target.answer },
        ]
      : [
          { role: "user", text: target.prompt },
          { role: "assistant", text: target.answer },
        ];
    return { ...target, sessionId: session.sessionId, expectedMessages };
  });
  const submissions = targets.flatMap((target) => target.index === 0
    ? [
        { sessionId: target.sessionId, prompt: oldPrompt, lastLine: oldLastLine },
        { sessionId: target.sessionId, prompt: target.prompt, lastLine: target.lastLine },
      ]
    : [{ sessionId: target.sessionId, prompt: target.prompt, lastLine: target.lastLine }]);

  await seed.evalIn(app, browserScript(async (workspaceId, engine, providerId, modelId, submissions) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
    const mount = base + "/workspace/" + encodeURIComponent(workspaceId) + "/" + (engine === "v2" ? "opencode2/api" : "opencode");
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(mount + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(path + " returned HTTP " + response.status + ": " + text.slice(0, 240));
      return text;
    };
    const isActive = (text: string, sessionId: string) => {
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch {}
      const payload = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed
        ? Reflect.get(parsed, "data") : parsed;
      if (Array.isArray(payload)) return payload.some((entry) => entry === sessionId
        || (entry !== null && typeof entry === "object" && (Reflect.get(entry, "id") === sessionId || Reflect.get(entry, "sessionID") === sessionId)));
      if (payload !== null && typeof payload === "object") {
        const entry = Reflect.get(payload, sessionId);
        if (entry === undefined) return false;
        if (entry !== null && typeof entry === "object") {
          const status = Reflect.get(entry, "type") ?? Reflect.get(entry, "status");
          return status !== "idle" && status !== "completed" && status !== "stopped";
        }
        return Boolean(entry);
      }
      return text.includes(sessionId);
    };
    for (const submission of submissions) {
      const id = encodeURIComponent(submission.sessionId);
      if (engine === "v2") {
        await request("/session/" + id + "/model", "POST", { model: { providerID: providerId, id: modelId } });
        await request("/session/" + id + "/prompt", "POST", { text: submission.prompt });
      } else {
        await request("/session/" + id + "/prompt_async", "POST", {
          agent: "build",
          model: { providerID: providerId, modelID: modelId },
          parts: [{ type: "text", text: submission.prompt }],
        });
      }
      const deadline = Date.now() + 60_000;
      let diagnostic = "";
      let settled = false;
      while (Date.now() < deadline) {
        const [messages, active] = await Promise.all([
          request("/session/" + id + "/message?limit=20"),
          request(engine === "v2" ? "/session/active" : "/session/status"),
        ]);
        diagnostic = messages.slice(-240);
        if (messages.includes(submission.prompt) && messages.includes(submission.lastLine)
          && !isActive(active, submission.sessionId)) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const persisted = await request("/session/" + id + "/message?limit=20");
      if (!settled || !persisted.includes(submission.prompt) || !persisted.includes(submission.lastLine)) {
        throw new Error("Completed native turn was not persisted for " + submission.sessionId + ": " + diagnostic);
      }
    }
  }, [workspace.workspaceId, engine, providerId, modelId, submissions]), { awaitPromise: true, timeoutMs: 180_000 });

  const transportRegistration = await addInitScript(app.client, installTransportObservation);
  await evaluate(app.client, installTransportObservation);
  const markerSet = new Set(workloads.map((workload) => workload.promptMarker));

  const nativeState = () => evaluate(app.client, browserScript(async (workspaceId, engine, targets, oldLastLine) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") };
    const mount = "/workspace/" + encodeURIComponent(workspaceId) + "/" + (engine === "v2" ? "opencode2/api" : "opencode");
    const get = async (path: string) => {
      const response = await fetch(base + mount + path, { headers, signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.text() };
    };
    const [inventory, active, ...histories] = await Promise.all([
      get("/session?limit=200"),
      get(engine === "v2" ? "/session/active" : "/session/status"),
      ...targets.map((target) => get("/session/" + encodeURIComponent(target.sessionId) + "/message?limit=20")),
    ]);
    const occurrences = (text: string, marker: string) => text.split(marker).length - 1;
    const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
    const object = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null;
    const stringField = (value: Record<string, unknown> | null, key: string) => typeof value?.[key] === "string" ? value[key] : "";
    const numberField = (value: Record<string, unknown> | null, key: string) => typeof value?.[key] === "number" ? value[key] : null;
    const normalize = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
    const nativeMessages = (body: string) => {
      let parsed: unknown = null;
      try { parsed = JSON.parse(body); } catch {}
      const parsedRecord = object(parsed);
      const payload = parsedRecord && "data" in parsedRecord ? parsedRecord.data : parsed;
      if (!Array.isArray(payload)) return [];
      return payload.flatMap((entry, arrayIndex) => {
        const message = object(entry);
        if (!message) return [];
        const info = object(message.info) ?? message;
        const time = object(info.time);
        const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
        const renderedText = parts.flatMap((part) => {
          const item = object(part);
          return item && item.type === "text" && typeof item.text === "string" ? [item.text] : [];
        }).join("");
        const directText = typeof message.text === "string" ? message.text : "";
        return [{
          arrayIndex,
          id: stringField(info, "id") || stringField(info, "messageID"),
          sessionId: stringField(info, "sessionID") || stringField(info, "sessionId"),
          role: stringField(info, "role") || stringField(info, "type"),
          parentId: stringField(info, "parentID") || stringField(info, "parentId"),
          created: numberField(time, "created") ?? numberField(info, "timestamp"),
          completed: numberField(time, "completed"),
          text: normalize(renderedText || directText),
        }];
      });
    };
    let parsedActive: unknown = null;
    try { parsedActive = JSON.parse(active.body); } catch {}
    const activePayload = parsedActive !== null && typeof parsedActive === "object" && !Array.isArray(parsedActive) && "data" in parsedActive
      ? Reflect.get(parsedActive, "data") : parsedActive;
    const activeTargetIds = targets.flatMap((target) => {
      if (Array.isArray(activePayload)) {
        const found = activePayload.some((entry) => entry === target.sessionId
          || (entry !== null && typeof entry === "object" && (Reflect.get(entry, "id") === target.sessionId || Reflect.get(entry, "sessionID") === target.sessionId)));
        return found ? [target.sessionId] : [];
      }
      if (activePayload !== null && typeof activePayload === "object") {
        const entry = Reflect.get(activePayload, target.sessionId);
        if (entry === undefined) return [];
        if (entry !== null && typeof entry === "object") {
          const status = Reflect.get(entry, "type") ?? Reflect.get(entry, "status");
          return status === "idle" || status === "completed" || status === "stopped" ? [] : [target.sessionId];
        }
        return entry ? [target.sessionId] : [];
      }
      return active.body.includes(target.sessionId) ? [target.sessionId] : [];
    });
    return {
      inventory,
      active,
      activeTargetIds,
      sessions: targets.map((target, index) => {
        const history = histories[index] ?? { status: 0, body: "" };
        const messages = nativeMessages(history.body);
        const expectedMatches = target.expectedMessages.map((expected, expectedIndex) => {
          const matches = messages.filter((message) => message.role === expected.role && message.text === normalize(expected.text));
          return { expectedIndex, role: expected.role, text: normalize(expected.text), count: matches.length, matches };
        });
        const matched = expectedMatches.flatMap((expected) => expected.matches);
        const matchedIds = matched.map((message) => message.id).filter(Boolean);
        const assistantRelationships = target.expectedMessages.flatMap((expected, expectedIndex) => {
          if (expected.role !== "user" || target.expectedMessages[expectedIndex + 1]?.role !== "assistant") return [];
          const user = expectedMatches[expectedIndex]?.matches[0];
          const assistant = expectedMatches[expectedIndex + 1]?.matches[0];
          if (!user || !assistant) return [];
          return [{
            userId: user.id,
            assistantId: assistant.id,
            assistantParentId: assistant.parentId,
            available: Boolean(assistant.parentId),
            matches: Boolean(assistant.parentId) && assistant.parentId === user.id,
          }];
        });
        const timestampRelationships = expectedMatches.slice(0, -1).flatMap((expected, expectedIndex) => {
          const earlier = expected.matches[0];
          const later = expectedMatches[expectedIndex + 1]?.matches[0];
          if (!earlier || !later || earlier.created === null || later.created === null) return [];
          return [{ earlierId: earlier.id, laterId: later.id, earlierCreated: earlier.created, laterCreated: later.created,
            chronological: earlier.created <= later.created }];
        });
        const timestampsAvailable = timestampRelationships.length > 0;
        const timestampsChronological = timestampsAvailable && timestampRelationships.every((relationship) => relationship.chronological);
        const parentRelationshipsAvailable = assistantRelationships.some((relationship) => relationship.available);
        return {
          index: target.index,
          sessionId: target.sessionId,
          status: history.status,
          body: history.body,
          promptOccurrences: occurrences(history.body, target.prompt),
          finalLineOccurrences: occurrences(history.body, target.lastLine),
          oldAnswerOccurrences: target.index === 0 ? occurrences(history.body, oldLastLine) : 0,
          expectedMessageCount: matched.length,
          expectedMessagesPresent: expectedMatches.every((expected) => expected.count === 1),
          expectedMessageIdsUnique: matchedIds.length === matched.length && new Set(matchedIds).size === matchedIds.length,
          userTurnCount: expectedMatches.filter((expected) => expected.role === "user").reduce((count, expected) => count + expected.count, 0),
          assistantTurnCount: expectedMatches.filter((expected) => expected.role === "assistant").reduce((count, expected) => count + expected.count, 0),
          timestampsAvailable,
          timestampsChronological,
          parentRelationshipsAvailable,
          parentRelationshipsValid: parentRelationshipsAvailable
            && assistantRelationships.every((relationship) => !relationship.available || relationship.matches),
          expectedMatches,
          timestampRelationships,
          parentRelationships: assistantRelationships,
          rawDiagnostic: target.index === 0
            ? messages.map(({ text, ...message }) => ({ ...message, textPrefix: text.slice(0, 180) })) : [],
        };
      }),
    };
  }, [workspace.workspaceId, engine, targets, oldLastLine]), { awaitPromise: true, timeoutMs: 30_000 });

  return {
    app,
    engine,
    providerId,
    modelId,
    workspace,
    targets,
    expectedProviderFinalRequests: submissions.length,
    firstVisitOrder: (restoredSessionId: string) => alternatingColdOrder(targets, restoredSessionId),
    warmVisitOrder: () => [...targets],
    summary,
    nativeState,
    compactNativeState(state: Awaited<ReturnType<typeof nativeState>>) {
      return {
        inventoryStatus: state.inventory.status,
        activeStatus: state.active.status,
        activeTargetIds: state.activeTargetIds,
        sessions: state.sessions.map(({ body, expectedMatches, rawDiagnostic, ...session }) => ({
          ...session,
          expectedMatchCounts: expectedMatches.map((message) => message.count),
          bodyBytes: body.length,
        })),
      };
    },
    sidebarTargetState: (sessionId: string) => evaluate(app.client, browserScript((workspaceId, sessionId) => {
      const workspace = document.querySelector<HTMLElement>(`[data-sidebar-workspace-id="${CSS.escape(workspaceId)}"]`);
      const row = workspace?.querySelector<HTMLElement>(`[data-sidebar-session-id="${CSS.escape(sessionId)}"][data-sidebar-session-workspace-id="${CSS.escape(workspaceId)}"]`);
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none"
          && style.visibility !== "hidden" && style.opacity !== "0";
      };
      const showMoreControls = [...(workspace?.querySelectorAll<HTMLElement>(
        '[data-sidebar="menu-sub-button"][data-slot="sidebar-menu-sub-button"]',
      ) ?? [])]
        .filter((control) => /^Show \d+ more$/.test(control.innerText.trim()))
        .filter(visible)
        .map((control) => ({
          label: control.innerText.trim(),
          tagName: control.tagName.toLowerCase(),
          dataSidebar: control.dataset.sidebar ?? "",
          dataSlot: control.dataset.slot ?? "",
          ariaDisabled: control.getAttribute("aria-disabled"),
        }));
      const visibleSessionCount = [...(workspace?.querySelectorAll<HTMLElement>(
        `[data-sidebar-session-workspace-id="${CSS.escape(workspaceId)}"]`,
      ) ?? [])]
        .filter((session) => {
          const rect = session.getBoundingClientRect();
          const style = getComputedStyle(session);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        })
        .length;
      return {
        workspacePresent: Boolean(workspace),
        targetPresent: Boolean(row),
        visibleSessionCount,
        showMoreControls,
        sidebarText: (workspace?.innerText ?? "").slice(0, 4_000),
        domShape: (workspace?.outerHTML ?? "").slice(0, 12_000),
      };
    }, [workspace.workspaceId, sessionId])),
    current: () => evaluate(app.client, () => {
      const surface = document.querySelector<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]');
      return {
        sessionId: surface?.dataset.sessionSurfaceId ?? "",
        workspaceId: surface?.dataset.sessionSurfaceWorkspaceId ?? "",
        hash: location.hash,
      };
    }),
    runtimeFacts: async () => ({
      ...(await evaluate(app.client, browserScript(async (
      workspaceId,
      engine,
      providerId,
      modelId,
      expectedOrigin,
      actualSourceSha,
      hostKind,
    ) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") };
      const [health, status, native] = await Promise.all([
        fetch(base + "/health", { headers }),
        fetch(base + "/experimental/engine-v2-preview/status", { headers }),
        fetch(base + "/workspace/" + encodeURIComponent(workspaceId) + (engine === "v2" ? "/opencode2/api/model" : "/opencode/session"), { headers }),
      ]);
      const statusBody = await status.text();
      const nativeBody = await native.text();
      let parsedStatus: unknown = null;
      try { parsedStatus = JSON.parse(statusBody); } catch {}
      const statusRecord = parsedStatus !== null && typeof parsedStatus === "object" && !Array.isArray(parsedStatus) ? parsedStatus : null;
      return {
        surface: window.__OPENWORK_ELECTRON__ ? "electron" : "web",
        electronBridge: Boolean(window.__OPENWORK_ELECTRON__),
        origin: location.origin,
        expectedOrigin,
        actualSourceSha,
        hostKind,
        engine,
        healthStatus: health.status,
        engineStatus: status.status,
        engineEnabled: statusRecord !== null && Reflect.get(statusRecord, "enabled") === true,
        engineRunning: statusRecord !== null && Reflect.get(statusRecord, "running") === true,
        chatRouting: statusRecord !== null && Reflect.get(statusRecord, "chatRouting") === true,
        nativeStatus: native.status,
        nativeRoute: engine === "v2" ? "/opencode2/api/model" : "/opencode/session",
        modelVisible: engine === "v1" || (nativeBody.includes(providerId) && nativeBody.includes(modelId)),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      };
    }, [workspace.workspaceId, engine, providerId, modelId, new URL(app.webUrl).origin, app.actualSourceSha, app.handle.hostKind]), {
      awaitPromise: true,
      timeoutMs: 30_000,
      })),
      requestedPlacement: declaredPlacement,
      resolvedPlacement: context.place.kind,
      actualHostKind: app.handle.hostKind,
      actualSandboxId: app.handle.sandboxId ?? null,
    }),
    async controllerCounts() {
      const allRequests = await agentMock.agentRequests();
      const requests = allRequests.filter((request) => request.kind === "final" && request.promptMarker !== null && markerSet.has(request.promptMarker));
      const byMarker: Record<string, number> = {};
      for (const request of requests) {
        if (request.promptMarker) byMarker[request.promptMarker] = (byMarker[request.promptMarker] ?? 0) + 1;
      }
      const transport = await evaluate(app.client, () => {
        const state = window.__sessionSwitchLatencyTransport;
        return { promptPosts: state?.promptPosts ?? -1, promptPaths: state?.promptPaths ?? [] };
      });
      return {
        providerRequests: allRequests.length,
        providerFinalRequests: requests.length,
        providerModels: [...new Set(requests.map((request) => request.model))],
        providerByMarker: byMarker,
        ...transport,
      };
    },
    async armMeasurement(target: SessionSwitchTarget, phase: SessionSwitchMeasurement["phase"]) {
      await evaluate(app.client, browserScript((workspaceId, target, targets, phase) => {
        window.__sessionSwitchLatencyMeasurement?.stop();
        delete window.__sessionSwitchLatencyMeasurement;
        const normalize = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
        const expected = target.expectedMessages.map((message) => ({ ...message, text: normalize(message.text) }));
        const expectedAnswer = normalize(target.answer);
        const foreignMarkers = targets.filter((candidate) => candidate.sessionId !== target.sessionId)
          .flatMap((candidate) => candidate.expectedMessages)
          .flatMap((message) => normalize(message.text).split("\n"));
        const currentOwner = () => document.querySelector<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]')?.dataset.sessionSurfaceId ?? "";
        const promptPosts = () => window.__sessionSwitchLatencyTransport?.promptPosts ?? -1;
        const state: SessionSwitchMeasurement = {
          phase,
          targetIndex: target.index,
          targetSessionId: target.sessionId,
          ownerAtArm: currentOwner(),
          ownerSessionId: currentOwner(),
          ownerWorkspaceId: "",
          matchedClickTarget: "",
          actionCaptured: false,
          ownerCommitted: false,
          completed: false,
          expired: false,
          elapsedMs: null,
          firstDisplayMs: null,
          stableFrames: 0,
          frames: 0,
          mutations: 0,
          sampleIntervalsMs: [],
          snapshots: [],
          finalAnswerCount: 0,
          lastAssistantText: "",
          lastLineVisible: false,
          loaderSeen: false,
          violations: [],
          promptPostsAtArm: promptPosts(),
          promptPostsAtEnd: promptPosts(),
        };
        let actionAt: number | null = null;
        let lastSampleAt = performance.now();
        let lastSignature = "";
        let frame = 0;
        let timeout = 0;
        let stopped = false;
        const addViolation = (value: string) => {
          if (!state.violations.includes(value)) state.violations.push(value);
        };
        const visibleText = (root: HTMLElement, text: string) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const value = node.nodeValue ?? "";
            const start = value.lastIndexOf(text);
            if (start >= 0) {
              const range = document.createRange();
              range.setStart(node, start);
              range.setEnd(node, start + text.length);
              const rect = range.getBoundingClientRect();
              let left = Math.max(0, rect.left);
              let right = Math.min(innerWidth, rect.right);
              let top = Math.max(0, rect.top);
              let bottom = Math.min(innerHeight, rect.bottom);
              for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                const box = ancestor.getBoundingClientRect();
                if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                  left = Math.max(left, box.left);
                  right = Math.min(right, box.right);
                }
                if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                  top = Math.max(top, box.top);
                  bottom = Math.min(bottom, box.bottom);
                }
              }
              const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
              return rect.width > 0 && rect.height > 0 && right > left && bottom > top
                && Boolean(hit && (root.contains(hit) || hit.contains(root)))
                && getComputedStyle(root).visibility !== "hidden" && getComputedStyle(root).display !== "none";
            }
            node = walker.nextNode();
          }
          return false;
        };
        const sample = (source: SwitchSnapshot["source"]) => {
          if (stopped) return;
          const now = performance.now();
          if (state.sampleIntervalsMs.length < 20) state.sampleIntervalsMs.push(now - lastSampleAt);
          lastSampleAt = now;
          const pane = document.querySelector<HTMLElement>('[data-workbench-pane="primary"]');
          const surface = pane?.querySelector<HTMLElement>("[data-session-surface-id]");
          const ownerSessionId = surface?.dataset.sessionSurfaceId ?? "";
          const ownerWorkspaceId = surface?.dataset.sessionSurfaceWorkspaceId ?? "";
          const ownerCommitted = ownerSessionId === target.sessionId && ownerWorkspaceId === workspaceId;
          const assistantRows = [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="assistant"]') ?? [])];
          const renderedRows = [...(surface?.querySelectorAll<HTMLElement>("[data-message-role]") ?? [])]
            .map((row) => ({ role: row.dataset.messageRole ?? "", text: normalize(row.innerText) }));
          const assistantTexts = assistantRows.map((row) => normalize(row.innerText));
          const lastAssistantText = assistantTexts.at(-1) ?? "";
          const finalAnswerCount = assistantTexts.filter((text) => text === expectedAnswer).length;
          const surfaceText = normalize(surface?.innerText ?? "");
          const foreignContent = ownerCommitted ? foreignMarkers.filter((marker) => surfaceText.includes(marker)) : [];
          const knownOrder = renderedRows.flatMap((row) => {
            const index = expected.findIndex((message) => message.role === row.role && message.text === row.text);
            return index < 0 ? [] : [index];
          });
          const duplicates = expected.filter((message) => renderedRows.filter((row) => row.role === message.role && row.text === message.text).length > 1);
          const orderReversed = knownOrder.some((value, index) => index > 0 && value < knownOrder[index - 1]!);
          const paneText = pane?.innerText ?? "";
          const starters = ["What do you need done?", "Try one of these:", "Try one of your organization's prompts:", "Connect a model provider to get started:"]
            .some((label) => paneText.includes(label));
          const loader = paneText.includes("Opening session") || paneText.includes("Switching session");
          const lastRow = assistantRows.at(-1);
          const lastLineVisible = Boolean(lastRow && lastAssistantText === expectedAnswer && visibleText(lastRow, target.lastLine));
          state.ownerSessionId = ownerSessionId;
          state.ownerWorkspaceId = ownerWorkspaceId;
          state.ownerCommitted ||= ownerCommitted;
          state.finalAnswerCount = finalAnswerCount;
          state.lastAssistantText = lastAssistantText;
          state.lastLineVisible = lastLineVisible;
          state.loaderSeen ||= loader;
          state.promptPostsAtEnd = promptPosts();
          state.elapsedMs = actionAt === null ? null : now - actionAt;
          if (ownerCommitted) {
            if (foreignContent.length > 0) addViolation("foreign persisted content painted under destination owner");
            if (starters) addViolation("empty-task starters painted under historical destination owner");
            if (duplicates.length > 0) addViolation("known persisted message duplicated");
            if (orderReversed) addViolation("known persisted message order reversed");
          }
          if (state.promptPostsAtEnd !== state.promptPostsAtArm) addViolation("navigation issued a prompt POST");
          if (loader && state.elapsedMs !== null && state.elapsedMs >= 2_000) addViolation("loading indicator remained at the two-second ceiling");
          const correct = actionAt !== null && ownerCommitted && finalAnswerCount === 1
            && lastAssistantText === expectedAnswer && lastLineVisible && state.violations.length === 0;
          if (state.firstDisplayMs !== null && !correct) addViolation("latest answer regressed after its first correct paint");
          if (correct && state.firstDisplayMs === null) state.firstDisplayMs = state.elapsedMs;
          else if (correct && source === "frame") state.stableFrames += 1;
          const signature = JSON.stringify([ownerSessionId, ownerWorkspaceId, lastAssistantText, foreignContent, starters, loader, state.violations]);
          if ((source === "capture" || signature !== lastSignature) && state.snapshots.length < 20) {
            state.snapshots.push({ source, elapsedMs: state.elapsedMs, ownerSessionId, ownerWorkspaceId,
              lastAssistantPrefix: lastAssistantText.slice(0, 180), foreignContent, starters, loader });
            lastSignature = signature;
          }
          if (correct && state.stableFrames >= 2) {
            state.completed = true;
            stop();
          }
        };
        const capture = (event: MouseEvent) => {
          if (actionAt !== null || !(event.target instanceof Element)) return;
          const row = event.target.closest<HTMLElement>("[data-sidebar-session-id], [data-session-tab-id]");
          const sidebarMatch = row?.dataset.sidebarSessionId === target.sessionId;
          const tabMatch = row?.dataset.sessionTabId === target.sessionId;
          if (!sidebarMatch && !tabMatch) return;
          actionAt = performance.now();
          state.actionCaptured = true;
          state.matchedClickTarget = sidebarMatch
            ? `[data-sidebar-session-id="${target.sessionId}"]`
            : `[data-session-tab-id="${target.sessionId}"]`;
          clearTimeout(timeout);
          timeout = window.setTimeout(() => { sample("timeout"); state.expired = true; stop(); }, 5_000);
          sample("capture");
        };
        const mutations = new MutationObserver(() => { state.mutations += 1; sample("mutation"); });
        const paint = () => { state.frames += 1; sample("frame"); frame = requestAnimationFrame(paint); };
        function stop() {
          if (stopped) return;
          stopped = true;
          clearTimeout(timeout);
          cancelAnimationFrame(frame);
          mutations.disconnect();
          document.removeEventListener("click", capture, true);
        }
        document.addEventListener("click", capture, true);
        mutations.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        frame = requestAnimationFrame(paint);
        timeout = window.setTimeout(() => { state.expired = true; stop(); }, 30_000);
        window.__sessionSwitchLatencyMeasurement = { state, stop };
        sample("initial");
      }, [workspace.workspaceId, target, targets, phase]));
    },
    readMeasurement: () => evaluate(app.client, () => {
      const measurement = window.__sessionSwitchLatencyMeasurement?.state;
      if (!measurement) throw new Error("The SWITCH-10 measurement observer is unavailable.");
      return measurement;
    }),
    async [Symbol.asyncDispose]() {
      await evaluate(app.client, () => {
        window.__sessionSwitchLatencyMeasurement?.stop();
        window.__sessionSwitchLatencyTransport?.restore();
      }).catch(() => undefined);
      await transportRegistration.dispose();
    },
  };
}
