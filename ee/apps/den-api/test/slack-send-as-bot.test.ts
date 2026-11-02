import assert from "node:assert/strict"
import { describe, mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Hono } from "hono"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { WorkbotChannelPostDeps, WorkbotChannelPostResult } from "../src/slack-assistant/bot-post.js"
import type { WorkbotDirectMessageResult, WorkbotDirectMessageTarget, WorkbotSlackMember } from "../src/slack-assistant/direct-message.js"
import type { SlackSendAsBotDeps, SlackSendAsBotLimitStore, SlackSendAsBotToolResult } from "../src/mcp/slack-send-as-bot.js"
import type { ConnectToolView } from "../src/mcp/connect-tool-view.js"

// No database, Slack or network: every boundary is injected or faked below.
// The modules' default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/slack_send_as_bot_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-slack-send-as-bot-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-slack-send-as-bot-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()

const {
  CAPABILITY_SOURCES,
  capabilitySearchMatch,
  createCapabilityRegistryContext,
  executeCapability,
  slackSendAsBotAvailable,
} = await import("../src/mcp/capability-registry.js")
const { compareCapabilityMatches, searchCapabilitySourceFilter, tokenize } = await import("../src/mcp/search.js")
const { scoreExternalTool } = await import("../src/mcp/external-search-selection.js")
const { buildExternalCapabilityName } = await import("../src/mcp/external-capabilities.js")
const { loadConnectFullTools } = await import("../src/mcp/connect-full-tool-sources.js")
const { createAgentMcpServer } = await import("../src/mcp/agent-server.js")
const { SlackApiError } = await import("../src/slack-assistant/protocol.js")
const { postWorkbotChannelMessage, workbotAttributionLine } = await import("../src/slack-assistant/bot-post.js")
const {
  executeSlackSendAsBot,
  searchSlackSendAsBotCapability,
  SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA,
  SLACK_SEND_AS_BOT_CAPABILITY,
  SLACK_SEND_AS_BOT_SUMMARY,
} = await import("../src/mcp/slack-send-as-bot.js")

const noDatabase = () => {
  throw new Error("This test must not reach the database.")
}
mock.method(db, "select", noDatabase)
mock.method(db, "execute", noDatabase)
mock.method(db, "insert", noDatabase)
mock.method(db, "update", noDatabase)
mock.method(db, "delete", noDatabase)

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const connectionId = createDenTypeId("externalMcpConnection")
const member: WorkbotSlackMember = { ok: true, connectionId, slackUserId: "U0MEMBER" }
const NOW = Date.parse("2026-10-26T15:00:00Z")
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The rate_limit table's fixed windows (utils/rate-limit.ts), in memory. */
function memoryLimits() {
  const rows = new Map<string, { count: number; start: number }>()
  const wait = (row: { count: number; start: number }, max: number, windowMs: number, now: number) => {
    const remaining = row.start + windowMs - now
    return remaining > 0 && row.count >= max ? Math.max(1, Math.ceil(remaining / 1000)) : null
  }
  const store: SlackSendAsBotLimitStore = {
    peek: async (key, max, windowMs, now) => {
      const row = rows.get(key)
      return row ? wait(row, max, windowMs, now) : null
    },
    take: async (key, max, windowMs, now) => {
      const row = rows.get(key)
      if (!row || now - row.start >= windowMs) {
        rows.set(key, { count: 1, start: now })
        return null
      }
      const blocked = wait(row, max, windowMs, now)
      if (blocked !== null) return blocked
      row.count += 1
      return null
    },
    prune: async (prefix, windowMs, now) => {
      for (const [key, row] of rows) if (key.startsWith(prefix) && now - row.start >= windowMs) rows.delete(key)
    },
  }
  return { rows, store }
}

type SentMessage = { kind: "direct" | "channel"; member: WorkbotSlackMember; message: Record<string, unknown> }

function harness(options: {
  member?: WorkbotDirectMessageTarget
  direct?: WorkbotDirectMessageResult
  channel?: (message: { channelId: string; text: string; threadTs?: string }) => Promise<WorkbotChannelPostResult>
} = {}) {
  let clock = NOW
  let ts = 0
  const sent: SentMessage[] = []
  const limits = memoryLimits()
  const deps: SlackSendAsBotDeps = {
    resolveMember: async () => options.member ?? member,
    sendDirect: async (target, message) => {
      sent.push({ kind: "direct", member: target, message })
      return options.direct ?? { ok: true, channelId: "D0DM", messageTs: `1700000000.${String(++ts).padStart(6, "0")}` }
    },
    postChannel: async (target, message) => {
      sent.push({ kind: "channel", member: target, message })
      return options.channel ? options.channel(message) : { ok: true, channelId: message.channelId, messageTs: `1700000000.${String(++ts).padStart(6, "0")}` }
    },
    limits: limits.store,
    now: () => clock,
  }
  return { deps, sent, limits, advance: (ms: number) => { clock += ms } }
}

function send(body: unknown, deps: SlackSendAsBotDeps, access: { memberId?: DenTypeId<"member"> | null; hasWriteScope?: boolean } = {}) {
  return executeSlackSendAsBot({ organizationId, userId, memberId, hasWriteScope: true, ...access, body }, deps)
}

function payload(result: SlackSendAsBotToolResult) {
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent)
  return result.structuredContent
}

function refused(result: SlackSendAsBotToolResult, error: string, message?: string | RegExp) {
  assert.equal(result.isError, true)
  const body = payload(result)
  assert.equal(body.sent, false)
  assert.equal(body.error, error)
  if (typeof message === "string") assert.equal(body.message, message)
  else if (message) assert.match(String(body.message), message)
  return body
}

/** Fake Slack for the real channel helper: records calls, answers like Slack. */
function slackChannel(input: { fail?: string; access?: boolean | null; permalink?: boolean } = {}) {
  const calls: { token: string; method: string; body: Record<string, unknown> }[] = []
  const deps: WorkbotChannelPostDeps = {
    installations: async () => [{ connectionId, teamId: "T1" }],
    linkedSlackUser: async () => "U0MEMBER",
    botToken: async () => "xoxb-bot",
    memberCanReadChannel: async () => input.access === undefined ? true : input.access,
    slack: (token) => async (method, body) => {
      calls.push({ token, method, body })
      if (method === "chat.postMessage") {
        if (input.fail) throw new SlackApiError(input.fail, input.fail === "ratelimited" ? 30_000 : 0)
        return { ok: true, channel: body.channel, ts: "1700000000.000100" }
      }
      if (method === "chat.getPermalink") {
        if (input.permalink === false) throw new SlackApiError("message_not_found")
        return { ok: true, permalink: "https://example.slack.com/archives/C0TEAMROOM/p1700000000000100" }
      }
      return { ok: true }
    },
  }
  return { deps, calls }
}

describe("slack_send_as_bot targets", () => {
  test("me: a DM to the caller from the OpenWork app, optionally in a thread", async () => {
    const run = harness()
    const result = await send({ target: "me", text: "The export finished." }, run.deps)
    assert.equal(result.isError, undefined)
    assert.deepEqual(payload(result), {
      sent: true, target: "me", channelId: "D0DM", messageTs: "1700000000.000001", message: "Sent to you as a DM from the OpenWork app.",
    })
    assert.deepEqual(run.sent, [{ kind: "direct", member, message: { text: "The export finished." } }])

    await send({ target: "me", text: "Second part.", threadTs: "1700000000.000001" }, run.deps)
    assert.deepEqual(run.sent[1]?.message, { text: "Second part.", threadTs: "1700000000.000001" })
  })

  test("channel: a post in the channel, with its permalink", async () => {
    const run = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel().deps) })
    const result = await send({ target: "channel", channelId: "C0TEAMROOM", text: "Weekly numbers are in.", threadTs: "1700000000.000050" }, run.deps)
    assert.deepEqual(payload(result), {
      sent: true,
      target: "channel",
      channelId: "C0TEAMROOM",
      messageTs: "1700000000.000100",
      permalink: "https://example.slack.com/archives/C0TEAMROOM/p1700000000000100",
      message: "Posted in the channel from the OpenWork app, credited to your agent.",
    })
    assert.deepEqual(run.sent[0]?.message, { channelId: "C0TEAMROOM", text: "Weekly numbers are in.", threadTs: "1700000000.000050" })
  })

  test("no DMs to anyone else, no channel names: a sentence says why, and nothing is sent or counted", async () => {
    const run = harness()
    const other = /only messages you \(target "me"\) or posts in a channel .* can't DM other people; to message someone as yourself, use slack_send_message/
    refused(await send({ target: "user", text: "hi" }, run.deps), "invalid_target", other)
    refused(await send({ target: "U0SOMEONE", text: "hi" }, run.deps), "invalid_target", other)
    refused(await send({ target: "channel", channelId: "D0THEIRDM", text: "hi" }, run.deps), "invalid_target", other)
    refused(await send({ target: "channel", channelId: "U0SOMEONE", text: "hi" }, run.deps), "invalid_target", other)
    refused(await send({ target: "channel", channelId: "#general", text: "hi" }, run.deps), "invalid_target", /must be a Slack channel ID such as C0123ABCD, not a #name/)
    refused(await send({ target: "channel", text: "hi" }, run.deps), "invalid_target", /needs channelId/)
    refused(await send({ target: "me", channelId: "C0TEAMROOM", text: "hi" }, run.deps), "invalid_target", /channelId only goes with target "channel"/)
    const invalid = refused(await send({ target: "me", user: "U0SOMEONE", text: "hi" }, run.deps), "invalid_capability_arguments")
    assert.ok(Array.isArray(invalid.issues))
    refused(await send({ target: "me", text: "   " }, run.deps), "invalid_capability_arguments")
    refused(await send({ target: "me", text: "x".repeat(4_001) }, run.deps), "invalid_capability_arguments")
    refused(await send({ target: "me", text: "hi", threadTs: "yesterday" }, run.deps), "invalid_capability_arguments")
    assert.equal(run.sent.length, 0)
    assert.equal(run.limits.rows.size, 0)
  })

  test("accepts arguments sent as a JSON string, as execute_capability bodies sometimes are", async () => {
    const run = harness()
    assert.equal(payload(await send(JSON.stringify({ target: "me", text: "String body." }), run.deps)).sent, true)
  })
})

describe("slack_send_as_bot limits", () => {
  test("a member's daily cap: the 21st message in a day is refused with the count", async () => {
    const run = harness()
    for (let index = 1; index <= 20; index += 1) {
      assert.equal(payload(await send({ target: "me", text: `Update ${index}` }, run.deps)).sent, true, `message ${index}`)
      run.advance(13_000)
    }
    refused(await send({ target: "me", text: "Update 21" }, run.deps), "daily_limit_reached", "Not sent: daily limit reached (20/20).")
    assert.equal(run.sent.length, 20)
    run.advance(DAY)
    assert.equal(payload(await send({ target: "me", text: "Update 21" }, run.deps)).sent, true)
  })

  test("the same text to the same place within 24 hours is refused; elsewhere, later, or after a failed send it goes", async () => {
    const run = harness()
    assert.equal(payload(await send({ target: "me", text: "Build is green." }, run.deps)).sent, true)
    run.advance(MINUTE)
    refused(await send({ target: "me", text: "Build is green." }, run.deps), "duplicate_message", "Not sent: the same message already went there in the last 24 hours.")
    refused(await send({ target: "me", text: "  Build is green.  " }, run.deps), "duplicate_message")
    assert.equal(payload(await send({ target: "channel", channelId: "C0TEAMROOM", text: "Build is green." }, run.deps)).sent, true)
    assert.equal(payload(await send({ target: "me", text: "Build is green.", threadTs: "1700000000.000001" }, run.deps)).sent, true)
    run.advance(DAY)
    assert.equal(payload(await send({ target: "me", text: "Build is green." }, run.deps)).sent, true)
    // Expired same-message records are forgotten after a send; the live ones stay.
    assert.equal([...run.limits.rows.keys()].filter((key) => key.includes(":same:")).length, 1)

    const failing = harness({ channel: async () => ({ ok: false, reason: "bot_not_in_channel", code: "not_in_channel" }) })
    refused(await send({ target: "channel", channelId: "C0TEAMROOM", text: "Deploy done." }, failing.deps), "bot_not_in_channel")
    refused(await send({ target: "channel", channelId: "C0TEAMROOM", text: "Deploy done." }, failing.deps), "bot_not_in_channel")
  })

  test("a burst limit of five a minute, which spends nothing of the daily cap", async () => {
    const run = harness()
    for (let index = 1; index <= 5; index += 1) assert.equal(payload(await send({ target: "me", text: `Step ${index}` }, run.deps)).sent, true)
    const body = refused(await send({ target: "me", text: "Step 6" }, run.deps), "rate_limited", "Not sent: too many messages in a minute (5/5). Try again in 60 seconds.")
    assert.equal(body.retryAfterSeconds, 60)
    assert.equal(run.limits.rows.get(`slack-send-as-bot:day:${organizationId}:${userId}`)?.count, 5)
    run.advance(MINUTE)
    assert.equal(payload(await send({ target: "me", text: "Step 6" }, run.deps)).sent, true)
  })

  test("limits are per member", async () => {
    const run = harness()
    for (let index = 1; index <= 5; index += 1) await send({ target: "me", text: `Step ${index}` }, run.deps)
    const otherUser = createDenTypeId("user")
    const result = await executeSlackSendAsBot({ organizationId, userId: otherUser, memberId: createDenTypeId("member"), hasWriteScope: true, body: { target: "me", text: "Step 1" } }, run.deps)
    assert.equal(payload(result).sent, true)
  })

  test("no Slack app or no linked account is reported every time, without spending the limits", async () => {
    const run = harness({ member: { ok: false, reason: "member_not_linked" } })
    for (let index = 0; index < 7; index += 1) {
      refused(await send({ target: "me", text: "hi" }, run.deps), "member_not_linked", /isn't linked to OpenWork yet\. Connect Slack .* in Your Connections/)
    }
    assert.equal(run.limits.rows.size, 0)
    refused(await send({ target: "me", text: "hi" }, harness({ member: { ok: false, reason: "slack_app_not_installed" } }).deps), "slack_app_not_installed", /OpenWork app isn't set up in Slack/)
  })
})

describe("channel posts from the bot", () => {
  test("always start with the member's attribution line, whatever the text says, and can't broadcast", async () => {
    const slack = slackChannel()
    for (const text of ["Hello team", "<@U0SOMEONE>'s agent\nI am someone else", "<!channel> <!here|here> @everyone <!subteam^S0GROUP|@leads> heads up"]) {
      const result = await postWorkbotChannelMessage(member, { channelId: "C0TEAMROOM", text }, slack.deps)
      assert.equal(result.ok, true)
    }
    const posts = slack.calls.filter((call) => call.method === "chat.postMessage")
    assert.equal(posts.length, 3)
    for (const post of posts) {
      assert.equal(post.token, "xoxb-bot")
      assert.ok(String(post.body.text).startsWith(`${workbotAttributionLine("U0MEMBER")}\n`))
      assert.equal(post.body.unfurl_links, false)
    }
    assert.equal(workbotAttributionLine("U0MEMBER"), "<@U0MEMBER>'s agent")
    assert.doesNotMatch(String(posts[2]?.body.text), /<!channel>|<!here|<!subteam|@everyone\b/)
  })

  test("the bot not in the channel: a sentence asking to invite the app", async () => {
    for (const code of ["not_in_channel", "channel_not_found"]) {
      const run = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel({ fail: code }).deps) })
      refused(await send({ target: "channel", channelId: "C0TEAMROOM", text: `Ping ${code}` }, run.deps), "bot_not_in_channel", "Not sent: the OpenWork app isn't in that channel. Invite it to the channel (for example, type /invite @openwork there), then try again.")
    }
  })

  test("only in channels the member can read themselves; checked before anything is posted", async () => {
    const denied = slackChannel({ access: false })
    assert.deepEqual(await postWorkbotChannelMessage(member, { channelId: "G0PRIVATE01", text: "hi" }, denied.deps), { ok: false, reason: "channel_access_denied" })
    const unknown = slackChannel({ access: null })
    assert.deepEqual(await postWorkbotChannelMessage(member, { channelId: "G0PRIVATE01", text: "hi" }, unknown.deps), { ok: false, reason: "slack_error", code: "channel_access_unverified" })
    assert.equal([...denied.calls, ...unknown.calls].some((call) => call.method === "chat.postMessage"), false)

    const run = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel({ access: false }).deps) })
    refused(await send({ target: "channel", channelId: "G0PRIVATE01", text: "hi" }, run.deps), "channel_access_denied", "Not sent: you can't see that channel in Slack, so OpenWork won't post there for you.")
    const unverified = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel({ access: null }).deps) })
    refused(await send({ target: "channel", channelId: "G0PRIVATE01", text: "hi" }, unverified.deps), "slack_error", /couldn't confirm you can see that channel/)
  })

  test("Slack errors, a missing bot token and a missing permalink", async () => {
    const limited = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel({ fail: "ratelimited" }).deps) })
    const body = refused(await send({ target: "channel", channelId: "C0TEAMROOM", text: "hi" }, limited.deps), "slack_error", "Not sent: Slack returned an error (ratelimited). Try again in 30 seconds.")
    assert.equal(body.code, "ratelimited")

    const archived = harness({ channel: (message) => postWorkbotChannelMessage(member, message, slackChannel({ fail: "is_archived" }).deps) })
    refused(await send({ target: "channel", channelId: "C0TEAMROOM", text: "hi" }, archived.deps), "slack_error", "Not sent: Slack returned an error (is_archived).")

    const noToken = { ...slackChannel().deps, botToken: async () => null }
    assert.deepEqual(await postWorkbotChannelMessage(member, { channelId: "C0TEAMROOM", text: "hi" }, noToken), { ok: false, reason: "slack_app_not_installed" })

    const noLink = await postWorkbotChannelMessage(member, { channelId: "C0TEAMROOM", text: "hi" }, slackChannel({ permalink: false }).deps)
    assert.deepEqual(noLink, { ok: true, channelId: "C0TEAMROOM", messageTs: "1700000000.000100" })

    const dmFailed = harness({ direct: { ok: false, reason: "slack_error", code: "messages_tab_disabled" } })
    refused(await send({ target: "me", text: "hi" }, dmFailed.deps), "slack_error", "Not sent: Slack returned an error (messages_tab_disabled).")
  })
})

describe("routing: who a Slack message comes from", () => {
  // The Slack connection's tools as Slack's MCP server describes them (trimmed; the member's user id replaced).
  const slackTools = [
    { name: "slack_send_message", description: "Sends a message to a Slack channel or user. To DM a user, use their user_id as channel_id. If the user wants to send a message to themselves, the current logged in user's user_id is U0EXAMPLE. Return the message link to the user. Thread replies: set thread_ts to parent message timestamp, reply_broadcast=true to also post to channel. Use slack_search_channels to find channel IDs, slack_search_users to find user IDs. If user has not reviewed the message, use slack_send_message_draft instead." },
    { name: "slack_schedule_message", description: "Schedules a message for future delivery to a Slack channel. Does NOT send immediately — use slack_send_message for that." },
    { name: "slack_send_message_draft", description: "Creates a draft message in a Slack channel. The draft is saved to the user's \"Drafts & Sent\" in Slack without sending it." },
    { name: "slack_read_channel", description: "Reads messages from a Slack channel in reverse chronological order (newest first). To read DM history, use a user_id as channel_id. Read-only." },
    { name: "slack_search_public", description: "Searches for messages, files in public Slack channels ONLY." },
    { name: "slack_create_conversation", description: "Create a channel, DM, or group DM. Returns a channel_id for use with slack_send_message, slack_send_message_draft, or slack_schedule_message." },
  ]
  const sendAsUser = buildExternalCapabilityName("emc_slack", "slack_send_message")

  /** Capability names best first, scored and ordered the way search_capabilities merges a Slack probe with this source. */
  function ranked(query: string) {
    const queryTokens = tokenize(query)
    const external = slackTools.map((tool) => ({
      name: buildExternalCapabilityName("emc_slack", tool.name), method: "MCP", path: tool.name, score: scoreExternalTool("Slack", tool, queryTokens),
      summary: tool.description, pathParams: [], queryParams: [], hasBody: true,
    }))
    return [...external, ...searchSlackSendAsBotCapability(query)].filter((match) => match.score > 0).sort(compareCapabilityMatches).map((match) => match.name)
  }

  test("asking for something sent to themselves ranks slack_send_as_bot first, above slack_send_message", () => {
    for (const query of [
      "send me the summary on Slack", "notify me on Slack", "notify myself on Slack", "DM me", "ping me when it's done",
      "message me on Slack", "remind me on Slack", "every morning send me the summary on Slack", "let me know on Slack when it's done",
      "send a Slack DM to myself", "notify me",
    ]) {
      const names = ranked(query)
      assert.equal(names[0], SLACK_SEND_AS_BOT_CAPABILITY, query)
      if (names.includes(sendAsUser)) assert.ok(names.indexOf(SLACK_SEND_AS_BOT_CAPABILITY) < names.indexOf(sendAsUser), query)
    }
  })

  test("posting as themselves, or to someone else, keeps slack_send_message first", () => {
    for (const query of ["post this in #team as me", "reply to my teammate as me", "send it from me in #team"]) {
      const names = ranked(query)
      assert.equal(names[0], sendAsUser, query)
      assert.equal(names.includes(SLACK_SEND_AS_BOT_CAPABILITY), false, query)
    }
    for (const query of ["DM my teammate on Slack", "send a slack message", "slack send message"]) {
      const names = ranked(query)
      assert.ok(names.indexOf(sendAsUser) < names.indexOf(SLACK_SEND_AS_BOT_CAPABILITY), query)
    }
  })

  test("\"me\" alone, reading Slack, or another channel gets no boost", () => {
    assert.deepEqual(searchSlackSendAsBotCapability("show me my calendar"), [])
    assert.notEqual(ranked("show me my slack messages")[0], SLACK_SEND_AS_BOT_CAPABILITY)
    const boosted = searchSlackSendAsBotCapability("notify me on Slack")[0]?.score ?? 0
    const byEmail = searchSlackSendAsBotCapability("notify me by email")[0]?.score ?? 0
    assert.ok(byEmail < 6 && boosted > byEmail * 4, `${byEmail} vs ${boosted}`)
  })
})

function registryContext(input: { scopes: string[]; member?: boolean }) {
  return createCapabilityRegistryContext({
    app: new Hono(),
    env: undefined,
    catalog: [],
    principal: { userId, organizationId, scopes: new Set(input.scopes), payload: {} },
    organizationId,
    member: input.member === false ? null : { orgMembershipId: createDenTypeId("member"), teamIds: [] },
    redirectUriBase: "http://unit.test",
    generatedArtifactViewsEnabled: false,
    organizationFeatures: {},
    usageSource: "agent",
  })
}

async function searchSource(context: ReturnType<typeof registryContext>, query: string, type: "all" | "api" | "mcp" | "skills" = "all") {
  return CAPABILITY_SOURCES.slackSendAsBot.search({ ...context, sourceFilter: searchCapabilitySourceFilter(type), reportExternalCoverage: () => undefined }, query, 5)
}

function resultText(result: { content: { type: string; text?: string }[] }) {
  return result.content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n")
}

describe("slack_send_as_bot on the gateway", () => {
  const writer = ["mcp:read", "mcp:write"]

  test("found next to the Slack tools, with its own arguments and the description about who it comes from", async () => {
    const context = registryContext({ scopes: writer })
    for (const query of ["slack send message", "ping me on slack", "notify me", SLACK_SEND_AS_BOT_CAPABILITY]) {
      const [match] = await searchSource(context, query)
      assert.equal(match?.name, SLACK_SEND_AS_BOT_CAPABILITY, query)
    }
    assert.deepEqual(await searchSource(context, "slack send message", "mcp").then((matches) => matches.map((match) => match.name)), [SLACK_SEND_AS_BOT_CAPABILITY])
    assert.deepEqual(await searchSource(context, "slack send message", "skills"), [])
    assert.deepEqual(searchSlackSendAsBotCapability("quarterly revenue spreadsheet"), [])

    const [match] = searchSlackSendAsBotCapability("slack send message")
    assert.ok(match)
    assert.equal(match.summary, SLACK_SEND_AS_BOT_SUMMARY)
    assert.ok(match.summary.startsWith("Send a Slack message as the OpenWork bot instead of as you, so the user gets a real Slack notification."))
    for (const phrase of ["Use target me", "\"send me…\"", "\"DM me\"", "\"notify me\"", "\"ping me when it's done\"", "\"remind me\"", "also in Automations", "To post as the user (\"as me\"), use slack_send_message"]) {
      assert.ok(match.summary.includes(phrase), phrase)
    }
    const tool = capabilitySearchMatch(match)
    assert.deepEqual(tool.inputSchema, SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA)
    assert.deepEqual(tool.annotations, { readOnlyHint: false })
    // Never read as a Den API operation, which would take path/query/body.
    assert.equal(CAPABILITY_SOURCES.catalog.parseName(SLACK_SEND_AS_BOT_CAPABILITY), null)
  })

  test("read-only tokens never see or run it, so Your agent's background turns can't send", async () => {
    const reader = registryContext({ scopes: ["mcp:read"] })
    assert.equal(slackSendAsBotAvailable(reader), false)
    assert.deepEqual(await searchSource(reader, "slack send message"), [])
    const result = await executeCapability(reader, { name: SLACK_SEND_AS_BOT_CAPABILITY, arguments: { target: "me", text: "hi" } })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(resultText(result)).error, "insufficient_mcp_scope")
    assert.equal(JSON.parse(resultText(result)).requiredScope, "mcp:write")

    const notMember = registryContext({ scopes: writer, member: false })
    assert.equal(slackSendAsBotAvailable(notMember), false)
    assert.deepEqual(await searchSource(notMember, "slack send message"), [])
    assert.equal(JSON.parse(resultText(await executeCapability(notMember, { name: SLACK_SEND_AS_BOT_CAPABILITY, arguments: { target: "me", text: "hi" } }))).error, "membership_required")

    assert.equal(slackSendAsBotAvailable(registryContext({ scopes: writer })), true)
  })

  test("the full tool view lists it as openwork-bot.slack_send_as_bot, only while it is available", async () => {
    const emptyNamespaces = async () => ({
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: { native: new Map<string, string>(), externalMcp: new Map<string, string>() },
    })
    async function listed(context: ReturnType<typeof registryContext>) {
      const loaded = await loadConnectFullTools({
        ctx: { ...context, resolveNamespaceContext: emptyNamespaces },
        scope: { namespaces: new Set(["openwork-bot"]) },
        apps: async () => [],
        execute: async () => ({ content: [] }),
      })
      return loaded.tools
    }
    const [tool, ...rest] = await listed(registryContext({ scopes: writer }))
    assert.equal(rest.length, 0)
    assert.equal(tool?.name, "openwork-bot.slack_send_as_bot")
    assert.equal(tool?.capability, SLACK_SEND_AS_BOT_CAPABILITY)
    assert.equal(tool?.description, SLACK_SEND_AS_BOT_SUMMARY)
    assert.deepEqual(tool?.inputSchema, SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA)
    assert.deepEqual(await listed(registryContext({ scopes: ["mcp:read"] })), [])
  })

  test("not in Code Mode scripts", async () => {
    const leaves = await CAPABILITY_SOURCES.slackSendAsBot.enumerate(registryContext({ scopes: writer }))
    assert.deepEqual(leaves, [])
  })

  test("agents are told when to use it instead of slack_send_message, only while it is available", async () => {
    async function instructions(options: { canSendSlackMessages?: boolean; toolView?: ConnectToolView }) {
      const server = createAgentMcpServer({ remoteSessionStatus: true, ...options })
      const client = new Client({ name: "slack-send-as-bot-unit-test", version: "1" })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      try {
        await client.connect(clientTransport)
        return client.getInstructions() ?? ""
      } finally {
        await client.close()
        await server.close()
      }
    }
    const search = await instructions({ canSendSlackMessages: true })
    assert.match(search, /To notify the user or "send me" something on Slack \(DM me, ping me, remind me, let me know; also in Automations and their instructions\), use slack_send_as_bot with target me; slack_send_message posts as the user and does not notify them, so use it only to post as the user\./)
    const full = await instructions({ canSendSlackMessages: true, toolView: "full" })
    assert.match(full, /use openwork-bot\.slack_send_as_bot with target me;/)
    for (const text of [search, full]) assert.ok(Buffer.byteLength(text, "utf8") <= 2048)
    assert.doesNotMatch(await instructions({}), /slack_send_as_bot/)
  })
})
