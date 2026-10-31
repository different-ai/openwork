import assert from "node:assert/strict"
import { test } from "node:test"
import { desktopHandoffMessage } from "../src/slack-assistant/desktop-handoff-messages.js"
import { advanceSlackWatch, checkpointSchema } from "../src/slack-assistant/run.js"
import {
  excerpt,
  markdownToMrkdwn,
  markdownToPlainText,
  SECTION_TEXT_LIMIT,
  splitSlackText,
} from "../src/slack-assistant/slack-text.js"
import { fakeRunner, fakeSlack } from "./slack-fakes.js"

// The desktop answer that was posted cut off, as raw Markdown, in https://openworklabs.slack.com/archives/C0AL7NRD733/p1793429310206659
const REPORTED_ANSWER = [
  "Implemented and CI is green.",
  "",
  "- **PR:** [#6805 — Missing and remote file links](<https://github.com/different-ai/openwork/pull/6805>)",
  "- **Original resolver fix:** [#6803](<https://github.com/different-ai/openwork/pull/6803>) was merged before the additional requirement arrived, so that work is in the follow-up.",
  "",
  "**Root cause:** chat surfaces interpreted paths differently, guessed bare filenames under the workspace root, and could send remote references to local file APIs.",
  "",
  "**Fix:** shared resolution, workspace search, origin-aware native access, preserved worktree ownership, and a calm **Copy path** action for paths on another machine.",
  "",
  "**Tests:** unit tests for every path shape, plus an end-to-end check of a remote session's file link.",
].join("\n")

/** Every `*`, `~` and code fence in mrkdwn has a partner (inline code and link targets aside). */
function assertBalanced(mrkdwn: string) {
  assert.equal((mrkdwn.match(/^```/gm) ?? []).length % 2, 0, `open code block in: ${mrkdwn.slice(-200)}`)
  const prose = mrkdwn.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "").replace(/<[^<>\n]*>/g, "")
  assert.equal((prose.match(/\*/g) ?? []).length % 2, 0, `open bold in: ${prose.slice(-200)}`)
  assert.equal((prose.match(/~/g) ?? []).length % 2, 0, `open strikethrough in: ${prose.slice(-200)}`)
}

const words = (text: string) => text.replace(/^```.*$/gm, "").split(/\s+/).filter(Boolean)

test("the reported desktop answer becomes Slack mrkdwn: bold, links and bullets render", () => {
  assert.equal(
    markdownToMrkdwn(REPORTED_ANSWER),
    [
      "Implemented and CI is green.",
      "",
      "• *PR:* <https://github.com/different-ai/openwork/pull/6805|#6805 — Missing and remote file links>",
      "• *Original resolver fix:* <https://github.com/different-ai/openwork/pull/6803|#6803> was merged before the additional requirement arrived, so that work is in the follow-up.",
      "",
      "*Root cause:* chat surfaces interpreted paths differently, guessed bare filenames under the workspace root, and could send remote references to local file APIs.",
      "",
      "*Fix:* shared resolution, workspace search, origin-aware native access, preserved worktree ownership, and a calm *Copy path* action for paths on another machine.",
      "",
      "*Tests:* unit tests for every path shape, plus an end-to-end check of a remote session's file link.",
    ].join("\n"),
  )
})

test("Markdown to mrkdwn covers headings, emphasis, lists, quotes, code and tables", () => {
  const cases: Array<[string, string]> = [
    ["## Build **status**", "*Build status*"],
    ["*italic* and _also_ and ~~gone~~", "_italic_ and _also_ and ~gone~"],
    ["__bold__ but snake_case_name stays", "*bold* but snake_case_name stays"],
    ["5 * 3 * 2 = 30", "5 * 3 * 2 = 30"],
    ["- [ ] todo\n- [x] done\n  - nested", "☐ todo\n☑ done\n    ◦ nested"],
    ["1. first\n2) second", "1. first\n2. second"],
    ["> quoted **bit**", "> quoted *bit*"],
    ["Run `pnpm test -- --grep \"a*b*c\"` now", "Run `pnpm test -- --grep \"a*b*c\"` now"],
    ["```ts\nconst x = a**2 < b\n```", "```\nconst x = a**2 &lt; b\n```"],
    ["| a | b |\n|---|---|\n| **1** | 2 |", "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```"],
    ["See **https://github.com/different-ai/openwork/pull/6357**.", "See *<https://github.com/different-ai/openwork/pull/6357>*."],
    ["Docs (https://example.com/a_(b)) here", "Docs (<https://example.com/a_(b)>) here"],
    ["[report](https://x.dev/r?a=1&b=2 \"title\")", "<https://x.dev/r?a=1&amp;b=2|report>"],
    ["[notes](docs/notes.md)", "notes (docs/notes.md)"],
    ["![chart](https://x.dev/c.png)", "<https://x.dev/c.png|chart>"],
    ["---", "───"],
  ]
  for (const [markdown, expected] of cases) assert.equal(markdownToMrkdwn(markdown), expected, markdown)
})

test("converted text can't mention, broadcast or inject Slack controls", () => {
  const out = markdownToMrkdwn("hi <@U123> <!here> @channel [x](javascript:alert(1)) [y](<https://ok.dev/a|b>) & done")
  assert.ok(!/<@|<!|@channel/.test(out), out)
  assert.ok(out.includes("&lt;@U123&gt;") && out.includes("&lt;!here&gt;") && out.includes("&amp; done"))
  assert.ok(!out.includes("<javascript"), "only http(s) and mailto become links")
  assert.ok(out.includes("<https://ok.dev/a%7Cb|y>"), "a pipe can't end the link early")
})

test("a `**` left without a partner never shows as literal asterisks", () => {
  assert.equal(markdownToMrkdwn("and a calm **Copy"), "and a calm Copy")
  assertBalanced(markdownToMrkdwn("one **two** three **four"))
})

test("an excerpt ends at a sentence when it can, and never leaves formatting open", () => {
  const text = "First sentence is here. Second sentence has **bold words that run past the limit** and more."
  assert.equal(excerpt(text, 40), "First sentence is here.")
  assert.equal(excerpt(text, 60), "First sentence is here. Second sentence has bold words…")
  const cut = excerpt("Short lead **and a long bold run that never closes before the limit is reached**", 40)
  assert.ok(cut.endsWith("…") && !cut.includes("**"), cut)
  assert.ok(excerpt("```\ncode code code code code code code", 20).endsWith("\n```"))
})

test("plain text for notifications has no Markdown markers", () => {
  assert.equal(
    markdownToPlainText("## Done\n- **PR:** [#6805](<https://github.com/x/y/pull/6805>) with `code`"),
    "Done\n• PR: #6805 with code",
  )
})

test("long text splits at paragraph and sentence breaks without losing or breaking anything", () => {
  const paragraphs = Array.from(
    { length: 60 },
    (_, i) => `Paragraph ${i} has **bold ${i}**, a [link ${i}](https://x.dev/${i}) and _emphasis_. It ends with a full sentence ${i}.`,
  )
  const code = `\`\`\`\n${Array.from({ length: 300 }, (_, i) => `line ${i} <tag>`).join("\n")}\n\`\`\``
  const mrkdwn = markdownToMrkdwn(`${paragraphs.join("\n\n")}\n\n${code}\n\nThe very last sentence.`)
  const parts = splitSlackText(mrkdwn, SECTION_TEXT_LIMIT)
  assert.ok(parts.length > 2)
  for (const part of parts) {
    assert.ok(part.length <= SECTION_TEXT_LIMIT, `part is ${part.length} characters`)
    assertBalanced(part)
    const prose = part.replace(/^```[\s\S]*?^```/gm, "").trim()
    if (prose) assert.match(prose, /[.>]$|^```/m, `part ends mid-sentence: ${prose.slice(-80)}`)
  }
  assert.deepEqual(words(parts.join("\n")), words(mrkdwn), "every word is posted, in order")
  assert.ok(parts.at(-1)?.endsWith("The very last sentence."))
})

test("one very long paragraph splits between sentences, and a run-on line between words", () => {
  const sentences = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} talks about *item ${i}*.`).join(" ")
  const parts = splitSlackText(sentences, 1_000)
  for (const part of parts) {
    assert.ok(part.length <= 1_000)
    assert.match(part, /\.$/, "ends at a sentence")
    assertBalanced(part)
  }
  assert.deepEqual(words(parts.join(" ")), words(sentences))
  const runOn = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ")
  const runOnParts = splitSlackText(runOn, 1_000)
  assert.deepEqual(words(runOnParts.join(" ")), words(runOn))
  for (const part of runOnParts) assert.match(part, /^word\d+.*word\d+$/, "never splits inside a word")
})

test("the desktop's whole answer is posted in mrkdwn, mentioning the person, nothing cut off", () => {
  const message = desktopHandoffMessage("U0AK7E403AS", { kind: "finished", finalText: REPORTED_ANSWER })
  const shown = message.blocks?.map((block) => block.text.text).join("\n") ?? ""
  assert.ok(shown.startsWith("<@U0AK7E403AS> Your desktop finished: Implemented and CI is green."))
  assert.ok(shown.includes("<https://github.com/different-ai/openwork/pull/6805|#6805 — Missing and remote file links>"))
  assert.ok(shown.includes("a calm *Copy path* action"), "the part that used to be cut off is there")
  assert.ok(shown.endsWith("end-to-end check of a remote session's file link."))
  assert.ok(!/\*\*|\]\(|…/.test(shown), "no raw Markdown, no ellipsis")
  assertBalanced(shown)
  // The notification is plain text that ends at a sentence and still mentions the person.
  assert.ok(message.text.startsWith("<@U0AK7E403AS> Your desktop finished: Implemented and CI is green."))
  assert.ok(!/\*\*|\]\(/.test(message.text))
})

test("a desktop answer at the 20,000 character cap is split across sections, not shortened", () => {
  const paragraph = "This paragraph explains one **part** of the change in a full sentence. It has a second sentence too."
  const finalText = Array.from({ length: 190 }, (_, i) => `${i}. ${paragraph}`).join("\n\n").slice(0, 20_000)
  const message = desktopHandoffMessage("U1ABC", { kind: "finished", finalText })
  const blocks = message.blocks ?? []
  assert.ok(blocks.length > 6 && blocks.length <= 50)
  for (const block of blocks) {
    assert.ok(block.text.text.length <= SECTION_TEXT_LIMIT)
    assertBalanced(block.text.text)
  }
  const shown = blocks.map((block) => block.text.text).join("\n")
  assert.deepEqual(words(shown).slice(4), words(markdownToMrkdwn(finalText)), "every word of the answer, in order")
})

test("answers that open with a list start on their own line; other notices stay one line", () => {
  const listed = desktopHandoffMessage("U1ABC", { kind: "finished", finalText: "- one\n- two" })
  assert.equal(listed.blocks?.[0]?.text.text, "<@U1ABC> Your desktop finished:\n• one\n• two")
  assert.deepEqual(desktopHandoffMessage("U1ABC", { kind: "finished", finalText: "  " }), { text: "<@U1ABC> Your desktop finished." })
  assert.equal(
    desktopHandoffMessage("U1ABC", { kind: "failed", message: "Tool **bash** failed <@U2>." }).text,
    "<@U1ABC> The task on your desktop failed: Tool bash failed &lt;@U2&gt;. It's still open in OpenWork on that computer.",
  )
})

test("a long background report continues in more replies instead of being cut off, once", async () => {
  const { slack, calls } = fakeSlack()
  const report = Array.from({ length: 400 }, (_, i) => `Finding ${i}: the **Q3 deck** slide ${i} is ready and reviewed.`).join("\n\n")
  let failNext = false
  const flaky = async (method: string, body: Record<string, unknown>) => {
    if (failNext && method === "chat.postMessage" && calls.length === 1) {
      failNext = false
      throw new Error("network")
    }
    return slack(method, body)
  }
  const { runner } = fakeRunner([], {
    background: async () => ({
      ok: true,
      tasks: [{ id: "msg_1.t1", title: "Q3 deck", status: "completed" }],
      reports: [{ id: "msg_1.t1.r", title: "Q3 deck", status: "completed", task: "msg_1.t1" }],
    }),
    turnText: async () => ({ ok: true, text: report }),
  })
  const cp = checkpointSchema.parse({ phase: "watch", sessionId: "hs_1", channel: "C1", threadTs: "9.0", recipientUserId: "U0ABC", watchUntil: Date.now() + 60_000 })
  failNext = true
  await assert.rejects(advanceSlackWatch({ checkpoint: cp, runner, slack: flaky, messageId: "msg_1" }))
  await advanceSlackWatch({ checkpoint: cp, runner, slack: flaky, messageId: "msg_1" })
  const posts = calls.filter((call) => call.method === "chat.postMessage")
  const markdown = posts.map((post) => {
    const blocks = post.body.blocks as Array<{ type: string; text: string }>
    return blocks.find((block) => block.type === "markdown")?.text ?? ""
  })
  assert.ok(posts.length >= 2, "split across replies")
  assert.equal(new Set(markdown).size, markdown.length, "no part is posted twice after a retry")
  for (const part of markdown) {
    assert.ok(part.length <= 11_000)
    assert.match(part, /reviewed\.$/, "each reply ends at a sentence")
  }
  assert.deepEqual(words(markdown.join("\n\n")), words(report))
  assert.ok(String(posts[0]?.body.text).startsWith("<@U0ABC> Finding 0: the Q3 deck"), "plain notification text")
  assert.ok(cp.reported.includes("msg_1.t1.r"))
})
