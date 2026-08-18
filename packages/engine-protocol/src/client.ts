import type {
  ConfigUpdateInput,
  EngineAdapter,
  EngineAuthAdapter,
  EngineCapabilities,
  EngineConfigAdapter,
  EngineEventSubscribeInput,
  EngineMcpAdapter,
  EngineMetaAdapter,
  EnginePermissionAdapter,
  EngineProviderAdapter,
  EngineQuestionAdapter,
  EngineSessionAdapter,
  McpAuthCallbackInput,
  McpNameInput,
  PermissionReplyInput,
  ProviderOauthAuthorizeInput,
  ProviderOauthCallbackInput,
  QuestionReplyInput,
  SessionCommandInput,
  SessionCreateInput,
  SessionForkInput,
  SessionIdInput,
  SessionListInput,
  SessionMessagesInput,
  SessionPromptInput,
  SessionRevertInput,
  SessionShellInput,
  SessionUpdateInput,
  ToolListInput,
} from "./adapter.js";
import type { EngineEvent, EngineGlobalEventEnvelope } from "./events.js";
import { engineEventEnvelopeSchema } from "./schemas.js";
import type {
  Agent,
  AssistantMessage,
  Command,
  Config,
  GlobalHealthResponse,
  LspStatus,
  McpStatus,
  McpStatusMap,
  Message,
  MessageWithParts,
  Path,
  PermissionRequest,
  PermissionV2Request,
  Project,
  ProviderAuthAuthorization,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionMessagesResponse,
  SessionStatusResponse,
  Todo,
  ToolIds,
  ToolList,
  VcsInfo,
} from "./types.js";

export type EngineFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type EngineHttpClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: EngineFetch;
};

export type EngineRequestOptions = {
  signal?: AbortSignal;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export class EngineClientError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly detail: unknown;

  constructor(status: number, statusText: string, detail: unknown) {
    super(`Engine request failed: ${status} ${statusText}`);
    this.name = "EngineClientError";
    this.status = status;
    this.statusText = statusText;
    this.detail = detail;
  }
}

export class EngineHttpClient implements EngineAdapter {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: EngineFetch;

  constructor(options: EngineHttpClientOptions) {
    let baseUrl = options.baseUrl;
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  capabilities(options?: EngineRequestOptions): Promise<EngineCapabilities> {
    return this.request("GET", "capabilities", { signal: options?.signal });
  }

  readonly sessions: EngineSessionAdapter = {
    list: (input?: SessionListInput) => this.request<Array<Session>>("GET", "session", { query: input }),
    get: (input: SessionIdInput) => this.request<Session>("GET", `session/${encodeURIComponent(input.sessionID)}`, { query: input }),
    messages: (input: SessionMessagesInput) => this.request<SessionMessagesResponse>("GET", `session/${encodeURIComponent(input.sessionID)}/message`, { query: input }),
    todo: (input: SessionIdInput) => this.request<Array<Todo>>("GET", `session/${encodeURIComponent(input.sessionID)}/todo`, { query: input }),
    status: (input) => this.request<SessionStatusResponse>("GET", "session/status", { query: input }),
    create: (input?: SessionCreateInput) => this.request<Session>("POST", "session", { body: input }),
    update: (input: SessionUpdateInput) => this.request<Session>("PATCH", `session/${encodeURIComponent(input.sessionID)}`, { body: input }),
    command: (input: SessionCommandInput) => this.request<MessageWithParts<AssistantMessage>>("POST", `session/${encodeURIComponent(input.sessionID)}/command`, { body: input }),
    promptAsync: (input: SessionPromptInput) => this.requestVoid("POST", `session/${encodeURIComponent(input.sessionID)}/prompt_async`, { body: input }),
    revert: (input: SessionRevertInput) => this.request<Session>("POST", `session/${encodeURIComponent(input.sessionID)}/revert`, { body: input }),
    unrevert: (input: SessionIdInput) => this.request<Session>("POST", `session/${encodeURIComponent(input.sessionID)}/unrevert`, { body: input }),
    shell: (input: SessionShellInput) => this.request<MessageWithParts<Message>>("POST", `session/${encodeURIComponent(input.sessionID)}/shell`, { body: input }),
    fork: (input: SessionForkInput) => this.request<Session>("POST", `session/${encodeURIComponent(input.sessionID)}/fork`, { body: input }),
    delete: (input: SessionIdInput) => this.request<boolean>("DELETE", `session/${encodeURIComponent(input.sessionID)}`, { query: input }),
    abort: (input: SessionIdInput) => this.request<boolean>("POST", `session/${encodeURIComponent(input.sessionID)}/abort`, { body: input }),
  };

  readonly config: EngineConfigAdapter = {
    get: (input) => this.request<Config>("GET", "config", { query: input }),
    update: (input?: ConfigUpdateInput) => this.request<Config>("PATCH", "config", { body: input }),
  };

  readonly providers: EngineProviderAdapter = {
    list: (input) => this.request<ProviderListResponse>("GET", "provider", { query: input }),
    auth: (input) => this.request<ProviderAuthResponse>("GET", "provider/auth", { query: input }),
    oauth: {
      authorize: (input: ProviderOauthAuthorizeInput) => this.request<ProviderAuthAuthorization>("POST", `provider/${encodeURIComponent(input.providerID)}/oauth/authorize`, { body: input }),
      callback: (input: ProviderOauthCallbackInput) => this.request<boolean>("POST", `provider/${encodeURIComponent(input.providerID)}/oauth/callback`, { body: input }),
    },
  };

  readonly auth: EngineAuthAdapter = {
    set: (input) => this.request<boolean>("PUT", `auth/${encodeURIComponent(input.providerID)}`, { body: input.auth }),
  };

  readonly mcp: EngineMcpAdapter = {
    status: (input) => this.request<McpStatusMap>("GET", "mcp", { query: input }),
    add: (input) => this.request<McpStatusMap>("POST", "mcp", { body: input }),
    connect: (input: McpNameInput) => this.request<boolean>("POST", `mcp/${encodeURIComponent(input.name)}/connect`, { body: input }),
    disconnect: (input: McpNameInput) => this.request<boolean>("POST", `mcp/${encodeURIComponent(input.name)}/disconnect`, { body: input }),
    auth: {
      start: (input: McpNameInput) => this.request<{ authorizationUrl: string; oauthState: string }>("POST", `mcp/${encodeURIComponent(input.name)}/auth`, { body: input }),
      callback: (input: McpAuthCallbackInput) => this.request<McpStatus>("POST", `mcp/${encodeURIComponent(input.name)}/auth/callback`, { body: input }),
      authenticate: (input: McpNameInput) => this.request<McpStatus>("POST", `mcp/${encodeURIComponent(input.name)}/auth/authenticate`, { body: input }),
      remove: (input: McpNameInput) => this.request<{ success: true }>("DELETE", `mcp/${encodeURIComponent(input.name)}/auth`, { query: input }),
    },
  };

  readonly permissions: EnginePermissionAdapter = {
    list: (input) => this.request<Array<PermissionRequest>>("GET", "permission", { query: input }),
    reply: (input: PermissionReplyInput) => this.request<boolean>("POST", `permission/${encodeURIComponent(input.requestID)}/reply`, { body: input }),
    v2: {
      list: (input: SessionIdInput) => this.request<Array<PermissionV2Request>>("GET", `session/${encodeURIComponent(input.sessionID)}/permission`, { query: input }),
      reply: (input) => this.request<boolean>("POST", `session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`, { body: input }),
    },
  };

  readonly questions: EngineQuestionAdapter = {
    list: (input) => this.request<Array<QuestionRequest>>("GET", "question", { query: input }),
    reply: (input: QuestionReplyInput) => this.request<boolean>("POST", `question/${encodeURIComponent(input.requestID)}/reply`, { body: input }),
    reject: (input) => this.request<boolean>("POST", `question/${encodeURIComponent(input.requestID)}/reject`, { body: input }),
  };

  readonly meta: EngineMetaAdapter = {
    agents: {
      list: (input) => this.request<Array<Agent>>("GET", "agent", { query: input }),
    },
    project: {
      list: (input) => this.request<Array<Project>>("GET", "project", { query: input }),
    },
    path: {
      get: (input) => this.request<Path>("GET", "path", { query: input }),
    },
    vcs: {
      get: (input) => this.request<VcsInfo>("GET", "vcs", { query: input }),
    },
    lsp: {
      status: (input) => this.request<Array<LspStatus>>("GET", "lsp", { query: input }),
    },
    command: {
      list: (input) => this.request<Array<Command>>("GET", "command", { query: input }),
    },
    global: {
      health: () => this.request<GlobalHealthResponse>("GET", "global/health"),
    },
    tool: {
      list: (input: ToolListInput) => this.request<ToolList>("GET", "experimental/tool", { query: input }),
      ids: (input) => this.request<ToolIds>("GET", "experimental/tool/ids", { query: input }),
    },
  };

  readonly events = {
    subscribe: (input?: EngineEventSubscribeInput) => this.streamEvents("event", input),
  };

  private url(path: string, query?: object): URL {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    if (query) appendSearch(url, query);
    return url;
  }

  private headers(contentType?: string): Headers {
    const headers = new Headers();
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (contentType) headers.set("Content-Type", contentType);
    return headers;
  }

  private async request<T>(method: HttpMethod | "PUT", path: string, init: { query?: object; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path, init.query), {
      method,
      headers: this.headers(init.body === undefined ? undefined : "application/json"),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    await throwIfNotOk(response);
    return response.json();
  }

  private async requestVoid(method: HttpMethod, path: string, init: { query?: object; body?: unknown; signal?: AbortSignal } = {}): Promise<void> {
    const response = await this.fetchImpl(this.url(path, init.query), {
      method,
      headers: this.headers(init.body === undefined ? undefined : "application/json"),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    await throwIfNotOk(response);
  }

  private async *streamEvents(path: string, query?: object): AsyncIterable<EngineEvent> {
    const headers = this.headers();
    headers.set("Accept", "text/event-stream");
    const response = await this.fetchImpl(this.url(path, query), { headers });
    await throwIfNotOk(response);
    if (!response.body) throw new EngineClientError(response.status, "Missing event stream", undefined);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = nextSseBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(block);
        if (event) yield event;
        boundary = nextSseBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const event = parseSseBlock(buffer);
    if (event) yield event;
  }
}

function appendSearch(url: URL, input: object): void {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    if (typeof value === "object") continue;
    url.searchParams.set(key, String(value));
  }
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail: unknown;
  try {
    detail = await response.json();
  } catch {
    detail = await response.text().catch(() => undefined);
  }
  throw new EngineClientError(response.status, response.statusText, detail);
}

function nextSseBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function parseSseBlock(block: string): EngineEvent | undefined {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  const text = data.join("\n");
  if (!text || text === "[DONE]") return undefined;
  const raw: unknown = JSON.parse(text);
  const parsed = engineEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return unwrapEventEnvelope(parsed.data);
}

function unwrapEventEnvelope(event: EngineEvent | EngineGlobalEventEnvelope): EngineEvent {
  if ("payload" in event) return event.payload;
  return event;
}
