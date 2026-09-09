import { browserScript, type Surface } from "@openwork/cdp";
import { resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import type { MockMcpHandle } from "@openwork/labs";
import { chatContinuity } from "./chat-continuity.ts";
import { configureProvider } from "./chat.ts";

export const streamedContinuityMarker = "CONT_01_STREAM_PREFIX";
export const streamedContinuityPrompt = `Prepare the requested continuity report. ${streamedContinuityMarker}`;
export const streamedContinuityBullets = [
  "01 amber-orbit confirms the first checkpoint.",
  "02 birch-signal confirms the offscreen checkpoint.",
  "03 cobalt-river preserves the returning prefix.",
  "04 dune-lantern keeps the sequence ordered.",
  "05 ember-maple crosses the second switch intact.",
  "06 fjord-needle follows the completed fifth entry.",
  "07 granite-pulse remains cumulative while held.",
  "08 harbor-quartz arrives after the final release.",
  "09 indigo-summit keeps its unique position.",
  "10 juniper-vault closes the continuity report.",
];
export const streamedContinuityPartialThird = "03 cobalt-river preserves the returning";
export const streamedContinuityPartialFifth = "05 ember-maple crosses the second switch";
export const streamedContinuityPartialSeventh = "07 granite-pulse remains cumulative";
export const streamedContinuityAnswer = streamedContinuityBullets.map((bullet) => `- ${bullet}`).join("\n");
export const streamedContinuityChunks = [
  `- ${streamedContinuityBullets[0]}\n`,
  `- ${streamedContinuityBullets[1]}\n`,
  `- ${streamedContinuityPartialThird}`,
  `${streamedContinuityBullets[2].slice(streamedContinuityPartialThird.length)}\n- ${streamedContinuityBullets[3]}\n- ${streamedContinuityPartialFifth}`,
  `${streamedContinuityBullets[4].slice(streamedContinuityPartialFifth.length)}\n- ${streamedContinuityBullets[5]}\n- ${streamedContinuityPartialSeventh}`,
  `${streamedContinuityBullets[6].slice(streamedContinuityPartialSeventh.length)}\n- ${streamedContinuityBullets[7]}\n- ${streamedContinuityBullets[8]}\n- ${streamedContinuityBullets[9]}`,
];

function requestedSurface(): "electron" | "web" {
  const value = process.env.OPENWORK_EVAL_APP_SURFACE?.trim() || "web";
  if (value !== "electron" && value !== "web") {
    throw new Error(`OPENWORK_EVAL_APP_SURFACE must be web or electron; received ${JSON.stringify(value)}.`);
  }
  return value;
}

function requestedPlacement(place: Place): Place["kind"] {
  const value = process.env.OPENWORK_WORLD_PLACE?.trim();
  if (value === undefined || value === "") return place.kind;
  if (value !== "local" && value !== "daytona") {
    throw new Error(`OPENWORK_WORLD_PLACE must be local or daytona; received ${JSON.stringify(value)}.`);
  }
  return value;
}

async function createSession(seed: Seed, app: Surface, title: string) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Isolated CONT-01 fixture; legacy streamed-markdown cases keep their original desktop world. */
export async function chatStreamContinuity(seed: Seed, context: { place: Place }) {
  const surface = requestedSurface();
  const declaredPlacement = requestedPlacement(context.place);
  const engine = resolveEvalEngine();
  const providerId = "stream-continuity-mock";
  const modelId = "stream-continuity-model";
  const workspacePath = seed.tmpPath("chat-stream-continuity");
  const mock = seed.mock({
    isolatedProcessEnv: surface === "web",
    agentWorkloads: [{
      promptMarker: streamedContinuityMarker,
      latestUserTurn: true,
      finalReply: streamedContinuityAnswer,
      finalReplyChunks: [...streamedContinuityChunks],
      finalReplyInitiallyReleasedChunks: 1,
      steps: [],
    }],
  });

  let app: Surface;
  let agentMock: MockMcpHandle;
  let expectedOrigin: string | null = null;
  if (surface === "web") {
    const web = await seed.appWeb({
      name: "chat-stream-continuity",
      workspacePath,
      mocks: { agent: mock },
      headless: process.env.OPENWORK_EVAL_CHROME_HEADLESS === "1",
    });
    app = web;
    const configured = web.mocks.agent;
    if (!configured) throw new Error("The app-web fixture did not boot its stream-continuity model witness.");
    agentMock = configured;
    expectedOrigin = new URL(web.webUrl).origin;
  } else {
    const den = await seed.den({ mocks: { agent: mock } });
    app = await seed.desktop({ name: "chat-stream-continuity", den, as: "admin", model: `${providerId}/${modelId}` });
    const configured = den.mocks.agent;
    if (!configured) throw new Error("The Electron fixture did not boot its stream-continuity model witness.");
    agentMock = configured;
  }

  const workspace = await seed.workspace(app, workspacePath);
  const continuity = chatContinuity(app, workspace.workspaceId);
  const engineHttpEvents = await continuity.observeEngineHttpEvents();
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stream continuity mock",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-stream-continuity-fixture" },
        models: { [modelId]: { name: "Stream continuity model" } },
      },
    },
  }, engine);
  const neighbor = await createSession(seed, app, "Unrelated continuity control");
  const session = await createSession(seed, app, "Streaming continuity report");
  const nativePath = (sessionId: string) => `/workspace/${encodeURIComponent(workspace.workspaceId)}`
    + `/${engine === "v2" ? "opencode2/api" : "opencode"}/session/${encodeURIComponent(sessionId)}/message?limit=100`;

  return {
    app,
    surface,
    engine,
    workspace,
    session,
    neighbor,
    continuity,
    engineHttpEvents: () => engineHttpEvents.read(),
    replyState: () => agentMock.agentReplyState(streamedContinuityMarker),
    releaseReply: (count = 1) => agentMock.releaseAgentReply(streamedContinuityMarker, count),
    providerFinalRequests: async () => (await agentMock.agentRequests({ promptMarker: streamedContinuityMarker }))
      .filter((request) => request.kind === "final"),
    readNative: (sessionId: string) => seed.evalIn(app, browserScript(async (path) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      return { status: response.status, text: await response.text() };
    }, [nativePath(sessionId)]), { awaitPromise: true, timeoutMs: 30_000 }),
    runtimeFacts: async () => ({
      ...(await seed.evalIn(app, browserScript(async (workspaceId, engine, providerId, modelId, expectedOrigin) => {
      const port = localStorage.getItem("openwork.server.port") ?? "";
      const token = localStorage.getItem("openwork.server.token") ?? "";
      const base = "http://127.0.0.1:" + port;
      const headers = { Authorization: "Bearer " + token };
      const [healthResponse, statusResponse, nativeResponse] = await Promise.all([
        fetch(base + "/health", { headers }),
        fetch(base + "/experimental/engine-v2-preview/status", { headers }),
        fetch(base + `/workspace/${encodeURIComponent(workspaceId)}`
          + (engine === "v2" ? "/opencode2/api/model" : "/opencode/session"), { headers }),
      ]);
      const rawStatus: unknown = statusResponse.ok ? await statusResponse.json() : null;
      const status = typeof rawStatus === "object" && rawStatus !== null && !Array.isArray(rawStatus) ? rawStatus : {};
      const nativeText = await nativeResponse.text();
      return {
        surface: window.__OPENWORK_ELECTRON__ ? "electron" : "web",
        origin: location.origin,
        expectedOrigin,
        electronBridge: Boolean(window.__OPENWORK_ELECTRON__),
        browser: navigator.userAgent,
        tokenPresent: token.length > 0,
        serverPortPresent: port.length > 0,
        healthStatus: healthResponse.status,
        engineStatus: statusResponse.status,
        engineRunning: Reflect.get(status, "running") === true,
        engineChatRouting: Reflect.get(status, "chatRouting") === true,
        nativeStatus: nativeResponse.status,
        syntheticModelInNativeResponse: nativeText.includes(providerId) && nativeText.includes(modelId),
      };
      }, [workspace.workspaceId, engine, providerId, modelId, expectedOrigin]), { awaitPromise: true, timeoutMs: 30_000 })),
      requestedPlacement: declaredPlacement,
      resolvedPlacement: context.place.kind,
      actualHostKind: app.handle.hostKind,
      actualSandboxId: app.handle.sandboxId ?? null,
    }),
    [Symbol.asyncDispose]: () => engineHttpEvents[Symbol.asyncDispose](),
  };
}
