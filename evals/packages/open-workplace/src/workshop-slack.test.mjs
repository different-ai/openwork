// node --test evals/packages/open-workplace/src/workshop-slack.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkshop } from "./workshop.mjs";
import { renderMrkdwn } from "./workshop-slack.mjs";

const CALLBACK = "http://127.0.0.1:8790/v1/oauth/callback";

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "workshop-slack-"));
  const options = { joinMode: "automatic", dataDir: directory, idleEvictionMs: 60_000 };
  let workshop = await startWorkshop({ ...options, port: 0 });
  const port = workshop.server.address().port;
  t.after(async () => { await workshop?.close(); await rm(directory, { recursive: true, force: true }); });
  const base = workshop.origin;
  const form = (fields) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  /** A new browser: its own private workspace. */
  const enter = async () => {
    const response = await fetch(base + "/login?next=%2F", { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(response.status, 303);
    return response.headers.get("set-cookie").split(";")[0];
  };
  /** The person connects one connector in their browser, as an MCP client would; answers the connector's access token. */
  const connect = async (cookie, connector = "slack") => {
    const resource = `${base}/${connector}/mcp`;
    const client = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "OpenWork", redirect_uris: [CALLBACK] }) })).json();
    const verifier = randomBytes(32).toString("base64url");
    const request = { client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource, state: "s" };
    const consent = await fetch(`${base}/oauth/authorize?${new URLSearchParams(request)}`, { redirect: "manual", headers: { cookie, accept: "text/html" } });
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    if (connector === "slack") assert.match(consentHtml, /Read your sample Slack messages\./);
    assert.match(consentHtml, connector === "slack" ? /active for up to 30 days/ : /active for up to 8 hours/);
    const allowed = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...request, decision: "allow" }) });
    assert.equal(allowed.status, 303);
    const code = new URL(allowed.headers.get("location")).searchParams.get("code");
    const issued = await (await fetch(base + "/oauth/token", { method: "POST", ...form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK, resource }) })).json();
    assert.equal(typeof issued.access_token, "string");
    return issued.access_token;
  };
  const register = async (body = {}) => {
    const response = await fetch(base + "/_workshop/slack/apps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  /** One Slack Web API call, the way Den's client sends it. */
  const slack = async (app, token, method, body = {}) => {
    const response = await fetch(`${app.api_base_url}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const page = async (cookie, path = "/slack") => {
    const response = await fetch(base + path, { redirect: "manual", headers: { cookie, accept: "text/html" } });
    return { status: response.status, html: await response.text(), headers: response.headers };
  };
  const mcp = async (token, name, args) => {
    const response = await fetch(base + "/slack/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    return { isError: result.isError, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  const restart = async () => { await workshop.close(); workshop = await startWorkshop({ ...options, port }); };
  return { base, enter, connect, register, slack, page, mcp, restart, form };
}

test("an app's bot messages a person who connected Slack, and only they see it", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const registered = await f.register({ bot_name: "Workbot" });
  assert.equal(registered.status, 201);
  const app = registered.body;
  assert.match(app.team_id, /^T[A-Z0-9]+$/);
  assert.match(app.bot_token, /^xoxb-open-workplace-/);
  assert.equal(app.api_base_url, `${f.base}/slack/teams/${app.team_id}/api`);
  assert.equal(typeof app.signing_secret, "string");

  const bot = await f.slack(app, app.bot_token, "auth.test");
  assert.deepEqual({ ok: bot.ok, team_id: bot.team_id, user_id: bot.user_id, bot_id: bot.bot_id }, { ok: true, team_id: app.team_id, user_id: app.bot_user_id, bot_id: app.bot_id });

  const alexBrowser = await f.enter(), samBrowser = await f.enter();
  const before = await f.page(alexBrowser);
  assert.equal(before.status, 200);
  assert.match(before.html, /Connect Slack in OpenWork from this browser/);
  assert.match(before.headers.get("content-security-policy"), /script-src 'self'/);

  // Connecting Slack and the app's first call with the person's token is what puts them in the app's workspace.
  const alexToken = await f.connect(alexBrowser);
  const alex = await f.slack(app, alexToken, "auth.test");
  assert.equal(alex.ok, true);
  assert.equal(alex.team_id, app.team_id);
  assert.equal(alex.bot_id, undefined, "a person is not a bot");
  assert.match(alex.user_id, /^U[A-Z0-9]+$/);
  assert.equal((await f.slack(app, alexToken, "auth.test")).user_id, alex.user_id, "the same person keeps the same Slack user");

  const opened = await f.slack(app, app.bot_token, "conversations.open", { users: alex.user_id });
  assert.equal(opened.ok, true);
  const channel = opened.channel.id;
  const sent = await f.slack(app, app.bot_token, "chat.postMessage", { channel, text: "*Morning brief*\nReview <https://example.com/doc?a=1&b=2|the pilot brief> before 10. <script>alert(1)</script>", unfurl_links: false });
  assert.equal(sent.ok, true);
  assert.match(sent.ts, /^\d+\.\d{6}$/);
  const link = await f.slack(app, app.bot_token, "chat.getPermalink", { channel, message_ts: sent.ts });
  assert.equal(link.permalink, `${f.base}/slack?team=${app.team_id}#m-${sent.ts}`);

  const shown = await f.page(alexBrowser);
  assert.match(shown.html, /<strong>Workbot<\/strong><span class="badge">APP<\/span>/);
  assert.match(shown.html, /<strong>Morning brief<\/strong><br>Review <a href="https:\/\/example\.com\/doc\?a=1&amp;b=2" target="_blank" rel="noreferrer noopener">the pilot brief<\/a>/);
  assert.ok(!shown.html.includes("<script>alert"), "message text never becomes markup");
  assert.match(shown.html, new RegExp(`id="m-${sent.ts.replace(".", "\\.")}"`));

  // Another browser is another person: nothing of Alex's, and the bot cannot reach someone who never connected.
  assert.match((await f.page(samBrowser)).html, /Connect Slack in OpenWork from this browser/);
  assert.equal((await f.slack(app, app.bot_token, "conversations.open", { users: "U0000000000" })).error, "user_not_found");

  // The person replies on their page; the app reads the conversation with its bot token, newest first.
  const reply = await fetch(f.base + "/slack/messages", { method: "POST", redirect: "manual", headers: { cookie: alexBrowser, origin: f.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ team: app.team_id, text: "I'll handle it after lunch" }) });
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get("location"), `/slack?team=${app.team_id}`);
  const forged = await fetch(f.base + "/slack/messages", { method: "POST", redirect: "manual", headers: { cookie: alexBrowser, origin: "https://elsewhere.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ team: app.team_id, text: "not mine" }) });
  assert.equal(forged.status, 403, "another site cannot post as the person");
  const history = await f.slack(app, app.bot_token, "conversations.history", { channel, limit: 20, oldest: "0" });
  assert.deepEqual(history.messages.map((message) => [message.text.slice(0, 16), message.user, Boolean(message.bot_id)]), [["I'll handle it a", alex.user_id, false], ["*Morning brief*\n", app.bot_user_id, true]]);

  // A reply in a thread is counted on its parent and read with conversations.replies.
  const threaded = await f.slack(app, app.bot_token, "chat.postMessage", { channel, text: "Noted.", thread_ts: history.messages[0].ts });
  assert.equal(threaded.ok, true);
  const parent = (await f.slack(app, app.bot_token, "conversations.history", { channel })).messages[0];
  assert.equal(parent.reply_count, 1);
  const replies = await f.slack(app, app.bot_token, "conversations.replies", { channel, ts: parent.ts });
  assert.deepEqual(replies.messages.map((message) => message.text), ["I'll handle it after lunch", "Noted."]);
  assert.equal((await f.slack(app, app.bot_token, "chat.postMessage", { channel, text: "x", thread_ts: "1.000001" })).error, "thread_not_found");

  // The person's own token reads their own conversation, and nothing else.
  assert.equal((await f.slack(app, alexToken, "conversations.history", { channel, limit: 1 })).ok, true);
  const samToken = await f.connect(samBrowser);
  const sam = await f.slack(app, samToken, "auth.test");
  assert.notEqual(sam.user_id, alex.user_id);
  assert.equal((await f.slack(app, samToken, "conversations.history", { channel })).error, "channel_not_found");
  assert.match((await f.page(samBrowser)).html, /No messages yet/);

  // Tokens stay where they were issued: another connector's token, another app's bot token, or none at all.
  const jiraToken = await f.connect(alexBrowser, "jira");
  assert.equal((await f.slack(app, jiraToken, "auth.test")).error, "invalid_auth");
  const other = (await f.register()).body;
  assert.notEqual(other.team_id, app.team_id);
  assert.equal((await f.slack(app, other.bot_token, "auth.test")).error, "invalid_auth");
  assert.equal((await f.slack(other, other.bot_token, "conversations.history", { channel })).error, "channel_not_found");
  assert.equal((await f.slack(other, other.bot_token, "conversations.open", { users: alex.user_id })).error, "user_not_found", "a person joins each workspace separately");
  assert.equal((await f.slack(app, "not-a-token", "auth.test")).error, "invalid_auth");
  assert.equal((await f.slack(app, app.bot_token, "admin.users.list")).error, "unknown_method");
  assert.equal((await fetch(f.base + "/slack/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

  // The Slack connector's tools work over the person's own conversations.
  const channels = await f.mcp(alexToken, "slack_search_channels", {});
  assert.deepEqual(channels.value.channels.map((entry) => [entry.channel_id, entry.name]), [[channel, "Workbot"]]);
  const read = await f.mcp(alexToken, "slack_read_channel", { channel_id: channel, limit: 1 });
  assert.equal(read.value.messages[0].text, "I'll handle it after lunch");
  const posted = await f.mcp(alexToken, "slack_send_message", { channel_id: channel, message: "On it." });
  assert.equal(posted.isError, false);
  assert.equal((await f.mcp(samToken, "slack_read_channel", { channel_id: channel })).isError, true, "another person's conversation is not found");

  // Messages and the link survive a restart; resetting sample data clears the messages and keeps the link.
  await f.restart();
  assert.match((await f.page(alexBrowser)).html, /On it\./);
  assert.equal((await f.slack(app, app.bot_token, "auth.test")).ok, true);
  const reset = await fetch(f.base + "/_workshop/reset", { method: "POST", redirect: "manual", headers: { cookie: alexBrowser, origin: f.base } });
  assert.equal(reset.status, 303);
  assert.match((await f.page(alexBrowser)).html, /No messages yet/);
  assert.equal((await f.slack(app, app.bot_token, "chat.postMessage", { channel, text: "Still linked" })).ok, true);
});

test("registering a sample Slack app is bounded and validated", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register({ bot_name: "<b>Workbot</b>" })).status, 400);
  assert.equal((await fetch(f.base + "/_workshop/slack/apps")).status, 405);
  assert.equal((await fetch(f.base + "/_workshop/slack/apps", { method: "POST", body: "bot_name=x" })).status, 415);
  const health = await (await fetch(f.base + "/health")).json();
  assert.equal(health.slack, true);
});

test("message text renders as Slack mrkdwn without becoming markup", () => {
  assert.equal(renderMrkdwn("a *b* _c_ ~d~ `e*f*`"), "a <strong>b</strong> <em>c</em> <s>d</s> <code>e*f*</code>");
  assert.equal(renderMrkdwn("<@U123> and <!here>", (id) => (id === "U123" ? "Jordan Reyes" : id)), '<span class="mention">@Jordan Reyes</span> and <span class="mention">@here</span>');
  assert.equal(renderMrkdwn("<javascript:alert(1)|x> <img src=x onerror=1>"), "&lt;javascript:alert(1)|x&gt; &lt;img src=x onerror=1&gt;");
  assert.equal(renderMrkdwn('<https://example.com/"onmouseover="x|label>'), '<a href="https://example.com/&quot;onmouseover=&quot;x" target="_blank" rel="noreferrer noopener">label</a>');
  assert.equal(renderMrkdwn("2 * 3 * 4"), "2 * 3 * 4");
});
