import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  RemoteSessionExecuteDeps,
  RemoteSessionRuntime,
  RemoteSessionToolResult,
} from "../src/mcp/remote-session-capabilities.js";

type RemoteSessionModule = typeof import("../src/mcp/remote-session-capabilities.js");

/**
 * The module reads den-api env at import time (db wiring for its default
 * runtime resolver). Seed placeholder env before the dynamic import; every
 * test here injects its own runtime resolver, so no database is touched.
 */
function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32);
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32);
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790";
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790";
}

let DEFAULT_REMOTE_SESSION_DEPS: RemoteSessionModule["DEFAULT_REMOTE_SESSION_DEPS"];
let executeRemoteSessionCapability: RemoteSessionModule["executeRemoteSessionCapability"];
let searchRemoteSessionCapabilities: RemoteSessionModule["searchRemoteSessionCapabilities"];

/**
 * A witness openwork-server: the exact native OpenCode routes the
 * headless-threads client speaks through `/workspace/:id/opencode`,
 * recording every request so assertions observe the real wire traffic the
 * `remote-session:*` capabilities produce — not a stubbed client.
 */

const WORKSPACE_ID = "ws_witness";
const CLIENT_TOKEN = "witness-client-token";
const HOST_TOKEN = "witness-host-token";

type WitnessRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  hostToken: string | undefined;
  body: unknown;
};

type WitnessSession = {
  id: string;
  title: string;
  prompts: string[];
};

const witness = {
  requests: [] as WitnessRequest[],
  sessions: new Map<string, WitnessSession>(),
  nextSessionId: 1,
};

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function snapshotWire(session: WitnessSession) {
  const messages = session.prompts.flatMap((prompt, index) => [
    {
      info: { id: `msg_user_${index}`, role: "user", time: { created: index * 2 } },
      parts: [{ id: `part_user_${index}`, type: "text", text: prompt }],
    },
    {
      info: { id: `msg_assistant_${index}`, role: "assistant", parentID: `msg_user_${index}`, time: { created: index * 2 + 1 } },
      parts: [{ id: `part_assistant_${index}`, type: "text", text: `witness reply to: ${prompt}` }],
    },
  ]);
  return {
    session: { id: session.id, title: session.title, directory: null, time: { created: 1 } },
    messages,
    todos: [],
    status: { type: "idle" },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const path = request.url ?? "";
  const method = request.method ?? "GET";
  const body = await readBody(request);
  witness.requests.push({
    method,
    path,
    authorization: request.headers.authorization,
    hostToken: typeof request.headers["x-openwork-host-token"] === "string" ? request.headers["x-openwork-host-token"] : undefined,
    body,
  });

  const prefix = `/workspace/${WORKSPACE_ID}/opencode/session`;
  if (method === "POST" && path === prefix) {
    const title = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).title === "string"
      ? String((body as Record<string, unknown>).title)
      : "Untitled";
    const session: WitnessSession = {
      id: `ses_witness_${witness.nextSessionId++}`,
      title,
      prompts: [],
    };
    witness.sessions.set(session.id, session);
    return json(response, 200, snapshotWire(session).session);
  }

  const messagesMatch = path.match(new RegExp(`^${prefix}/([^/]+)/message$`));
  if (method === "GET" && messagesMatch) {
    const session = witness.sessions.get(decodeURIComponent(messagesMatch[1] ?? ""));
    if (!session) return json(response, 404, { code: "not_found", message: "session not found" });
    return json(response, 200, snapshotWire(session).messages);
  }

  if (method === "GET" && path === `${prefix}/status`) {
    return json(response, 200, {});
  }

  const sessionMatch = path.match(new RegExp(`^${prefix}/([^/]+)$`));
  if (method === "GET" && sessionMatch) {
    const session = witness.sessions.get(decodeURIComponent(sessionMatch[1] ?? ""));
    if (!session) return json(response, 404, { code: "not_found", message: "session not found" });
    return json(response, 200, snapshotWire(session).session);
  }

  const todoMatch = path.match(new RegExp(`^${prefix}/([^/]+)/todo$`));
  if (method === "GET" && todoMatch) {
    const session = witness.sessions.get(decodeURIComponent(todoMatch[1] ?? ""));
    if (!session) return json(response, 404, { code: "not_found", message: "session not found" });
    return json(response, 200, snapshotWire(session).todos);
  }

  const promptMatch = path.match(new RegExp(`^${prefix}/([^/]+)/prompt_async$`));
  if (method === "POST" && promptMatch) {
    const session = witness.sessions.get(decodeURIComponent(promptMatch[1] ?? ""));
    if (!session) return json(response, 404, { code: "not_found", message: "session not found" });
    const parts = typeof body === "object" && body !== null ? (body as Record<string, unknown>).parts : undefined;
    const text = Array.isArray(parts) && typeof parts[0] === "object" && parts[0] !== null
      ? String((parts[0] as Record<string, unknown>).text ?? "")
      : "";
    session.prompts.push(text);
    return json(response, 200, {});
  }

  return json(response, 404, { code: "not_found", message: `no witness route for ${method} ${path}` });
}

let server: Server;
let runtime: RemoteSessionRuntime;
let deps: RemoteSessionExecuteDeps;

beforeAll(async () => {
  seedRequiredEnv();
  const module = await import("../src/mcp/remote-session-capabilities.js");
  DEFAULT_REMOTE_SESSION_DEPS = module.DEFAULT_REMOTE_SESSION_DEPS;
  executeRemoteSessionCapability = module.executeRemoteSessionCapability;
  searchRemoteSessionCapabilities = module.searchRemoteSessionCapabilities;
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("witness server did not report a port");
  runtime = {
    workerId: "worker_witness",
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspaceId: WORKSPACE_ID,
    clientToken: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
  };
  deps = {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    // Remote sessions require OpenWork Web access for the organization; this
    // spec proves the wire and guardrails, so the entitlement is granted inline.
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    resolveRuntime: async () => ({ ok: true, runtime }),
    createClient: DEFAULT_REMOTE_SESSION_DEPS.createClient,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

// DenTypeId<"organization"> is the template-literal type `org_${string}`.
const ORGANIZATION_ID = "org_witness_fixture";

function input(action: "create" | "send" | "read", body: unknown, hasWriteScope = true) {
  return { action, organizationId: ORGANIZATION_ID, userId: "user_witness", hasWriteScope, body };
}

function payload(result: RemoteSessionToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("remote-session capabilities drive a real openwork-server wire with scoped guardrails", async () => {
  const matches = searchRemoteSessionCapabilities("send a chat to my cloud web session", 10);
  expect(matches.map((match) => match.name)).toContain("remote-session:send");
  expect(matches.every((match) => match.invocation?.argumentsField === "body")).toBe(true);
  const created = await executeRemoteSessionCapability(
    input("create", { title: "Witness handoff", prompt: "start working" }),
    deps,
  );
  expect(created.isError).toBeUndefined();
  const createdBody = payload(created);
  const sessionId = String(createdBody.sessionId);
  expect(sessionId.startsWith("ses_witness_")).toBe(true);
  expect(createdBody.workspaceId).toBe(WORKSPACE_ID);
  expect(createdBody.started).toBe(true);

  const createRequest = witness.requests.find(
    (request) => request.method === "POST" && request.path === `/workspace/${WORKSPACE_ID}/opencode/session`,
  );
  expect(createRequest).toBeDefined();
  expect(createRequest?.authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
  expect(createRequest?.hostToken).toBe(HOST_TOKEN);
  const sent = await executeRemoteSessionCapability(
    input("send", { sessionId, prompt: "and now summarize" }),
    deps,
  );
  expect(sent.isError).toBeUndefined();
  expect(payload(sent).state).toBe("accepted");
  const promptRequest = witness.requests.findLast(
    (request) => request.method === "POST" && request.path.includes("/prompt_async"),
  );
  expect(promptRequest).toBeDefined();
  const promptParts = (promptRequest?.body as { parts?: { text?: string }[] }).parts;
  expect(promptParts?.[0]?.text).toBe("and now summarize");
  const read = await executeRemoteSessionCapability(input("read", { sessionId, limit: 3 }, false), deps);
  expect(read.isError).toBeUndefined();
  const readBody = payload(read);
  expect(readBody.status).toBe("idle");
  expect(readBody.messageCount).toBe(4);
  expect((readBody.messages as unknown[]).length).toBe(3);
  expect(String(readBody.finalAssistantText)).toBe("witness reply to: and now summarize");
  // Guardrail: a session id absent from the caller's own worker.
  const foreign = await executeRemoteSessionCapability(
    input("read", { sessionId: "ses_of_someone_else" }),
    deps,
  );
  expect(foreign.isError).toBe(true);
  const foreignBody = payload(foreign);
  expect(foreignBody.error).toBe("unknown_session");
  expect(foreignBody.retryable).toBe(false);
  // Guardrail: no cloud runtime resolved for the member.
  const requestsBeforeNoRuntime = witness.requests.length;
  const noRuntime = await executeRemoteSessionCapability(input("create", { title: "no runtime" }), {
    ...deps,
    resolveRuntime: async () => ({
      ok: false,
      error: "needs_cloud_setup",
      message: "No OpenWork Cloud workspace is available for your account yet.",
      retryable: false,
    }),
    createClient: DEFAULT_REMOTE_SESSION_DEPS.createClient,
  });
  expect(noRuntime.isError).toBe(true);
  expect(payload(noRuntime).error).toBe("needs_cloud_setup");
  expect(witness.requests.length).toBe(requestsBeforeNoRuntime);
  // Guardrail: mcp:write gates mutations before any side effect.
  const requestsBeforeScope = witness.requests.length;
  const createdWithoutScope = await executeRemoteSessionCapability(input("create", {}, false), deps);
  const sentWithoutScope = await executeRemoteSessionCapability(
    input("send", { sessionId, prompt: "x" }, false),
    deps,
  );
  expect(createdWithoutScope.isError).toBe(true);
  expect(sentWithoutScope.isError).toBe(true);
  expect(payload(createdWithoutScope).error).toBe("insufficient_mcp_scope");
  expect(payload(sentWithoutScope).error).toBe("insufficient_mcp_scope");
  expect(witness.requests.length).toBe(requestsBeforeScope);
});

test("remote-session capability accepts a JSON-stringified body", async () => {
  const created = await executeRemoteSessionCapability(
    input("create", JSON.stringify({ title: "Stringified handoff" })),
    deps,
  );

  expect(created.isError).toBeUndefined();
  expect(payload(created).sessionId).toMatch(/^ses_witness_/);
  expect(witness.requests.findLast(
    (request) => request.method === "POST" && request.path === `/workspace/${WORKSPACE_ID}/opencode/session`,
  )?.body).toMatchObject({ title: "Stringified handoff" });
});
