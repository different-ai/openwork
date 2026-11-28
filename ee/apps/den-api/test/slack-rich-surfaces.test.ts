import assert from "node:assert/strict"
import { test } from "node:test"
import type { SlackSendAsBotDeps } from "../src/mcp/slack-send-as-bot.js"
import type { SlackChoiceDeps, SlackChoiceInstallation } from "../src/slack-assistant/choice.js"
import { desktopHandoffMessage, desktopHandoffRichMessages } from "../src/slack-assistant/desktop-handoff-messages.js"
import { SlackApiError, slackWorkbotInstructions, type SlackEvent } from "../src/slack-assistant/protocol.js"
import { slackBlockProblems, type SlackOutgoingMessage } from "../src/slack-assistant/rich-message.js"
import { advanceSlackRun, advanceSlackWatch, checkpointSchema, STREAM_CHARACTER_LIMIT } from "../src/slack-assistant/run.js"
import { agentBriefParts, agentNoticeParts } from "../src/workbot-proactive/slack-layout.js"
import { fakeRunner, fakeSlack, idle, runToEnd, snapshot } from "./slack-fakes.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/slack_rich_surfaces_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-slack-rich-surfaces-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-slack-rich-surfaces-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"

const { executeSlackSendAsBot, searchSlackSendAsBotCapability } = await import("../src/mcp/slack-send-as-bot.js")
const { postWorkbotChannelMessage } = await import("../src/slack-assistant/bot-post.js")
const { settleSlackChoice, slackChoicePress, slackInteractionSchema } = await import("../src/slack-assistant/choice.js")
const { sendWorkbotDirectMessageTo } = await import("../src/slack-assistant/direct-message.js")
const { deliverAgentMessage } = await import("../src/workbot-proactive/deliver.js")

/** Every place the OpenWork app writes to Slack, with the feature on and off. */

const options = { places: { automations: "https://app.example.com/dashboard/automations" }, imageUrl: () => null }
const blocksOf = (body: Record<string, unknown> | undefined) => (Array.isArray(body?.blocks) ? body.blocks : [])
const typesOf = (body: Record<string, unknown> | undefined) => blocksOf(body).map((block: { type?: unknown }) => block.type)
const posts = (slack: ReturnType<typeof fakeSlack>) => slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body)

const ANSWER = [
  "# Pipeline by stage",
  "Two deals moved this week.",
  "",
  "| Stage | Deals | Value |",
  "| --- | ---: | ---: |",
  "| Proposal | 4 | $82,000 |",
  "| Won | 2 | $31,500 |",
  "",
  "```slack",
  '[{"type":"context","text":"From the CRM, read just now"},{"type":"choices","prompt":"Post this in #sales?","options":["Post it","Not now"]}]',
  "```",
].join("\n")

const finishing = (extra: Record<string, unknown> = {}) =>
  checkpointSchema.parse({ phase: "finish", channel: "C1", threadTs: "10.1", workbot: true, answerReply: true, answerText: ANSWER, recipientUserId: "U0MEMBER", startedAt: Date.now(), ...extra })

test("an answer with the feature on posts real components, feedback on the content, and the question as its own message", async () => {
  const slack = fakeSlack()
  const { runner } = fakeRunner()
  const result = await advanceSlackRun({ checkpoint: finishing({ rich: true }), runner, slack: slack.slack, messageId: "msg_e1", saveSession: async () => {}, clearSession: async () => {}, title: "t", richOptions: options })
  const [content, choice, ...rest] = posts(slack)
  assert.equal(rest.length, 0)
  assert.deepEqual(typesOf(content), ["header", "markdown", "table", "context", "context_actions"])
  assert.deepEqual(typesOf(choice), ["section", "actions"])
  assert.deepEqual(slackBlockProblems(blocksOf(content).slice(0, -1)), [])
  assert.deepEqual(slackBlockProblems(blocksOf(choice)), [])
  assert.equal(content?.text, "*Pipeline by stage*\n\nTwo deals moved this week.\n\n*Stage · Deals · Value*\n• Proposal · 4 · $82,000\n• Won · 2 · $31,500\n\nFrom the CRM, read just now")
  assert.equal(content?.thread_ts, "10.1")
  assert.equal(content?.unfurl_links, false)
  assert.equal(JSON.stringify(choice).includes("openwork_choice:U0MEMBER"), true)
  assert.equal(result.checkpoint.answerPartsPosted, 2)
})

test("with the feature off the same answer is sent exactly as before: one Markdown block and a short notification", async () => {
  for (const checkpoint of [finishing(), finishing({ rich: true })]) {
    const slack = fakeSlack()
    const { runner } = fakeRunner()
    await advanceSlackRun({ checkpoint, runner, slack: slack.slack, messageId: "msg_e1", saveSession: async () => {}, clearSession: async () => {}, title: "t" })
    const [only, ...rest] = posts(slack)
    assert.equal(rest.length, 0)
    assert.deepEqual(typesOf(only), ["markdown", "context_actions"])
    assert.equal(blocksOf(only)[0]?.text, ANSWER)
    assert.ok(String(only?.text).length <= 300)
  }
})

test("a retry after a crash posts only the parts that did not go out", async () => {
  const slack = fakeSlack()
  const { runner } = fakeRunner()
  await advanceSlackRun({ checkpoint: finishing({ rich: true, answerPartsPosted: 1 }), runner, slack: slack.slack, messageId: "msg_e1", saveSession: async () => {}, clearSession: async () => {}, title: "t", richOptions: options })
  assert.deepEqual(posts(slack).map(typesOf), [["section", "actions"]])
})

test("when Slack refuses an answer's blocks the answer still arrives once, as plain sections", async () => {
  const slack = fakeSlack()
  let refused = 0
  const picky = async (method: string, body: Record<string, unknown>) => {
    if (method === "chat.postMessage" && JSON.stringify(body.blocks).includes('"table"') && refused++ === 0) throw new SlackApiError("invalid_blocks")
    return slack.slack(method, body)
  }
  const { runner } = fakeRunner()
  const logged: string[] = []
  await advanceSlackRun({ checkpoint: finishing({ rich: true }), runner, slack: picky, messageId: "msg_e1", saveSession: async () => {}, clearSession: async () => {}, title: "t", richOptions: options, log: (message) => logged.push(message) })
  const [content, choice] = posts(slack)
  assert.deepEqual(typesOf(content), ["section", "context_actions"])
  assert.match(String(blocksOf(content)[0]?.text?.text), /Proposal · 4 · \$82,000/)
  assert.deepEqual(typesOf(choice), ["section", "actions"])
  assert.deepEqual(logged, ["slack_rich_message_rejected"])
})

test("a background task's report uses the same components and still mentions the member once", async () => {
  const slack = fakeSlack()
  const { runner } = fakeRunner([], {
    background: async () => ({ ok: true, tasks: [{ id: "t1", title: "Pipeline", status: "completed" }], reports: [{ id: "r1", task: "t1", title: "Pipeline", status: "completed" }] }),
    turnText: async () => ({ ok: true, text: "## Pipeline\n\n| Stage | Deals |\n| --- | --- |\n| Won | 2 |" }),
  })
  const checkpoint = checkpointSchema.parse({ phase: "watch", channel: "C1", threadTs: "10.1", workbot: true, sessionId: "hs_1", recipientUserId: "U0MEMBER", taskIds: ["t1"], watchUntil: Date.now() + 60_000, rich: true })
  await advanceSlackWatch({ checkpoint, runner, slack: slack.slack, messageId: "msg_e1", richOptions: options })
  const [report] = posts(slack)
  assert.deepEqual(typesOf(report), ["section", "header", "table"])
  assert.equal(blocksOf(report)[0]?.text?.text, "<@U0MEMBER>")
  assert.match(String(report?.text), /^<@U0MEMBER> \*Pipeline\*/)

  const plain = fakeSlack()
  await advanceSlackWatch({ checkpoint: { ...checkpoint, reported: [] }, runner, slack: plain.slack, messageId: "msg_e1" })
  assert.deepEqual(typesOf(posts(plain)[0]), ["section", "markdown"])
})

test("a long streamed reply moves to a new stream before Slack's 12,000 character limit", async () => {
  assert.ok(STREAM_CHARACTER_LIMIT < 12_000)
  const slack = fakeSlack()
  const { runner } = fakeRunner([idle("word ".repeat(5_000))])
  await runToEnd({ checkpoint: checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "10.1", sessionId: "hs_1", live: true, startedAt: Date.now() }), runner, slack: slack.slack })
  const perStream: number[] = []
  for (const call of slack.calls) {
    const size = Array.isArray(call.body.chunks) ? call.body.chunks.reduce((sum: number, chunk: { text?: string }) => sum + (chunk.text?.length ?? 0), 0) : 0
    if (call.method === "chat.startStream") perStream.push(size)
    else if (call.method === "chat.appendStream" || call.method === "chat.stopStream") perStream[perStream.length - 1] = (perStream.at(-1) ?? 0) + size
  }
  assert.ok(perStream.length >= 3)
  for (const size of perStream) assert.ok(size <= 12_000, `stream carried ${size} characters`)
  assert.equal(slack.text().replaceAll("OpenWork task · continued\n\n", ""), "word ".repeat(5_000))
})

test("a stream Slack says is full continues in a new one without losing or repeating text", async () => {
  const slack = fakeSlack()
  let full = true
  const strict = async (method: string, body: Record<string, unknown>) => {
    if (method === "chat.appendStream" && full) {
      full = false
      throw new SlackApiError("msg_too_long")
    }
    return slack.slack(method, body)
  }
  const { runner } = fakeRunner([snapshot({ finalAssistantText: "First part. ", assistantTexts: ["First part. "] }), idle("First part. Second part.")])
  const checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "10.1", sessionId: "hs_1", live: true, startedAt: Date.now(), streamTs: "1.0", streamStartedAt: Date.now(), sentText: "" })
  await runToEnd({ checkpoint, runner, slack: strict })
  assert.equal(slack.text().replaceAll("OpenWork task · continued\n\n", ""), "First part. Second part.")
  assert.ok(slack.methods().includes("chat.startStream"))
})

test("the Slack bot is told about components only when the feature is on", () => {
  const off = slackWorkbotInstructions({ driveFiles: true, answerReply: true })
  const on = slackWorkbotInstructions({ driveFiles: true, answerReply: true, rich: true })
  assert.equal(off.includes("```slack") || off.includes("language slack"), false)
  assert.ok(on.startsWith(off))
  for (const word of ["real table", "context", "fields", "buttons", "choices", "plain sentences"]) assert.ok(on.includes(word), word)
  assert.equal(slackWorkbotInstructions({ driveFiles: true, answerReply: false, rich: true }).includes("language slack"), false)
})

const member = { ok: true as const, connectionId: "emc_01k8z5wq0s0000000000000000" as const, slackUserId: "U0MEMBER" }
const COMPONENTS = [
  { type: "header", text: "Weekly signups" },
  { type: "table", columns: ["Week", "Signups"], rows: [["Nov 16", "412"], ["Nov 23", "468"]] },
  { type: "context", text: "From PostHog, Nov 16 to Nov 29" },
  { type: "buttons", buttons: [{ text: "Open in OpenWork", open: "automations" }] },
]

function sendDeps(overrides: Partial<SlackSendAsBotDeps> = {}) {
  const direct: Array<{ text: string; rich?: readonly SlackOutgoingMessage[] }> = []
  const channel: Array<{ channelId: string; text: string; rich?: readonly SlackOutgoingMessage[] }> = []
  const used: string[] = []
  const windows = new Map<string, number>()
  const deps: SlackSendAsBotDeps = {
    resolveMember: async () => member,
    sendDirect: async (_member, message) => {
      direct.push(message)
      return { ok: true, channelId: "D1", messageTs: "1.1" }
    },
    postChannel: async (_member, message) => {
      channel.push(message)
      return { ok: true, channelId: message.channelId, messageTs: "1.2" }
    },
    choicesAnswered: async () => true,
    composeOptions: () => options,
    markRichUsed: (input) => used.push(input.memberId),
    limits: {
      peek: async (key, max) => ((windows.get(key) ?? 0) >= max ? 60 : null),
      take: async (key, max) => {
        if ((windows.get(key) ?? 0) >= max) return 60
        windows.set(key, (windows.get(key) ?? 0) + 1)
        return null
      },
      prune: async () => {},
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  }
  return { deps, direct, channel, used }
}

const call = (body: unknown, richEnabled: boolean, deps: SlackSendAsBotDeps) =>
  executeSlackSendAsBot({ organizationId: "org_01k8z5wq0s0000000000000000", userId: "user_1", memberId: "om_01k8z5wq0s0000000000000000", hasWriteScope: true, richEnabled, body }, deps)

test("slack_send_as_bot offers and accepts components only with the feature on", async () => {
  const offSchema = JSON.stringify(searchSlackSendAsBotCapability("slack_send_as_bot")[0]?.argumentsSchema)
  const onSchema = JSON.stringify(searchSlackSendAsBotCapability("slack_send_as_bot", { rich: true })[0]?.argumentsSchema)
  assert.equal(offSchema.includes("components"), false)
  assert.ok(onSchema.includes('"components"') && onSchema.includes('"choices"') && onSchema.includes("additionalProperties"))

  const off = sendDeps()
  const refused = await call({ target: "me", text: "Signups are up.", components: COMPONENTS }, false, off.deps)
  assert.equal(refused.structuredContent.error, "invalid_capability_arguments")
  assert.equal(off.direct.length, 0)
  const plain = await call({ target: "me", text: "Signups are up." }, false, off.deps)
  assert.equal(plain.structuredContent.sent, true)
  assert.deepEqual(off.direct, [{ text: "Signups are up." }])
  assert.deepEqual(off.used, [])
})

test("slack_send_as_bot composes validated components under the text and never forwards what the model sent", async () => {
  const on = sendDeps()
  const sent = await call({ target: "me", text: "Signups are up 14% week over week.", components: COMPONENTS }, true, on.deps)
  assert.equal(sent.structuredContent.sent, true, JSON.stringify(sent.structuredContent))
  const [message] = on.direct
  assert.equal(message?.text, "Signups are up 14% week over week.")
  assert.equal(message?.rich?.length, 1)
  assert.deepEqual(message?.rich?.[0]?.blocks.map((block) => block.type), ["section", "header", "table", "context", "actions"])
  assert.ok(message?.rich?.[0]?.text.startsWith("Signups are up 14% week over week."))
  assert.ok(message?.rich?.[0]?.text.includes("<https://app.example.com/dashboard/automations|Open in OpenWork>"))
  assert.deepEqual(on.used, ["om_01k8z5wq0s0000000000000000"])

  for (const raw of [
    [{ type: "section", text: { type: "mrkdwn", text: "<!channel> raw Block Kit" } }],
    [{ type: "actions", elements: [{ type: "button", action_id: "slack_feedback:x", text: { type: "plain_text", text: "x" } }] }],
    [{ type: "buttons", buttons: [{ text: "Go", url: "https://example.com", action_id: "openwork_choice:0" }] }],
    [{ type: "table", columns: ["A", "B"], rows: Array.from({ length: 51 }, () => ["1", "2"]) }],
  ]) {
    const refused = await call({ target: "me", text: "x", components: raw }, true, on.deps)
    assert.equal(refused.structuredContent.error, "invalid_capability_arguments", JSON.stringify(raw))
  }
  assert.equal(on.direct.length, 1)
})

test("the same text with different components is not a duplicate, and the same message twice is", async () => {
  const on = sendDeps()
  assert.equal((await call({ target: "me", text: "Report", components: COMPONENTS }, true, on.deps)).structuredContent.sent, true)
  assert.equal((await call({ target: "me", text: "Report", components: COMPONENTS }, true, on.deps)).structuredContent.error, "duplicate_message")
  assert.equal((await call({ target: "me", text: "Report", components: [{ type: "divider" }] }, true, on.deps)).structuredContent.sent, true)
})

test("choices are refused where nothing would answer the click, and reported when the buttons could not be added", async () => {
  const body = { target: "me", text: "The draft reply to Dana is ready.", components: [{ type: "choices", prompt: "Send it?", options: ["Send it", "Don't send"] }] }
  const none = sendDeps({ choicesAnswered: async () => false })
  const refused = await call(body, true, none.deps)
  assert.equal(refused.structuredContent.error, "choices_unavailable")
  assert.equal(none.direct.length, 0)

  const on = sendDeps()
  assert.equal((await call(body, true, on.deps)).structuredContent.sent, true)
  assert.deepEqual(on.direct[0]?.rich?.map((message) => message.choice), [false, true])

  const partial = sendDeps({ sendDirect: async () => ({ ok: true, channelId: "D1", messageTs: "1.1", partial: true }) })
  const result = await call(body, true, partial.deps)
  assert.equal(result.structuredContent.partial, true)
  assert.match(String(result.structuredContent.message), /Don't send it again/)
})

test("a channel post keeps the attribution line first and a DM posts the question after the content", async () => {
  const rich = (await (async () => {
    const on = sendDeps()
    await call({ target: "channel", channelId: "C0123ABCD", text: "Handoff for this week.", components: [{ type: "fields", fields: [{ label: "Owner", value: "Dana" }, { label: "Due", value: "Friday" }] }, { type: "choices", options: ["Take it", "Pass"] }] }, true, on.deps)
    return on.channel[0]?.rich
  })()) ?? []
  const slack = fakeSlack()
  const deps = { botToken: async () => "xoxb-test", slack: () => slack.slack, memberCanReadChannel: async () => true }
  const posted = await postWorkbotChannelMessage(member, { channelId: "C0123ABCD", text: "Handoff for this week.", rich }, deps)
  assert.equal(posted.ok, true)
  const [content, choice] = posts(slack)
  assert.deepEqual(typesOf(content), ["section", "section", "section"])
  assert.equal(blocksOf(content)[0]?.text?.text, "<@U0MEMBER>'s agent")
  assert.match(String(content?.text), /^<@U0MEMBER>'s agent\nHandoff for this week\./)
  assert.deepEqual(typesOf(choice), ["actions"])
  assert.equal(blocksOf(content).length <= 50, true)

  const dm = fakeSlack()
  const dmDeps = { botToken: async () => "xoxb-test", slack: () => async (method: string, body: Record<string, unknown>) => (method === "conversations.open" ? { ok: true, channel: { id: "D1" } } : dm.slack(method, body)) }
  const sent = await sendWorkbotDirectMessageTo(member, { text: "Handoff for this week.", rich }, dmDeps)
  assert.equal(sent.ok, true)
  assert.deepEqual(posts(dm).map((body) => body.channel), ["D1", "D1"])

  const failing = fakeSlack()
  let count = 0
  const flaky = { botToken: async () => "xoxb-test", slack: () => async (method: string, body: Record<string, unknown>) => {
    if (method === "conversations.open") return { ok: true, channel: { id: "D1" } }
    if (method === "chat.postMessage" && ++count === 2) throw new SlackApiError("ratelimited")
    return failing.slack(method, body)
  } }
  const partial = await sendWorkbotDirectMessageTo(member, { text: "Handoff for this week.", rich }, flaky)
  assert.deepEqual([partial.ok, partial.ok && partial.partial], [true, true])
  assert.equal(posts(failing).length, 1)
})

const installation = (extra: Partial<SlackChoiceInstallation> = {}): SlackChoiceInstallation => ({ connectionId: "emc_01k8z5wq0s0000000000000000", enabled: true, botToken: "xoxb-test", teamId: "T1", channelIds: null, ...extra })

function choiceDeps(overrides: Partial<SlackChoiceDeps> = {}) {
  const slack = fakeSlack()
  const recorded = new Map<string, SlackEvent>()
  const deps: SlackChoiceDeps = {
    slack: async () => slack.slack,
    record: async (_installation, id, event) => {
      const existing = recorded.get(id)
      if (existing) return { created: false, event: existing }
      recorded.set(id, event)
      return { created: true, event }
    },
    available: () => true,
    enabled: async () => true,
    ...overrides,
  }
  return { deps, slack, recorded }
}

const click = (extra: Record<string, unknown> = {}) =>
  slackInteractionSchema.parse({
    team: { id: "T1" },
    user: { id: "U0MEMBER" },
    api_app_id: "A1",
    channel: { id: "C1" },
    message: {
      ts: "20.5",
      thread_ts: "10.1",
      blocks: [
        { type: "section", block_id: "x", text: { type: "mrkdwn", text: "Post this in #sales?", verbatim: false } },
        {
          type: "actions",
          block_id: "openwork_choice:U0MEMBER",
          elements: [
            { type: "button", action_id: "openwork_choice:0", text: { type: "plain_text", text: "Post it" }, value: "Post it" },
            { type: "button", action_id: "openwork_choice:1", text: { type: "plain_text", text: "Not now" }, value: "Not now" },
          ],
        },
      ],
    },
    actions: [{ action_id: "openwork_choice:0", block_id: "openwork_choice:U0MEMBER", value: "Post it", action_ts: "21.0" }],
    ...extra,
  })
const pressed = (extra: Record<string, unknown> = {}) => {
  const press = slackChoicePress(click(extra))
  assert.ok(press)
  return press.event
}

test("a press is queued from the signed payload alone, so the click is acknowledged without waiting on Slack", () => {
  const press = slackChoicePress(click())
  assert.deepEqual(press, {
    eventId: "press:C1:20.5:U0MEMBER:21.0",
    event: { type: "choice_pressed", user: "U0MEMBER", channel: "C1", text: "Post it", ts: "20.5", thread_ts: "10.1", choice: { addressed: "U0MEMBER", prompt: "Post this in #sales?" } },
  })
  assert.equal(slackChoicePress(click({ actions: [{ action_id: "openwork_choice:0", block_id: "openwork_choice:U0MEMBER", value: "Delete everything" }] })), null, "a value that was not on a button")
  assert.equal(slackChoicePress(click({ actions: [{ action_id: "openwork_choice:1", block_id: "openwork_choice:U0MEMBER", value: "Post it" }] })), null, "a value from another button")
  for (const actions of [[{ action_id: "openwork_link:0", block_id: "openwork_link:1" }], [{ action_id: "slack_feedback:abc", value: "positive" }], [{ action_id: "connect_openwork" }]])
    assert.equal(slackChoicePress(click({ actions })), null, "link buttons and feedback are acknowledged and start nothing")
})

test("the member a question was for presses a choice: it becomes their next request in that thread and the buttons are replaced", async () => {
  const { deps, slack, recorded } = choiceDeps()
  assert.equal(await settleSlackChoice(installation(), pressed(), deps), "accepted")
  assert.deepEqual([...recorded], [["choice:C1:20.5", { type: "app_mention", user: "U0MEMBER", channel: "C1", text: "Post it", ts: "20.5", thread_ts: "10.1" }]])
  const [update] = slack.calls
  assert.equal(update?.method, "chat.update")
  assert.deepEqual(update?.body, {
    channel: "C1",
    ts: "20.5",
    text: 'Post this in #sales?\n<@U0MEMBER> chose "Post it".',
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Post this in #sales?" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "✅ <@U0MEMBER> chose *Post it*" }] },
    ],
  })

  const dm = choiceDeps()
  assert.equal(await settleSlackChoice(installation(), pressed({ channel: { id: "D9" }, message: { ts: "30.1" } }), dm.deps), "accepted")
  assert.deepEqual([...dm.recorded.values()], [{ type: "message", channel_type: "im", user: "U0MEMBER", channel: "D9", text: "Post it", ts: "30.1", thread_ts: "30.1" }])
})

test("when two different buttons are pressed, the first is what runs and what Slack shows", async () => {
  const { deps, slack, recorded } = choiceDeps()
  const second = { actions: [{ action_id: "openwork_choice:1", block_id: "openwork_choice:U0MEMBER", value: "Not now", action_ts: "21.5" }] }
  assert.deepEqual(await Promise.all([settleSlackChoice(installation(), pressed(), deps), settleSlackChoice(installation(), pressed(second), deps)]), ["accepted", "already_answered"])
  assert.deepEqual([...recorded.values()].map((event) => event.text), ["Post it"])
  const updates = slack.calls.filter((call) => call.method === "chat.update").map((call) => call.body.text)
  assert.deepEqual(updates, ['Post this in #sales?\n<@U0MEMBER> chose "Post it".', 'Post this in #sales?\n<@U0MEMBER> chose "Post it".'])
  assert.deepEqual(slack.calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.body.text), ['You already chose "Post it", and that is what OpenWork is working on.'])
  assert.equal(await settleSlackChoice(installation(), pressed(), deps), "already_answered", "the same press again changes nothing")
  assert.equal(recorded.size, 1)
})

test("someone else pressing a choice starts nothing and is told privately", async () => {
  const { deps, slack, recorded } = choiceDeps()
  assert.equal(await settleSlackChoice(installation(), pressed({ user: { id: "U0OTHER" } }), deps), "not_addressed")
  assert.equal(recorded.size, 0)
  assert.deepEqual(slack.calls.map((entry) => [entry.method, entry.body.user, entry.body.text]), [["chat.postEphemeral", "U0OTHER", "Only <@U0MEMBER> can answer this."]])
})

test("a question already in Slack starts nothing once the feature is turned off for the member, the assistant is off, the channel is not allowed or the limit is reached", async () => {
  for (const [row, overrides, outcome] of [
    [installation(), { enabled: async () => false }, "unavailable"],
    [installation({ enabled: false }), {}, "unavailable"],
    [installation(), { available: () => false }, "unavailable"],
    [installation({ channelIds: ["C9"] }), {}, "unavailable"],
    [installation(), { record: async () => null }, "throttled"],
  ] as const) {
    const { deps, slack, recorded } = choiceDeps(overrides)
    assert.equal(await settleSlackChoice(row, pressed(), deps), outcome)
    assert.equal(recorded.size, 0)
    assert.deepEqual(slack.methods(), ["chat.postEphemeral"], "the member is told privately and the buttons stay")
  }
})

test("only a queued press is settled, and the request it starts is an ordinary message from the member", async () => {
  const event = pressed()
  assert.equal(await settleSlackChoice(installation(), { ...event, type: "message" }, choiceDeps().deps), "not_a_choice")
  const { deps, recorded } = choiceDeps()
  assert.equal(await settleSlackChoice(installation(), event, deps), "accepted")
  assert.deepEqual([...recorded.values()].map((entry) => [entry.type, entry.text, entry.choice]), [["app_mention", "Post it", undefined]])
})

test("a finished desktop task arrives with real tables when the feature is on and as sections when it is off", () => {
  const finalText = "## Renewals\n\n| Account | Renews |\n| --- | --- |\n| Northwind | Dec 3 |\n\nAll three are drafted."
  const rich = desktopHandoffRichMessages("U0MEMBER", { kind: "finished", finalText }, options)
  assert.equal(rich?.cut, false)
  assert.deepEqual(rich?.messages.map((message) => message.blocks.map((block) => block.type)), [["section", "header", "table", "markdown"]])
  assert.match(rich?.messages[0]?.text ?? "", /^<@U0MEMBER> Your desktop finished:\n\n\*Renewals\*/)
  assert.equal(desktopHandoffRichMessages("U0MEMBER", { kind: "failed", message: "boom" }, options), null)
  assert.equal(desktopHandoffRichMessages("U0MEMBER", { kind: "finished", finalText: " " }, options), null)
  const directive = desktopHandoffRichMessages("U0MEMBER", { kind: "finished", finalText: '```slack\n{"type":"choices","options":["A","B"]}\n```' }, options)
  assert.equal(JSON.stringify(directive?.messages).includes("openwork_choice"), false)
  const plain = desktopHandoffMessage("U0MEMBER", { kind: "finished", finalText })
  assert.ok(plain.blocks?.every((block) => block.type === "section"))
  assert.match(plain.blocks?.[0]?.text.text ?? "", /```\n\| Account \| Renews \|/)
})

test("Your agent's message keeps its words and gains sections and a line saying what was read", async () => {
  const text = "Before 10 AM: <https://mail.google.com/x|Dana's follow-up> still has no reply.\n\nA cost check: the invoice is *due Friday*."
  const parts = agentBriefParts({ text, sources: ["Gmail", "Slack", "Calendar"], at: Date.UTC(2026, 10, 27, 17, 2), timeZone: "America/Los_Angeles", first: true })
  assert.deepEqual(parts.map((part) => part.type), ["header", "mrkdwn", "divider", "mrkdwn", "context"])
  assert.deepEqual(parts.at(-1), { type: "context", text: "Your agent read Gmail, Slack and Calendar at 9:02 AM" })
  assert.deepEqual(agentBriefParts({ text: "One finding.", sources: [], at: 0, timeZone: "UTC", first: true }).map((part) => part.type), ["mrkdwn", "context"])

  const sent: Array<Record<string, unknown>> = []
  const deps = (on: boolean) => ({
    target: async () => member,
    send: async (input: Record<string, unknown>) => {
      sent.push(input)
      return { ok: true as const, channelId: "D1", messageTs: "1.1", permalink: null }
    },
    rich: async () => on,
    markRichUsed: () => {},
  })
  await deliverAgentMessage({ organizationId: "org_1", userId: "user_1", memberId: "om_1", text, parts }, deps(false))
  await deliverAgentMessage({ organizationId: "org_1", userId: "user_1", memberId: "om_1", text, parts }, deps(true))
  assert.deepEqual(sent[0], { organizationId: "org_1", userId: "user_1", text, permalink: true })
  assert.equal(sent[1]?.text, text)
  const [message] = z_rich(sent[1])
  assert.deepEqual(message?.blocks.map((block) => block.type), ["header", "section", "divider", "section", "context"])
  assert.ok(message?.text.includes("<https://mail.google.com/x|Dana's follow-up>"))
})

test("a notice that an app needs reconnecting becomes a sentence and a button to the fix", async () => {
  const parts = agentNoticeParts({ text: "Quick check: I can't read your Gmail, so I've paused checking it and kept reading the rest.", actions: [{ text: "Reconnect Google Workspace", url: "http://localhost:3005/dashboard/library/connectors/emc_1" }] })
  const sent: Array<Record<string, unknown>> = []
  await deliverAgentMessage(
    { organizationId: "org_1", userId: "user_1", text: "fallback", parts },
    { target: async () => member, send: async (input) => { sent.push(input); return { ok: true, channelId: "D1", messageTs: "1.1" } }, rich: async () => true, markRichUsed: () => {} },
  )
  const [message] = z_rich(sent[0])
  assert.deepEqual(message?.blocks.map((block) => block.type), ["section", "actions"])
  const actions = message?.blocks[1]
  assert.ok(actions?.type === "actions")
  assert.deepEqual(actions.elements.map((button) => [button.text.text, button.url]), [["Reconnect Google Workspace", "http://localhost:3005/dashboard/library/connectors/emc_1"]])
})

function z_rich(input: Record<string, unknown> | undefined): SlackOutgoingMessage[] {
  return Array.isArray(input?.rich) ? input.rich : []
}
