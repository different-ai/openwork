// Workshop Slack ("Open Slack"): a fictional Slack for the workshop gateway, so an app that messages people from its
// own Slack app (OpenWork's Workbot) can be tried without a real Slack workspace. An app registers a sample Slack app
// and gets a bot token; each person connects the Slack connector once in their own browser workspace; the bot's
// direct messages then show up on that person's /slack page. Sandbox only: this is not Slack, and nothing leaves it.
//
//   POST /_workshop/slack/apps                 {"bot_name"?} -> a sample workspace (team) with one app and its bot token
//   POST /slack/teams/<team>/api/<method>      Slack Web API subset, "Authorization: Bearer <bot or member token>"
//   POST /slack/mcp                            the person's Slack connector (workshop OAuth, like the other apps)
//   GET  /slack                                the person's own messages with the app, in their browser workspace
//
// A member token is the workshop OAuth token issued for /slack/mcp: the same token works on the Web API of any team,
// as the person it was issued to. The first call with it (`auth.test`) adds the person to that team, which is what
// lets the team's bot message them. A bot reaches only people who joined its team; a person reads only their own
// conversations. Node builtins only, like the rest of this package.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { escapeHtml } from "./workshop-html.mjs";

const APP_MS = 120 * 24 * 60 * 60 * 1000;
const APP_LIMIT = 4096;
const MEMBER_LIMIT = 50_000;
const MAX_MESSAGES = 500;
const MAX_TEXT = 40_000;
const MAX_BODY = 256 * 1024;
const STORAGE_KEY = "workshop-slack:v1";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SLACK_MCP_PATH = "/slack/mcp";
export const SLACK_TEAM_NAME = "Acme Robotics";

const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(String(value)).digest("base64url");
/** A Slack-style ID (a letter, then capitals and digits) derived from a seed, so the same person keeps the same ID. */
const derivedId = (prefix, seed) => prefix + createHash("sha256").update(seed).digest("hex").slice(0, 10).toUpperCase();
const randomId = (prefix) => prefix + randomBytes(5).toString("hex").toUpperCase();

/**
 * Slack mrkdwn as HTML: links, mentions, bold, italic, strike and code. The text is escaped first; only the tags
 * written here are ever added, and links are limited to http(s).
 */
export function renderMrkdwn(text, mention = (id) => id) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let html = escapeHtml(String(text).replace(/[\u0000-\u0008\u000b-\u001f]/g, ""));
  html = html.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  html = html.replace(/&lt;(https?:\/\/(?:(?!&gt;|\|)\S)+)(?:\|((?:(?!&gt;)[^\n])*))?&gt;/g, (_, url, label) => hold(`<a href="${url}" target="_blank" rel="noreferrer noopener">${label || url}</a>`));
  html = html.replace(/&lt;@([A-Z0-9]+)&gt;/g, (_, id) => hold(`<span class="mention">@${escapeHtml(mention(id))}</span>`));
  html = html.replace(/&lt;!(here|channel|everyone)(?:\|[^&]*)?&gt;/g, (_, group) => hold(`<span class="mention">@${group}</span>`));
  for (const [mark, tag] of [["\\*", "strong"], ["_", "em"], ["~", "s"]]) {
    html = html.replace(new RegExp(`(^|[\\s(])${mark}([^\\s${mark}](?:[^${mark}\\n]*[^\\s${mark}])?)${mark}(?=$|[\\s.,!?:;)])`, "gm"), `$1<${tag}>$2</${tag}>`);
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => held[Number(index)]).replace(/\n/g, "<br>");
}

const TOOLS = [
  {
    name: "slack_search_channels",
    description: "List the Slack conversations you are in (your direct messages with apps), optionally filtered by name.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Part of a conversation's name." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slack_read_channel",
    description: "Read the newest messages in one of your Slack conversations, newest first.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["channel_id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slack_read_thread",
    description: "Read a message and its replies in one of your Slack conversations, oldest first.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" }, message_ts: { type: "string" } }, required: ["channel_id", "message_ts"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slack_send_message",
    description: "Send a message as yourself in one of your Slack conversations, optionally as a reply in a thread.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" }, message: { type: "string" }, thread_ts: { type: "string" } }, required: ["channel_id", "message"], additionalProperties: false },
  },
];

const STYLE = `
:root{--aubergine:#3f0e40;--aubergine-active:#1164a3;--foreground:#1d1c1d;--muted:#616061;--border:rgba(29,28,29,.13);--surface:#fff;--focus:#1264a3;font:15px/1.46668 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--foreground);color-scheme:light}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;grid-template-columns:260px 1fr;background:var(--surface)}
aside{background:var(--aubergine);color:#d1c7d2;display:flex;flex-direction:column;min-height:0}
.team{padding:14px 16px;color:#fff;font-weight:700;font-size:18px;border-bottom:1px solid rgba(255,255,255,.1)}
.section{padding:16px 16px 4px;font-size:13px}
.conversation{display:flex;align-items:center;gap:8px;padding:4px 16px;color:inherit;text-decoration:none}
.conversation[aria-current]{background:var(--aubergine-active);color:#fff}
aside .badge{color:inherit;background:rgba(255,255,255,.16)}
.conversation:focus-visible,a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.sandbox{margin-top:auto;padding:12px 16px;font-size:12px;border-top:1px solid rgba(255,255,255,.1)}
main{display:flex;flex-direction:column;min-width:0;min-height:0;height:100vh}
main>header{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border)}
h1{font-size:18px;margin:0}
.badge{font-size:10px;font-weight:700;letter-spacing:.02em;color:var(--muted);background:rgba(29,28,29,.08);border-radius:3px;padding:1px 4px}
#messages{flex:1;overflow-y:auto;margin:0;padding:12px 0;list-style:none}
.message{display:flex;gap:10px;padding:6px 20px}
.message:target{background:#fef9e7}
.avatar{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#011627;color:#fff;font-weight:700}
.avatar.person{background:#2b6cb0}
.body{min-width:0;flex:1}.meta{display:flex;align-items:baseline;gap:6px}.meta time{font-size:12px;color:var(--muted)}
.text{overflow-wrap:anywhere}.text code{background:rgba(29,28,29,.06);border:1px solid var(--border);border-radius:3px;padding:0 3px;font-size:12px}
.text a{color:var(--focus)}.mention{background:rgba(29,155,209,.12);color:#1264a3;border-radius:3px;padding:0 2px}
.replies{list-style:none;margin:6px 0 0;padding:0 0 0 12px;border-left:2px solid var(--border)}.replies .message{padding:4px 0 4px 8px}
.replies .avatar{width:24px;height:24px;font-size:12px}
.empty{padding:40px 20px;color:var(--muted);max-width:560px}.empty h2{color:var(--foreground);font-size:18px;margin:0 0 8px}
form{padding:0 20px 16px}
.composer{display:flex;gap:8px;align-items:flex-end;border:1px solid rgba(29,28,29,.3);border-radius:8px;padding:8px}
textarea{flex:1;border:0;resize:none;font:inherit;min-height:44px;outline-offset:4px}
button{font:inherit;font-weight:700;min-height:36px;padding:0 14px;border:0;border-radius:4px;background:#007a5a;color:#fff;cursor:pointer}
.hint{margin:6px 0 0;font-size:12px;color:var(--muted)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:700px){body{grid-template-columns:1fr}aside{display:none}}
`;

// Keeps the page current without a reload: new messages appear, times show in the reader's own time zone, and the
// list stays at the newest message unless the reader scrolled up.
const SCRIPT = `
const list = document.getElementById("messages");
const localize = (root) => {
  for (const element of root.querySelectorAll("time[datetime]")) {
    const date = new Date(element.dateTime);
    if (!Number.isNaN(date.valueOf())) element.textContent = date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
};
if (list) {
  localize(list);
  if (!location.hash) list.scrollTop = list.scrollHeight;
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const response = await fetch(location.pathname + location.search, { headers: { accept: "text/html" }, credentials: "same-origin" });
      if (!response.ok) return;
      const next = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("messages");
      if (!next || next.dataset.revision === list.dataset.revision) return;
      const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.innerHTML = next.innerHTML;
      list.dataset.revision = next.dataset.revision;
      localize(list);
      if (atEnd) list.scrollTop = list.scrollHeight;
    } catch { /* The next check tries again. */ }
  }, 5000);
}
`;

/**
 * The fictional Slack for one workshop gateway. `auth` is the workshop's authentication (createWorkshopAuth): it says
 * who a browser or a connector token belongs to. `personName` gives the name a person goes by in the workplace.
 */
export function createWorkshopSlack({ origin, auth, storage, personName = (participant) => participant.name }) {
  if (new URL(origin).origin !== origin) throw new Error("Workshop origin must be an HTTP(S) origin");
  /** appId -> { appId, teamId, botUserId, botId, botName, tokenDigest, expires } */
  const apps = new Map();
  const byTeam = new Map(), byToken = new Map();
  /** `${teamId}:${userId}` -> participantId */
  const members = new Map();
  /** channelId -> { teamId, userId, participantId, revision, messages: [{ ts, user, text, bot_id?, thread_ts? }] } */
  const conversations = new Map();
  const rates = new Map();

  function index(app) { apps.set(app.appId, app); byTeam.set(app.teamId, app); byToken.set(app.tokenDigest, app); }
  function save() {
    storage?.write(STORAGE_KEY, { version: 1, origin, apps: [...apps.values()], members: [...members], conversations: [...conversations] });
  }
  function restore() {
    const saved = storage?.read(STORAGE_KEY);
    if (saved === undefined) return;
    if (!saved || saved.version !== 1 || saved.origin !== origin || !Array.isArray(saved.apps) || !Array.isArray(saved.members) || !Array.isArray(saved.conversations)) throw new Error("Workshop Slack storage is invalid; restore a trusted backup before restarting.");
    for (const app of saved.apps) if (app && typeof app.appId === "string" && typeof app.teamId === "string" && typeof app.tokenDigest === "string" && Number.isFinite(app.expires) && app.expires > Date.now()) index(app);
    // A person who no longer exists takes their membership and messages with them, as does an expired app.
    for (const [key, participantId] of saved.members) if (typeof key === "string" && byTeam.has(key.split(":")[0]) && auth.participant(participantId)) members.set(key, participantId);
    for (const [channelId, conversation] of saved.conversations) {
      if (typeof channelId !== "string" || !conversation || !Array.isArray(conversation.messages) || !members.has(`${conversation.teamId}:${conversation.userId}`)) continue;
      conversations.set(channelId, conversation);
    }
  }
  restore();

  function prune() {
    const now = Date.now();
    let changed = false;
    for (const app of [...apps.values()]) {
      if (app.expires > now) continue;
      apps.delete(app.appId); byTeam.delete(app.teamId); byToken.delete(app.tokenDigest);
      for (const key of [...members.keys()]) if (key.startsWith(`${app.teamId}:`)) members.delete(key);
      for (const [channelId, conversation] of [...conversations]) if (conversation.teamId === app.teamId) conversations.delete(channelId);
      changed = true;
    }
    if (changed) save();
  }
  function budget(req, category, maximum) {
    const now = Date.now();
    for (const [key, entry] of rates) if (entry.expires <= now) rates.delete(key);
    const key = `${category}:${req.socket?.remoteAddress || "unknown"}`;
    let entry = rates.get(key);
    if (!entry) { if (rates.size >= APP_LIMIT) return false; entry = { count: 0, expires: now + 60_000 }; rates.set(key, entry); }
    if (entry.count >= maximum) return false;
    entry.count++;
    return true;
  }

  function send(res, status, value, headers = {}) {
    const text = typeof value === "string";
    res.writeHead(status, {
      "content-type": text ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
      ...(text ? { "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } : {}),
      ...headers,
    });
    res.end(value === undefined ? undefined : text ? value : JSON.stringify(value));
  }
  async function read(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  }
  /** Slack accepts JSON and form bodies; both arrive as one flat set of arguments. */
  async function readArguments(req) {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const text = await read(req);
    if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid arguments");
    return parsed;
  }

  // People and conversations.
  const userIdFor = (teamId, participant) => derivedId("U", `${teamId}:${participant.id}`);
  /** Adds the person to the team (the first time their connector reaches it) and answers their Slack user ID. */
  function join(app, participant) {
    const userId = userIdFor(app.teamId, participant);
    const key = `${app.teamId}:${userId}`;
    if (!members.has(key)) {
      if (members.size >= MEMBER_LIMIT) return null;
      members.set(key, participant.id);
      save();
    }
    return userId;
  }
  function memberParticipant(teamId, userId) { return auth.participant(members.get(`${teamId}:${userId}`)); }
  function directMessage(app, userId) {
    const channelId = derivedId("D", `${app.teamId}:${userId}`);
    let conversation = conversations.get(channelId);
    if (!conversation) {
      conversation = { teamId: app.teamId, userId, participantId: members.get(`${app.teamId}:${userId}`), revision: 0, messages: [] };
      conversations.set(channelId, conversation);
    }
    return { channelId, conversation };
  }
  /** The person's conversations, one per team they joined, whether or not anything was sent yet. */
  function conversationsOf(participant) {
    prune();
    const found = [];
    for (const [key, participantId] of members) {
      if (participantId !== participant.id) continue;
      const [teamId, userId] = key.split(":");
      const app = byTeam.get(teamId);
      if (app) found.push({ app, userId, ...directMessage(app, userId) });
    }
    return found;
  }
  function nextTs(conversation) {
    const last = conversation.messages.at(-1)?.ts;
    let micros = Date.now() * 1000;
    if (last && micros <= Math.round(Number(last) * 1e6)) micros = Math.round(Number(last) * 1e6) + 1;
    return `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, "0")}`;
  }
  /** Adds a message; answers `{ message }` or `{ error }` with Slack's error name. */
  function post(conversation, { user, botId, text, threadTs }) {
    if (typeof text !== "string" || !text.trim()) return { error: "no_text" };
    if (text.length > MAX_TEXT) return { error: "msg_too_long" };
    if (threadTs !== undefined && !conversation.messages.some((message) => message.ts === threadTs && !message.thread_ts)) return { error: "thread_not_found" };
    const message = { ts: nextTs(conversation), user, text, ...(botId ? { bot_id: botId } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) };
    conversation.messages.push(message);
    // Keep each conversation bounded: the oldest message goes first, with its replies.
    while (conversation.messages.length > MAX_MESSAGES) {
      const [dropped] = conversation.messages.splice(0, 1);
      if (!dropped.thread_ts) conversation.messages = conversation.messages.filter((entry) => entry.thread_ts !== dropped.ts);
    }
    conversation.revision++;
    save();
    return { message };
  }
  const replyCount = (conversation, ts) => conversation.messages.filter((message) => message.thread_ts === ts).length;
  function wire(conversation, app, message) {
    const replies = message.thread_ts ? 0 : replyCount(conversation, message.ts);
    return { type: "message", ts: message.ts, user: message.user, text: message.text, ...(message.bot_id ? { bot_id: message.bot_id, app_id: app.appId } : {}), ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}), ...(replies ? { thread_ts: message.ts, reply_count: replies } : {}) };
  }
  function history(conversation, app, { limit, oldest, latest }) {
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    const from = Number(oldest) || 0, to = Number(latest) || Infinity;
    const top = conversation.messages.filter((message) => !message.thread_ts && Number(message.ts) > from && Number(message.ts) < to).reverse();
    return { messages: top.slice(0, size).map((message) => wire(conversation, app, message)), has_more: top.length > size };
  }
  function thread(conversation, app, ts) {
    const parent = conversation.messages.find((message) => message.ts === ts && !message.thread_ts);
    if (!parent) return null;
    return [parent, ...conversation.messages.filter((message) => message.thread_ts === ts)].map((message) => wire(conversation, app, message));
  }

  // Registration: one sample workspace with one app per call.
  async function register(req, res) {
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    if (!budget(req, "register", 30)) return send(res, 429, { error: "too_many_requests" });
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return send(res, 415, { error: "invalid_request" });
    let data;
    try { data = JSON.parse((await read(req)) || "{}"); } catch (error) { return send(res, error.status || 400, { error: "invalid_request" }); }
    const botName = data?.bot_name === undefined ? "Workbot" : data.bot_name;
    if (typeof botName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(botName)) return send(res, 400, { error: "invalid_bot_name", error_description: "Use 1 to 40 letters, digits, spaces, dots, dashes or underscores." });
    prune();
    if (apps.size >= APP_LIMIT) return send(res, 503, { error: "temporarily_unavailable" });
    let teamId;
    do { teamId = randomId("T"); } while (byTeam.has(teamId));
    const token = `xoxb-open-workplace-${secret()}`;
    const app = { appId: randomId("A"), teamId, botUserId: randomId("U"), botId: randomId("B"), botName, tokenDigest: digest(token), expires: Date.now() + APP_MS };
    index(app); save();
    // The signing secret is for requests this workshop would send the app. It sends none yet, so it is not kept.
    return send(res, 201, {
      team_id: app.teamId, team_name: SLACK_TEAM_NAME, app_id: app.appId, bot_user_id: app.botUserId, bot_id: app.botId, bot_token: token, signing_secret: secret(),
      api_base_url: `${origin}/slack/teams/${app.teamId}/api`, mcp_url: origin + SLACK_MCP_PATH, expires_at: new Date(app.expires).toISOString(),
    });
  }

  // Slack Web API subset. Like Slack, a refused call answers 200 with `ok: false` and an error name.
  async function api(req, res, teamId, method) {
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    prune();
    const app = byTeam.get(teamId);
    const bearer = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(String(req.headers.authorization || ""))?.[1];
    let actor = null;
    if (app && bearer && byToken.get(digest(bearer)) === app) {
      actor = { bot: true, userId: app.botUserId };
      // An app in use never expires: each day of use renews it for another 120 days.
      if (app.expires - Date.now() < APP_MS - 24 * 60 * 60 * 1000) { app.expires = Date.now() + APP_MS; save(); }
    } else if (app) {
      const participant = auth.bearerFor(req, SLACK_MCP_PATH);
      const userId = participant ? join(app, participant) : null;
      if (userId) actor = { bot: false, userId, participant };
    }
    if (!actor) return send(res, 200, { ok: false, error: "invalid_auth" });
    let args;
    try { args = await readArguments(req); } catch (error) { return send(res, error.status === 413 ? 413 : 200, { ok: false, error: "invalid_arguments" }); }
    const ok = (value = {}) => send(res, 200, { ok: true, ...value });
    const fail = (error) => send(res, 200, { ok: false, error });
    /** A conversation the caller may use: any of the team's for its bot, only their own for a person. */
    const conversationFor = (channelId) => {
      const conversation = typeof channelId === "string" ? conversations.get(channelId) : undefined;
      return conversation && conversation.teamId === app.teamId && (actor.bot || conversation.userId === actor.userId) ? conversation : null;
    };
    switch (method) {
      case "auth.test":
        return ok({ url: `${origin}/slack?team=${app.teamId}`, team: SLACK_TEAM_NAME, team_id: app.teamId, user_id: actor.userId, user: actor.bot ? app.botName : personName(actor.participant), ...(actor.bot ? { bot_id: app.botId } : {}) });
      case "users.info": {
        if (args.user === app.botUserId) return ok({ user: { id: app.botUserId, name: app.botName, real_name: app.botName, is_bot: true } });
        const participant = typeof args.user === "string" && (actor.bot || args.user === actor.userId) ? memberParticipant(app.teamId, args.user) : null;
        return participant ? ok({ user: { id: args.user, name: personName(participant), real_name: personName(participant), is_bot: false } }) : fail("user_not_found");
      }
      case "conversations.open": {
        // A person's only conversation here is with the app; the bot opens one with a member of its team.
        const userId = actor.bot ? args.users : actor.userId;
        if (typeof userId !== "string" || !members.has(`${app.teamId}:${userId}`)) return fail("user_not_found");
        return ok({ channel: { id: directMessage(app, userId).channelId } });
      }
      case "chat.postMessage": {
        const conversation = conversationFor(args.channel);
        if (!conversation) return fail("channel_not_found");
        const posted = post(conversation, { user: actor.userId, botId: actor.bot ? app.botId : undefined, text: args.text, threadTs: args.thread_ts || undefined });
        return posted.error ? fail(posted.error) : ok({ channel: args.channel, ts: posted.message.ts, message: wire(conversation, app, posted.message) });
      }
      case "chat.update": {
        const conversation = conversationFor(args.channel);
        if (!conversation) return fail("channel_not_found");
        const message = conversation.messages.find((entry) => entry.ts === args.ts);
        if (!message) return fail("message_not_found");
        if (message.user !== actor.userId) return fail("cant_update_message");
        if (typeof args.text !== "string" || !args.text.trim()) return fail("no_text");
        if (args.text.length > MAX_TEXT) return fail("msg_too_long");
        message.text = args.text; conversation.revision++; save();
        return ok({ channel: args.channel, ts: message.ts, text: message.text });
      }
      case "chat.getPermalink": {
        const conversation = conversationFor(args.channel);
        if (!conversation) return fail("channel_not_found");
        if (!conversation.messages.some((entry) => entry.ts === args.message_ts)) return fail("message_not_found");
        return ok({ channel: args.channel, permalink: `${origin}/slack?team=${app.teamId}#m-${args.message_ts}` });
      }
      case "conversations.history": {
        const conversation = conversationFor(args.channel);
        return conversation ? ok(history(conversation, app, args)) : fail("channel_not_found");
      }
      case "conversations.replies": {
        const conversation = conversationFor(args.channel);
        if (!conversation) return fail("channel_not_found");
        const messages = thread(conversation, app, args.ts);
        return messages ? ok({ messages, has_more: false }) : fail("thread_not_found");
      }
      default: return fail("unknown_method");
    }
  }

  /** Requests answered before the gateway decides who is asking: registering an app, and the Web API. */
  async function handle(req, res, url) {
    if (url.pathname === "/_workshop/slack/apps") { await register(req, res); return true; }
    const route = /^\/slack\/teams\/(T[A-Z0-9]{1,20})\/api\/([a-zA-Z.]{1,60})$/.exec(url.pathname);
    if (!route) return false;
    await api(req, res, route[1], route[2]);
    return true;
  }

  // The person's connector: tools over their own conversations.
  function ownConversation(participant, channelId) {
    return conversationsOf(participant).find((entry) => entry.channelId === channelId) ?? null;
  }
  function callTool(participant, name, input) {
    const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (name === "slack_search_channels") {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      return { channels: conversationsOf(participant).filter((entry) => !query || entry.app.botName.toLowerCase().includes(query)).map((entry) => ({ channel_id: entry.channelId, name: entry.app.botName, type: "app_direct_message", workspace: SLACK_TEAM_NAME, message_count: entry.conversation.messages.length })) };
    }
    const found = ownConversation(participant, args.channel_id);
    if (!found) throw new Error("channel_not_found: use slack_search_channels to list your conversations.");
    if (name === "slack_read_channel") return history(found.conversation, found.app, { limit: args.limit ?? 20 });
    if (name === "slack_read_thread") {
      const messages = thread(found.conversation, found.app, args.message_ts);
      if (!messages) throw new Error("thread_not_found");
      return { messages };
    }
    if (name === "slack_send_message") {
      const posted = post(found.conversation, { user: found.userId, text: args.message, threadTs: args.thread_ts || undefined });
      if (posted.error) throw new Error(posted.error);
      return { channel_id: found.channelId, message_ts: posted.message.ts };
    }
    throw new Error(`Unknown tool: ${name}`);
  }
  function rpc(message, participant) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    if (message.id === undefined || message.id === null) return null;
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        return result({ protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Open Slack", version: "1.0.0" } });
      }
      case "ping": return result({});
      case "tools/list": return result({ tools: TOOLS });
      case "resources/list": return result({ resources: [] });
      case "resources/templates/list": return result({ resourceTemplates: [] });
      case "prompts/list": return result({ prompts: [] });
      case "tools/call":
        try { return result({ content: [{ type: "text", text: JSON.stringify(callTool(participant, params.name, params.arguments)) }], isError: false }); }
        catch (error) { return result({ content: [{ type: "text", text: error.message }], isError: true }); }
      default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    }
  }
  async function mcp(req, res, participant) {
    if (req.method === "DELETE") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 405, { error: "SSE stream not offered; use POST." }, { allow: "POST, DELETE" });
    let payload;
    try { payload = JSON.parse(await read(req)); } catch (error) { return send(res, error.status === 413 ? 413 : 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const session = { "mcp-session-id": typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : randomUUID() };
    const responses = Array.isArray(payload) ? payload.map((message) => rpc(message, participant)).filter(Boolean) : rpc(payload, participant);
    if (!responses || (Array.isArray(responses) && !responses.length)) return send(res, 202, undefined, session);
    return send(res, 200, responses, session);
  }

  // The person's own Slack page.
  function messageHtml(found, message, replies = []) {
    const fromApp = Boolean(message.bot_id);
    const name = fromApp ? found.app.botName : personName(auth.participant(found.conversation.participantId) ?? { name: "You" });
    const at = new Date(Math.round(Number(message.ts) * 1000));
    const mention = (id) => (id === found.app.botUserId ? found.app.botName : memberParticipant(found.app.teamId, id) ? personName(memberParticipant(found.app.teamId, id)) : id);
    return `<li class="message" id="m-${escapeHtml(message.ts)}"><span class="avatar${fromApp ? "" : " person"}" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span><div class="body"><div class="meta"><strong>${escapeHtml(name)}</strong>${fromApp ? '<span class="badge">APP</span>' : ""}<time datetime="${at.toISOString()}">${at.toISOString().slice(0, 16).replace("T", " ")} UTC</time></div><div class="text">${renderMrkdwn(message.text, mention)}</div>${replies.length ? `<ol class="replies">${replies.map((reply) => messageHtml(found, reply)).join("")}</ol>` : ""}</div></li>`;
  }
  function page(participant, url) {
    const all = conversationsOf(participant);
    const found = all.find((entry) => entry.app.teamId === url.searchParams.get("team")) ?? all[0];
    const sidebar = all.map((entry) => `<a class="conversation" href="/slack?team=${entry.app.teamId}"${entry === found ? ' aria-current="page"' : ""}>${escapeHtml(entry.app.botName)} <span class="badge">APP</span></a>`).join("");
    let main;
    if (!found) {
      main = `<header><h1>Slack</h1></header><div class="empty"><h2>Nothing here yet</h2><p>Connect Slack in OpenWork from this browser. Messages your agent sends you then arrive on this page.</p></div>`;
    } else {
      const top = found.conversation.messages.filter((message) => !message.thread_ts);
      const items = top.map((message) => messageHtml(found, message, found.conversation.messages.filter((reply) => reply.thread_ts === message.ts))).join("");
      main = `<header><h1>${escapeHtml(found.app.botName)}</h1><span class="badge">APP</span></header><ol id="messages" data-revision="${found.conversation.revision}" aria-label="Messages" aria-live="polite">${items || `<li class="empty"><h2>No messages yet</h2><p>Messages from ${escapeHtml(found.app.botName)} arrive here.</p></li>`}</ol><form method="post" action="/slack/messages"><input type="hidden" name="team" value="${found.app.teamId}"><div class="composer"><label class="visually-hidden" for="text">Message ${escapeHtml(found.app.botName)}</label><textarea id="text" name="text" rows="2" maxlength="4000" required placeholder="Message ${escapeHtml(found.app.botName)}"></textarea><button type="submit">Send</button></div><p class="hint">Sample Slack. ${escapeHtml(found.app.botName)} sends messages here and does not answer replies yet.</p></form>`;
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slack · Acme Workplace sandbox</title><style>${STYLE}</style></head><body><aside><div class="team">${SLACK_TEAM_NAME}</div><div class="section">Apps</div>${sidebar || '<div class="conversation">None yet</div>'}<div class="sandbox">Fictional workshop sandbox. Not Slack.</div></aside><main>${main}</main><script src="/slack/app.js" defer></script></body></html>`;
  }
  async function compose(req, res, participant) {
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return send(res, 415, { error: "invalid_request" });
    let fields;
    try { fields = new URLSearchParams(await read(req)); } catch (error) { return send(res, error.status || 400, { error: "invalid_request" }); }
    const found = conversationsOf(participant).find((entry) => entry.app.teamId === fields.get("team"));
    if (!found) return send(res, 404, { error: "not_found" });
    const posted = post(found.conversation, { user: found.userId, text: (fields.get("text") || "").slice(0, 4000) });
    if (posted.error) return send(res, 400, { error: posted.error });
    return send(res, 303, undefined, { location: `/slack?team=${found.app.teamId}` });
  }

  /** Requests from a person the gateway already recognised (their browser, or their connector token on /slack/mcp). */
  async function serve(req, res, url, participant) {
    if (url.pathname === SLACK_MCP_PATH) { await mcp(req, res, participant); return true; }
    if (url.pathname === "/slack" && req.method === "GET") { send(res, 200, page(participant, url)); return true; }
    if (url.pathname === "/slack/app.js" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(SCRIPT);
      return true;
    }
    if (url.pathname === "/slack/messages" && req.method === "POST") { await compose(req, res, participant); return true; }
    return false;
  }

  return {
    handle, serve,
    /** Resets one person's sample data: their messages go; they stay in their teams, so connected apps keep working. */
    clearParticipant(participantId) {
      for (const conversation of conversations.values()) if (conversation.participantId === participantId && conversation.messages.length) { conversation.messages = []; conversation.revision++; }
      save();
    },
    /** Resets everyone's messages; apps and memberships stay, like the other OAuth registrations and grants. */
    clearMessages() {
      for (const conversation of conversations.values()) { conversation.messages = []; conversation.revision++; }
      save();
    },
  };
}
