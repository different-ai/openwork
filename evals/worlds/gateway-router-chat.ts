import { browserScript } from "@openwork/cdp";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import { localMysqlIsRunning, needs, server, SkipError } from "@openwork/testkit";
import { configureProvider } from "./chat.ts";
import { api, orgId, record, routerGateway, routerUpstream, rows, text } from "./gateway-router.ts";

const exec = promisify(execFile);
async function engines() {
  const { stdout } = await exec("ps", ["-axo", "pid=,args="], { timeout: 5_000 });
  return stdout.split("\n").flatMap(line => {
    // The pinned npm package ships an ELF named opencode.exe on Linux too.
    const match = line.match(/^\s*(\d+)\s+(\S*opencode(?:\.exe)?)\s+serve\b/);
    return match ? [{ pid: match[1], binary: match[2] }] : [];
  });
}

// Deliberately synthetic Jev classification, not live Jev quality verification.
export async function gatewayRouterChat(seed: Seed, { place }: { place: Place }) {
  needs({ placement: "local", commands: ["pnpm", "bun", "ps", "opencode"] });
  if (place.kind !== "local" || resolveEvalEngine() !== "v1" || process.env.OPENWORK_EVAL_DEN_API_URL) {
    throw new SkipError("Co-located source appWeb, managed OpenCode v1, scratch MySQL, Den and Gateway required");
  }
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  const expectedEngineVersion = text(record(JSON.parse(await readFile(new URL("../../constants.json", import.meta.url), "utf8"))).opencodeVersion).replace(/^v/, "");
  const availableEngineVersion = (await exec("opencode", ["--version"], { timeout: 15_000 })).stdout.trim();
  if (availableEngineVersion !== expectedEngineVersion) throw new Error(`Install the pinned OpenCode ${expectedEngineVersion} in this executor; found ${availableEngineVersion}`);
  await using resources = new AsyncDisposableStack();
  const nonce = `${Date.now()}-${process.pid}`;
  const cases = [
    { prompt: `Explain TypeScript generics. GR_CODE_${nonce}`, model: "gpt-4o", route: "code", fallback: "none", answer: "A generic preserves the relationship between input and output types." },
    { prompt: `Write a poem about rain. GR_WRITE_${nonce}`, model: "gpt-4o-mini", route: "writing", fallback: "none", answer: "Rain taps the quiet window; silver rivers wake the street." },
    { prompt: `An uncertain question about tomorrow. GR_FALLBACK_${nonce}`, model: "gpt-4o-mini", route: "writing", fallback: "low_confidence", answer: "Tomorrow remains open; begin with one small, reversible step." },
  ];
  const exactPrompt = (body: Record<string, unknown>, prompt: string) => {
    const users = rows(body.messages).filter(message => message.role === "user");
    if (users.length !== 1) return false;
    const content = users[0]?.content;
    const original = typeof content === "string" ? content : Array.isArray(content)
      ? content.map(record).filter(part => part.type === "text").map(part => part.text).join("") : null;
    return original === prompt;
  };
  const upstream = resources.use(await routerUpstream(body => cases.find(item => exactPrompt(body, item.prompt))?.answer ?? "Router chat title"));
  const name = `Router chat ${nonce}`;
  const den = resources.use(await server({ place, web: false,
    env: { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_ENABLED: "true",
      GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:19999", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:19999", GATEWAY_EGRESS_ALLOWED_ORIGINS: upstream.baseUrl },
    org: { name, admin: { name: "Router Admin" }, members: { owner: { name: "Router Owner" } } },
  }));
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Scratch database required");
  const owner = den.members.owner;
  if (!owner) throw new Error("Missing router owner");
  const organization = await orgId(den.admin, name);
  const checked = async (session: typeof owner, path: string, method = "GET", body?: unknown) => {
    const result = await api(session, organization, path, method, body);
    if (!result.response.ok) throw new Error(`${method} ${path}: ${result.response.status} ${result.text}`);
    return record(result.body);
  };
  const provider = record((await checked(den.admin, "/v1/inference-providers", "POST", {
    name: "Chat controlled destination", providerId: "openai", modelIds: ["gpt-4o", "gpt-4o-mini"], allMembers: true,
    credential: { kind: "api_key", secret: "fixture-upstream-key" }, settings: { upstreamBaseUrl: `${upstream.baseUrl}/v1` },
  })).inferenceProvider);
  const providerId = text(provider.id);
  const connection = record((await checked(owner, `/v1/inference-providers/${providerId}/connect`)).inferenceProvider);
  const key = text(connection.apiKey);
  const models = rows(connection.models);
  const definition = { name: "Chat prompt router", status: "active", minConfidence: 0.8, fallbackRouteId: "writing",
    routes: cases.slice(0, 2).map(item => ({ id: item.route, description: item.route === "code" ? "Programming questions" : "Creative writing",
      inferenceProviderId: providerId, model: text(models.find(model => model.upstreamModelId === item.model)?.id) })) };
  const router = record((await checked(owner, "/v1/gateway-routers", "POST", definition)).router);
  const id = text(router.id);
  const persisted = record((await checked(owner, `/v1/gateway-routers/${id}`)).router);
  const gateway = resources.use(await routerGateway(databaseUrl, upstream.baseUrl));
  const workspacePath = seed.tmpPath("gateway-router-chat");
  const previousEngines = await engines();
  const app = await seed.appWeb({ name: "gateway-router-chat", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const providerIdInEngine = "gateway-router-chat";
  await configureProvider(seed, app, workspace.workspaceId, providerIdInEngine, "auto", {
    model: `${providerIdInEngine}/auto`, small_model: `${providerIdInEngine}/auto`, default_agent: "build",
    provider: { [providerIdInEngine]: { npm: "@ai-sdk/openai-compatible", name: "Gateway router",
      options: { baseURL: `${gateway.baseUrl}/api/v1/routers/${id}`, apiKey: key },
      models: { auto: { name: "Automatic router", tool_call: false } } } },
  }, "v1");
  const sessions = await seed.sessions(app, cases.map((_, index) => `Router chat ${index + 1}`));
  const read = (path: string) => seed.evalIn(app, browserScript(async path => {
    const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + path,
      { headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") } });
    if (!response.ok) throw new Error(`Readback ${path}: ${response.status}`);
    return response.json();
  }, [path]), { awaitPromise: true, timeoutMs: 30_000 });
  const nativeBase = `/workspace/${workspace.workspaceId}/opencode`;
  const lifetime = resources.move();
  return {
    app, cases, sessions, persisted, definition,
    async runtimeFacts() {
      const managed = (await engines()).filter(engine => !previousEngines.some(previous => previous.pid === engine.pid));
      if (managed.length !== 1 || !managed[0]) throw new Error("Expected exactly one new real managed OpenCode serve process");
      const binary = managed[0];
      const version = (await exec(binary.binary, ["--version"], { timeout: 15_000 })).stdout.trim();
      return { actualSourceSha: app.actualSourceSha, hostKind: app.handle.hostKind, engine: "v1", expectedEngineVersion,
        binary: { ...binary, version },
        classifier: "injected deterministic Jev seam (not live Jev)",
        nativeHealth: await read(`${nativeBase}/global/health`) };
    },
    async native(sessionId: string) {
      return rows(await read(`${nativeBase}/session/${sessionId}/message`)).map(message => ({
        role: record(message.info).role, error: record(message.info).error,
        text: rows(message.parts).filter(part => part.type === "text").map(part => part.text).join("\n"),
      }));
    },
    visible(sessionId: string) { return seed.evalIn(app, browserScript(sessionId => {
      const surface = document.querySelector(`[data-session-surface-id="${sessionId}"]`);
      return [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="assistant"]') ?? [])]
        .filter(node => node.getClientRects().length > 0).map(node => node.innerText);
    }, [sessionId])); },
    async witness(prompt: string) {
      const response = await fetch(`${gateway.baseUrl}/witness`, { signal: AbortSignal.timeout(5_000) });
      const witness = record(await response.json());
      return { evaluations: rows(witness.evaluations).filter(entry => entry.text === prompt),
        dispatches: rows(witness.dispatches).filter(entry => exactPrompt(record(entry.body), prompt)),
        upstream: upstream.requests.filter(entry => exactPrompt(entry.body, prompt)) };
    },
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}
