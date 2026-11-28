import assert from "node:assert/strict"
import { test } from "node:test"
import { SlackApiError } from "../src/slack-assistant/protocol.js"
import {
  composeSlackMessages,
  markdownToSlackParts,
  postSlackMessage,
  SLACK_LIMITS,
  slackBlockProblems,
  slackComponentsSchema,
  type SlackOutgoingMessage,
  type SlackPart,
} from "../src/slack-assistant/rich-message.js"

/** One way from agent output to Slack blocks: Markdown and validated components in, messages inside Slack's limits out. */

const types = (message: SlackOutgoingMessage | undefined) => (message?.blocks ?? []).map((block) => block.type)
const compose = (markdown: string, options: Parameters<typeof composeSlackMessages>[1] = {}) =>
  composeSlackMessages(markdownToSlackParts(markdown, { directives: true }).parts, options)

function tableCharacters(message: SlackOutgoingMessage) {
  const cells = message.blocks.flatMap((block) => (block.type === "table" ? block.rows.flat() : []))
  return cells.reduce((sum, cell) => sum + (cell.type === "raw_text" ? cell.text.length : (cell.elements[0]?.elements[0]?.text.length ?? 0)), 0)
}

test("a Markdown answer becomes a header, text, a real table, a divider and a context line", () => {
  const [message, ...rest] = compose(
    [
      "# Open issues",
      "Three need you this week.",
      "",
      "| Issue | Owner | Days open |",
      "| --- | --- | ---: |",
      "| [ENG-12](https://linear.app/acme/issue/ENG-12) | Dana | 9 |",
      "| ENG-15 | Lee | 4 |",
      "",
      "---",
      "",
      "```slack",
      '{"type":"context","text":"From Linear, read just now"}',
      "```",
    ].join("\n"),
  )
  assert.equal(rest.length, 0)
  assert.deepEqual(types(message), ["header", "markdown", "table", "divider", "context"])
  const table = message?.blocks.find((block) => block.type === "table")
  assert.ok(table?.type === "table")
  assert.deepEqual(table.rows[0], [{ type: "raw_text", text: "Issue" }, { type: "raw_text", text: "Owner" }, { type: "raw_text", text: "Days open" }])
  assert.deepEqual(table.rows[1]?.[0], { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://linear.app/acme/issue/ENG-12", text: "ENG-12" }] }] })
  assert.deepEqual(table.column_settings, [{ align: "left" }, { align: "left" }, { align: "right" }])
  assert.deepEqual(slackBlockProblems(message?.blocks ?? []), [])
})

test("the fallback text carries the whole message for notifications and screen readers", () => {
  const [message] = compose("# Pipeline\n\n| Stage | Deals |\n| --- | --- |\n| Proposal | 4 |\n| Won | 2 |\n\n```slack\n{\"type\":\"buttons\",\"buttons\":[{\"text\":\"Open the board\",\"url\":\"https://example.com/board\"}]}\n```")
  assert.equal(message?.text, "*Pipeline*\n\n*Stage · Deals*\n• Proposal · 4\n• Won · 2\n\n<https://example.com/board|Open the board>")
  assert.deepEqual(message?.plain.blocks, [{ type: "section", text: { type: "mrkdwn", text: message?.text } }])
})

test("a table past Slack's limits continues in further messages, one table each, header row repeated", () => {
  const rows = Array.from({ length: 240 }, (_, index) => `| Row ${index} | ${"x".repeat(60)} |`)
  const messages = compose(["| Name | Note |", "| --- | --- |", ...rows].join("\n"))
  assert.ok(messages.length >= 3)
  for (const message of messages) {
    assert.deepEqual(types(message), ["table"])
    const table = message.blocks[0]
    assert.ok(table?.type === "table")
    assert.ok(table.rows.length <= SLACK_LIMITS.tableRows)
    assert.deepEqual(table.rows[0]?.[0], { type: "raw_text", text: "Name" })
    assert.ok(tableCharacters(message) <= SLACK_LIMITS.tableCharacters)
    assert.deepEqual(slackBlockProblems(message.blocks), [])
  }
  const shown = messages.flatMap((message) => (message.blocks[0]?.type === "table" ? message.blocks[0].rows.slice(1) : []))
  assert.equal(shown.length, 240)
})

test("two tables never share a message", () => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |"
  const messages = compose(`${table}\n\nBetween.\n\n${table}`)
  assert.deepEqual(messages.map(types), [["table", "markdown"], ["table"]])
})

test("a table Slack cannot hold stays Markdown instead of being cut", () => {
  const wide = `| ${Array.from({ length: 21 }, (_, index) => `c${index}`).join(" | ")} |\n| ${Array.from({ length: 21 }, () => "---").join(" | ")} |\n| ${Array.from({ length: 21 }, () => "v").join(" | ")} |`
  assert.deepEqual(compose(wide).map(types), [["markdown"]])
})

test("long text is split at Slack's Markdown limit and every message stays valid", () => {
  const messages = compose(Array.from({ length: 400 }, (_, index) => `Paragraph ${index} ${"word ".repeat(20)}`).join("\n\n"))
  assert.ok(messages.length > 1)
  for (const message of messages) {
    assert.deepEqual(slackBlockProblems(message.blocks), [])
    assert.ok(message.text.length <= SLACK_LIMITS.fallbackText)
  }
})

test("more blocks than Slack allows continue in the next message, with room kept for the caller's own blocks", () => {
  const parts: SlackPart[] = Array.from({ length: 120 }, (_, index) => ({ type: "context", text: `Line ${index}` }))
  const messages = composeSlackMessages(parts, { reservedBlocks: 2 })
  assert.deepEqual(messages.map((message) => message.blocks.length), [48, 48, 24])
})

test("mentions and broadcasts a model wrote never reach Slack as pings", () => {
  const [message] = composeSlackMessages([
    { type: "header", text: "Heads up @channel" },
    { type: "context", text: "cc <@U123ABC> <!here>" },
    { type: "fields", fields: [{ label: "Owner", value: "<!channel>" }] },
  ])
  const sent = JSON.stringify(message?.blocks)
  assert.equal(sent.includes("<@U123ABC>"), false)
  assert.equal(sent.includes("<!here>"), false)
  assert.equal(sent.includes("<!channel>"), false)
  assert.equal(sent.includes("@channel"), false)
  assert.equal(message?.text.includes("<@U123ABC>"), false)
})

test("an image shows only from an allowed host and is a link everywhere else", () => {
  const markdown = "![Signups this week](https://charts.example.com/a.png?secret=1)"
  assert.deepEqual(compose(markdown).map(types), [["section"]])
  const [allowed] = compose(markdown, { imageUrl: (url) => (new URL(url).hostname === "charts.example.com" ? url : null) })
  assert.deepEqual(allowed?.blocks, [{ type: "image", image_url: "https://charts.example.com/a.png?secret=1", alt_text: "Signups this week" }])
})

test("link buttons need https and a known OpenWork place resolves to its address", () => {
  const [message] = composeSlackMessages(
    [{ type: "buttons", buttons: [{ text: "Open in OpenWork", open: "automations" }, { text: "Docs", url: "https://docs.example.com" }] }],
    { places: { automations: "https://app.example.com/dashboard/automations" } },
  )
  const actions = message?.blocks[0]
  assert.ok(actions?.type === "actions")
  assert.deepEqual(actions.elements.map((button) => [button.text.text, button.url, button.action_id]), [
    ["Open in OpenWork", "https://app.example.com/dashboard/automations", "openwork_link:0"],
    ["Docs", "https://docs.example.com/", "openwork_link:1"],
  ])
  assert.equal(slackComponentsSchema.safeParse([{ type: "buttons", buttons: [{ text: "Run", url: "javascript:alert(1)" }] }]).success, false)
  assert.equal(slackComponentsSchema.safeParse([{ type: "buttons", buttons: [{ text: "Run", url: "http://example.com" }] }]).success, false)
})

test("choices are buttons only for the person they are for, in a message of their own", () => {
  const parts: SlackPart[] = [{ type: "text", text: "Draft ready." }, { type: "choices", prompt: "Send it to Dana?", options: ["Send it", "Don't send"] }]
  const [content, choice] = composeSlackMessages(parts, { choiceFor: "U0MEMBER" })
  assert.deepEqual(types(content), ["markdown"])
  assert.equal(choice?.choice, true)
  assert.deepEqual(choice?.blocks, [
    { type: "section", text: { type: "mrkdwn", text: "Send it to Dana?" } },
    {
      type: "actions",
      block_id: "openwork_choice:U0MEMBER",
      elements: [
        { type: "button", action_id: "openwork_choice:0", text: { type: "plain_text", text: "Send it", emoji: true }, value: "Send it" },
        { type: "button", action_id: "openwork_choice:1", text: { type: "plain_text", text: "Don't send", emoji: true }, value: "Don't send" },
      ],
    },
  ])
  assert.equal(choice?.text, 'Send it to Dana?\nReply with "Send it" or "Don\'t send".')

  const [unhandled, ...none] = composeSlackMessages(parts)
  assert.equal(none.length, 0)
  assert.deepEqual(types(unhandled), ["markdown", "section"])
  assert.equal(JSON.stringify(unhandled?.blocks).includes("button"), false)
})

test("the component schema refuses anything outside the vocabulary", () => {
  const refused = (value: unknown) => assert.equal(slackComponentsSchema.safeParse(value).success, false, JSON.stringify(value))
  refused([{ type: "section", text: { type: "mrkdwn", text: "raw Block Kit" } }])
  refused([{ type: "header", text: "x", block_id: "mine" }])
  refused([{ type: "header", text: "x".repeat(151) }])
  refused([{ type: "choices", options: ["Only one"] }])
  refused([{ type: "choices", options: ["A", "B"] }, { type: "divider" }])
  refused([{ type: "choices", options: ["Yes", "yes"] }])
  refused([{ type: "table", columns: ["A", "B"], rows: [["1"]] }])
  refused([{ type: "table", columns: ["A", "B"], rows: [["1", "2"]] }, { type: "table", columns: ["A", "B"], rows: [["1", "2"]] }])
  refused(Array.from({ length: 21 }, () => ({ type: "divider" })))
  refused([{ type: "image", url: "https://user:pass@example.com/a.png", alt: "x" }])
  assert.equal(slackComponentsSchema.safeParse([{ type: "table", columns: ["A", "B"], rows: [["1", "2"]] }, { type: "choices", options: ["A", "B"] }]).success, true)
})

test("a slack block that is not valid stays visible as written and is counted", () => {
  const result = markdownToSlackParts('Before.\n\n```slack\n{"type":"marquee","text":"x"}\n```\n\nAfter.', { directives: true })
  assert.equal(result.invalidDirectives, 1)
  assert.deepEqual(result.parts.map((part) => part.type), ["text"])
  assert.match(result.parts[0]?.type === "text" ? result.parts[0].text : "", /marquee/)
  const off = markdownToSlackParts('```slack\n{"type":"divider"}\n```')
  assert.deepEqual(off.parts.map((part) => part.type), ["text"])
})

test("code fences, deep headings and headings with links stay Markdown", () => {
  const { parts } = markdownToSlackParts("```\n# not a heading\n| a | b |\n| --- | --- |\n```\n\n### Small\n\n## See [the doc](https://example.com)")
  assert.deepEqual(parts.map((part) => part.type), ["text"])
})

test("when Slack refuses the blocks the same content is posted once as plain sections", async () => {
  const calls: Record<string, unknown>[] = []
  const slack = async (_method: string, body: Record<string, unknown>) => {
    calls.push(body)
    if (calls.length === 1) throw new SlackApiError("invalid_blocks")
    return { ok: true, ts: "1.1" }
  }
  const [message] = compose("# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |")
  assert.ok(message)
  const rejected: string[] = []
  const posted = await postSlackMessage(slack, { channel: "C1" }, message, { after: [{ type: "context_actions" }], onRejected: (code) => rejected.push(code) })
  assert.equal(posted.ts, "1.1")
  assert.deepEqual(rejected, ["invalid_blocks"])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.blocks, [{ type: "section", text: { type: "mrkdwn", text: "*Title*\n\n*A · B*\n• 1 · 2" } }, { type: "context_actions" }])
  await assert.rejects(postSlackMessage(async () => { throw new SlackApiError("channel_not_found") }, { channel: "C1" }, message), /channel_not_found/)
})
