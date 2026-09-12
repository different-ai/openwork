import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { buildOpenworkProviderContributions } from "../../apps/server/src/opencode-plugins/openwork-provider-adapters";
import { close, isRecord, listen, readBody, sendJson } from "../worlds/openwork-server-cli";

function outputOf(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value)) throw new Error("Expected an affordance response");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

test("session.create reports asynchronous acceptance, preserves rejected session IDs, and never claims inference started", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "session-create-acceptance-"));
  const overrides = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: join(root, "opencode"),
    OPENWORK_SERVER_CONFIG: join(root, "server.json"),
    OPENWORK_ENV_STORE: join(root, "env.json"),
    OPENWORK_DATA_DIR: join(root, "data"),
    OPENWORK_TOKEN_STORE: join(root, "tokens.json"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_UI_CONTROL_DISCOVERY: "",
    OPENWORK_SERVER_URL: "",
    OPENWORK_SERVER_TOKEN: "acceptance-test-token",
  };
  const keys = new Set([...Object.keys(overrides), ...Object.keys(process.env).filter((key) => key.startsWith("OPENWORK_") || key.startsWith("OPENCODE"))]);
  const previous = Object.fromEntries([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  const sessions: Array<{ id: string; title: string; directory: string; time: { created: number; updated: number }; model: { id: string; providerID: string } }> = [];
  const transcripts = new Map<string, unknown[]>();
  const prompts: Array<{ sessionId: string; modelId: string }> = [];
  const engine = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/session" && request.method === "POST") {
        const body: unknown = JSON.parse(await readBody(request));
        if (!isRecord(body) || typeof body.title !== "string" || !isRecord(body.model) || typeof body.model.id !== "string" || typeof body.model.providerID !== "string") {
          return sendJson(response, 400, { message: "Invalid create request" });
        }
        const session = { id: `ses_acceptance_${sessions.length + 1}`, title: body.title, directory: root, time: { created: 100, updated: 100 }, model: { id: body.model.id, providerID: body.model.providerID } };
        sessions.push(session);
        transcripts.set(session.id, []);
        return sendJson(response, 200, session);
      }
      if (url.pathname === "/session") return sendJson(response, 200, sessions);
      if (url.pathname === "/session/status") return sendJson(response, 200, {});
      if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname.endsWith("/children")) return sendJson(response, 200, []);
      const session = sessions.find((entry) => url.pathname === `/session/${entry.id}` || url.pathname.startsWith(`/session/${entry.id}/`));
      if (session && url.pathname.endsWith("/prompt_async") && request.method === "POST") {
        const body: unknown = JSON.parse(await readBody(request));
        if (!isRecord(body) || !isRecord(body.model) || typeof body.model.modelID !== "string") return sendJson(response, 400, { message: "Missing prompt model" });
        prompts.push({ sessionId: session.id, modelId: body.model.modelID });
        if (body.model.modelID === "rejected") return sendJson(response, 400, { name: "UnknownError", data: { message: "Model unavailable: rejected" } });
        const user = { info: { id: `msg_${session.id}_user`, role: "user" }, parts: body.parts };
        transcripts.set(session.id, [user]);
        if (body.model.modelID === "available") transcripts.set(session.id, [user, { info: { id: `msg_${session.id}_assistant`, role: "assistant" }, parts: [{ type: "text", text: "Fixture reply" }] }]);
        response.writeHead(204);
        response.end();
        return;
      }
      if (session && url.pathname.endsWith("/message")) return sendJson(response, 200, transcripts.get(session.id));
      if (session) return sendJson(response, 200, session);
      return sendJson(response, 404, { message: "Not found" });
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  let stopServer: (() => Promise<void>) | undefined;
  try {
    const engineUrl = await listen(engine);
    const { startServer } = await import("../../apps/server/src/server");
    const server = await startServer({
      host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
      token: overrides.OPENWORK_SERVER_TOKEN, hostToken: "acceptance-host-token",
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
      workspaces: [{ id: "ws_acceptance", name: "Acceptance", path: root, preset: "starter", workspaceType: "local", baseUrl: engineUrl }],
      authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
      tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    });
    stopServer = async () => { await server.stop(); };
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    const plugin = await OpenWorkExtensionsPreview({ directory: root });
    const description = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.create")?.description;
    expect(description).toContain("not proof that inference started or succeeded");
    const output = outputOf(await plugin.tool.openwork_execute.execute({
      id: "session.create",
      args: {
        model: { providerId: "acceptance-provider", modelId: "rejected" },
        sessions: [
          { title: "HTTP rejection", prompt: "Rejected before acceptance" },
          { title: "Async unavailable model", prompt: "Accepted but no reply", model: { providerId: "acceptance-provider", modelId: "unavailable" } },
          { title: "Working sibling", prompt: "Reply once", model: { providerId: "acceptance-provider", modelId: "available" } },
        ],
      },
    }, {}));
    expect(output.ok).toBe(false);
    expect(output.issues).toEqual([{ path: "sessions[0].prompt", message: "sessions[0].prompt: Model unavailable: rejected", sessionId: "ses_acceptance_1" }]);
    const result = isRecord(output.result) ? output.result : {};
    const created = records(result.created);
    expect(created).toHaveLength(2);
    expect(created.map((entry) => entry.accepted)).toEqual([true, true]);
    expect(created.every((entry) => !Object.hasOwn(entry, "started"))).toBe(true);
    expect(records(result.failures)).toMatchObject([{ sessionId: "ses_acceptance_1", path: "sessions[0].prompt" }]);
    expect(sessions).toHaveLength(3);
    expect(prompts).toEqual([
      { sessionId: "ses_acceptance_1", modelId: "rejected" },
      { sessionId: "ses_acceptance_2", modelId: "unavailable" },
      { sessionId: "ses_acceptance_3", modelId: "available" },
    ]);
    const reads = [];
    for (const entry of created) {
      const read = outputOf(await plugin.tool.openwork_query.execute({ id: "session.read", args: { sessionId: entry.sessionId, workspaceId: "ws_acceptance", summary: true } }));
      expect(read.ok).toBe(true);
      if (!isRecord(read.result)) throw new Error("Expected session.read result");
      reads.push(read.result);
    }
    expect(reads[0]).toMatchObject({ status: "idle", working: false, lastAssistant: null, model: { providerId: "acceptance-provider", modelId: "unavailable", variant: null } });
    expect(reads[0]?.firstUser).toMatchObject({ text: "Accepted but no reply" });
    expect(reads[1]?.lastAssistant).toMatchObject({ text: "Fixture reply" });
    expect(prompts).toHaveLength(3);
    evidence.recordAssertionEvidence(
      "Real OpenWork server preserves acceptance versus execution and partial failure recovery IDs",
      "The rejecting-engine witness received exactly three creates and three prompts through the real server proxy. HTTP rejection surfaced its indexed issue and created ID; both 204 responses reported accepted without started. session.read found one pinned, idle, user-only session and one sibling reply. No automatic retry occurred.",
      created.every((entry) => entry.accepted === true && !Object.hasOwn(entry, "started")) && prompts.length === 3,
    );
  } finally {
    await stopServer?.();
    await close(engine);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
