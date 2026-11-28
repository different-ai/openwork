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
  assert.equal(renderMrkdwn("R&amp;D &lt;@U123&gt; &lt;!here&gt; &lt;https://example.com|x&gt;", () => "Jordan"), "R&amp;D &lt;@U123&gt; &lt;!here&gt; &lt;https://example.com|x&gt;");
  assert.equal(renderMrkdwn("Table:\n```\na | *b*\n1 | <2>\n```\nDone"), "Table:<br><pre>a | *b*\n1 | &lt;2&gt;</pre><br>Done");
});

test("a bot's blocks are checked against Slack's limits and drawn on the person's page", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const app = (await f.register()).body;
  const browser = await f.enter();
  const person = await f.slack(app, await f.connect(browser), "auth.test");
  const channel = (await f.slack(app, app.bot_token, "conversations.open", { users: person.user_id })).channel.id;
  const post = (body) => f.slack(app, app.bot_token, "chat.postMessage", { channel, text: "Open issues this week", ...body });
  const raw = (text) => ({ type: "raw_text", text });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Open issues <b>", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "*Three* need you. <script>x</script>" } },
    { type: "section", fields: [{ type: "mrkdwn", text: "*Owner*\nDana" }, { type: "mrkdwn", text: "*Due*\nFriday" }] },
    { type: "table", column_settings: [{ align: "left" }, { align: "right" }], rows: [[raw("Issue"), raw("Days")], [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://example.com/1", text: "ENG-1" }] }] }, raw("9")]] },
    { type: "divider" },
    { type: "markdown", text: "**Next**\n\n- one\n- [two](https://example.com/2)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" },
    { type: "image", image_url: "https://example.com/chart.png", alt_text: "Signups by week" },
    { type: "context", elements: [{ type: "mrkdwn", text: "From Linear, read just now" }] },
    { type: "actions", block_id: "openwork_link:1", elements: [{ type: "button", action_id: "openwork_link:0", text: { type: "plain_text", text: "Open the board" }, url: "https://example.com/board" }] },
    { type: "actions", block_id: "openwork_choice:U1", elements: [{ type: "button", action_id: "openwork_choice:0", text: { type: "plain_text", text: "Send it" }, value: "Send it" }] },
  ];
  const sent = await post({ blocks });
  assert.equal(sent.ok, true, sent.error);
  assert.deepEqual((await f.slack(app, app.bot_token, "conversations.history", { channel, oldest: "0" })).messages[0].blocks, blocks);

  const { html } = await f.page(browser);
  assert.match(html, /<div class="bk-header">Open issues &lt;b&gt;<\/div>/);
  assert.match(html, /<strong>Three<\/strong> need you\. &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /<div class="bk-fields"><div><strong>Owner<\/strong><br>Dana<\/div><div><strong>Due<\/strong><br>Friday<\/div><\/div>/);
  assert.match(html, /<th style="text-align:right;white-space:nowrap">Days<\/th>/);
  assert.match(html, /<td style="text-align:left;white-space:nowrap"><a href="https:\/\/example\.com\/1" target="_blank" rel="noreferrer noopener">ENG-1<\/a><\/td>/);
  assert.match(html, /<hr class="bk-divider">/);
  assert.match(html, /<ul><li>one<\/li><li><a href="https:\/\/example\.com\/2" target="_blank" rel="noreferrer noopener">two<\/a><\/li><\/ul>/);
  assert.match(html, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(html, /aria-label="Image: Signups by week"/);
  assert.ok(!html.includes("<img"), "the sandbox never loads an image from elsewhere");
  assert.match(html, /<div class="bk-context"><span>From Linear, read just now<\/span><\/div>/);
  assert.match(html, /<a class="bk-button" href="https:\/\/example\.com\/board" target="_blank" rel="noreferrer noopener">Open the board<\/a>/);
  assert.match(html, /<button type="button" class="bk-button" aria-disabled="true"[^>]*>Send it<\/button>/);
  assert.ok(!html.includes("<script>x"), "block text never becomes markup");

  // What Slack refuses is refused here, with Slack's error names.
  const error = async (value) => (await post({ blocks: value })).error;
  assert.equal(await error("not json"), "invalid_blocks_format");
  assert.equal(await error({ type: "section" }), "invalid_blocks_format");
  assert.equal(await error([{ type: "marquee", text: "x" }]), "invalid_blocks");
  assert.equal(await error([{ type: "header", text: { type: "plain_text", text: "x".repeat(151) } }]), "invalid_blocks");
  assert.equal(await error([{ type: "header", text: { type: "mrkdwn", text: "x" } }]), "invalid_blocks");
  assert.equal(await error([{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3001) } }]), "invalid_blocks");
  assert.equal(await error([{ type: "section", fields: Array.from({ length: 11 }, () => ({ type: "mrkdwn", text: "x" })) }]), "invalid_blocks");
  assert.equal(await error(Array.from({ length: 51 }, () => ({ type: "divider" }))), "invalid_blocks");
  assert.equal(await error([{ type: "table", rows: [Array.from({ length: 21 }, () => raw("x"))] }]), "invalid_blocks");
  assert.equal(await error([{ type: "table", rows: Array.from({ length: 101 }, () => [raw("x")]) }]), "invalid_blocks");
  assert.equal(await error([{ type: "table", rows: [[raw("")]] }]), "invalid_blocks");
  assert.equal(await error([{ type: "table", rows: Array.from({ length: 11 }, () => [raw("x".repeat(1000))]) }]), "msg_blocks_too_long");
  assert.equal(await error([{ type: "markdown", text: "x".repeat(7000) }, { type: "markdown", text: "x".repeat(7000) }]), "msg_blocks_too_long");
  assert.equal(await error([{ type: "image", image_url: "javascript:alert(1)", alt_text: "x" }]), "invalid_blocks");
  assert.equal(await error([{ type: "image", image_url: "https://example.com/a.png" }]), "invalid_blocks");
  assert.equal(await error([{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "x".repeat(76) }, url: "https://example.com" }] }]), "invalid_blocks");
  assert.equal(await error([{ type: "actions", elements: [{ type: "button", action_id: "a", text: { type: "plain_text", text: "x" } }, { type: "button", action_id: "a", text: { type: "plain_text", text: "y" } }] }]), "invalid_blocks");
  assert.equal(await error([{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "x" }, url: "javascript:alert(1)" }] }]), "invalid_blocks");
  assert.equal((await f.slack(app, app.bot_token, "conversations.history", { channel, oldest: "0" })).messages.length, 1, "a refused message is not stored");

  // An update replaces the blocks; new text alone removes them, as in Slack.
  const updated = await f.slack(app, app.bot_token, "chat.update", { channel, ts: sent.ts, text: "Chosen", blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "<@" + person.user_id + "> chose *Send it*" }] }] });
  assert.equal(updated.ok, true, updated.error);
  const after = (await f.page(browser)).html;
  assert.match(after, /<span class="mention">@[^<]+<\/span> chose <strong>Send it<\/strong>/);
  assert.ok(!after.includes("<div class=\"bk-header\">"));
  assert.equal((await f.slack(app, app.bot_token, "chat.update", { channel, ts: sent.ts, blocks: [{ type: "marquee" }] })).error, "invalid_blocks");
  assert.equal((await f.slack(app, app.bot_token, "chat.update", { channel, ts: sent.ts, text: "Plain again" })).ok, true);
  assert.equal((await f.slack(app, app.bot_token, "conversations.history", { channel, oldest: "0" })).messages[0].blocks, undefined);
});
