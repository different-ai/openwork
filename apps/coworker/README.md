# Open Coworker

A standalone desktop app for persistent AI coworkers, powered by the OpenWork
platform. Open Coworker is a second product client, not a second platform: it
assembles existing OpenWork primitives into a coworker-centric experience and
adds no new database concepts.

## What a coworker is

```
~/.config/openwork/coworkers/<slug>/   ← via @openwork/paths openworkConfigDir()
├── AGENTS.md          coworker contract: conduct + memory maintenance duties
├── opencode.json      instructions: soul.md, memory/working.md, memory/index.md, documents/index.md, team/roster.md
├── coworker.md        app-owned profile, workspace id, model + reasoning preference, catalog role, who proposed it
├── discussions.json   which native threads are discussions (the open one is in coworker.md)
├── local-responsibilities.json  local schedule and run state
├── workers.json       which native threads belong to Workers
├── workers/<id>/      one Worker: worker.json (goal, lifespan, status) + findings.jsonl
├── soul.md            stable identity, loaded every turn
├── memory/
│   ├── working.md     active memory the coworker itself edits while working
│   ├── index.md       always-loaded map of long-term memories
│   ├── long-term/     durable Markdown memories, read on demand
│   ├── changes.jsonl  recent changes to memory and soul, with the text before and after
│   └── style.jsonl    when a reply ran long with no document behind it
├── documents/
│   ├── index.md       always-loaded list of the documents in play
│   ├── <id>.md        a document: frontmatter + Markdown body
│   └── .history/      the last five revisions of each document
├── team/
│   ├── roster.md      always-loaded description of the teammates; written by the app, never by the coworker
│   ├── suggestions.jsonl  teammates this coworker proposed and how the person answered
│   └── referrals.jsonl    requests it offered to hand over and what the person chose
└── workspace/         the coworker's working area
```

The coworker directory is registered as an ordinary OpenWork workspace, so:

- **Threads are native sessions** in that workspace, created and driven through
  `@openwork/headless-threads` against the embedded server's workspace-scoped
  engine proxy. A thread made here opens in the OpenWork app unchanged.
- **A coworker holds several discussions at once.** Each discussion is its
  own native thread; `discussions.json` records which threads are discussions
  so none of them ever reads as an assignment, and `coworker.md`'s
  `conversationThreadId` points at the one that is open. The one conversation
  header carries the coworker (avatar, name, status) and, on its second line,
  the discussion switcher: it shows the current discussion's title, lists the
  others (a busy one reads "Replying"), and starts a new one from its menu. A
  discussion is titled after its first message (`session.update`; the engine
  keeps custom titles), and a reply in progress keeps going while another
  discussion is open. Each view places its own title line and actions (Back,
  Stop) into that header, so there is never a second header row. The header
  ends in one plain status word — Ready, Working, Retrying, Needs you,
  Stopped… — with no dot: mist unless the coworker is asking for the person
  (amber: Needs you, Waiting for permission, Waiting for an answer) or reporting
  a failure (rose: AI unavailable, Not responding, Reply failed, Response
  delayed). The moment-to-moment phases (Sending, Thinking, Using a tool) fold
  into Working there; the live row in the transcript owns those phrases, and a
  tooltip on the word adds the reason and the time ("Retrying after an
  interruption · since 7:40 AM"). An empty conversation shows only a small
  avatar, the coworker's name and role, one line ("What should we work
  through?", or, for a coworker a teammate proposed, "Nova suggested me — …"),
  and the focused composer; there are no starter cards. At the foot
  of the conversation column one discreet **summary line** on the composer's
  hint row says what the coworker holds — "2 assignments · 1 Worker · 3
  documents" (`lib/coworker-summary.ts`) — each part opening the matching level
  of the Activity panel; a coworker that holds nothing and has never finished
  anything shows no line at all.
- **Group chats put several coworkers in one conversation.** A group lives
  under `<coworkers home>/.groups/<id>/` as `group.json` (members, the native
  thread each member uses for it, the facilitator's thread, and the last 50
  turns) plus an append-only `timeline.jsonl` of what was said
  (`electron/groups.mjs`; bridge `groups.*`). The person writes once and the
  right coworkers answer one after the other, each a real turn in its own
  workspace on a group-specific discussion thread (registered in its
  `discussions.json`, so it never reads as an assignment) with its own model,
  memory, tools, and permissions. Every message opens one **turn record**
  (`turns[]`: the speakers in order, each with its status, thread, and plain
  reason) written through the store, so the view, a retry, and recovery all
  read one source of truth: a double Send never makes two turns, and a turn
  cut off by a quit or reload is settled at the next launch as `partial`
  with one quiet line ("Stopped when the app closed before Editor replied.")
  and a **Continue** control; a coworker that could not reply gets **Retry**
  (and **Choose AI model** when the model is the likely cause), and nobody
  who already replied is ever asked again. One coworker failing, timing out
  (180 s), or being stopped never blocks the next; **Stop all** aborts the
  in-flight native turn and marks the rest stopped.

  A **silent facilitator** decides who answers (`lib/facilitator.ts`): once
  per message it is told the members with roles, missions, and who is busy in
  another group, a bounded visible transcript, the earlier speaking orders,
  and the message with its mentions, and answers with one strict JSON plan —
  speakers in order with a one-sentence brief each, sequential or parallel,
  dependencies, at most one follow-up where a coworker responds to another,
  and a wrap-up only when it asks for one. The plan is validated (unknown or
  duplicate coworkers, the wrong count, a set that ignores the person's
  mentions, or a dependency pointing the wrong way are rejected), repaired
  once with the reason fed back, tried once more on the next connected model,
  and otherwise replaced silently by the deterministic role-and-mission
  scorer (`lib/groups.ts`). Mentions still rule: one `@name` skips routing,
  several names keep the set and let the facilitator order it, `@everyone`
  includes all; without a name the default is one speaker, never more than
  three. It runs in a hidden, tool-less coordinator workspace
  (`<coworkers home>/.coordinator/`, `electron/coordinator.mjs`: every tool
  off, permissions denied, no MCP, no memory, no `coworker.md` so it never
  appears in the rail) on one native thread per group, on the model the
  group's coworkers already use (account models first; per group under Group
  details › Advanced). Nobody ever sees its words: the person sees "Choosing
  who should respond…", then "Scout is replying… then Editor".

  Each speaker's prompt (`groupSpeakerPrompt`) carries the room, the last
  visible lines (never status lines, reasoning, or tool payloads), every
  earlier reply in this turn with its speaker's name, its own part from the
  facilitator's brief, and the message; it is asked to add something new for
  the person and may answer exactly `Nothing to add.`, which the group shows
  as a quiet line rather than a bubble. Independent parallel replies still
  settle into the timeline in the facilitator's order. The composer keeps
  working while a turn runs (the message goes **Next**; a message naming one
  coworker waits as that coworker's own next turn), `@` offers member names,
  and the same `+` control turns a message into an assignment: the person
  says what someone should own, a lettered choice card asks who (the best
  match by role proposed first), the assignment is created in the owner's
  workspace with the signed visible conversation as context, and one action
  line ("Assignment for Editor · Draft the launch note") opens it. Groups are
  created from the rail's `New group chat` (at least two coworkers, a name
  suggested from roles); the header's overflow renames, opens **Group
  details** (name, members — changes apply to the next message — the
  who-answers AI model under Advanced, archive) or archives; a group is never
  deleted and a running turn keeps going when another view is open.
- **Identity and memory ride the engine's existing instruction loading**
  (`AGENTS.md` + `opencode.json` `instructions`); the coworker maintains
  `memory/working.md`, its long-term memories, and its soul through its own
  memory and soul tools (see below) or ordinary file tools. No memory backend. The app
  shows memory as structure rather than raw files: Soul and Working memory
  render as pages with an editor behind them, and Long-term is the list the
  index describes (`electron/memory-index.mjs` parses the bullets a model
  actually writes), joined with the files on disk so an unlisted file or a
  dangling index line stays visible. A memory can be read, edited, created,
  or deleted; deleting removes the file and its index line together.
- **Assignments on a schedule (responsibilities, in the code) have two explicit
  placements.** The person meets them in the Activity panel's Assignments
  level, below the one-off assignments handed over from a discussion.
  OpenWork Cloud is the recommended always-on lane: scheduled assignments are native Den Automations
  created through the Cloud creation surface (`POST /v1/cloud-automations`),
  so Den fixes their placement to OpenWork Cloud, they keep running with this
  Mac off, and they use a model the organization authorizes
  (`GET /v1/llm-providers` plus the free starter, resolved in
  `src/lib/cloud-responsibilities.ts`). Because they execute in OpenWork
  Cloud they cannot read the coworker's local files or memory; the UI says so
  and labels any older desktop-placed Automation honestly (those run only
  while the OpenWork desktop app is open — Open Coworker hosts no desktop
  runner). Association stays in `coworker.md`. This Mac is a local-first
  lane: schedules reuse `@openwork/automations` occurrence rules (widened
  locally by an interval and a custom timetable, see "Scheduling from the
  chat"), persist beside the coworker, and create native OpenWork threads
  through `@openwork/headless-threads`. Local responsibilities run while Open
  Coworker is available and recover at most one missed occurrence after
  relaunch; they do not pretend to be always-on Cloud work.
- **Workers are long-lived helpers a coworker runs for one goal.** A Worker is
  a native thread in the coworker's own workspace — same files, memory, tools,
  and permissions — started for a goal that outlives one reply (watching
  something over time, a long research pass, a multi-step job) with a lifespan:
  a number of turns (default 10), a time, or until stopped. It works in bounded
  turns and ends each with a *Finding*, a *Needs a decision*, or *Done*, which
  the app reads back into `workers/<id>/findings.jsonl`; every turn takes a
  slot on this Mac like a responsibility run and releases it when it settles,
  so Workers and scheduled runs wait in one line (`electron/workers.mjs`,
  `electron/main.mjs`). Each finding wakes the coworker: findings queue per
  coworker and, at most once a minute, become one ordinary turn in its open
  discussion listing the Workers and their updates; the transcript folds that
  turn into the action line ("Reviewed an update from Market scan") beside
  whatever the coworker did about it. The coworker starts, steers, and stops
  Workers through its own tools (`worker_spawn`, `worker_steer`,
  `worker_cancel`, `workers_list`, `worker_findings`, served by the same
  loopback MCP server as its document tools); the person does the same from
  the Activity panel's Workers level — flat rows opening into the findings timeline,
  Steer, Pause/Resume, Stop, and Open its work (the Worker's thread, read-only)
  — and starts one with New Worker. At most three Workers are live per
  coworker; a Worker never starts a Worker. `workers.json` keeps Worker threads
  out of discussions and assignments; a Worker left mid-turn by a quit resumes
  on the next launch and waits its turn like any run.
- **Skills and MCP** come for free from the same engine configuration layering
  the OpenWork desktop uses.
- **Personality is a voice, not a behavior.** Each coworker can have a
  personality (`coworker.md` `personality`: none, neutral, warm, calm,
  eager, playful, dry, blunt, curious, thoughtful, meticulous, detective) —
  temperaments, not job titles.
  It only changes what the interface says while the coworker is working —
  the rail label, the Now card note, and the quiet moments in the thread —
  from a pre-written set of sayings in `src/lib/personalities.ts` that
  rotate deterministically per coworker and thread. It never changes how the
  coworker works or writes, and truthful states (Needs you, Retrying, tool
  labels) always win. "None" keeps plain status text everywhere.
- **Retirement is recoverable.** Retiring a coworker deregisters its workspace
  and moves the whole home to `~/.config/openwork/coworkers/.retired/<slug>-<timestamp>/`
  with `retiredSlug`/`retiredAt` recorded in `coworker.md`. Nothing is deleted;
  the Add coworker screen lists retired coworkers with Restore (re-registers the
  same path, so the workspace id and native threads reattach) and a separately
  armed permanent delete. Retirement is refused while one of the coworker's
  scheduled assignments or Workers is still running.

## Documents and how coworkers talk

A coworker answers like a colleague in a chat, not like a report: the point
first, two to four sentences, at most three highlights, rarely more than about
120 words. When the answer needs more than that — a plan, a comparison,
research, a draft, a summary of many things — the coworker writes or updates a
**document** in the same turn and answers with the short version, naming the
document. The person is never buried in text and always has one clean place to
read more.

- **The coworker's document tools** are served by the app itself: the Electron
  main process answers MCP over loopback HTTP (`electron/coworker-tools.mjs`)
  and registers that endpoint in each coworker workspace like any remote MCP,
  with a per-coworker bearer token that names the coworker (so no tool takes a
  coworker id from the model). The tools are `documents_list`,
  `document_create { title, summary, highlights, body }`, `document_update`
  (a whole body, or `patch: { heading, content }` to replace one `##` section),
  `document_read`, `context_set { active, aside }`, and `document_archive`
  (only when the person asked for it). Each returns one plain sentence plus the
  card fields. Ids come from titles (`launch-plan`), writes are atomic, and a
  body that looks like it carries a credential is refused with a sentence the
  coworker can act on.
- **Active context.** `documents/index.md` lists the active set (`- <id> —
  <title> — <summary>`) and is loaded every turn beside `memory/index.md`, so
  the coworker always knows what it has. Every time it creates or refreshes a
  document it reconsiders the set with `context_set` and puts aside what the
  current work no longer needs (about five stay in play). Coworkers never
  archive on their own. A document the person edited is marked in the index so
  the coworker asks before rewriting it.
- **The Documents level** of the Activity panel (reached from Activity's
  Documents row or the summary line's "n documents"; a small dot on the
  Activity strip icon, the row, and the line marks documents changed since it
  was last opened) shows two flat groups — Active by last update and Put aside,
  closed by default — plus Archived behind a quiet link. A row is title, one-line
  summary, when, and *by <coworker> / by you*. Opening a document shows a
  reading header (title, updated, revision) over Markdown rendered for reading
  (`lib/document-markdown.ts`: a 68ch measure, stable heading ids with a quiet
  table of contents at three or more sections, tables, task lists, code with
  Copy, `> **Note**` callouts, images only from inside the coworker home,
  `doc:<id>` links between documents, raw HTML shown as text) with Edit in
  place (saved as the person's revision), Ask <name> to update (drops
  `Update "Title" with …` into the composer), Put aside / Make active, Copy,
  Export to a chosen `.md`, History (revisions with a side-by-side line diff
  and Restore), Archive, and — when the window is wide enough — Open beside, a
  reading pane in a second column next to the conversation.
- **The card in a bubble.** When a reply's turn created or updated a document,
  the bubble ends with a compact card — title, summary, up to three
  highlights, Open — built from the tool calls (`lib/documents.ts`), so no
  Markdown from the model is needed; an update reads *Updated · Timeline
  section*. Receipts say *Wrote a document · Launch plan*, *Updated Launch plan
  · Timeline section*, *Put aside · Old vendor notes*.
- **Soft enforcement.** A finished reply longer than about 1,200 characters
  with no document call in its turn renders as its first paragraph behind a
  quiet **Show the rest**; nothing is cut. The app records it in
  `memory/style.jsonl` and the index carries a one-line reminder of the
  contract until the coworker next writes a document.
- **The contract** lives in the coworker's `AGENTS.md` (`## How I talk`, with
  three before/after examples: a research question, a plan request, a quick
  question that needs no document). It is versioned and regenerated on launch
  for existing coworkers without touching `soul.md` or anything under
  `memory/`; the repair also adds `documents/index.md` to `opencode.json`'s
  instructions and creates the index when it is missing.

Prove it with the packaged app:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="apps/coworker/dist-electron/mac-arm64/Open Coworker.app/Contents/MacOS/Open Coworker" \
  pnpm evals:e2e open-coworker-documents --local
```

## When a reply doesn't come

A turn that does not simply reply is still part of the conversation — one
small line or one coworker-side bubble in the flow, never a wide card. What
the conversation says is derived from one place, `lib/turn-outcome.ts`: the
turn in flight (`turns.json` beside `coworker.md` records it per thread), what
the engine reports (idle, busy, or retrying with its next attempt), the reply
it holds for that message, and the wait budget. The header status, the rail
line, Activity's Now card, and the journeys read the same value.

- **Working** is the live row: a small avatar, three dots, and one phrase that
  changes only with the phase ("Nova is thinking…"). Tap the phrase when you
  get impatient and one discreet gray line below shows the end of what is
  streaming right now — the words being written, the thinking, or the tool
  step — live from the engine's events (the thread itself only carries a text
  or reasoning part once it has ended); it hides itself after twelve seconds,
  or on a second tap.
- **Still working** is not a failure. When two minutes pass while the engine
  is still busy, the phrase softens to "Nova is still working on it…" and gains
  one inline *Stop*; the header and rail say *Still working*. Only the engine
  going idle without a reply ends the turn without one.
- **Retrying.** The engine retries a rate limit or a 5xx by itself and says
  when; the app shows "Couldn't reach the AI model. Trying again in 6 s…" with
  the count live and one *Stop*. When the engine gives up on a transient
  failure (network, a busy provider, a 5xx, the AI service restarting —
  `lib/turn-retry.ts`), the app tries again itself, three times at 2, 6, and
  15 seconds, under the same message id. Hard failures — a model that cannot
  use tools or is not available, a refused account, a denied tool — are never
  retried automatically beyond the one-time fallback to another connected
  model when the app itself had picked the failing one. A retry the engine
  pushes hours away (the free tier's daily usage) is a failure with the
  provider's words, not endless Retrying.
- **A failure** is one message on the coworker's side at the bubble's width: a
  headline in its voice ("Nova couldn't reach the AI model.", "Nova's AI model
  cannot use the tools enabled for this coworker."), one line of explanation,
  then lettered choices — `A Use <model>` when another connected model can take
  over, else `A Retry`; `B Choose AI model`; and `C Continue with OpenWork`
  (signed out) or `C Refresh providers` (signed in) when the model is the
  likely cause. Never more than three. An amber dot says it needs you; the raw
  text waits behind a closed *Technical details*. When the retry replies the
  bubble goes and, if the model changed, one line stays: "Retried with Claude".
- **Stopped.** The round send control becomes a stop control while a reply runs
  and the field is empty; the live row's *Stop* and the header's *Stop* do the
  same. Stopping leaves one quiet line — "Stopped." · *Retry* — and Retry runs
  the same message again under its own id, so it is never in the thread twice
  (`retryTurn` in `@openwork/headless-threads` removes the earlier attempt and
  prompts again). A stop pressed while the message is still on its way is kept
  and carried out as soon as the engine has the turn.
- **Cut off.** A quit or reload while a reply was on its way reads, on the next
  open, as "Stopped when the app closed before Nova replied." · *Continue* ·
  *Discard*; Continue finishes it under the same message id. If the engine is
  still on the turn when the window returns, the view simply follows it.
- **Next.** The composer never holds. Enter while the coworker works puts the
  message on **Next** — rows between the transcript and the field ("Next ·
  steers the reply that follows") with *Edit* (back to the field), *Remove*,
  and *Send now*, which stops the reply in progress and sends at once, leaving
  the stopped turn's one "Stopped." line where it happened. Next drains one
  message at a time, in order, as turns settle; it holds behind a failure or a
  stop until you choose, and it survives a reload and a coworker switch.
  Steering is a Next message: the engine takes a new prompt only at a turn
  boundary, so nothing is injected mid-generation.

Prove it with the packaged app (the scripted model is on the runner's
loopback, so this journey runs on the local lane by construction):

```bash
OPENWORK_EVAL_ELECTRON_BINARY="apps/coworker/dist-electron/mac-arm64/Open Coworker.app/Contents/MacOS/Open Coworker" \
  pnpm evals:e2e open-coworker-turn-recovery --local
```

## Architecture

- `electron/main.mjs` — standalone shell (own app id/userData; single
  instance). Boots the same `apps/server` embedded bundle the OpenWork desktop
  uses (`startEmbeddedServer`, managed OpenCode engine), against its own
  registry file `~/.config/openwork/coworker-server.json`, so both apps run
  side by side. Open Coworker never requires the OpenWork desktop process. The
  packaged main process is bundled into plain ESM so workspace TypeScript is
  never loaded from `app.asar` at runtime.
- `electron/coworkers.mjs` — the filesystem coworker store (pure Node,
  unit-tested).
- `src/` — Vite + React + Tailwind renderer: coworkers rail, coworker home
  (Work / Responsibilities / Memory), account connection, first-run choice,
  and connected-model selection.
- `src/lib/den.ts` — narrow Den client typed by `@openwork/types/automations`
  (sign-in handoff exchange + automations), resolving the API origin with the
  same deterministic rule as the OpenWork desktop (`api.<host>` for hosted
  OpenWork Cloud, `/api/den` proxy path for self-hosted Dens). Promoting the
  desktop's full Den client into a shared package is the designated follow-up
  extraction.

OpenWork Cloud is strongly recommended, but no longer required. First run
offers the same Den desktop sign-in handoff (open OpenWork in the browser,
copy the sign-in link, paste it here) or a local path with no account. Cloud
adds always-on responsibilities and shared organization settings; local use
keeps identity, memory, model preference, schedules, and thread execution on
this Mac.

## A team that grows

A new person never meets a blank form first, coworkers know who else is on the
team, and the team can grow from the conversation — while only the person's
tap ever creates a coworker.

- **Onboarding proposes a team.** After the account or local-mode step, *What
  will your team help with?* (`ui/onboarding-intents.tsx`) offers six roles —
  Research and synthesis, Writing and content, Operations and scheduling,
  Customer support, Sales and relationships, Product and engineering — picked
  one or more in order. *Meet your team* (`ui/onboarding-team.tsx`) then shows
  the coworkers proposed from the picks (`electron/team.mjs` `recommendTeam`:
  one intent brings its complement — Ops for everyone, Scout for Ops — two or
  three stand alone, more keep the first three) as live cards: tap the name to
  rename in place, remove (at least one stays), add another role. *Create my
  team* makes them one by one behind a calm preparation screen; the draft
  lives in session storage under a stable id (`lib/onboarding-team.ts`), so
  Back, forward, or a crash mid-way loses nothing and creates nothing twice,
  and one failure names the coworker and offers Retry or Remove from team
  without rolling the others back. The first coworker opens with the composer
  focused. Each coworker's working memory starts with one line — "Joined the
  team on Sep 3 to help with research and writing." — and `coworker.md`
  records its catalog role. *I'll add my own* skips the proposal for the blank
  Add screen. Existing installs are never routed through the steps; the Add
  screen offers up to three roles nobody covers yet as cards
  (`new-coworker-suggested`) that fill the form in, still editable. The §4
  connector grid, model disclosure, reordering, and a *Personalize your team*
  indicator for existing installs are not built.
- **Teammates know each other.** Every coworker home carries `team/roster.md`:
  who it is, its teammates one line each (name, id, role, mission; alphabetical,
  twelve then "and n more"), the roles the person declined in the last two
  weeks, and how to hand work over or propose a teammate. The app writes it
  whenever the team changes (create, a role or mission change, retire,
  restore, delete) and on launch; it is loaded every turn beside memory and the
  documents index and never carries another coworker's memory, documents, or
  conversation. Contract v5 (`## My team`) says when to use it: refer *before*
  doing a teammate's job when it is more than a quick answer, never in a group
  chat, suggest only when uncovered work keeps coming up or the person asks
  who could do it, never create, rename, or retire anyone, never more than one
  suggestion a day.
- **Three team tools** on the coworker's own server (`electron/team-tools.mjs`;
  `coworker_team_list`, `coworker_team_refer`, `coworker_team_suggest`). A
  referral names a real teammate (by name or id, never itself), carries the
  person's request in their words and one sentence of why, and is only an
  offer. A suggestion is guarded in the handler too, so a model that ignores
  its contract still cannot nag: a teammate who already covers the role
  answers "Editor already covers writing — offer to pass it to them instead",
  a role the person declined within fourteen days answers "don't bring it up",
  a second proposal in one day answers "you already suggested a teammate
  today"; none of those leaves a tile. Both offers are appended to the
  coworker's `team/*.jsonl` logs, and the person's answer is appended after.
- **Tiles like a shared contact** (`ui/team-cards.tsx`). A reply whose turn
  made an offer ends with a rounded tile after the bubble, the radius and width
  of a bubble: a live avatar, the name plate, role, mission, and small print
  ("Suggested by Nova · Customer support", "Editor could take this · Writing
  and content"). No buttons inside; the choice is a right-aligned pill row
  under it, and tapping a pill is the person's answer. **Add to team** creates
  the coworker the one way there is (`team.accept` → the same path as the Add
  screen), inheriting the proposer's model and remembering who proposed it and
  why; the rail gains the row without leaving the conversation, the tile flips
  to *Added to your team* with one **Say hi** pill, and the newcomer's empty
  conversation opens with "Nova suggested me — the support inbox comes up
  every morning." **Not now** keeps the tile as a quiet record and reaches the
  coworker through its team description. **Ask Editor** records the choice,
  switches to Editor, and sends the request as the person's own message with a
  brief (`lib/conversation.ts` `referralPrompt`: who passed it and why, at most
  three exchanges and 600 characters, never tool payloads or reasoning);
  Editor's transcript shows the person's words under a small *Passed from
  Nova* line (`parseReferralBrief`), and Nova's tile reads *Passed to Editor*.
  **Continue with Nova** sends "Go ahead, Nova." as the person's message and
  the contract tells Nova to do the work and not refer again. Letters A–D and
  Enter work as accelerators for the last open row, read only by assistive
  tech. A later message from the person closes open pills; the tile stays. The
  person's answers are restored after a reload from the logs (`team.states`);
  tiles come only from kept tool results (`lib/team.ts`), never from prose.
  Receipts read "Checked the team", "Offered to pass this to Editor",
  "Suggested a teammate · Care", "Checked the team · Editor already covers
  this" — never an id.

Proof: `evals/specs/open-coworker-team.e2e.test.ts` (a scripted model plays
both coworkers so every tool call is exact) plus the unit tests in
`electron/team.test.mjs`, `electron/team-tools.test.mjs`, `src/lib/team.test.ts`,
and `src/lib/onboarding-team.test.ts`.

## Local mode

*Use this Mac* (and the same screen under OpenWork › AI models) gets a person
without an account to a working coworker in a minute, using what they already
pay for. One component (`ui/local-providers.tsx`; the rules in
`lib/local-providers.ts`, detection in `electron/local-providers.mjs`) shows:

- **Found on this Mac** — one flat row per thing the app found, with one line
  saying what Connect does, and **Connect**. Detection is presence-only and
  runs when the screen opens and on Refresh, never on a timer:
  - *ChatGPT (signed in with Codex)* — Codex's sign-in file (`$CODEX_HOME` or
    `~/.codex/auth.json`) has ChatGPT tokens; when Codex kept an OpenAI key
    instead the row reads *OpenAI key (saved by Codex)*.
  - *GitHub Copilot (signed in on this Mac)* — a Copilot `hosts.json` or
    `apps.json` under the XDG config dir carries a github.com sign-in.
  - *Claude (signed in with Claude Code)* — `~/.claude/.credentials.json`, or
    on macOS the *Claude Code-credentials* keychain item. Shown without
    Connect: Claude subscriptions only work inside Claude Code, so the row
    offers **Add key** (an Anthropic key) instead.
  - *Ollama* / *LM Studio (running on this Mac)* — the server answers on its
    default port (Ollama honours `OLLAMA_HOST`; `LMSTUDIO_HOST` overrides LM
    Studio) with its model list. Each probe gives up after 200 ms.
  - Keys in the app's own environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
    `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `XAI_API_KEY`) are
    reported by name only; the AI service already uses them, so they appear
    under Connected as *From GEMINI_API_KEY in your environment* rather than
    with a Connect step.
  - Providers already connected in OpenCode's shared store are listed by id.
  A finding whose provider is connected moves out of Found; a Mac with nothing
  to connect shows one quiet line.
- **Connect** does the engine's own thing, in one step: a Codex or Copilot
  sign-in is handed to the AI service as the exact credential its own sign-in
  would have stored (`PUT /auth/{provider}`), a local server becomes a provider
  the AI service is pointed at, then every coworker workspace is reloaded so
  the models appear everywhere. The result is one line (*Connected. 13 models
  available.*); an expired Codex sign-in says so and offers the AI service's
  own sign-in instead. Sign-ins the engine offers (ChatGPT in the browser,
  GitHub Copilot's device code) render inline as a lettered card: the code,
  *Open browser*, *I've finished*, *Cancel*; the app polls the AI service until
  it reports the result.
- **Connected** — each connected provider on this Mac with where it comes
  from, its model count, and **Disconnect**. Disconnecting a credential the
  shared store holds first says, in one sentence, that OpenWork Desktop and
  OpenCode lose it too; a key from the environment cannot be disconnected here
  and says where to remove it.
- **A free model is ready now** — the free provider's default model (nothing
  to set up); the default until something else is connected.
- **Add another** — the well-known providers the AI service lists (OpenAI,
  Anthropic, Google, OpenRouter, GitHub Copilot, xAI, Mistral, Groq, DeepSeek)
  plus **Custom (OpenAI-compatible)**. A key provider asks for the key only;
  Custom asks for a name, the address, and an optional key, lists the models
  the server answers with before anything is saved, and lets the person pick
  one to start with. Everything derived (the compatible SDK, `/v1`, ids) stays
  under *Technical details*.
- One line at the top recommends *Continue with OpenWork* while signed out;
  it is dismissible for the session.

When nobody chose a model, `recommendModel` prefers the OpenWork account, then
a subscription or key on this Mac, then a local model server, then the free
model; a model chosen on the local mode screen before the first coworker
existed becomes that coworker's model. Existing coworkers keep their choice.

Sign-ins and keys go through the AI service's own credential store
(`~/.local/share/opencode/auth.json`, shared with OpenWork Desktop and the
OpenCode CLI on this Mac); servers added here live in Open Coworker's own
runtime provider config. The renderer never sees a stored secret: the main
process reads a sign-in file only to hand it to the AI service over loopback
with the owner token, keeps nothing, and logs ids only. A key the person types
travels once. The packaged journey uses fixtures with plainly fake values and
asserts none of them reaches the screen or the app log.

### Technical notes

Verified against the bundled engine (OpenCode 1.18.18) before building:

- `GET /provider/auth` lists sign-in methods per provider. `openai` offers
  *ChatGPT Pro/Plus (browser)* and *(headless)* (both `method: "auto"`; the
  headless one shows a device code), `github-copilot` offers a device flow
  with a deployment-type prompt (`inputs.deploymentType = "github.com"`), and
  `xai`, `poe`, `digitalocean`, `snowflake-cortex`, `gitlab` offer their own.
  **There is no Anthropic sign-in method**: Claude Pro/Max subscriptions
  cannot be connected through the engine, only an Anthropic API key. Claude
  Code is therefore detected but never offered for Connect.
- `POST /provider/{id}/oauth/authorize` returns `{ url, method, instructions }`;
  `POST /provider/{id}/oauth/callback` blocks until the flow finishes (it polls
  the device code or waits for the browser redirect on `localhost:1455`).
  The app runs it in the background with a 15-minute cap and reports through
  `localProviders.signIn.status`.
- `PUT /auth/{id}` stores `{ type: "api", key }` or
  `{ type: "oauth", refresh, access, expires, accountId? }` in
  `$XDG_DATA_HOME/opencode/auth.json` (`~/.local/share/opencode/auth.json`);
  `DELETE /auth/{id}` removes it (200 even when absent). Codex's
  `~/.codex/auth.json` tokens use the same OAuth client as the engine's own
  ChatGPT sign-in, so they import as that shape (`expires` from the access
  token's `exp`, else 0 so the engine refreshes first); a Copilot
  `oauth_token` imports as the refresh token with an empty access token, as
  the engine's own Copilot sign-in stores it.
- A stored credential is read when a workspace's engine instance is built.
  `POST /workspace/:id/engine/reload` normally skips when the runtime config
  fingerprint is unchanged (a store change is invisible to it), so it now
  accepts `{ force: true }`, and Open Coworker reloads every registered
  workspace after a credential change (the server re-attaches each
  workspace's tools as part of that reload).
- Keys in the engine's environment connect providers automatically
  (`source: "env"`); custom providers come from the embedded server's
  `PATCH /runtime-config/providers` (host token) as
  `{ npm: "@ai-sdk/openai-compatible", name, options: { baseURL }, models }`,
  which the server writes into the engine's `OPENCODE_CONFIG` and reloads.
  Ollama serves an OpenAI-compatible API at `<host>/v1`; LM Studio at
  `http://127.0.0.1:1234/v1`. Known models.dev ids (`lmstudio`) would merge
  phantom default models, so local servers use `ollama` and `lm-studio` and
  custom servers `custom-<slug>`.
- The engine spawns before any coworker exists by registering the hidden
  coordinator workspace, so the local mode screen has a live catalog during
  onboarding; registering the first workspace restarts the platform, which may
  move its port — `localProviders.prepare` returns the live address.
- `GET /config/providers` returns only the connected providers (the same
  `Provider` shape and defaults as `GET /provider`, which also carries every
  provider the engine knows: 5.7 MB and 7,400 models against about 5 KB). The
  model catalog, the connect-time polling, and Disconnect read the small one;
  only the local mode screen's *Add another* list and the key check read the
  full one.
- `GET /session/status` is the cheap read that says whether a turn is still
  running; the shared `@openwork/headless-threads` poller reads only that while
  a thread is busy and the full snapshot (session, messages, todos) once the
  status says the turn may be over, so a long turn no longer re-reads its
  growing transcript every poll (in the view, in group chats, and for every
  responsibility run and Worker turn in the main process). In the view, the
  engine's `message.*` events collapse into one refresh per 250 ms; questions,
  permissions, and status changes still refresh at once.

## Review / develop

```bash
pnpm --filter openwork-server build        # once: the embedded platform bundle
pnpm --filter @openwork/coworker dev       # Vite + Electron (builds server bundle if missing)
pnpm --filter @openwork/coworker test      # store + platform integration tests (node --test)
pnpm --filter @openwork/coworker typecheck
pnpm --filter @openwork/coworker build     # renderer bundle
pnpm --filter @openwork/coworker package:electron:dir # unpacked native app
pnpm --filter @openwork/coworker installer:background # regenerate the macOS DMG artwork
pnpm --filter @openwork/coworker package:electron     # platform installers
```

The macOS DMG is an Open Coworker-owned installation surface rather than the
electron-builder default: two quiet installation stations hold the native app
and Applications icons while three small, tilted coworkers carry the eye
across the drag path. Its source artwork is flat SVG (no gradients or raster
effects) under `resources/installer/`; `installer:background` renders the exact
760×500 PNG consumed by electron-builder.

The packaged local-first journey is a canonical `@openwork/testkit` spec. On
macOS, prove the exact unpacked binary with:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="apps/coworker/dist-electron/mac-arm64/Open Coworker.app/Contents/MacOS/Open Coworker" \
  pnpm evals:e2e open-coworker-local-first --local
```

The other journeys (`open-coworker-discussion`, `open-coworker-assignments`,
`open-coworker-mcp-apps`, `open-coworker-openwork-account`,
`open-coworker-self-memory`) run the same way. `local-first`, `self-memory`,
`mcp-apps`, and `openwork-account` host a deterministic model, Den, or MCP
fixture on the runner's loopback, which a sandboxed app cannot reach, so they
run on the local lane by construction.

First run: choose OpenWork Cloud or local mode, name a coworker, then give it
work. Identity and memory are plain files under `~/.config/openwork/coworkers/`.
The right panel starts folded to its icon strip on every launch and closes
again when you move to another coworker; a strip icon or a click on its edge
opens it, and Escape or the same edge closes it (its width and last view are
remembered, whether it was open is not). The strip is **three icons** —
Activity, Memory, Coworker settings (`lib/panel-views.ts`) — each with a
tooltip that says what the view shows in the coworker's name ("Activity — what
Editor is doing now, recently, and the assignments, Workers, and documents it
holds"; the one `Tooltip` primitive in `ui/kit.tsx` and the copy in
`lib/tooltip.ts`). Open, Activity is flat rows with hairlines and no card
inside the panel: what the coworker is doing now (the subject as a line that
opens its thread, a note underneath, the time at the right — never the status
word the header already shows), then three count rows — Documents, Workers,
Assignments ("3 documents ›", "1 Worker ›", "2 assignments ›") — that each
open a **level** of Activity, then Recent. The Documents level is the
Documents view above; the Workers level holds the coworker's Workers only; the
Assignments level holds every one-off assignment (newest first, with New
assignment) followed by the ones on a schedule (with Add assignment). Its AI
model, thinking effort, memory files, Apps & tools, and retirement live under
the strip's Coworker settings icon.

The panel keeps a **route** (`lib/panel-route.ts`): one view and a short path
inside it, at most root → level → group → item, remembered per view for the
session. Its 78 px header band shows breadcrumbs — the root and each level as
buttons, the current one in white; narrower than 380 px, or when the trail is
long, the middle folds into `…` with a menu of the skipped levels — and one
back control that names the level it returns to (*Back to Apps & tools*). Back
is that arrow, `⌘[` / `Alt+←`, or a two-finger swipe right on the panel;
Escape goes back one level and closes the panel only at a root; the strip icon
of the view already showing goes to its root, another view opens where it was
last. Each level slides in over about 160 ms (none under reduced motion),
keeps its own scroll position, and hands focus back to the row it was opened
from. Any part of the app can open a route with `openPanelRoute` — a receipt
step that used a tool or an App opens that item under Coworker settings ›
Apps & tools, and the composer's summary line opens the Activity level it
counts. Below 900 px the open panel lies over the conversation behind a scrim.
A discreet OpenWork control in the bottom-left rail opens the full-window
global settings (account, AI models, AI & local setup) without taking space
from the thread. That surface reads the active connected-provider catalog, so
OpenWork model and provider changes stay visible without a second settings
store. User-facing copy says "AI model", "AI providers", and "AI is
ready/unavailable"; the word "engine" is reserved for developer-facing
documentation, diagnostics, and code.

Both side panels resize by dragging their inner edge and fold away when dragged
narrower than they can usefully be; a plain click on that edge folds or unfolds
them, so there is no separate fold button (the keyboard still nudges, folds
with Home, and resets with Enter). The folded team
rail keeps every coworker as an avatar with a bottom status dot, marks the
active one, and shows a hover card naming what that coworker is doing; the
folded context panel keeps Activity, Memory, and Coworker settings as icons
that unfold straight into the chosen view. Widths are remembered per machine;
the team rail also remembers whether it was folded.

Signing in also brings OpenWork Connect to every coworker: the app mints the
same short-lived gateway token the OpenWork desktop uses (`POST /v1/mcp/token`)
and registers the `openwork-cloud` gateway in each coworker workspace through
the embedded server's reconcile route, so the coworker gains
`search_capabilities` / `execute_capability`, remote skills such as
create-skill, and the organization's Apps (discovered through the gateway's
connection index and rendered with the standard MCP App host). Signing out
removes the gateway again. The packaged app ships the engine's OpenWork plugins
under `Resources/opencode-plugins`, as the desktop does.

## Apps & tools

Apps & tools is the first row of Coworker settings and a small navigable
surface inside the panel — tap in, read, tap back — never one long page of
everything (`ui/capabilities.tsx`, levels in `lib/apps-tools.ts`, states in
`lib/connection-words.ts`, the Connect catalog in `lib/connect-catalog.ts`).
Its trail starts *Coworker settings › Apps & tools*, so an item sits at the
panel's fourth level (root → level → group → item). Its root is three flat
rows, each with an icon, a title, one status line, a count, and a chevron:

- **Connected with OpenWork** — *Connected as <org>*, *Not connected*, *Needs
  sign-in*, *Needs setup by an admin*, *Needs attention*, or *Unavailable*,
  mapped from the gateway's own health (a lapsed token is a sign-in; revoked
  membership, disabled agent access, or the wrong organization needs an admin;
  anything else offers Repair). Signed out, its screen is the OpenWork Connect
  explanation as a first step (Continue, Skip, "don't show this again"), then
  the short card. Signed in, the screen leads with *Ask <coworker>* and *Create
  a skill*, then four rows: **Apps** (gateway Apps that render inline),
  **Skills** (built in and from marketplaces, read from the gateway's skill
  index through `GET /experimental/connect/skills`), **Plugins & marketplaces**
  (each plugin lists its skills and the services it uses with their readiness in
  plain words and the step that unblocks them), and **Connections** (each
  organization connection with its live status and the exact human step —
  naming your Connections page, the organization's Connections dashboard, or the
  provider's own console — from the gateway's connection-status results). The
  gateway has no "list everything" call, so plugin readiness and connection
  statuses come from its search with four keyword variants, merged and cached
  once per session and coworker; Refresh reads again. The live status always
  wins: a connection the catalog reached but the gateway says needs a person
  reads as the gateway says.
- **Apps** — everything that renders inline, from any source, with a source line
  (*OpenWork Connect* or *<tool> on this Mac*). A detail offers **Open** (the
  App mounts in the panel through the standard MCP App host), **Open beside**
  when the window has room, **Ask <coworker>** (a prefilled assignment), and a
  *Technical details* fold with the source, tool, and resource.
- **Tools on this Mac** — the servers the person set up (the gateway and the
  app's own document tools are not listed), each with its state in plain words
  — *Connected*, *Not connected*, *Needs sign-in*, *Needs setup*, *Connecting*,
  *Off* — read from the workspace config, the managed sign-in, and the AI
  service's own report, in that order of authority, plus a tool count. A detail
  says what the server offers by its own titles and descriptions (the embedded
  server's `GET /workspace/:id/mcp/:name/tools`), lists its Apps, offers *Ask
  <coworker> to use it*, explains a disconnected state, and keeps identifiers
  and raw errors behind *Technical details*.

Search is one field in the content, not the header (`⌘F` focuses it while the
panel is open). At the root it searches everything and groups the results
(Apps, Skills, Plugins & marketplaces, Connections, Tools on this Mac); inside
a level it scopes to that level with one tap to *Search everywhere*; a result
opens its item with the trail built as if navigated. Empty levels are quiet
lines ("Nothing set up on this Mac yet."), loading lists are skeleton rows, and
only the root's refresh icon ever spins.

**Open beside** puts an App or skill detail in a column of at least 480 px next
to the conversation while the panel returns to its list. It is offered from
1,280 px on and only while the conversation keeps its own minimum width beside
the rail, the panel, and the column; when the window shrinks below that, the
column folds back into the panel at the same route. It is closed by default and
never restored on launch; closing it returns focus to the row it came from.
Rows are buttons in a list: arrow keys move between them, Enter opens, Back
returns focus to the originating row, and only one level is ever in the DOM.

The first screen carries a small mascot (`ui/onboarding-mascot.tsx`) with the
app icon's composition — the flat white Open Coworker bubble in front of one
charcoal card. Once per session the front card settles into place, two visiting
coworkers slide out from behind it (pale mint to the upper left, pale violet to
the upper right, about three quarters of the front's size, seven degrees), hold
while everyone blinks once in a stagger, and slip back; the whole welcome takes
about 2.3 seconds and never loops. Afterwards only the front card's existing
pointer gaze remains, within the icon's restraint (pupils ≈2 px, turn ≤0.8°,
travel ≤1 px). The box never changes size, the stack takes no pointer events,
and reduced motion renders the icon composition at once. The new-coworker
preview reuses the component with the coworker being created in front. The app
icon itself is one coworker over one charcoal card on the OpenWork-blue tile
(`resources/icons/open-coworker-app-icon.svg`); every raster is regenerated from
it with `pnpm --filter @openwork/coworker icons:render`.

The avatars' always-on idle motion (an 8.8 s float of 0.8 px and turns of about
a pixel, staggered per coworker) is drawn in six steps per movement rather than
at every frame: a continuously moving avatar forces the vibrancy window to
recomposite at 60 fps, which with three or four coworkers on screen cost most
of a CPU core while the app sat idle (renderer 25%, GPU process 61%); stepped,
the same motion idles near the floor (about 5–10% each), with brief spikes only
when a coworker actually blinks or glances. Blinks, idle glances, and pointer
gaze keep their smooth curves. Idle glances are skipped while the window is
hidden or covered, so a journey brings the window to front before waiting for
one.

Coworker settings lay out as rows on the panel — Apps & tools first (the level
described above), then an identity row, Profile (look, glasses, role, mission,
personality) as hairline-separated rows, the AI model, Memory, and a quiet
Retire row — with Save appearing only when something changed; no card sits
inside another card.

Thinking and tool work fold into two quiet lines above a reply: provider-returned
thinking becomes a borderless "Thought through" disclosure once the reply is
complete, and all the tool calls behind one reply become one work receipt
("Edited index.md", "Worked with your files and Calendar · 3 steps") that opens
into plain-word steps with the tool name behind Technical details
(`lib/work-receipt.ts`). Documents and Apps the work produced stay first-class
as compact attachment chips beneath the receipt. While a turn runs, one live row
carries the moving state — a small avatar, three dots, and one phrase that
changes only with the phase ("Nova is thinking…", "Nova is editing index.md…",
"Nova is putting it together…"). Consecutive messages from the same speaker
drop the repeated avatar and name and sit closer together.

The message that opens an assignment carries scaffolding for the model (the
outcome, the visible discussion it came from, and a short instruction); the
person sees it as a brief — "Assignment for Nova", the outcome, and a closed
"From your discussion · n messages" disclosure — never the headings or the
instruction (`parseAssignmentBrief` in `lib/conversation.ts`). The engine still
receives the exact prompt the journeys verify.

Scheduled assignments read like a to-do list for a person: one line per
assignment (its name, then "Every day at 9:00 AM · Done today at 12:05
PM") that opens into labelled everyday facts — When, Where, Next, Last time,
what the coworker said — and each earlier run in the same words. The
vocabulary is shared with the sidebar's Recent list (`lib/responsibility-copy.ts`,
`lib/run-history.ts`): Done, Didn't finish, Working on it, Waiting its turn;
schedules show the person's clock and name another time zone only when the
schedule keeps one ("Every day at 6:30 PM (Paris time)"); nothing in the list
says slot, thread, UTC, or a status code.

Each scheduled assignment's row keeps a bounded run history (`runs`, newest first, in
`local-responsibilities.json`) with the coworker's own closing summary, the
duration, and how the run came about; a run can be re-opened as its native
thread or handed to the discussion composer as an "explain this run" message
that the person still sends. Runs on this Mac respect a shared limit stored in
`coworker-settings.json` (`maxParallelLocalRuns`, 1–8 with choices
1 · 2 · 3 · 4 · 6 · 8, default 2, editable under AI & local setup); later runs
are recorded as `queued` and start by themselves when a slot frees, and a
failed run with a thread can be resumed inside that same thread. OpenWork Cloud
schedules its own runs.

## Scheduling from the chat

A person can say *"every weekday at 9 remind me to move the car"* or *"check
the competitor page every 2 hours during the day, at most 4 times"* and the
coworker sets it up itself. The assignment tools — `assignments_list`,
`assignment_create`, `assignment_update`, `assignment_run_now`,
`assignment_remove` (`electron/assignment-tools.mjs`) — ride the same loopback
MCP server as the document and Worker tools (`electron/coworker-tools.mjs`):
one bearer token per coworker, every request bound to the coworker that token
was minted for, registered in the workspace as the remote MCP server
`coworker` on creation and repaired on every launch. They work on the same
local store and run gate the panel uses; nothing is stored twice. Placement is this Mac unless the person is
signed in and asks for OpenWork Cloud, which keeps the shared daily / weekly /
once contract (the tool says so when asked for an interval there). Tools
answer in plain words plus ids, and a refusal is a sentence the coworker
relays.

Schedules on this Mac are a superset of OpenWork's shared contract
(`src/lib/local-schedule.ts`, pure and shared by the main process and the
renderer): `once` / `daily` / `weekly` as before, plus `interval` (every 1, 2,
3, 4, 6, 8, or 12 hours, an optional active window, optional days, the most
runs a day — default 4) and `cron` (a five-field expression read in the
coworker's time zone, plus the most runs a day). Daylight-saving gaps shift
forward to the next valid minute; a repeated hour takes its first instance; a
missing time zone is filled from the coworker's own, never invented. Two
guardrails in `coworker-settings.json` — `minimumRunGapMinutes` (15, 30, or 60,
default 60) and `maxRunsPerDay` (default 4) — refuse a schedule with a sentence
before anything is created, in the form and in the tool alike. The shared
`@openwork/types` contract is untouched.

In the conversation each call reads as what it did, between the bubbles:
*"Created assignment · Move the car · Every weekday at 9:00 AM"*, *"Changed
Move the car to every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a
day"*, *"Paused Move the car"*, *"Removed Move the car"*; the tool id waits
behind Technical details. The same words describe the schedule in the panel
(`describeScheduleForPeople`): a custom timetable shows its plain reading when
it has one (*"Every weekday at 9:00 AM"*), otherwise *"On a custom timetable"*
with the expression under Technical details. The panel form offers the
interval (every N hours, window, days, most runs a day) beside Daily and
Weekly and shows the schedule, or the guardrail sentence, inline before
creating. When the cadence is ambiguous the coworker asks with the question
tool, which renders as the lettered choice card.

## Memory and soul the coworker keeps

As the person talks (*"call me J"*, *"I work in Product"*, *"be shorter"*,
*"never email customers without asking"*), the coworker records what will
matter later with the self tools on the same server — `memory_remember`
(kind `working` for what the current work needs, `long-term` with a topic for
what stays true), `memory_forget`, `soul_update` (one change inside one of the
four soul sections: Role, Mission, Principles, Communication — add, replace,
remove, or rewrite — never touching another), and `self_read` (its own files
back, so *"what do you know about me?"* is answered honestly). The coworker
contract (`AGENTS.md`, refreshed on launch for existing coworkers without
touching their soul or memory) asks for this in the same turn the person says
it, and to state a significant soul change in one sentence rather than ask.

Every write is atomic (temp file + rename), keeps the files small (working
memory is curated, capped, never appended blindly; a fact promoted to
long-term memory leaves working memory), and refuses secrets or credentials
with a sentence. Each change lands in `memory/changes.jsonl` with the prior
and new text (`electron/self-memory.mjs`), and the person's own edits from the
Memory view take the same path. The conversation shows each change as an
action line — *"Remembered · You work in Product"*, *"Moved to long-term
memory · …"*, *"Forgot · …"*, *"Updated how I work · Shorter replies"*,
*"Checked what I remember"*; a step that did not finish never echoes what it
was told. The Memory view keeps its Soul / Working memory / Long-term tabs and
adds *Recent changes*: flat rows, newest first, in the same words, each with
**Undo**, which restores the prior text and is itself a recorded change.
Existing or manually copied coworker directories are registered as native
OpenWork workspaces automatically when the app loads them; the manual prepare
action is retained only as recovery when registration fails.

The managed engine binary resolves from `OPENWORK_OPENCODE_BIN`, the packaged
target-specific OpenCode sidecar, or `opencode` on PATH, in that order. The
Electron build mirrors the embedded server's runtime dependencies, prepares
the same versioned sidecar used by OpenWork Desktop, and includes both as
application resources.
