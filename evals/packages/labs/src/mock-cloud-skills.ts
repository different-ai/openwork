// In-process stand-in for the OpenWork Cloud `/mcp/agent` endpoint, scoped to
// what the desktop host needs for just-in-time Cloud skills: a Streamable HTTP
// MCP server that serves `skill://index.json` and each `skill://<name>/SKILL.md`
// per bearer identity, advertises the two Connect routing tools, and records
// every request with a SAFE identity label. Credentials never enter the log.
//
// It mirrors ee/apps/den-api/src/mcp/agent.ts (index shape, standard SKILL.md
// framing, SSE-by-default transport) without importing product source.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { MockAgentRequest, MockAuthorizeRequest, MockMcpHandle, MockToolCall } from "./mock-mcp.ts";

export const MOCK_CLOUD_SKILL_INDEX_URI = "skill://index.json";
export const MOCK_CLOUD_SKILL_INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Identity label for a request that presented no bearer token. */
export const MOCK_CLOUD_ANONYMOUS = "anonymous";
/** Identity label for a bearer token this fixture never minted. */
export const MOCK_CLOUD_UNKNOWN = "unknown";

export interface MockCloudSkill {
  /** Kebab-case machine identifier; also the `skill://<name>/SKILL.md` path segment. */
  name: string;
  description: string;
  title?: string;
  /** Instructions below the frontmatter, served verbatim. */
  body: string;
  /** Defaults to a synthetic `plugin:<...>:<...>` capability. */
  capability?: string;
}

export interface MockCloudSkillsRequest {
  at: string;
  /** HTTP method. */
  method: string;
  path: string;
  /** JSON-RPC method, or null for non-RPC traffic (health, GET stream probes). */
  rpcMethod: string | null;
  /** `resources/read` target, when any. */
  uri: string | null;
  /** `tools/call` name, when any. */
  toolName: string | null;
  /** Safe identity label (the label passed to the fixture), anonymous, or unknown. Never the credential. */
  identity: string;
  authorized: boolean;
  status: number;
}

export interface MockCloudSkillsLogQuery {
  sinceIso?: string;
  identity?: string;
  rpcMethod?: string;
  uri?: string;
}

export interface StartMockCloudSkillsOptions {
  /** Identity labels to mint credentials for. More can be added with `addIdentity`. */
  identities?: readonly string[];
  /** Wire framing for JSON-RPC results. The real endpoint streams SSE. */
  transport?: "sse" | "json";
  port?: number;
}

export interface MockCloudSkillsHandle extends MockMcpHandle {
  /** The `/mcp/agent` URL the host must be pointed at (loopback, trusted for global persist). */
  agentUrl: string;
  /** Mint or return the bearer credential for a label. Keep it out of evidence. */
  credential(identity: string): string;
  addIdentity(identity: string): string;
  identities(): string[];
  publishSkill(identity: string, skill: MockCloudSkill): void;
  /** Replace only the instructions body; name, title and description are unchanged. */
  updateSkillBody(identity: string, name: string, body: string): void;
  revokeSkill(identity: string, name: string): boolean;
  skills(identity: string): MockCloudSkill[];
  /** An unauthorized identity keeps its credential but every MCP request answers 401. */
  setAuthorization(identity: string, authorized: boolean): void;
  isAuthorized(identity: string): boolean;
  skillUri(name: string): string;
  /** Exactly what `resources/read` returns for this identity's skill right now. */
  skillMarkdown(identity: string, name: string): string | null;
  log(query?: MockCloudSkillsLogQuery): MockCloudSkillsRequest[];
  /** Names of every `tools/call` served, in order. Empty proves the host never routed skills through Connect tools. */
  toolCallNames(query?: MockCloudSkillsLogQuery): string[];
  resourceReads(query?: MockCloudSkillsLogQuery): MockCloudSkillsRequest[];
  clearLog(): void;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcId(message: JsonRpcMessage): string | number | null {
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function mockCloudSkillUri(name: string): string {
  return `skill://${name}/SKILL.md`;
}

/** Same framing as the real endpoint: normalized frontmatter, then the body verbatim. */
export function mockCloudSkillMarkdown(skill: MockCloudSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}`;
}

export function mockCloudSkillIndex(skills: readonly MockCloudSkill[]) {
  return {
    $schema: MOCK_CLOUD_SKILL_INDEX_SCHEMA,
    skills: skills.map((skill) => ({
      name: skill.name,
      type: "skill-md" as const,
      title: skill.title ?? skill.name,
      description: skill.description,
      url: mockCloudSkillUri(skill.name),
      capability: skill.capability ?? `plugin:plg_mock_cloud_skills:cob_${skill.name.replaceAll("-", "_")}`,
    })),
  };
}

const CONNECT_TOOLS = [
  {
    name: "search_capabilities",
    description: "Search connection actions, saved Workflows, and skills by keyword.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "execute_capability",
    description: "Call a capability found via search_capabilities, by its exact name.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, body: {} }, required: ["name"] },
  },
];

function assertSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`Mock Cloud skill names must be kebab-case (received ${JSON.stringify(name)}).`);
  }
}

export async function startMockCloudSkills(options: StartMockCloudSkillsOptions = {}): Promise<MockCloudSkillsHandle> {
  const transport = options.transport ?? "sse";
  const credentials = new Map<string, string>();
  const identityByToken = new Map<string, string>();
  const authorized = new Map<string, boolean>();
  const skillsByIdentity = new Map<string, Map<string, MockCloudSkill>>();
  const log: MockCloudSkillsRequest[] = [];
  let sessionCounter = 0;

  const addIdentity = (identity: string): string => {
    const existing = credentials.get(identity);
    if (existing) return existing;
    if (!identity.trim() || identity === MOCK_CLOUD_ANONYMOUS || identity === MOCK_CLOUD_UNKNOWN) {
      throw new Error(`Invalid mock Cloud identity label ${JSON.stringify(identity)}.`);
    }
    const token = `mock-cloud-${randomBytes(24).toString("hex")}`;
    credentials.set(identity, token);
    identityByToken.set(token, identity);
    authorized.set(identity, true);
    skillsByIdentity.set(identity, new Map());
    return token;
  };
  for (const identity of options.identities ?? []) addIdentity(identity);

  const requireIdentity = (identity: string): Map<string, MockCloudSkill> => {
    const skills = skillsByIdentity.get(identity);
    if (!skills) throw new Error(`Unknown mock Cloud identity ${JSON.stringify(identity)}; add it first.`);
    return skills;
  };

  const resolveIdentity = (request: IncomingMessage): { identity: string; authorized: boolean } => {
    const token = bearerToken(request);
    if (!token) return { identity: MOCK_CLOUD_ANONYMOUS, authorized: false };
    const identity = identityByToken.get(token);
    if (!identity) return { identity: MOCK_CLOUD_UNKNOWN, authorized: false };
    return { identity, authorized: authorized.get(identity) === true };
  };

  const rpcResult = (identity: string, message: JsonRpcMessage): { result?: unknown; error?: { code: number; message: string } } => {
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return { result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
          serverInfo: { name: "mock-openwork-cloud-skills", version: "1.0.0" },
        } };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: CONNECT_TOOLS } };
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!CONNECT_TOOLS.some((tool) => tool.name === name)) {
          return { error: { code: -32602, message: `Unknown tool ${name}` } };
        }
        // Served, not rejected: a spec proves the zero-call contract from the log,
        // never from a tool failure the host could have swallowed.
        return { result: { content: [{ type: "text", text: JSON.stringify({ matches: [], mock: "cloud-skills" }) }] } };
      }
      case "resources/list": {
        const skills = [...requireIdentity(identity).values()];
        return { result: { resources: [
          { uri: MOCK_CLOUD_SKILL_INDEX_URI, name: "agent-skills-index", title: "Available Agent Skills", mimeType: "application/json" },
          ...skills.map((skill) => ({ uri: mockCloudSkillUri(skill.name), name: skill.name, title: skill.title ?? skill.name, description: skill.description, mimeType: "text/markdown" })),
        ] } };
      }
      case "resources/templates/list":
        return { result: { resourceTemplates: [] } };
      case "prompts/list":
        return { result: { prompts: [] } };
      case "resources/read": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        const skills = requireIdentity(identity);
        if (uri === MOCK_CLOUD_SKILL_INDEX_URI) {
          return { result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(mockCloudSkillIndex([...skills.values()])) }] } };
        }
        const skill = [...skills.values()].find((candidate) => mockCloudSkillUri(candidate.name) === uri);
        if (!skill) return { error: { code: -32002, message: "Resource not found" } };
        return { result: { contents: [{ uri, mimeType: "text/markdown", text: mockCloudSkillMarkdown(skill) }] } };
      }
      default:
        return { error: { code: -32601, message: "Method not found" } };
    }
  };

  const writeJson = (response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    response.end(JSON.stringify(payload));
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const who = resolveIdentity(request);
    const entry: MockCloudSkillsRequest = {
      at: new Date().toISOString(), method: request.method ?? "GET", path: url.pathname,
      rpcMethod: null, uri: null, toolName: null, identity: who.identity, authorized: who.authorized, status: 0,
    };
    log.push(entry);
    response.once("finish", () => { entry.status = response.statusCode; });
    try {
      if (url.pathname === "/health") {
        writeJson(response, 200, { ok: true, identities: [...credentials.keys()], transport });
        return;
      }
      if (url.pathname !== "/mcp/agent") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (!who.authorized) {
        // Read the body so the connection stays reusable, then refuse. No OAuth
        // metadata is advertised: the host must not be lured into a sign-in flow.
        if (request.method === "POST") await readBody(request);
        writeJson(response, 401, { error: who.identity === MOCK_CLOUD_ANONYMOUS ? "missing_token" : "invalid_token" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (request.method === "GET") {
        // No server-initiated stream in this fixture.
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(request));
      } catch {
        writeJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const messages: JsonRpcMessage[] = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
      const first = messages[0];
      entry.rpcMethod = first && typeof first.method === "string" ? first.method : null;
      for (const message of messages) {
        const params = isRecord(message.params) ? message.params : {};
        if (message.method === "resources/read" && typeof params.uri === "string") entry.uri = params.uri;
        if (message.method === "tools/call" && typeof params.name === "string") entry.toolName = params.name;
      }
      const responses = messages.flatMap((message) => {
        const id = rpcId(message);
        if (id === null) return [];
        const outcome = rpcResult(who.identity, message);
        return [outcome.error ? { jsonrpc: "2.0", id, error: outcome.error } : { jsonrpc: "2.0", id, result: outcome.result }];
      });
      if (responses.length === 0) {
        response.writeHead(202).end();
        return;
      }
      const headers: Record<string, string> = {};
      if (messages.some((message) => message.method === "initialize")) {
        sessionCounter += 1;
        headers["mcp-session-id"] = `mock-cloud-session-${sessionCounter}`;
      }
      const payload = Array.isArray(parsed) ? responses : responses[0];
      if (transport === "json") {
        writeJson(response, 200, payload, headers);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", ...headers });
      response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock Cloud skills server did not bind a TCP port.");
  const url = `http://127.0.0.1:${address.port}`;
  const agentUrl = `${url}/mcp/agent`;

  const filterLog = (query: MockCloudSkillsLogQuery = {}): MockCloudSkillsRequest[] => log.filter((entry) =>
    (query.sinceIso === undefined || entry.at >= query.sinceIso)
    && (query.identity === undefined || entry.identity === query.identity)
    && (query.rpcMethod === undefined || entry.rpcMethod === query.rpcMethod)
    && (query.uri === undefined || entry.uri === query.uri));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  const unsupported = (feature: string) => async (): Promise<never> => {
    throw new Error(`The mock Cloud skills fixture does not ${feature}.`);
  };
  const authorizeRequests = (entries: MockCloudSkillsRequest[]): MockAuthorizeRequest[] => entries.map((entry) => ({
    method: entry.method, path: entry.path, url: entry.path, at: entry.at, status: entry.status, tokenId: entry.identity,
  }));

  return {
    url,
    mcpUrl: agentUrl,
    agentUrl,
    credential: addIdentity,
    addIdentity,
    identities: () => [...credentials.keys()],
    publishSkill(identity, skill) {
      assertSkillName(skill.name);
      requireIdentity(identity).set(skill.name, { ...skill });
    },
    updateSkillBody(identity, name, body) {
      const skills = requireIdentity(identity);
      const existing = skills.get(name);
      if (!existing) throw new Error(`Identity ${identity} has no skill ${name} to update.`);
      skills.set(name, { ...existing, body });
    },
    revokeSkill(identity, name) {
      return requireIdentity(identity).delete(name);
    },
    skills: (identity) => [...requireIdentity(identity).values()].map((skill) => ({ ...skill })),
    setAuthorization(identity, value) {
      requireIdentity(identity);
      authorized.set(identity, value);
    },
    isAuthorized: (identity) => authorized.get(identity) === true,
    skillUri: mockCloudSkillUri,
    skillMarkdown(identity, name) {
      const skill = requireIdentity(identity).get(name);
      return skill ? mockCloudSkillMarkdown(skill) : null;
    },
    log: (query) => filterLog(query).map((entry) => ({ ...entry })),
    toolCallNames: (query) => filterLog(query).flatMap((entry) => entry.toolName ? [entry.toolName] : []),
    resourceReads: (query) => filterLog({ ...query, rpcMethod: "resources/read" }).map((entry) => ({ ...entry })),
    clearLog() { log.length = 0; },
    // MockMcpHandle compatibility so the fixture can ride seed.appWeb({ mocks }).
    async requests() {
      return authorizeRequests(filterLog());
    },
    async toolCalls(opts = {}): Promise<MockToolCall[]> {
      const read = () => filterLog({ sinceIso: opts.sinceIso }).flatMap((entry) => entry.toolName && (!opts.name || entry.toolName === opts.name)
        ? [{ name: entry.toolName, args: {}, tokenId: entry.identity, at: entry.at }] : []);
      const wanted = opts.atLeast ?? 0;
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let calls = read();
      while (calls.length < wanted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        calls = read();
      }
      return calls;
    },
    async agentRequests(): Promise<MockAgentRequest[]> {
      return [];
    },
    agentReplyState: unsupported("serve agent reply gates"),
    releaseAgentReply: unsupported("serve agent reply gates"),
    async handshakes(opts = {}) {
      const read = () => authorizeRequests(filterLog({ sinceIso: opts.sinceIso, rpcMethod: "initialize" }));
      const wanted = opts.atLeast ?? 0;
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let handshakes = read();
      while (handshakes.length < wanted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        handshakes = read();
      }
      return handshakes;
    },
    authorizeRequestSince: unsupported("serve OAuth authorization"),
    configureOAuthRedirectUris: unsupported("serve OAuth authorization"),
    configureOAuthCallback: unsupported("serve OAuth authorization"),
    resetOAuth: unsupported("serve OAuth authorization"),
    holdRefreshResponses: unsupported("serve OAuth refresh"),
    pendingRefreshResponses: unsupported("serve OAuth refresh"),
    releaseRefreshResponse: unsupported("serve OAuth refresh"),
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
