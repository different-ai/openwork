import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

process.env.DATABASE_URL ??= "mysql://examples:examples@127.0.0.1:3306/slack_rich_examples"
process.env.BETTER_AUTH_URL ??= "https://app.example.com"
process.env.BETTER_AUTH_SECRET ??= "synthetic-slack-rich-examples-secret-not-for-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-slack-rich-examples-encryption-key-not-real"
process.env.OPENWORK_DEV_MODE ??= "1"

const { executeSlackSendAsBot } = await import("../src/mcp/slack-send-as-bot.js")
const { answerSlackChoice, slackInteractionSchema } = await import("../src/slack-assistant/choice.js")
const { postDesktopHandoffNotice } = await import("../src/slack-assistant/desktop-handoff-post.js")
const { sendWorkbotDirectMessageTo } = await import("../src/slack-assistant/direct-message.js")
const { slackClient } = await import("../src/slack-assistant/protocol.js")
const { slackComposeDefaults } = await import("../src/slack-assistant/rich-delivery.js")
const { advanceSlackRun, checkpointSchema } = await import("../src/slack-assistant/run.js")
const { deliverAgentMessage } = await import("../src/workbot-proactive/deliver.js")
const { agentBriefParts, agentNoticeParts } = await import("../src/workbot-proactive/slack-layout.js")

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const OUT = join(ROOT, "docs/features/slack-rich-messages")
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const CALLBACK = "http://127.0.0.1:8790/v1/oauth/callback"
const ORGANIZATION = "org_01k8z5wq0s0000000000000000" as const
const MEMBER = "om_01k8z5wq0s0000000000000000" as const
const CONNECTION = "emc_01k8z5wq0s0000000000000000" as const

type SlackCall = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>
type Place = { team: string; channel: string; userId: string; bot: SlackCall; person: SlackCall; botToken: string; apiBase: string }
type Example = {
  slug: string
  title: string
  surface: string
  through: string
  inputLabel: string
  input: string
  inputLanguage: string
  run: (place: Place) => Promise<void>
  after?: { slug: string; caption: string; run: (place: Place) => Promise<void> }
}

const json = (value: unknown) => JSON.stringify(value, null, 2)
const registered = z.object({ team_id: z.string(), bot_token: z.string(), api_base_url: z.string() })
const tokenResponse = z.object({ access_token: z.string() })
const clientResponse = z.object({ client_id: z.string() })

function dmDeps(place: Place) {
  return { botToken: async () => place.botToken, slack: (token: string, baseUrl?: string) => slackClient(token, fetch, baseUrl), sandboxApiBase: async () => place.apiBase }
}

async function sendAsBot(place: Place, body: Record<string, unknown>, richEnabled: boolean) {
  const member = { ok: true as const, connectionId: CONNECTION, slackUserId: place.userId }
  const result = await executeSlackSendAsBot(
    { organizationId: ORGANIZATION, userId: "user_examples", memberId: MEMBER, hasWriteScope: true, richEnabled, body },
    {
      resolveMember: async () => member,
      sendDirect: (target, message) => sendWorkbotDirectMessageTo(target, message, dmDeps(place)),
      postChannel: async () => ({ ok: false, reason: "bot_not_in_channel" }),
      choicesAnswered: async () => true,
      composeOptions: slackComposeDefaults,
      markRichUsed: () => {},
      limits: { peek: async () => null, take: async () => null, prune: async () => {} },
      now: Date.now,
    },
  )
  if (result.isError) throw new Error(`slack_send_as_bot refused: ${JSON.stringify(result.structuredContent)}`)
}

async function assistantAnswer(place: Place, ask: string, answer: string) {
  const root = z.object({ ts: z.string() }).parse(await place.person("chat.postMessage", { channel: place.channel, text: ask }))
  const onlyPosts: SlackCall = (method, body) => (method === "chat.postMessage" ? place.bot(method, body) : Promise.resolve({ ok: true }))
  await advanceSlackRun({
    checkpoint: checkpointSchema.parse({ phase: "finish", channel: place.channel, threadTs: root.ts, workbot: true, answerReply: true, answerText: answer, recipientUserId: place.userId, rich: true, startedAt: Date.now() }),
    runner: {
      create: async () => ({ ok: true, sessionId: "hs_examples" }),
      send: async () => ({ ok: true, accepted: true }),
      read: async () => ({ ok: false, error: "unused", retryable: false }),
      stop: async () => {},
      background: async () => ({ ok: true, tasks: [], reports: [] }),
      turnText: async () => ({ ok: true, text: "" }),
    },
    slack: onlyPosts,
    messageId: "msg_examples",
    saveSession: async () => {},
    clearSession: async () => {},
    title: "examples",
    richOptions: slackComposeDefaults(),
  })
  return root.ts
}

async function pressChoice(place: Place, threadTs: string, label: string) {
  const replies = z.object({ messages: z.array(z.object({ ts: z.string(), blocks: z.array(z.unknown()).optional() })) }).parse(await place.bot("conversations.replies", { channel: place.channel, ts: threadTs }))
  const asked = replies.messages.find((message) => JSON.stringify(message.blocks ?? []).includes("openwork_choice:"))
  if (!asked) throw new Error("No question with choices was posted")
  const queued: string[] = []
  const result = await answerSlackChoice(
    { connectionId: CONNECTION, enabled: true, botToken: place.botToken, teamId: place.team, channelIds: null },
    slackInteractionSchema.parse({
      team: { id: place.team },
      user: { id: place.userId },
      api_app_id: "A0EXAMPLES",
      channel: { id: place.channel },
      message: { ts: asked.ts, thread_ts: threadTs, blocks: asked.blocks },
      actions: [{ action_id: "openwork_choice:0", block_id: `openwork_choice:${place.userId}`, value: label }],
    }),
    { slack: async () => place.bot, enqueue: async (_installation, _id, event) => { queued.push(event.text ?? ""); return "evt_examples" }, available: () => true },
  )
  await result.settled
  if (result.outcome !== "accepted" || queued[0] !== label) throw new Error(`The choice was not accepted: ${result.outcome}`)
}

const statusReport = {
  target: "me",
  text: "Open issues this week: 4 open, 2 need you before Friday.",
  components: [
    { type: "header", text: "Open issues" },
    {
      type: "table",
      columns: ["Issue", "Owner", "Priority", "Days open"],
      rows: [
        ["[ENG-214 Export times out](https://linear.app/acme/issue/ENG-214)", "Dana", "Urgent", "9"],
        ["[ENG-221 Invoice totals round up](https://linear.app/acme/issue/ENG-221)", "Lee", "High", "6"],
        ["ENG-230 Slow search on large workspaces", "Sam", "Medium", "4"],
        ["ENG-233 Dark mode contrast", "Riley", "Low", "2"],
      ],
    },
    { type: "context", text: "From Linear, read Nov 27 at 9:02 AM" },
    { type: "buttons", buttons: [{ text: "Open the board", url: "https://linear.app/acme/team/ENG/active" }] },
  ],
}

const meetingFollowUp = {
  target: "me",
  text: "Follow-up from the Northwind renewal call: they want the security review by Dec 4 and agreed to a two-year term.",
  components: [
    { type: "header", text: "Northwind renewal call" },
    { type: "fields", fields: [{ label: "When", value: "Fri Nov 27, 10:00 AM" }, { label: "Decision", value: "Two-year term, pending security review" }, { label: "Attendees", value: "Alex, Dana and two from Northwind" }, { label: "Next meeting", value: "Tue Dec 8" }] },
    { type: "divider" },
    { type: "table", columns: ["Action item", "Owner", "Due"], rows: [["Send the security questionnaire answers", "Dana", "Dec 2"], ["Draft the two-year order form", "Alex", "Dec 3"], ["Confirm SSO requirements with their IT lead", "Lee", "Dec 4"]] },
    { type: "context", text: "From the meeting notes and the calendar invite" },
  ],
}

const automationResult = {
  target: "me",
  text: "Your weekly signups digest finished: 468 signups, up 14% on last week.",
  components: [
    { type: "fields", fields: [{ label: "This week", value: "468" }, { label: "Last week", value: "412" }, { label: "Change", value: "+14%" }, { label: "Top source", value: "Docs (38%)" }] },
    { type: "context", text: "Weekly signups digest, ran Mon Nov 23 at 9:00 AM" },
    { type: "buttons", buttons: [{ text: "Open in OpenWork", open: "automations" }] },
  ],
}

const automationBlocked = {
  target: "me",
  text: "Your pipeline report didn't run: Google Sheets needs you to sign in again. Nothing was changed.",
  components: [
    { type: "context", text: "Pipeline report, stopped Mon Nov 23 at 9:00 AM" },
    { type: "buttons", buttons: [{ text: "Reconnect in OpenWork", open: "connections" }] },
  ],
}

const pipelineAnswer = [
  "# Pipeline by stage",
  "Two deals moved forward this week and one slipped: **Northwind** is waiting on their security review.",
  "",
  "| Stage | Deals | Value | Change |",
  "| --- | ---: | ---: | --- |",
  "| Qualified | 7 | $96,000 | +2 |",
  "| Proposal | 4 | $82,000 | +1 |",
  "| Negotiation | 2 | $54,500 | Northwind slipped a week |",
  "| Won this month | 2 | $31,500 | |",
  "",
  "```slack",
  json([{ type: "context", text: "From the CRM, read just now" }, { type: "buttons", buttons: [{ text: "Open the pipeline", url: "https://crm.example.com/pipeline" }] }]),
  "```",
].join("\n")

const approvalAnswer = [
  "Here's the reply to Dana, ready to go:",
  "",
  "> Hi Dana, the security questionnaire answers are attached. The two open items are SSO and data retention; I'll have both to you by Wednesday.",
  "",
  "```slack",
  json({ type: "choices", prompt: "Send this reply to Dana from your Gmail?", options: ["Send it", "Let me edit it first", "Don't send"] }),
  "```",
].join("\n")

const briefText = [
  "Before your 10 AM with Northwind: <https://mail.google.com/mail/u/0/#inbox/18c2f|Dana's follow-up> from Thursday still has no reply, and it asks for the security questionnaire by *Dec 4*. I'd answer with a date before the call.",
  "A decision due today: Lee asked in <https://acme.slack.com/archives/C0123ABCD/p1764230400000100|#launch> whether the pricing page ships Monday or waits for legal. Nobody has answered since yesterday afternoon, and the build freezes at *5 PM*.",
  "Tomorrow's 2 PM design review now overlaps the customer call that was moved this morning. I checked both invites: the customer call can't move again. I'd ask Sam to shift the review to 3.",
].join("\n\n")
const briefInput = { text: briefText, sources: ["Gmail", "Slack", "Google Calendar"], at: Date.UTC(2026, 10, 27, 17, 2), timeZone: "America/Los_Angeles", first: true }

const noticeInput = {
  text: "Quick check: I can't read your Gmail, so I've paused checking it and kept reading the rest.",
  actions: [{ text: "Reconnect Google Workspace", url: "https://app.example.com/dashboard/library/connectors/emc_example" }],
}

const desktopFinal = [
  "## Renewals due in December",
  "",
  "I went through the contracts folder and the CRM export. Three renew next month and all three drafts are in `Renewals/2026-12`.",
  "",
  "| Account | Renews | Seats | Draft |",
  "| --- | --- | ---: | --- |",
  "| Northwind | Dec 3 | 120 | Ready |",
  "| Fabrikam | Dec 12 | 45 | Ready |",
  "| Tailspin | Dec 19 | 300 | Needs the new price list |",
  "",
  "Tailspin is the only one I couldn't finish: the 2027 price list isn't in the folder yet.",
].join("\n")

function handoff(place: Place, threadTs: string) {
  return { channelId: place.channel, threadTs, recipientUserId: place.userId, organizationId: ORGANIZATION, userId: "user_examples" }
}

const EXAMPLES: Example[] = [
  {
    slug: "status-report",
    title: "A status report with a table",
    surface: "A chat or Automation sending with `slack_send_as_bot`",
    through: "`executeSlackSendAsBot` and the DM sender, posting to the sample Slack. The proof sends the same call through Den's MCP endpoint.",
    inputLabel: "Tool call",
    input: json(statusReport),
    inputLanguage: "json",
    run: (place) => sendAsBot(place, statusReport, true),
  },
  {
    slug: "status-report-before",
    title: "The same report with the feature off",
    surface: "A chat or Automation sending with `slack_send_as_bot`",
    through: "`executeSlackSendAsBot` with the feature off: only `text` is accepted.",
    inputLabel: "Tool call",
    input: json({ target: "me", text: "Open issues this week: 4 open, 2 need you before Friday.\n```\nIssue | Owner | Priority | Days open\nENG-214 Export times out | Dana | Urgent | 9\nENG-221 Invoice totals round up | Lee | High | 6\nENG-230 Slow search on large workspaces | Sam | Medium | 4\nENG-233 Dark mode contrast | Riley | Low | 2\n```" }),
    inputLanguage: "json",
    run: (place) => sendAsBot(place, { target: "me", text: "Open issues this week: 4 open, 2 need you before Friday.\n```\nIssue | Owner | Priority | Days open\nENG-214 Export times out | Dana | Urgent | 9\nENG-221 Invoice totals round up | Lee | High | 6\nENG-230 Slow search on large workspaces | Sam | Medium | 4\nENG-233 Dark mode contrast | Riley | Low | 2\n```" }, false),
  },
  {
    slug: "pipeline-answer",
    title: "Pipeline by stage, answered in a thread",
    surface: "The Slack assistant's answer to a mention or DM",
    through: "`advanceSlackRun` posting the turn's last message. Markdown gives the header and the table; the fenced `slack` block adds the source line and the button.",
    inputLabel: "The assistant's last message",
    input: pipelineAnswer,
    inputLanguage: "markdown",
    run: async (place) => {
      await assistantAnswer(place, "How does the pipeline look this week?", pipelineAnswer)
    },
  },
  {
    slug: "meeting-follow-up",
    title: "A meeting follow-up with action items and owners",
    surface: "A chat or Automation sending with `slack_send_as_bot`",
    through: "`executeSlackSendAsBot` and the DM sender. The proof sends the same call through Den's MCP endpoint.",
    inputLabel: "Tool call",
    input: json(meetingFollowUp),
    inputLanguage: "json",
    run: (place) => sendAsBot(place, meetingFollowUp, true),
  },
  {
    slug: "daily-brief",
    title: "A daily brief from Your agent",
    surface: "Your agent's first check of the day",
    through: "`agentBriefParts` and `deliverAgentMessage`. The agent writes only the paragraphs, as before; OpenWork adds the header, the dividers and the line saying what was read.",
    inputLabel: "The agent's message, and what OpenWork knows about the check",
    input: json(briefInput),
    inputLanguage: "json",
    run: async (place) => {
      const member = { ok: true as const, connectionId: CONNECTION, slackUserId: place.userId }
      const sent = await deliverAgentMessage(
        { organizationId: ORGANIZATION, userId: "user_examples", text: briefText, parts: agentBriefParts(briefInput) },
        { target: async () => member, send: (input) => sendWorkbotDirectMessageTo(member, { text: input.text, ...(input.rich ? { rich: input.rich } : {}) }, dmDeps(place)), rich: async () => true, markRichUsed: () => {} },
      )
      if (!sent.ok) throw new Error(`Your agent's message was not delivered: ${sent.code}`)
    },
  },
  {
    slug: "automation-result",
    title: "An Automation result with a button to open it in OpenWork",
    surface: "An Automation run sending with `slack_send_as_bot`",
    through: "`executeSlackSendAsBot`. The agent names the place (`open: \"automations\"`) and OpenWork fills in the address.",
    inputLabel: "Tool call",
    input: json(automationResult),
    inputLanguage: "json",
    run: (place) => sendAsBot(place, automationResult, true),
  },
  {
    slug: "approval-choice",
    title: "An approval with buttons",
    surface: "The Slack assistant asking before it sends something",
    through: "`advanceSlackRun` posts the question as its own message. The second picture is the same message after `answerSlackChoice` handled the member's click and replaced the buttons.",
    inputLabel: "The assistant's last message",
    input: approvalAnswer,
    inputLanguage: "markdown",
    run: async (place) => {
      await assistantAnswer(place, "Draft a reply to Dana about the security questionnaire", approvalAnswer)
    },
    after: {
      slug: "approval-choice-chosen",
      caption: "After the member presses **Send it**: the buttons are replaced, and \"Send it\" is queued as their next request in the thread.",
      run: async (place) => {
        const history = z.object({ messages: z.array(z.object({ ts: z.string() })) }).parse(await place.bot("conversations.history", { channel: place.channel, oldest: "0" }))
        const root = history.messages.at(-1)
        if (!root) throw new Error("No thread to answer in")
        await pressChoice(place, root.ts, "Send it")
      },
    },
  },
  {
    slug: "needs-connection",
    title: "An app needs reconnecting",
    surface: "Your agent, when a source it reads stops working",
    through: "`agentNoticeParts` and `deliverAgentMessage`: the sentence OpenWork already sends, with the fix as a button instead of a link in the text.",
    inputLabel: "What OpenWork knows",
    input: json(noticeInput),
    inputLanguage: "json",
    run: async (place) => {
      const member = { ok: true as const, connectionId: CONNECTION, slackUserId: place.userId }
      await deliverAgentMessage(
        { organizationId: ORGANIZATION, userId: "user_examples", text: noticeInput.text, parts: agentNoticeParts(noticeInput) },
        { target: async () => member, send: (input) => sendWorkbotDirectMessageTo(member, { text: input.text, ...(input.rich ? { rich: input.rich } : {}) }, dmDeps(place)), rich: async () => true, markRichUsed: () => {} },
      )
    },
  },
  {
    slug: "automation-blocked",
    title: "An Automation that could not run",
    surface: "An Automation run sending with `slack_send_as_bot`",
    through: "`executeSlackSendAsBot`. One sentence, when it stopped, and a button to Your Connections.",
    inputLabel: "Tool call",
    input: json(automationBlocked),
    inputLanguage: "json",
    run: (place) => sendAsBot(place, automationBlocked, true),
  },
  {
    slug: "desktop-handoff",
    title: "A finished desktop task with a table",
    surface: "Work handed to the desktop from Slack, when it finishes",
    through: "`postDesktopHandoffNotice`. The desktop agent wrote ordinary Markdown; nothing about it is Slack-specific.",
    inputLabel: "The desktop session's final message",
    input: desktopFinal,
    inputLanguage: "markdown",
    run: async (place) => {
      const root = z.object({ ts: z.string() }).parse(await place.person("chat.postMessage", { channel: place.channel, text: "Prepare the December renewals on my desktop" }))
      await postDesktopHandoffNotice(place.bot, handoff(place, root.ts), { kind: "finished", finalText: desktopFinal }, async () => slackComposeDefaults())
    },
  },
  {
    slug: "desktop-handoff-before",
    title: "The same desktop result with the feature off",
    surface: "Work handed to the desktop from Slack, when it finishes",
    through: "`postDesktopHandoffNotice` with the feature off: the table is typed characters in a code block.",
    inputLabel: "The desktop session's final message",
    input: desktopFinal,
    inputLanguage: "markdown",
    run: async (place) => {
      const root = z.object({ ts: z.string() }).parse(await place.person("chat.postMessage", { channel: place.channel, text: "Prepare the December renewals on my desktop" }))
      await postDesktopHandoffNotice(place.bot, handoff(place, root.ts), { kind: "finished", finalText: desktopFinal }, async () => null)
    },
  },
]

async function freePort() {
  return new Promise<number>((done, fail) => {
    const server = createServer()
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (address && typeof address === "object" ? done(address.port) : fail(new Error("no port"))))
    })
  })
}

async function openChrome() {
  const port = await freePort()
  const profile = await mkdtemp(join(tmpdir(), "slack-rich-examples-"))
  const child = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=2", "about:blank"], { stdio: "ignore" })
  const targets = z.array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string() }))
  let socketUrl = ""
  for (let attempt = 0; attempt < 100 && !socketUrl; attempt++) {
    await new Promise((done) => setTimeout(done, 100))
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json(), () => null)
    const parsed = targets.safeParse(listed)
    socketUrl = parsed.success ? (parsed.data.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? "") : ""
  }
  if (!socketUrl) throw new Error(`Chrome did not start (${CHROME}). Set CHROME_PATH.`)
  const socket = new WebSocket(socketUrl)
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true })
    socket.addEventListener("error", fail, { once: true })
  })
  const waiting = new Map<number, (result: unknown) => void>()
  const reply = z.object({ id: z.number(), result: z.unknown().optional() })
  socket.addEventListener("message", (event) => {
    const parsed = reply.safeParse(JSON.parse(String(event.data)))
    if (parsed.success) waiting.get(parsed.data.id)?.(parsed.data.result)
  })
  let next = 0
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((done) => {
      const id = ++next
      waiting.set(id, done)
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression: string) => z.object({ result: z.object({ value: z.unknown().optional() }) }).parse(await send("Runtime.evaluate", { expression, returnByValue: true })).result.value
  return {
    send,
    evaluate,
    close: async () => {
      socket.close()
      child.kill("SIGTERM")
      await rm(profile, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

const base = `http://127.0.0.1:${await freePort()}`
const workshop = spawn(process.execPath, [join(ROOT, "evals/packages/open-workplace/src/workshop.mjs")], {
  env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(base).port, PUBLIC_URL: base, OPEN_WORKPLACE_JOIN_MODE: "automatic", OPEN_WORKPLACE_PARTICIPANTS: "[]" },
  stdio: "ignore",
})
for (let attempt = 0; attempt < 100; attempt++) {
  if (await fetch(`${base}/health`).then((response) => response.ok, () => false)) break
  await new Promise((done) => setTimeout(done, 200))
}
const entered = await fetch(`${base}/login?next=%2F`, { redirect: "manual", headers: { accept: "text/html" } })
const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
const [cookieName, ...cookieValue] = cookie.split("=")

async function connectSlack() {
  const resource = `${base}/slack/mcp`
  const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) })
  const client = clientResponse.parse(await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "OpenWork", redirect_uris: [CALLBACK] }) })).json())
  const verifier = randomBytes(32).toString("base64url")
  const request = { client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource, state: "s" }
  await fetch(`${base}/oauth/authorize?${new URLSearchParams(request)}`, { redirect: "manual", headers: { cookie, accept: "text/html" } })
  const allowed = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...request, decision: "allow" }) })
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? ""
  return tokenResponse.parse(await (await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK, resource }))).json()).access_token
}

const personToken = await connectSlack()

async function newPlace(): Promise<Place> {
  const app = registered.parse(await (await fetch(`${base}/_workshop/slack/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_name: "OpenWork" }) })).json())
  const bot = slackClient(app.bot_token, fetch, app.api_base_url)
  const person = slackClient(personToken, fetch, app.api_base_url)
  const who = z.object({ user_id: z.string() }).parse(await person("auth.test", {}))
  const opened = z.object({ channel: z.object({ id: z.string() }) }).parse(await bot("conversations.open", { users: who.user_id }))
  return { team: app.team_id, channel: opened.channel.id, userId: who.user_id, bot, person, botToken: app.bot_token, apiBase: app.api_base_url }
}

const browser = await openChrome()
await browser.send("Network.enable")
await browser.send("Network.setCookie", { name: cookieName, value: cookieValue.join("="), url: base, httpOnly: true })
await browser.send("Emulation.setDeviceMetricsOverride", { width: 1040, height: 2400, deviceScaleFactor: 2, mobile: false })

async function capture(place: Place, slug: string) {
  await browser.send("Page.navigate", { url: `${base}/slack?team=${place.team}` })
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((done) => setTimeout(done, 100))
    if ((await browser.evaluate('document.readyState === "complete" && document.querySelectorAll("#messages > .message").length > 0')) === true) break
  }
  const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).parse(
    JSON.parse(String(await browser.evaluate('(() => { const items = [...document.querySelectorAll("#messages > .message")]; const first = items[0].getBoundingClientRect(); const last = items[items.length - 1].getBoundingClientRect(); return JSON.stringify({ x: first.left, y: Math.max(0, first.top - 10), width: first.width, height: last.bottom - first.top + 20 }) })()'))),
  )
  const shot = z.object({ data: z.string() }).parse(await browser.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } }))
  await writeFile(join(OUT, `${slug}.png`), Buffer.from(shot.data, "base64"))
}

await mkdir(OUT, { recursive: true })
const sections: string[] = []
try {
  for (const example of EXAMPLES) {
    const place = await newPlace()
    await example.run(place)
    await capture(place, example.slug)
    const pictures = [`![${example.title}](./${example.slug}.png)`]
    if (example.after) {
      await example.after.run(place)
      await capture(place, example.after.slug)
      pictures.push("", example.after.caption, "", `![${example.title}, answered](./${example.after.slug}.png)`)
    }
    sections.push([`## ${example.title}`, "", `**Where:** ${example.surface}`, "", `**Made with:** ${example.through}`, "", `**${example.inputLabel}:**`, "", `\`\`\`\`${example.inputLanguage}`, example.input, "````", "", ...pictures].join("\n"))
    process.stdout.write(`rendered ${example.slug}\n`)
  }
} finally {
  await browser.close()
  workshop.kill("SIGTERM")
}

const intro = [
  "# Slack components: example use cases",
  "",
  "Each picture below is the message OpenWork's own code produced for the input shown, posted to the sample Slack that",
  "ships with sandbox organizations (`evals/packages/open-workplace`, \"Open Slack\"). That sample Slack checks every block",
  "against the limits Slack documents and draws it from the Block Kit reference. It is a stand-in, not Slack: spacing and",
  "type differ in the real client.",
  "",
  "Regenerate with `pnpm --filter @openwork-ee/den-api slack:examples`. This file and its pictures are written by",
  "`ee/apps/den-api/scripts/slack-rich-examples.ts`, so an input here is always the one that made its picture.",
].join("\n")
await writeFile(join(OUT, "examples.md"), `${intro}\n\n${sections.join("\n\n")}\n`)
process.exit(0)
