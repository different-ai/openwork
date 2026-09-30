import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { browserScript, type Surface } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { assertNoLiveSecret, liveOpenAiEnabled, liveOpenAiModel } from "@openwork/behaviors";
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

export const liveContinuityPrompt = "Write an original practical guide to observing seasonal changes in a public garden. "
  + "Use 80 numbered paragraphs of 35 to 45 words each, without a preamble or conclusion. "
  + "Give a different concrete observation in each paragraph. Write the entire guide in this one answer, "
  + "not an outline or a sample. Do not use tools, files, or external research.";

export async function chatStreamContinuityLiveWeb(seed: Seed, context: { place: Place }) {
  if (!liveOpenAiEnabled() || !process.env.OPENAI_API_KEY?.trim()) throw new SkipError("Live continuity requires OPENWORK_EVAL_LIVE_OPENAI=1 and OPENAI_API_KEY");
  if (context.place.kind !== "local" || resolveEvalEngine() !== "v1") throw new SkipError("Live continuity requires --engine v1 --surface web --local");
  const modelId = liveOpenAiModel();
  const providerId = "openai";
  const workspacePath = seed.tmpPath("chat-stream-continuity-live");
  const app = await seed.appWeb({ name: "chat-stream-continuity-live", workspacePath });
  const manifest: unknown = JSON.parse(await readFile(resolve(import.meta.dirname, "../../tmp/worlds/runtime", app.handle.name, "runtime.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("hostToken" in manifest) || typeof manifest.hostToken !== "string"
    || !("token" in manifest) || typeof manifest.token !== "string"
    || !("openworkUrl" in manifest) || manifest.openworkUrl !== app.openworkUrl) throw new Error("Owned app-web runtime receipt mismatch");
  const clientToken = manifest.token;
  const headers = { "x-openwork-host-token": manifest.hostToken, "content-type": "application/json" };
  const provision = async (path: string, method: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetch(app.openworkUrl + path, {
        method, headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Error(`Live provider provisioning failed at ${path} (details suppressed)`); }
    if (!response.ok) throw new Error(`Live provider provisioning ${path}: HTTP ${response.status}`);
    const result: unknown = await response.json().catch(() => {
      throw new Error(`Live provider provisioning ${path}: invalid JSON (details suppressed)`);
    });
    assertNoLiveSecret(result);
  };
  await provision("/env", "PUT", { entries: [{ key: "OPENAI_API_KEY", value: process.env.OPENAI_API_KEY.trim() }] });
  const provider = {
    id: providerId, name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"],
    models: { [modelId]: { name: modelId, limit: { context: 128_000, output: 6_500 }, options: { reasoningEffort: "none" } } },
  };
  await provision("/runtime-config/providers", "PATCH", { provider: { [providerId]: provider } });
  const workspace = await seed.workspace(app, workspacePath);
  const continuity = chatContinuity(app, workspace.workspaceId);
  const engineHttpEvents = await continuity.observeEngineHttpEvents();
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    default_agent: "build", provider: { [providerId]: provider }, tools: { "*": false },
  }, "v1");
  const neighbor = await createSession(seed, app, "Live unrelated control");
  const session = await createSession(seed, app, "Live garden guide");
  const nativePath = (id: string) => `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/session/${encodeURIComponent(id)}/message`;
  return {
    app, workspace, session, neighbor, modelId, providerId, continuity,
    readNative: async (id: string) => {
      const response = await fetch(app.openworkUrl + nativePath(id), {
        headers: { Authorization: `Bearer ${clientToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json().catch(() => {
        throw new Error("Live native observation returned invalid JSON (details suppressed)");
      });
      assertNoLiveSecret(body);
      return { status: response.status, body };
    },
    engineHttpEvents: () => engineHttpEvents.read(),
    runtimeFacts: async () => ({
      actualSourceSha: app.actualSourceSha, hostKind: app.handle.hostKind, mockCount: Object.keys(app.mocks).length,
      // Read-only renderer identity has no typed probe; this observes the browser/bridge without credentials or state changes.
      ...(await seed.evalIn(app, () => ({
        electronBridge: Boolean(window.__OPENWORK_ELECTRON__), browser: navigator.userAgent,
      }))),
    }),
    [Symbol.asyncDispose]: () => engineHttpEvents[Symbol.asyncDispose](),
  };
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

/** Headless app-web CONT-01 fixture; legacy cases keep their original desktop world. */
export async function chatStreamContinuityWeb(seed: Seed, context: { place: Place }) {
  const declaredPlacement = requestedPlacement(context.place);
  const engine = resolveEvalEngine();
  const providerId = "stream-continuity-mock";
  const modelId = "stream-continuity-model";
  const workspacePath = seed.tmpPath("chat-stream-continuity");
  const planPrompt = "Outline the next continuity check.";
  const planReply = "The next check will compare the retained report with its checkpoints.";
  const defaultPrompt = "Verify the completed continuity report.";
  const defaultReply = "The retained report still matches every continuity checkpoint.";
  const mock = seed.mock({
    isolatedProcessEnv: true,
    agentWorkloads: [{
      promptMarker: streamedContinuityMarker,
      latestUserTurn: true,
      finalReply: streamedContinuityAnswer,
      finalReplyChunks: [...streamedContinuityChunks],
      finalReplyInitiallyReleasedChunks: 1,
      steps: [],
    }, ...(engine === "v1" ? [{
      promptMarker: planPrompt,
      latestUserTurn: true,
      finalReply: planReply,
      steps: [],
    }, {
      promptMarker: defaultPrompt,
      latestUserTurn: true,
      finalReply: defaultReply,
      steps: [],
    }] : [])],
  });

  const app = await seed.appWeb({
    name: "chat-stream-continuity",
    workspacePath,
    mocks: { agent: mock },
  });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The app-web fixture did not boot its stream-continuity model witness.");
  const expectedOrigin = new URL(app.webUrl).origin;

  const workspace = await seed.workspace(app, workspacePath);
  const continuity = chatContinuity(app, workspace.workspaceId);
  const engineHttpEvents = await continuity.observeEngineHttpEvents();
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    ...(engine === "v1" ? { default_agent: "build" } : {}),
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
    engine,
    workspace,
    session,
    neighbor,
    planPrompt,
    planReply,
    defaultPrompt,
    defaultReply,
    continuity,
    engineHttpEvents: () => engineHttpEvents.read(),
    replyState: () => agentMock.agentReplyState(streamedContinuityMarker),
    releaseReply: (count = 1) => agentMock.releaseAgentReply(streamedContinuityMarker, count),
    providerFinalRequests: async (promptMarker = streamedContinuityMarker) => (await agentMock.agentRequests({ promptMarker }))
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
      actualSourceSha: app.actualSourceSha,
      requestedPlacement: declaredPlacement,
      resolvedPlacement: context.place.kind,
      actualHostKind: app.handle.hostKind,
      actualSandboxId: app.handle.sandboxId ?? null,
    }),
    [Symbol.asyncDispose]: () => engineHttpEvents[Symbol.asyncDispose](),
  };
}
