import { SlackApiError } from "../src/slack-assistant/protocol.js"
import type { SlackRunner, SlackRunSnapshot } from "../src/slack-assistant/headless.js"
import type { LiveFeed, LiveFeedSource, RunnerEvent } from "../src/slack-assistant/live.js"
import { advanceSlackRun, type Checkpoint } from "../src/slack-assistant/run.js"

export type SlackCallRecord = { method: string; body: Record<string, unknown> }

/** Records Slack calls; streams and posts get a ts. `fail` makes a method throw a Slack error. */
export function fakeSlack(fail: Record<string, string> = {}) {
  const calls: SlackCallRecord[] = []
  let ts = 0
  const slack = async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body })
    const code = fail[method]
    if (code) throw new SlackApiError(code)
    return method === "chat.startStream" || method === "chat.postMessage" ? { ok: true, ts: `1.${++ts}` } : { ok: true }
  }
  const chunkTexts = () =>
    calls.flatMap((call) =>
      Array.isArray(call.body.chunks)
        ? call.body.chunks.flatMap((chunk: unknown) =>
            typeof chunk === "object" && chunk !== null && "text" in chunk && typeof chunk.text === "string" ? [chunk.text] : [],
          )
        : [],
    )
  return { calls, slack, text: () => chunkTexts().join(""), appends: () => chunkTexts(), methods: () => calls.map((call) => call.method) }
}

export const snapshot = (input: Partial<SlackRunSnapshot> = {}): SlackRunSnapshot => ({
  status: "busy",
  finalAssistantText: "",
  lastAssistantText: "",
  steps: [],
  assistantTexts: [],
  tasks: [],
  ...input,
})

export const idle = (text: string, input: Partial<SlackRunSnapshot> = {}) =>
  snapshot({ status: "idle", finalAssistantText: text, lastAssistantText: text, assistantTexts: text ? [text] : [], ...input })

/** A runner whose reads return `reads` in turn (the last one repeats). */
export function fakeRunner(reads: SlackRunSnapshot[] = [idle("Here you go.")], overrides: Partial<SlackRunner> = {}) {
  const sent: Array<Parameters<SlackRunner["send"]>[0]> = []
  const created: Array<Parameters<SlackRunner["create"]>[0]> = []
  let index = 0
  const runner: SlackRunner = {
    create: async (input) => {
      created.push(input)
      return { ok: true, sessionId: `hs_new${created.length}` }
    },
    send: async (input) => {
      sent.push(input)
      return { ok: true, accepted: true }
    },
    read: async () => ({ ok: true, snapshot: reads[Math.min(index++, reads.length - 1)] ?? idle("") }),
    stop: async () => {},
    background: async () => ({ ok: true, tasks: [], reports: [] }),
    turnText: async () => ({ ok: true, text: "" }),
    ...overrides,
  }
  return { runner, sent, created, readCount: () => index }
}

/** A live feed the test pushes events into. */
export function fakeLive() {
  const queue: RunnerEvent[] = []
  const tokens: number[] = []
  let fresh = true
  const feed: LiveFeed = {
    get fresh() {
      return fresh
    },
    closed: false,
    take: () => queue.splice(0),
    release: (token) => {
      tokens.push(token)
      fresh = false
    },
  }
  const source: LiveFeedSource = { acquire: async () => feed }
  return { source, push: (...events: RunnerEvent[]) => queue.push(...events), tokens }
}

/** A clock the test moves; `sleep` advances it. */
export function fakeClock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

export async function runToEnd(input: Omit<Parameters<typeof advanceSlackRun>[0], "saveSession" | "clearSession" | "title" | "messageId"> & { checkpoint: Checkpoint }, max = 50) {
  const saved: string[] = []
  let cleared = 0
  for (let i = 0; i < max; i++) {
    const result = await advanceSlackRun({
      messageId: "msg_1",
      title: "C1 · hi",
      saveSession: async (id) => {
        saved.push(id)
      },
      clearSession: async () => {
        cleared += 1
      },
      ...input,
    })
    if (result.done) return { result, saved, cleared: () => cleared }
  }
  throw new Error("run did not finish")
}
