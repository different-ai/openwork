import type { RunnerMessage, RunnerSnapshot } from "@openwork-ee/headless-protocol"

/**
 * Test-only conversations for chat-screen-server.ts, in the shape `GET /v1/workbot` answers. Each scenario is a
 * function so every server start begins from the same conversation.
 */
type Part = { kind: "text"; text: string; step?: number } | { kind: "steps"; steps: unknown[] }
export type FixtureTurn = {
  id: string
  text: string
  sentAt: number | null
  finishedAt: number | null
  status: "queued" | "working" | "done" | "failed" | "stopped"
  attachments: Array<{ id: string; name: string; mediaType: string; size: number }>
  parts: Part[]
  modelSteps: number
  error: string | null
  tasks?: unknown[]
  greeting?: boolean
}
export type FixtureThread = { name: string; organizationName: string; status: "idle" | "busy"; turns: FixtureTurn[]; hasEarlier: boolean; filesEnabled: boolean }

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000
const said = (text: string, step = 0): Part => ({ kind: "text", text, step })
export const turn = (id: string, text: string, at: number, parts: Part[], extra: Partial<FixtureTurn> = {}): FixtureTurn =>
  ({ id, text, sentAt: at, finishedAt: at + 2_000, status: "done", attachments: [], parts, modelSteps: parts.length, error: null, ...extra })
export const hello = (): FixtureTurn => turn("hello", "", minutesAgo(30), [said("Hey Sam, happy Saturday. What can I do for you?")], { greeting: true })

const ago = (seconds: number) => Date.now() - seconds * 1_000
const appStep = (label: string, app: string, running: boolean, at: number) => ({ label, icon: "app", status: running ? "running" : "done", app, startedAt: at, finishedAt: running ? null : at + 2_000, updates: [] })
const computerStep = (updates: string[], running: boolean, at: number, extra: Record<string, unknown> = {}) =>
  ({ label: "Using the browser", icon: "computer", status: running ? "running" : "done", app: null, startedAt: at, finishedAt: running ? null : at + 5_000, updates, ...extra })
const working = (turnValue: FixtureTurn): FixtureTurn => ({ ...turnValue, status: "working", finishedAt: null })

export const scenarios: Record<string, () => FixtureThread> = {
  remote: () => ({ name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("remote-parent", "Check the browser changes on my Mac Studio", ago(400), [said("The checks are running on your Mac Studio. I'll reply here with the result.")], {
      tasks: [
        { id: "remote-parent.t1", title: "Watch the remote session", status: "working", startedAt: ago(300), finishedAt: null, update: null, updates: [], steps: [], stepsDone: 0, note: null },
        { id: "remote-parent.t2", title: "3D room planner", status: "stopped", startedAt: ago(13_000), finishedAt: ago(12_000), update: null, updates: [], steps: [], stepsDone: 0, note: null },
      ],
    })],
  }),
  /** Accepted, deliberately slow first token: the acknowledgement must not depend on a model response. */
  waiting: () => ({ name: "Workbot", organizationName: "Example Team", status: "busy", hasEarlier: false, filesEnabled: true,
    turns: [hello(), working(turn("w1", "Use the browser to open YouTube", Date.now(), [], { modelSteps: 0 }))],
  }),
  /** Hours-old stopped job must never hold the header or offer Stop. */
  stopped: () => ({ name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("s1", "Build a 3D room planner", ago(13_000), [said("I stopped the room planner.")], {
      tasks: [{ id: "s1.t1", title: "3D room planner", status: "stopped", startedAt: ago(13_000), finishedAt: ago(12_000), update: null, updates: [], steps: [], stepsDone: 0, note: null }],
    })],
  }),
  /** #6: Workbot searching YouTube in its browser, without showing its screen. */
  browsing: () => ({
    name: "Workbot", organizationName: "Example Team", status: "busy", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      working(turn("b1", "Find Chris Young's salmon tips, he has a thermometer", ago(70), [
        said("On it: I'll look through Chris Young's videos for his salmon advice and the thermometer he uses, and send you the best two with timestamps. A couple of minutes."),
        { kind: "steps", steps: [appStep("Searching Slack", "Slack", false, ago(65)), computerStep(["Opening youtube.com/results", "Searching YouTube"], true, ago(55), { surface: "browser" })] },
      ], { modelSteps: 2 })),
    ],
  }),
  /** Deterministic running task for preview ownership/control proofs; no external identity. */
  "browser-lifecycle": () => ({
    name: "Workbot", organizationName: "Example Team", status: "busy", hasEarlier: false, filesEnabled: true,
    turns: [hello(), working(turn("browser_live", "Open the project page in your browser", ago(10), [
      said("I'll open the project page in my browser."),
      { kind: "steps", steps: [computerStep(["Opening the project page"], true, ago(5), { surface: "browser" })] },
    ], { modelSteps: 2 }))],
  }),
  /** #9 and #10: a background task building an app, then a quick command on the computer. */
  task: () => ({
    name: "Workbot", organizationName: "Example Team", status: "busy", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("t1", "Code me an app that canothanize my Space in 3d", ago(140), [said("Fun one. I'll build you a 3D room planner.")], {
        tasks: [{ id: "t1.t1", title: "3D room planner", status: "working", startedAt: ago(135), finishedAt: null, update: "Building the planner", updates: ["Setting up the project", "Building the planner"],
          steps: [{ label: "Searching Google Drive", done: true, at: ago(130) }, { label: "Setting up the project", done: true, at: ago(110) }, { label: "Building the planner", done: false, at: ago(40) }], stepsDone: 2, note: "Planning the layout first: walls, then furniture you can drag." }],
      }),
      working(turn("t2", "This looks very ugly I also hate the way you show you're working on your computer", ago(20), [
        { kind: "steps", steps: [{ label: "Working on my computer", icon: "computer", status: "running", app: null, startedAt: ago(15), finishedAt: null, updates: ["Opening your screenshot"], background: true }] },
      ], { modelSteps: 1 })),
    ],
  }),
  /** Nov 8: "Could you go on google.com with browser", as the conversation is read once it is done (see googleAt). */
  google: () => googleAt(2),
  exa: () => exaAt(3),
  openwork: () => openworkAt(false),
  "openwork-live": () => openworkAt(true),
  connectors: () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("stack", "Find the UX research, check our design notes, and put the next steps in Linear.", minutesAgo(1), [
      said("I checked the research and your team's notes. The next steps are in Linear."),
      { kind: "steps", steps: ["Exa", "Exa", "Google Drive", "Linear", "Slack", "GitHub", "PlanetScale", "Research"].map((app) => ({ ...appStep(`Checking ${app}`, app, false, ago(20)), detail: "Read notes" })) },
    ])],
  }),
  /** Short and long messages from the person (#1, #2): "Hey" must stay on one line. */
  bubbles: () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("m1", "Hey", minutesAgo(6), [said("Hey! What's up?")]),
      turn("m2", "ok", minutesAgo(5), [said("👍")]),
      turn("m3", "Los notifs on the same image how the bubble seems a bit cut", minutesAgo(4), [said("Added as #2, using the same screenshot.")]),
    ],
  }),
}

/**
 * Ben's request of Nov 8 at each point the page reads it: 0, the call is being written and nothing is stored yet (the
 * live `working` events in GOOGLE_EVENTS are all the page has); 1, the browser call is stored and running; 2, done.
 */
export function googleAt(phase: 0 | 1 | 2): FixtureThread {
  const sent = Date.now() - 6_000
  const step = computerStep(["Opening google.com"], phase === 1, sent + 1_000, { surface: "browser", pages: [{ id: "g00gle", url: "https://www.google.com/", title: "google.com" }] })
  const parts: Part[] = phase === 0 ? [] : phase === 1 ? [{ kind: "steps", steps: [step] }] : [{ kind: "steps", steps: [step] }, said("Done: google.com is open in my browser.", 1)]
  const asked = turn("g1", "Could you go on google.com with browser", sent, parts, { modelSteps: phase === 0 ? 0 : phase === 1 ? 1 : 2 })
  return { name: "Workbot", organizationName: "Example Team", status: phase === 2 ? "idle" : "busy", hasEarlier: false, filesEnabled: true, turns: [hello(), phase === 2 ? asked : working(asked)] }
}

/**
 * Ben's request of Nov 8 at 7:33 ("could you use exa to search about best ux practices and skills"), in the shape
 * workbot-server builds from the runner's transcript for `mcp:<connection>:web_search_exa` calls: 0, the first search
 * is running; 1, the second; 2, both done while Workbot reads the results; 3, answered (also what a reload reads).
 */
export function exaAt(phase: 0 | 1 | 2 | 3): FixtureThread {
  const sent = Date.now() - 12_000
  const search = (running: boolean, at: number) => ({ ...appStep("Searching Exa", "Exa", running, at), detail: "Web search", site: "exa.ai" })
  const steps = phase === 0 ? [search(true, sent + 1_000)] : [search(false, sent + 1_000), search(phase === 1, sent + 4_000)]
  const parts: Part[] = [said("I'll search Exa for best UX practices and skills, then I'll come back with the useful bits."), { kind: "steps", steps }]
  if (phase === 3) parts.push(said("Here's what stands out: keep feedback immediate, show system status, and make every action reversible.", 2))
  const asked = turn("x1", "could you use exa to search about best ux practices and skills", sent, parts, { modelSteps: phase === 0 ? 1 : phase === 3 ? 3 : 2 })
  return { name: "Workbot", organizationName: "Example Team", status: phase === 3 ? "idle" : "busy", hasEarlier: false, filesEnabled: true, turns: [hello(), phase === 3 ? asked : working(asked)] }
}

/**
 * One answer that used connectors and OpenWork's own features, as the runner stores it: Exa, Google Drive, Linear,
 * then a skill, a plugin Workflow, an Automation, a background task and a remote task on the person's Mac Studio.
 * `live` leaves the remote task running. connector-steps.test.ts checks openworkAt against workbot-server's real
 * buildWorkbotTurns of this transcript (the fixture server runs without the development build of workbot-server).
 */
export function openworkSnapshot(live: boolean, sent: number): RunnerSnapshot {
  const id = "wb_ow1"
  const messages: RunnerMessage[] = [{ messageId: id, role: "user", text: OPENWORK_REQUEST }]
  OPENWORK_CALLS.forEach(([callId, name, input], index) => {
    const at = sent + 1_000 + index * 2_000
    messages.push({ messageId: id, role: "assistant", text: index === 0 ? "On it. I'll pull this together and set it up." : "", createdAt: at, toolCalls: [{ id: callId, name, input }] })
    if (!(live && callId === "c8")) messages.push({ messageId: id, role: "tool", callId, name, isError: false, createdAt: at + 500 })
  })
  if (!live) messages.push({ messageId: id, role: "assistant", text: OPENWORK_ANSWER, createdAt: sent + 20_000, toolCalls: [] })
  return {
    status: live ? "busy" : "idle", finalAssistantText: "", hasEarlier: false, messages,
    turns: [{ messageId: id, status: live ? "running" : "completed", createdAt: sent, updatedAt: sent + 21_000, error: null }],
  }
}
export const OPENWORK_CONNECTORS = new Map([["emc_01kexa7q2m", { name: "Exa", site: "exa.ai" }], ["emc_01klin42aa", { name: "Linear", site: "linear.app" }]])
const OPENWORK_REQUEST = "Make my weekly digest: research the format, use my notes and Linear, run it on my Mac Studio and schedule it."
const OPENWORK_ANSWER = "Done. Your weekly digest runs every Monday at 9, and the first draft is on its way from your Mac Studio."
const OPENWORK_CALLS: Array<[string, string, Record<string, unknown>]> = [
  ["c1", "execute_capability", { name: "mcp:emc_01kexa7q2m:web_search_exa", body: { query: "weekly digest format" } }],
  ["c2", "execute_capability", { name: "native:google-workspace:searchGoogleDriveFiles", query: { q: "digest" } }],
  ["c3", "execute_capability", { name: "mcp:emc_01klin42aa:list_issues", body: {} }],
  ["c4", "get_skill", { name: "weekly-digest-ksdx8c7f" }],
  ["c5", "execute_capability", { name: "plugin:plg_01k9:cfg_01k9", body: {} }],
  ["c6", "execute_capability", { name: "createCloudAutomation", body: { title: "Weekly digest" } }],
  ["c7", "start_task", { title: "Draft the weekly digest", brief: "…" }],
  ["c8", "execute_capability", { name: "remote-session:create", body: { target: "mac-studio" } }],
]
/** The steps workbot-server builds from OPENWORK_CALLS, in order (checked by connector-steps.test.ts). */
const OPENWORK_STEPS: Array<Record<string, unknown>> = [
  { label: "Searching Exa", app: "Exa", detail: "Web search", site: "exa.ai" },
  { label: "Searching Google Drive", app: "Google Drive", detail: "Search drive files" },
  { label: "Checking Linear", app: "Linear", detail: "List issues", site: "linear.app" },
  { label: "Reading a skill", app: "OpenWork", detail: "Weekly digest", site: "openworklabs.com", openwork: true },
  { label: "Using OpenWork", app: "OpenWork", detail: "Workflow or skill", site: "openworklabs.com", openwork: true },
  { label: "Setting up an automation", app: "OpenWork", detail: "Automations", site: "openworklabs.com", openwork: true },
  { label: "Starting a background task", app: "OpenWork", detail: "Draft the weekly digest", site: "openworklabs.com", openwork: true },
  { label: "Starting a remote task", app: "OpenWork", detail: "Remote task", site: "openworklabs.com", openwork: true, remote: true },
]

/** The page's view of openworkSnapshot: (Exa)(Google Drive)(Linear)(OpenWork), one OpenWork logo for all its features. */
export function openworkAt(live: boolean, sent = Date.now() - 30_000): FixtureThread {
  const parts: Part[] = []
  OPENWORK_STEPS.forEach((step, index) => {
    const at = sent + 1_000 + index * 2_000
    const running = live && index === OPENWORK_STEPS.length - 1
    if (index === 0) parts.push(said("On it. I'll pull this together and set it up.", 0))
    const value = { ...step, icon: "app", status: running ? "running" : "done", startedAt: at, finishedAt: running ? null : at + 500, updates: [] }
    const last = parts.at(-1)
    if (last?.kind === "steps") last.steps.push(value)
    else parts.push({ kind: "steps", steps: [value] })
  })
  if (!live) parts.push(said(OPENWORK_ANSWER, OPENWORK_STEPS.length))
  const asked = turn("wb_ow1", OPENWORK_REQUEST, sent, parts, { modelSteps: OPENWORK_STEPS.length + (live ? 0 : 1), finishedAt: live ? null : sent + 21_000 })
  return { name: "Workbot", organizationName: "Example Team", status: live ? "busy" : "idle", hasEarlier: false, filesEnabled: true, turns: [hello(), live ? working(asked) : asked] }
}

/** What the page hears while the call is written, as workbot-server sends it: the start, then where, then what. */
export const GOOGLE_EVENTS = [
  { type: "working", messageId: "g1", step: 0, on: "computer" },
  { type: "working", messageId: "g1", step: 0, on: "computer", surface: "browser" },
  { type: "working", messageId: "g1", step: 0, on: "computer", surface: "browser", update: "Opening google.com" },
]
