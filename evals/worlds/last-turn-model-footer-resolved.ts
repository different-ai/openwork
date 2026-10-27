import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real Den, engine sessions and headless UI; only native history GETs are fixtures.
 * resolvedModel deliberately crosses the real v2 adapter, rather than setting
 * renderer messages or manufacturing its projected replyModel metadata. */
export async function lastTurnModelFooterResolved(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const { den, webPort } = await denForAppWeb(seed, {
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The footer proof requires an organization.");
  const enabled = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { liveProviderSync: true } }),
  });
  if (!enabled.response.ok) throw new Error(`Enabling live provider sync failed: ${enabled.response.status} ${enabled.text}`);
  const assigned = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST", body: JSON.stringify({ name: "Reply model proof", providerId: "openai", modelIds: ["gpt-4o-mini"],
      credential: { kind: "api_key", secret: "synthetic-footer-upstream-key" }, allMembers: true }),
  });
  const provider = isRecord(assigned.body) && isRecord(assigned.body.inferenceProvider) ? assigned.body.inferenceProvider : undefined;
  const catalogModels = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const gatewayModel = catalogModels.find(model => model.upstreamModelId === "gpt-4o-mini");
  if (!assigned.response.ok || !provider || typeof provider.id !== "string" || !gatewayModel || typeof gatewayModel.id !== "string" || typeof gatewayModel.name !== "string") {
    throw new Error(`Creating the footer's real gateway catalog failed: ${assigned.response.status}`);
  }
  const gatewayName = gatewayModel.name;
  const gatewayIdentity = { providerID: provider.id, id: gatewayModel.id };
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    env: { OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken },
    name: "last-turn-model-footer-resolved", den, webPort, headless: true, engine: "v2",
    workspacePath: seed.tmpPath("last-turn-model-footer-resolved"),
  });
  const normal = await seed.session(app, { title: "Model footer" });
  const auto = await seed.session(app, { title: "Auto reply" });
  const gateway = await seed.session(app, { title: "Gateway reply" });
  const gatewayReply = { prompt: "Give me the document status.", reply: "The gateway reply is ready." };
  const older = { prompt: "Check five report sections and summarize the result.", reply: "All five report sections are ready." };
  const latest = { prompt: "Give me the final report status.", reply: "The report is ready to share." };
  const autoReply = { prompt: "Give me a reply using Auto.", reply: "The Auto reply is ready." };
  const autoModelName = "GPT-6 Luna";
  const modelName = "Claude Opus 4.5";
  const model = { providerID: "anthropic", id: "claude-opus-4-5" };
  const resolvedModel = { ...model, name: modelName };
  const now = Date.now();
  const user = (id: string, sessionID: string, text: string, created: number) => ({
    id, sessionID, type: "user", time: { created }, text,
  });
  const assistant = (id: string, sessionID: string, text: string, created: number, completed: number, automatic = false) => ({
    id, sessionID, type: "assistant", time: { created, completed },
    model: automatic ? { providerID: "openwork", id: "openai/gpt-6-luna" } : model,
    resolvedModel: automatic ? { providerID: "openai", id: "openai/gpt-6-luna", name: autoModelName } : resolvedModel,
    finish: "stop", content: [{ type: "text", text }],
  });
  const olderAssistant = {
    ...assistant("msg_footer_02", normal.sessionId, older.reply, now - 100_000, now - 21_000),
    content: [
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "tool", callID: `call_footer_section_${index + 1}`, tool: "shell",
        time: { created: now - 100_000 + index * 15_000, ran: now - 100_000 + index * 15_000, completed: now - 86_000 + index * 15_000 },
        state: {
          status: "completed", title: `Check report section ${index + 1}`,
          input: { command: `printf 'Section ${index + 1} checked\\n'`, description: `Check report section ${index + 1}` },
          content: [{ type: "text", text: `Section ${index + 1} checked\n` }],
        },
      })),
      { type: "text", text: older.reply },
    ],
  };
  const histories = new Map<string, Record<string, unknown>[]>([
    [normal.sessionId, [
      user("msg_footer_01", normal.sessionId, older.prompt, now - 100_000),
      olderAssistant,
      user("msg_footer_03", normal.sessionId, latest.prompt, now - 10_000),
      assistant("msg_footer_04", normal.sessionId, latest.reply, now - 10_000, now - 3_000),
    ]],
    [gateway.sessionId, [
      user("msg_footer_gateway_01", gateway.sessionId, gatewayReply.prompt, now - 10_000),
      { id: "msg_footer_gateway_02", sessionID: gateway.sessionId, type: "assistant", time: { created: now - 10_000, completed: now - 3_000 },
        model: gatewayIdentity, finish: "stop", content: [{ type: "text", text: gatewayReply.reply }] },
    ]],
    [auto.sessionId, [
      user("msg_footer_auto_01", auto.sessionId, autoReply.prompt, now - 10_000),
      assistant("msg_footer_auto_02", auto.sessionId, autoReply.reply, now - 10_000, now - 3_000, true),
    ]],
  ]);

  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("The resolved footer fixture requires browser CDP.");
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let sequence = 0;
  let fixtureReads = 0;
  let autoHistoryReads = 0;
  let failure: Error | undefined;
  let disposing = false;
  const fail = (error: unknown) => {
    const reason = error instanceof Error ? error : new Error(String(error));
    failure ??= reason;
    for (const call of pending.values()) call.reject(reason);
  };
  setup.defer(() => { disposing = true; socket.close(); });
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    if (failure) throw failure;
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Footer CDP timeout: ${method}`)), 15_000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const origin = new URL(app.openworkUrl).origin;
  const bases = ["workspace", "w"].map(alias => `/${alias}/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/session/`);
  async function paused(params: Record<string, unknown>) {
    const { requestId, request } = params;
    if (typeof requestId !== "string" || !isRecord(request) || typeof request.url !== "string") {
      throw new Error("Malformed footer Fetch.requestPaused event.");
    }
    const url = new URL(request.url);
    const base = bases.find(prefix => url.pathname.startsWith(prefix));
    const tail = base ? url.pathname.slice(base.length).split("/") : [];
    const [sessionId, resource, messageId] = tail;
    const history = sessionId ? histories.get(sessionId) : undefined;
    if (request.method !== "GET" || url.origin !== origin || !history || resource !== "message"
      || !(tail.length === 2 || (tail.length === 3 && messageId))) {
      await command("Fetch.continueRequest", { requestId });
      return;
    }
    // No cursor: the adapter must project this completed native history once.
    await command("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: new URL(app.webUrl).origin },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: Buffer.from(JSON.stringify({ data: messageId ? history.find(message => message.id === messageId) : history })).toString("base64"),
    });
    fixtureReads++;
    if (sessionId === auto.sessionId && !messageId) autoHistoryReads++;
  }
  socket.addEventListener("message", ({ data }) => {
    try {
      const message: unknown = JSON.parse(String(data));
      if (!isRecord(message)) return;
      if (typeof message.id === "number") {
        if (message.error) pending.get(message.id)?.reject(new Error(`Footer CDP command failed: ${JSON.stringify(message.error)}`));
        else pending.get(message.id)?.resolve();
      }
      if (message.method === "Fetch.requestPaused" && isRecord(message.params)) {
        void paused(message.params).catch(fail);
      }
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", () => fail(new Error("Footer CDP connection failed.")));
  socket.addEventListener("close", () => { if (!disposing) fail(new Error("Footer CDP connection closed unexpectedly.")); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Footer CDP connection timeout.")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Footer CDP connection failed.")); }, { once: true });
    socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Footer CDP connection closed.")); }, { once: true });
  });
  // This separate CDP connection is world-owned, so navigation/reload does not
  // remove the fixture and seed's browser control connection stays untouched.
  setup.defer(async () => {
    try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
    finally { disposing = true; socket.close(); }
  });
  await command("Fetch.enable", { patterns: bases.map(base => ({ urlPattern: `${origin}${base}*/message*`, requestStage: "Request" })) });
  const resources = setup.move();
  return {
    app, den, normal, auto, gateway, gatewayReply, gatewayName, gatewayIdentity, older, latest, autoReply, modelName, autoModelName,
    get fixtureReads() { if (failure) throw failure; return fixtureReads; },
    get autoHistoryReads() { if (failure) throw failure; return autoHistoryReads; },
    async touchInput() {
      if (failure) throw failure;
      await app.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
