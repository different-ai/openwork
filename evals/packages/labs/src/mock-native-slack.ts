import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type SlackConversationType = "public_channel" | "private_channel" | "im" | "mpim";
export type SlackFixtureMember = "first" | "second";
export const slackFixtureWorkspace = "TSYNTHETIC";
export const slackFixtureOtherWorkspace = "TOTHERSYNTHETIC";
export const slackFixtureClientId = "eng-76-synthetic-client";
export const slackFixtureClientSecret = "eng-76-synthetic-secret-not-a-credential";
export const slackFixtureScopes = [
  "search:read.public", "search:read.private", "search:read.im", "search:read.mpim",
  "channels:history", "groups:history", "im:history", "mpim:history",
];
const publicScopes = ["search:read.public", "channels:history"];
const scopeForType: Record<SlackConversationType, string> = {
  public_channel: "search:read.public", private_channel: "search:read.private", im: "search:read.im", mpim: "search:read.mpim",
};
const historyForType: Record<SlackConversationType, string> = {
  public_channel: "channels:history", private_channel: "groups:history", im: "im:history", mpim: "mpim:history",
};

export interface SlackHttpWitness {
  method: string;
  path: string;
  member: SlackFixtureMember | null;
  workspace: string | null;
  tokenId: string | null;
  parameters: Record<string, unknown>;
  returnedChannels: string[];
  returnedMessages: number;
  error: string | null;
}

interface Grant {
  member: SlackFixtureMember;
  workspace: string;
  scopes: string[];
  redirectUri: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function list(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function channelType(value: string): value is SlackConversationType {
  return value === "public_channel" || value === "private_channel" || value === "im" || value === "mpim";
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
async function parameters(request: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  if (!raw) return Object.fromEntries(url.searchParams);
  if (request.headers["content-type"]?.includes("application/json")) {
    const body: unknown = JSON.parse(raw);
    if (!record(body)) throw new Error("Expected a Slack request object");
    return body;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Native HTTP provider boundary, never a substitute for Den's capabilities.
 * RTS fixture shape follows the 2026-09-28 official assistant.search.context
 * reference: results.messages, content, message_ts, channel_id, permalink,
 * context_messages.before/after and response_metadata.next_cursor.
 */
export async function startNativeSlackFixture() {
  const nonce = randomUUID().slice(0, 8);
  const conversations: Array<{
    type: SlackConversationType; id: string; name: string; text: string; ts: string; members: SlackFixtureMember[];
  }> = [
    { type: "public_channel", id: "CSYNTHPUBLIC", name: "synthetic-launch", text: `Amber launch uses the morning window. PUBLIC-${nonce}`, ts: "1780000000.000001", members: ["first", "second"] },
    { type: "private_channel", id: "GSYNTHPRIVATE", name: "synthetic-private", text: `Amber launch has a private review. PRIVATE-${nonce}`, ts: "1780000001.000001", members: ["first"] },
    { type: "im", id: "DSYNTHDIRECT", name: "synthetic-direct", text: `Amber launch direct-message check is complete. DIRECT-${nonce}`, ts: "1780000002.000001", members: ["first"] },
    { type: "mpim", id: "GSYNTHGROUP", name: "synthetic-group", text: `Amber launch group-message check is complete. GROUP-${nonce}`, ts: "1780000003.000001", members: ["first"] },
  ];
  const calls: SlackHttpWitness[] = [];
  const otherConversations = conversations.map(conversation => ({ ...conversation, id: `${conversation.id}OTHER`, text: `Other workspace: ${conversation.text}` }));
  const authorizations: Array<{ clientId: string; scopes: string[]; botScopes: string[]; statePresent: boolean; redirectUri: string }> = [];
  const codes = new Map<string, Grant>();
  const tokens = new Map<string, Grant>();
  const pending = new Map<string, { state: string; redirectUri: string }>();
  const callbackOrigins = new Set<string>();
  const source = (channel: string, ts: string) => `https://synthetic.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/oauth/v2/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const clientId = url.searchParams.get("client_id") ?? "";
        const scopes = list(url.searchParams.get("user_scope"));
        const botScopes = list(url.searchParams.get("scope"));
        authorizations.push({ clientId, scopes, botScopes, statePresent: Boolean(state), redirectUri });
        if (!state || clientId !== slackFixtureClientId || !callbackOrigins.has(new URL(redirectUri).origin)
          || !new URL(redirectUri).pathname.endsWith("/v1/oauth-providers/slack/connect/callback")
          || !scopes.includes("search:read.public") || scopes.some(scope => !slackFixtureScopes.includes(scope)) || botScopes.length > 0) {
          json(response, { error: "invalid_synthetic_authorization" }, 400); return;
        }
        const id = randomUUID();
        pending.set(id, { state, redirectUri });
        const button = (choice: string, label: string) => `<form action="/consent"><input type="hidden" name="flow" value="${id}"><button name="choice" value="${choice}">${label}</button></form>`;
        // Chrome applies form-action to the redirect chain as well. Permit only
        // the already validated, test-owned callback origin—not arbitrary hosts.
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": `default-src 'none'; form-action 'self' ${new URL(redirectUri).origin}` });
        response.end(`<!doctype html><html><title>Synthetic Slack consent</title><h1>Synthetic Slack consent</h1><p>Read synthetic conversations using your own member identity. No messages will be sent.</p>${button("first", "Authorize member one")}${button("second", "Authorize member two")}${button("public", "Authorize public access only")}${button("other", "Authorize another workspace")}</html>`);
        return;
      }
      if (url.pathname === "/consent") {
        const id = url.searchParams.get("flow") ?? "";
        const flow = pending.get(id);
        const choice = url.searchParams.get("choice");
        if (!flow || !["first", "second", "public", "other"].includes(choice ?? "")) { json(response, { error: "invalid_consent" }, 400); return; }
        pending.delete(id);
        const code = `synthetic-code-${randomUUID()}`;
        codes.set(code, { member: choice === "second" ? "second" : "first", workspace: choice === "other" ? slackFixtureOtherWorkspace : slackFixtureWorkspace,
          scopes: choice === "public" ? publicScopes : slackFixtureScopes, redirectUri: flow.redirectUri });
        const callback = new URL(flow.redirectUri);
        callback.searchParams.set("state", flow.state);
        callback.searchParams.set("code", code);
        response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" }); response.end(); return;
      }
      const params = await parameters(request, url);
      if (url.pathname === "/api/oauth.v2.access") {
        const basic = request.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(request.headers.authorization.slice(6), "base64").toString("utf8") : "";
        const validClient = basic === `${slackFixtureClientId}:${slackFixtureClientSecret}`
          || (params.client_id === slackFixtureClientId && params.client_secret === slackFixtureClientSecret);
        const grant = typeof params.code === "string" ? codes.get(params.code) : undefined;
        if (!validClient || !grant || params.redirect_uri !== grant.redirectUri) { json(response, { ok: false, error: "invalid_code" }); return; }
        codes.delete(String(params.code));
        const token = `synthetic-user-${randomUUID()}`;
        tokens.set(token, grant);
        calls.push({ method: request.method ?? "GET", path: url.pathname, member: grant.member, workspace: grant.workspace,
          tokenId: createHash("sha256").update(token).digest("hex").slice(0, 12), parameters: {}, returnedChannels: [], returnedMessages: 0, error: null });
        json(response, { ok: true, app_id: "ASYNTHETIC", token_type: "bot", access_token: "synthetic-bot-trap-must-never-be-used", scope: "",
          team: { id: grant.workspace, name: "Synthetic validation workspace" }, is_enterprise_install: false,
          authed_user: { id: grant.member === "first" ? "USYNTHFIRST" : "USYNTHSECOND", token_type: "user", access_token: token, scope: grant.scopes.join(",") } });
        return;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /i, "") ?? "";
      const grant = tokens.get(bearer);
      const observed: SlackHttpWitness = {
        method: request.method ?? "GET", path: url.pathname, member: grant?.member ?? null, workspace: grant?.workspace ?? null,
        tokenId: bearer ? createHash("sha256").update(bearer).digest("hex").slice(0, 12) : null,
        parameters: Object.fromEntries(Object.entries(params).filter(([key]) => !["token", "client_secret", "code"].includes(key))),
        returnedChannels: [], returnedMessages: 0, error: null,
      };
      calls.push(observed);
      const fail = (error: string) => { observed.error = error; json(response, { ok: false, error }); };
      if (!grant) { fail("invalid_auth"); return; }
      const workspaceConversations = grant.workspace === slackFixtureOtherWorkspace ? otherConversations : conversations;
      if (url.pathname === "/api/auth.test") {
        json(response, { ok: true, team_id: grant.workspace, user_id: grant.member === "first" ? "USYNTHFIRST" : "USYNTHSECOND",
          team: "Synthetic validation workspace", user: grant.member, url: "https://synthetic.slack.com/" }); return;
      }
      if (url.pathname === "/api/assistant.search.context") {
        const types = params.channel_types === undefined ? ["public_channel"] : list(params.channel_types);
        if (typeof params.query !== "string" || !params.query.trim()) { fail("missing_query"); return; }
        if (params.action_token !== undefined || types.some(type => !channelType(type))) { fail("invalid_arguments"); return; }
        if (types.some(type => channelType(type) && !grant.scopes.includes(scopeForType[type]))) { fail("missing_scope"); return; }
        if (list(params.content_types).some(type => type !== "messages")) { fail("fixture_disallows_file_search"); return; }
        const visible = workspaceConversations.filter(conversation => types.includes(conversation.type) && conversation.members.includes(grant.member));
        observed.returnedChannels = visible.map(conversation => conversation.id);
        observed.returnedMessages = visible.length;
        json(response, { ok: true, results: { messages: visible.map(conversation => ({
          author_name: "Synthetic member", author_user_id: "USYNTHFIRST", team_id: grant.workspace,
          channel_id: conversation.id, channel_name: conversation.name, message_ts: conversation.ts,
          content: conversation.text, is_author_bot: false, permalink: source(conversation.id, conversation.ts),
          context_messages: { before: [], after: [] },
        })) }, response_metadata: { next_cursor: "" } }); return;
      }
      const conversation = workspaceConversations.find(entry => entry.id === params.channel);
      if (!conversation || !conversation.members.includes(grant.member)) { fail("channel_not_found"); return; }
      if (url.pathname === "/api/conversations.replies") {
        if (!grant.scopes.includes(historyForType[conversation.type])) { fail("missing_scope"); return; }
        const limit = Number(params.limit ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || params.ts !== conversation.ts) { fail("invalid_arguments"); return; }
        const offset = params.cursor === "synthetic-thread-next" ? limit : 0;
        const messages = Array.from({ length: 105 }, (_, index) => ({ type: "message", user: "USYNTHFIRST",
          ts: index === 0 ? conversation.ts : `${1780000100 + index}.000001`, thread_ts: conversation.ts,
          text: index === 0 ? conversation.text : `Synthetic thread context ${index}.`, ...(index === 0 ? { reply_count: 104 } : {}),
        })).slice(offset, offset + limit);
        const more = offset + messages.length < 105;
        observed.returnedChannels = [conversation.id]; observed.returnedMessages = messages.length;
        json(response, { ok: true, messages, has_more: more, response_metadata: { next_cursor: more ? "synthetic-thread-next" : "" } }); return;
      }
      if (url.pathname === "/api/chat.getPermalink") {
        json(response, { ok: true, channel: conversation.id, permalink: source(conversation.id, String(params.message_ts ?? conversation.ts)) }); return;
      }
      fail("unsupported_synthetic_method");
    })().catch(() => json(response, { error: "synthetic_slack_protocol_failure" }, 500));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic Slack did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, apiUrl: `${origin}/api`, authorizeUrl: `${origin}/oauth/v2/authorize`, tokenUrl: `${origin}/api/oauth.v2.access`,
    conversations, otherConversations, otherWorkspace: slackFixtureOtherWorkspace, source,
    allowCallbackOrigin(value: string) {
      const url = new URL(value);
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Synthetic callback must be owned loopback HTTP");
      callbackOrigins.add(url.origin);
    },
    authorizations: () => structuredClone(authorizations),
    calls: () => structuredClone(calls),
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
