#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const MOCK_TELEGRAM_BOT_TOKEN = "900100:OPENWORK_TEST_TOKEN";
export const MOCK_TELEGRAM_WEBHOOK_SECRET = "openwork-telegram-webhook-secret";
export const MOCK_MICROSOFT_ACCESS_TOKEN = "mock-microsoft-access-token";
export const MOCK_MICROSOFT_REFRESH_TOKEN = "mock-microsoft-refresh-token";
export const MOCK_WORKER_HOST_TOKEN = "mock-worker-host-token";
export const MOCK_WORKER_CLIENT_TOKEN = "mock-worker-client-token";

const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Calendars.Read",
  "Files.Read",
];

const MICROSOFT_MESSAGES = [
  {
    id: "message-launch-readiness",
    subject: "Launch readiness",
    receivedDateTime: "2026-07-09T16:00:00Z",
    bodyPreview: "The launch checklist is complete. The only remaining item is the final support handoff.",
    body: {
      contentType: "text",
      content: "The launch checklist is complete. The only remaining item is the final support handoff.",
    },
    from: { emailAddress: { name: "Ada Lovelace", address: "ada@example.test" } },
    toRecipients: [{ emailAddress: { name: "OpenWork Tester", address: "tester@example.test" } }],
    webLink: "https://outlook.office.test/mail/message-launch-readiness",
  },
  {
    id: "message-q3-budget",
    subject: "Q3 budget approved",
    receivedDateTime: "2026-07-09T15:00:00Z",
    bodyPreview: "Finance approved the Q3 budget with no changes.",
    body: { contentType: "text", content: "Finance approved the Q3 budget with no changes." },
    from: { emailAddress: { name: "Grace Hopper", address: "grace@example.test" } },
    toRecipients: [{ emailAddress: { name: "OpenWork Tester", address: "tester@example.test" } }],
    webLink: "https://outlook.office.test/mail/message-q3-budget",
  },
  {
    id: "message-customer-feedback",
    subject: "Customer feedback summary",
    receivedDateTime: "2026-07-09T14:00:00Z",
    bodyPreview: "Pilot customers highlighted faster setup and asked for clearer connection health.",
    body: {
      contentType: "text",
      content: "Pilot customers highlighted faster setup and asked for clearer connection health.",
    },
    from: { emailAddress: { name: "Katherine Johnson", address: "katherine@example.test" } },
    toRecipients: [{ emailAddress: { name: "OpenWork Tester", address: "tester@example.test" } }],
    webLink: "https://outlook.office.test/mail/message-customer-feedback",
  },
];

const MICROSOFT_EVENTS = [
  {
    id: "event-launch-review",
    subject: "Launch review",
    bodyPreview: "Review launch status and support handoff.",
    start: { dateTime: "2026-07-10T09:00:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-07-10T09:30:00", timeZone: "America/Los_Angeles" },
    organizer: { emailAddress: { name: "Ada Lovelace", address: "ada@example.test" } },
    attendees: [],
    location: { displayName: "OpenWork Room" },
    isCancelled: false,
    webLink: "https://outlook.office.test/calendar/event-launch-review",
  },
  {
    id: "event-q3-planning",
    subject: "Q3 planning",
    bodyPreview: "Confirm Q3 milestones and owners.",
    start: { dateTime: "2026-07-10T11:00:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-07-10T12:00:00", timeZone: "America/Los_Angeles" },
    organizer: { emailAddress: { name: "Grace Hopper", address: "grace@example.test" } },
    attendees: [],
    location: { displayName: "Microsoft Teams" },
    isCancelled: false,
    webLink: "https://outlook.office.test/calendar/event-q3-planning",
  },
];

const MICROSOFT_Q3_FILE = {
  id: "file-q3-plan",
  name: "Q3 Plan.txt",
  size: 128,
  lastModifiedDateTime: "2026-07-09T13:00:00Z",
  webUrl: "https://onedrive.office.test/files/file-q3-plan",
  file: { mimeType: "text/plain", hashes: { quickXorHash: "mock-hash" } },
  parentReference: { driveId: "drive-openwork-test", path: "/drive/root:" },
};

const Q3_FILE_CONTENT = [
  "Q3 Plan",
  "",
  "1. Ship cloud connections.",
  "2. Improve connection health and audit history.",
  "3. Complete the support handoff.",
].join("\n");

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-openwork-host-token,x-telegram-bot-api-secret-token",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": contentType,
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { "access-control-allow-origin": "*" });
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) request.destroy(new Error("request_too_large"));
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function parseJson(raw) {
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function requestHeaders(request) {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value ?? ""]),
  );
}

function recordRequest(state, request, url, rawBody) {
  const contentType = request.headers["content-type"] ?? "";
  let body = rawBody;
  if (rawBody && contentType.includes("application/json")) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  } else if (rawBody && contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(rawBody));
  }

  state.requests.push({
    id: state.requests.length + 1,
    method: request.method ?? "GET",
    path: url.pathname,
    search: url.search,
    headers: requestHeaders(request),
    body,
  });
}

function initialState() {
  return {
    requests: [],
    telegram: {
      webhook: null,
      sentMessages: [],
      nextMessageId: 7001,
    },
    worker: {
      nextSessionId: 1,
      sessions: new Map(),
    },
  };
}

function resetState(state) {
  const fresh = initialState();
  state.requests = fresh.requests;
  state.telegram = fresh.telegram;
  state.worker = fresh.worker;
}

function telegramUser() {
  return {
    id: 900100,
    is_bot: true,
    first_name: "OpenWork Test Bot",
    username: "openwork_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
}

export function telegramUpdate(text = "Summarize the launch notes", updateId = 81001) {
  return {
    update_id: updateId,
    message: {
      message_id: 61001,
      date: 1783612800,
      chat: { id: 42001, type: "private", first_name: "OpenWork", username: "openwork_tester" },
      from: { id: 42001, is_bot: false, first_name: "OpenWork", username: "openwork_tester" },
      text,
    },
  };
}

function telegramUnauthorized(response) {
  sendJson(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
}

function handleTelegram(state, request, response, url, rawBody) {
  const match = url.pathname.match(/^\/telegram\/bot([^/]+)\/([^/]+)$/);
  if (!match) return false;

  const token = decodeURIComponent(match[1]);
  const method = match[2];
  if (token !== MOCK_TELEGRAM_BOT_TOKEN) {
    telegramUnauthorized(response);
    return true;
  }

  let body;
  try {
    body = parseJson(rawBody);
  } catch {
    sendJson(response, 400, { ok: false, error_code: 400, description: "Bad Request: invalid JSON" });
    return true;
  }

  if (method === "getMe" && (request.method === "GET" || request.method === "POST")) {
    sendJson(response, 200, { ok: true, result: telegramUser() });
    return true;
  }

  if (method === "setWebhook" && request.method === "POST") {
    state.telegram.webhook = {
      url: typeof body.url === "string" ? body.url : "",
      secretToken: typeof body.secret_token === "string" ? body.secret_token : null,
      allowedUpdates: Array.isArray(body.allowed_updates) ? body.allowed_updates : null,
    };
    sendJson(response, 200, { ok: true, result: true, description: "Webhook was set" });
    return true;
  }

  if (method === "deleteWebhook" && request.method === "POST") {
    state.telegram.webhook = null;
    sendJson(response, 200, { ok: true, result: true, description: "Webhook was deleted" });
    return true;
  }

  if (method === "getWebhookInfo" && (request.method === "GET" || request.method === "POST")) {
    sendJson(response, 200, {
      ok: true,
      result: {
        url: state.telegram.webhook?.url ?? "",
        has_custom_certificate: false,
        pending_update_count: 0,
        max_connections: 40,
        allowed_updates: state.telegram.webhook?.allowedUpdates ?? ["message"],
      },
    });
    return true;
  }

  if (method === "sendMessage" && request.method === "POST") {
    if ((typeof body.chat_id !== "string" && typeof body.chat_id !== "number") || typeof body.text !== "string") {
      sendJson(response, 400, { ok: false, error_code: 400, description: "Bad Request: chat_id and text are required" });
      return true;
    }
    const message = {
      message_id: state.telegram.nextMessageId++,
      date: 1783612801,
      chat: { id: Number(body.chat_id), type: "private" },
      from: telegramUser(),
      text: body.text,
    };
    state.telegram.sentMessages.push(message);
    sendJson(response, 200, { ok: true, result: message });
    return true;
  }

  sendJson(response, 404, { ok: false, error_code: 404, description: `Unknown Telegram method: ${method}` });
  return true;
}

function handleMicrosoftOAuth(request, response, url, rawBody) {
  const match = url.pathname.match(/^\/entra\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/);
  if (!match) return false;

  const operation = match[2];
  if (operation === "authorize" && request.method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) {
      sendJson(response, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
      return true;
    }
    const callback = new URL(redirectUri);
    const requestedScopes = url.searchParams.get("scope") ?? MICROSOFT_SCOPES.join(" ");
    const encodedScopes = Buffer.from(requestedScopes, "utf8").toString("base64url");
    callback.searchParams.set("code", `mock-microsoft-authorization-code.${encodedScopes}`);
    const state = url.searchParams.get("state");
    if (state) callback.searchParams.set("state", state);
    response.writeHead(302, { location: callback.toString() });
    response.end();
    return true;
  }

  if (operation === "token" && request.method === "POST") {
    const form = new URLSearchParams(rawBody);
    const grantType = form.get("grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      sendJson(response, 400, { error: "unsupported_grant_type" });
      return true;
    }
    const authorizationCode = form.get("code") ?? "";
    const encodedScopes = authorizationCode.startsWith("mock-microsoft-authorization-code.")
      ? authorizationCode.slice("mock-microsoft-authorization-code.".length)
      : "";
    let authorizedScopes = form.get("scope") ?? MICROSOFT_SCOPES.join(" ");
    if (encodedScopes) {
      try {
        authorizedScopes = Buffer.from(encodedScopes, "base64url").toString("utf8");
      } catch {
        sendJson(response, 400, { error: "invalid_grant", error_description: "The mock authorization code is malformed." });
        return true;
      }
    }
    sendJson(response, 200, {
      token_type: "Bearer",
      scope: authorizedScopes,
      expires_in: 3600,
      access_token: MOCK_MICROSOFT_ACCESS_TOKEN,
      refresh_token: MOCK_MICROSOFT_REFRESH_TOKEN,
    });
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}

function hasMicrosoftBearer(request) {
  return request.headers.authorization === `Bearer ${MOCK_MICROSOFT_ACCESS_TOKEN}`;
}

function graphEnvelope(value) {
  return {
    "@odata.context": "https://graph.microsoft.test/v1.0/$metadata#mock",
    value,
  };
}

function handleMicrosoftGraph(request, response, url) {
  if (!url.pathname.startsWith("/graph/v1.0/")) return false;
  if (!hasMicrosoftBearer(request)) {
    sendJson(response, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token is missing or invalid." } });
    return true;
  }

  if (url.pathname === "/graph/v1.0/me" && request.method === "GET") {
    sendJson(response, 200, {
      id: "microsoft-user-openwork-test",
      displayName: "OpenWork Tester",
      givenName: "OpenWork",
      surname: "Tester",
      mail: "tester@example.test",
      userPrincipalName: "tester@example.test",
    });
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/messages" && request.method === "GET") {
    const top = Number(url.searchParams.get("$top") ?? MICROSOFT_MESSAGES.length);
    sendJson(response, 200, graphEnvelope(MICROSOFT_MESSAGES.slice(0, Number.isFinite(top) ? top : MICROSOFT_MESSAGES.length)));
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/messages" && request.method === "POST") {
    sendJson(response, 201, {
      id: "draft-openwork-test",
      subject: "OpenWork permission parity draft",
      bodyPreview: "Drafted by the deterministic Microsoft Graph mock.",
      webLink: "https://outlook.office.test/mail/draft-openwork-test",
      isDraft: true,
    });
    return true;
  }

  const messageMatch = url.pathname.match(/^\/graph\/v1\.0\/me\/messages\/([^/]+)$/);
  if (messageMatch && request.method === "GET") {
    const message = MICROSOFT_MESSAGES.find((item) => item.id === decodeURIComponent(messageMatch[1]));
    if (!message) {
      sendJson(response, 404, { error: { code: "ErrorItemNotFound", message: "The message was not found." } });
      return true;
    }
    sendJson(response, 200, message);
    return true;
  }

  if (
    (url.pathname === "/graph/v1.0/me/calendarView" || url.pathname === "/graph/v1.0/me/events")
    && request.method === "GET"
  ) {
    sendJson(response, 200, graphEnvelope(MICROSOFT_EVENTS));
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/events" && request.method === "POST") {
    sendJson(response, 201, {
      id: "event-openwork-test",
      subject: "OpenWork permission parity review",
      start: { dateTime: "2026-07-13T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-07-13T10:30:00Z", timeZone: "UTC" },
      webLink: "https://outlook.office.test/calendar/event-openwork-test",
    });
    return true;
  }

  if (
    (url.pathname === "/graph/v1.0/me/drive/root/children" || url.pathname.startsWith("/graph/v1.0/me/drive/root/search"))
    && request.method === "GET"
  ) {
    sendJson(response, 200, graphEnvelope([MICROSOFT_Q3_FILE]));
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/drive/items/file-q3-plan" && request.method === "GET") {
    sendJson(response, 200, MICROSOFT_Q3_FILE);
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/drive/items/file-q3-plan/content" && request.method === "GET") {
    sendText(response, 200, Q3_FILE_CONTENT);
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/drive/root:/OpenWork/permission-parity.txt:/content" && request.method === "PUT") {
    sendJson(response, 201, {
      id: "file-permission-parity",
      name: "permission-parity.txt",
      size: 37,
      webUrl: "https://onedrive.office.test/files/file-permission-parity",
      file: { mimeType: "text/plain" },
    });
    return true;
  }

  if (url.pathname === "/graph/v1.0/me/chats" && request.method === "GET") {
    sendJson(response, 200, graphEnvelope([{
      id: "chat-openwork-test",
      topic: "OpenWork launch",
      chatType: "group",
      webUrl: "https://teams.office.test/chats/chat-openwork-test",
      lastUpdatedDateTime: "2026-07-13T09:00:00Z",
    }]));
    return true;
  }

  if (url.pathname === "/graph/v1.0/chats/chat-openwork-test/messages" && request.method === "GET") {
    sendJson(response, 200, graphEnvelope([{
      id: "teams-message-existing",
      createdDateTime: "2026-07-13T09:05:00Z",
      body: { contentType: "text", content: "Ready for the permission review." },
      from: { user: { id: "microsoft-user-openwork-test", displayName: "OpenWork Tester" } },
      webUrl: "https://teams.office.test/messages/teams-message-existing",
    }]));
    return true;
  }

  if (url.pathname === "/graph/v1.0/chats/chat-openwork-test/messages" && request.method === "POST") {
    sendJson(response, 201, {
      id: "teams-message-sent",
      createdDateTime: "2026-07-13T09:10:00Z",
      body: { contentType: "text", content: "Permission parity verified." },
      from: { user: { id: "microsoft-user-openwork-test", displayName: "OpenWork Tester" } },
      webUrl: "https://teams.office.test/messages/teams-message-sent",
    });
    return true;
  }

  sendJson(response, 404, { error: { code: "Request_ResourceNotFound", message: `Unhandled mock Graph route: ${url.pathname}` } });
  return true;
}

function hasWorkerDualAuth(request) {
  return request.headers["x-openwork-host-token"] === MOCK_WORKER_HOST_TOKEN
    && request.headers.authorization === `Bearer ${MOCK_WORKER_CLIENT_TOKEN}`;
}

function workerUnauthorized(response) {
  sendJson(response, 401, {
    error: "worker_mock_unauthorized",
    message: "Both the OpenWork host token and client bearer token are required.",
  });
}

function workerMessage(session, role, id, text, parentID = null) {
  return {
    info: { id, sessionID: session.id, role, ...(parentID ? { parentID } : {}), time: { created: 1783612800000 } },
    parts: [{ id: `${id}-part`, messageID: id, sessionID: session.id, type: "text", text }],
  };
}

function workerSnapshot(session, status) {
  const messages = [];
  if (session.prompt) {
    messages.push(workerMessage(session, "user", session.messageId, session.prompt));
  }
  if (status === "idle" && session.prompt) {
    messages.push(workerMessage(session, "assistant", `${session.messageId}-assistant`, `OpenWork worker reply: ${session.prompt}`, session.messageId));
  }
  return {
    item: {
      session: {
        id: session.id,
        title: session.title,
        directory: "/workspace",
        time: { created: 1783612800000, updated: 1783612801000 },
      },
      messages,
      todos: [],
      status: { type: status },
    },
  };
}

function handleWorker(state, request, response, url, rawBody) {
  if (!url.pathname.startsWith("/worker/")) return false;
  if (!hasWorkerDualAuth(request)) {
    workerUnauthorized(response);
    return true;
  }

  if (url.pathname === "/worker/workspaces" && request.method === "GET") {
    sendJson(response, 200, {
      activeId: "ws_mock_cloud",
      items: [{ id: "ws_mock_cloud", name: "Mock cloud workspace", path: "/workspace" }],
    });
    return true;
  }

  if (url.pathname === "/worker/workspace/ws_mock_cloud/opencode/session" && request.method === "POST") {
    let body;
    try {
      body = parseJson(rawBody);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return true;
    }
    const id = `ses_mock_${state.worker.nextSessionId++}`;
    const session = { id, title: typeof body.title === "string" ? body.title : "Telegram chat", prompt: null, messageId: null, polls: 0 };
    state.worker.sessions.set(id, session);
    sendJson(response, 200, { id, title: session.title, directory: "/workspace" });
    return true;
  }

  const promptMatch = url.pathname.match(
    /^\/worker\/workspace\/ws_mock_cloud\/opencode\/session\/([^/]+)\/prompt_async$/,
  );
  if (promptMatch && request.method === "POST") {
    const session = state.worker.sessions.get(decodeURIComponent(promptMatch[1]));
    if (!session) {
      sendJson(response, 404, { error: "session_not_found" });
      return true;
    }
    let body;
    try {
      body = parseJson(rawBody);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return true;
    }
    const textPart = Array.isArray(body.parts)
      ? body.parts.find((part) => part && part.type === "text" && typeof part.text === "string")
      : null;
    if (!textPart) {
      sendJson(response, 400, { error: "text_part_required" });
      return true;
    }
    session.prompt = textPart.text;
    session.messageId = typeof body.messageID === "string" ? body.messageID : `${session.id}-user`;
    session.polls = 0;
    sendEmpty(response);
    return true;
  }

  const snapshotMatch = url.pathname.match(
    /^\/worker\/workspace\/ws_mock_cloud\/sessions\/([^/]+)\/snapshot$/,
  );
  if (snapshotMatch && request.method === "GET") {
    const session = state.worker.sessions.get(decodeURIComponent(snapshotMatch[1]));
    if (!session) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found" });
      return true;
    }
    const status = session.polls++ === 0 ? "busy" : "idle";
    sendJson(response, 200, workerSnapshot(session, status));
    return true;
  }

  sendJson(response, 404, { error: "worker_mock_not_found", path: url.pathname });
  return true;
}

function stateView(state, origin) {
  return {
    endpoints: {
      telegramApiBaseUrl: `${origin}/telegram`,
      microsoftAuthorizeUrl: `${origin}/entra/{tenantId}/oauth2/v2.0/authorize`,
      microsoftTokenUrl: `${origin}/entra/{tenantId}/oauth2/v2.0/token`,
      microsoftGraphBaseUrl: `${origin}/graph/v1.0`,
      workerBaseUrl: `${origin}/worker`,
    },
    credentials: {
      telegramBotToken: MOCK_TELEGRAM_BOT_TOKEN,
      telegramWebhookSecret: MOCK_TELEGRAM_WEBHOOK_SECRET,
      microsoftAccessToken: MOCK_MICROSOFT_ACCESS_TOKEN,
      workerHostToken: MOCK_WORKER_HOST_TOKEN,
      workerClientToken: MOCK_WORKER_CLIENT_TOKEN,
    },
    telegram: state.telegram,
    worker: {
      sessions: Array.from(state.worker.sessions.values()),
    },
  };
}

export function createCloudConnectMockServer(options = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const state = initialState();

  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? `${hostname}:${port}`}`;
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";

    if (method === "OPTIONS") {
      sendEmpty(response);
      return;
    }

    let rawBody = "";
    try {
      rawBody = method === "GET" || method === "HEAD" ? "" : await readBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
      return;
    }
    recordRequest(state, request, url, rawBody);

    if (url.pathname === "/health" && method === "GET") {
      sendJson(response, 200, { ok: true, service: "cloud-connect-services-mock", ...stateView(state, origin) });
      return;
    }

    if (url.pathname === "/__mock/state" && method === "GET") {
      sendJson(response, 200, stateView(state, origin));
      return;
    }

    if (url.pathname === "/__mock/requests" && method === "GET") {
      sendJson(response, 200, { requests: state.requests });
      return;
    }

    if (url.pathname === "/__mock/reset" && method === "POST") {
      resetState(state);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/__mock/telegram/update" && method === "GET") {
      const text = url.searchParams.get("text") ?? "Summarize the launch notes";
      const updateId = Number(url.searchParams.get("updateId") ?? 81001);
      sendJson(response, 200, telegramUpdate(text, Number.isFinite(updateId) ? updateId : 81001));
      return;
    }

    if (handleTelegram(state, request, response, url, rawBody)) return;
    if (handleMicrosoftOAuth(request, response, url, rawBody)) return;
    if (handleMicrosoftGraph(request, response, url)) return;
    if (handleWorker(state, request, response, url, rawBody)) return;

    sendJson(response, 404, { error: "not_found", path: url.pathname });
  });

  return {
    state,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock_server_address_unavailable");
      return {
        origin: `http://${hostname}:${address.port}`,
        port: address.port,
      };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function cliPort() {
  const index = process.argv.indexOf("--port");
  const raw = index === -1 ? process.env.PORT : process.argv[index + 1];
  const port = Number(raw ?? 3979);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${raw}`);
  return port;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mock = createCloudConnectMockServer({
    hostname: process.env.HOST ?? "127.0.0.1",
    port: cliPort(),
  });
  const started = await mock.start();
  console.log(`Cloud connection services mock listening at ${started.origin}`);
  console.log(`Inspect endpoints and credentials at ${started.origin}/health`);
}
