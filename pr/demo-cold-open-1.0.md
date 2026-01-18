# PRD — Cold Open Demo 1.0: Montage + Scripted Scenario (OpenWork)

- Status: Draft
- Owner: OpenWork
- Last updated: 2026-01-17

## Product Truth (One Sentence)
OpenWork should feel like a calm, premium assistant that can run real tasks across files, tools, and time, and the demo must show that in under 60 seconds without relying on fragile live runs.

---

## Summary
This PRD defines a short, high-impact cold open demo for OpenWork. The demo combines a 5–10 second visual montage, a 35–45 second narrative voiceover, and a deterministic scripted UI walkthrough that can be recorded repeatedly.

The demo must show:
- scheduling recurring tasks
- reading files and compiling summaries
- buying groceries (represented as a verified order draft or checkout-ready cart)
- the workspace and skills model
- tasks running with visible progress and file changes
- a calm, finished state

This PRD also defines the required demo harness, seeded data, UI states, and shot list so the demo can be captured without manual clicking or live risk.

---

## Goals
- Produce a repeatable, deterministic demo that matches the voiceover exactly.
- Show real OpenWork primitives: workspaces, skills, tasks, files, schedules.
- Keep the demo believable for non-technical viewers.
- Keep the UI premium and calm; no debug overlays in final capture.
- Enable fast retakes and easy editing by using a scripted timeline runner.

## Non-goals
- Building a full demo editor or video tool.
- Shipping a complete grocery checkout integration (demo can use a pre-filled cart or placeholder provider).
- Recording a live walkthrough with unpredictable outcomes.
- Introducing new core backend features unrelated to the demo.

---

## Definitions
- Cold open: the first 5–10 seconds, fast montage of capabilities without context.
- Demo harness: tooling to put OpenWork into deterministic UI states.
- Scenario: the scripted timeline of UI states and events.
- Workspace: a folder-backed OpenCode project (per `prd-workspaces-jit.md`).
- Skill: a workspace-scoped workflow package (`.opencode/skill/*`).
- Task run: an OpenCode session represented in the UI.

---

## Guiding Principles
1. Believable over flashy: actions must look like real tasks with real outputs.
2. Deterministic over live: demo must be repeatable and stable.
3. Real primitives over fake UI: UI should use real components and data flows.
4. Tight pacing: the montage and voiceover map 1:1 to visuals.
5. Calm finish: end on a state of completion and quiet confidence.

---

## Audience + Message
- Audience: non-technical users and technical buyers evaluating feasibility.
- Message: OpenWork handles annoying recurring work, connects across files/tools/time, and stays extensible.

---

## Demo Format
- Total duration: 45–60 seconds.
- Sections:
  1) Cold open montage (5–10s)
  2) Voiceover narrative with synced visuals (35–45s)
  3) Calm ending state (3–5s)

---

## Voiceover Script (Base Draft)
"Hi, I'm Ben, and this is OpenWork.

OpenWork does the annoying, monotonous work for you.
The stuff you keep postponing.
The stuff that requires connecting dots across files, tools, and time.

It runs tasks on your computer, with access to your files, and eventually your browser.
It works where your work actually lives.

Instead of one generic setup, you create workspaces.
Each workspace can have its own agents,
with their own skills,
for your regular tasks.

One workspace for finance.
One for home.
One for notes.
One for whatever you do every week and don't want to think about anymore.

Agents read files, write files, schedule work, and keep things up to date.
You tell them what you want.
They handle the rest.

OpenWork is built to be extensible.
You can start simple,
and grow it as your needs grow.

The goal is simple:
OpenWork should be the app that Susan in accounting uses every day,
and the app that Bob in IT can extend endlessly for her workflows."

---

## Storyboard: Visual Timeline (Mapped to Voiceover)

### Cold Open Montage (0:00–0:08)
1) Scheduler view: "Weekly finance recap" scheduled.
2) File summary panel: "Notes summary generated" with small diff.
3) Grocery task: "Cart ready" with checkmark.
4) Workspace switcher flick: Finance → Home → Notes.
5) Skills panel: 3–4 skill tiles animate in.

### Narrative Sequence (0:09–0:50)
- "Hi, I'm Ben...": OpenWork home screen with a single active workspace.
- "does the annoying...": show a task run starting, progress dots filling.
- "connecting dots...": show files list and summary artifact creation.
- "runs tasks on your computer...": show permissions prompt + file access grant.
- "works where your work actually lives": show folder paths and workspace chip.
- "create workspaces": open workspace picker.
- "each workspace can have its own agents...": show workspace settings with skills list.
- "one for finance...": quick montage of three workspace cards.
- "agents read files...": show a task run with file changes and scheduled job creation.
- "you tell them...": prompt input with short goal.
- "built to be extensible...": skills install screen with one skill highlighted.
- "goal is simple...": split view of simple UI with "Accounting" workspace and advanced "IT" workspace showing more skills.

### Ending (0:50–0:58)
- Calm dashboard with completed tasks, one scheduled run, and a clean summary card.

---

## Demo Assets and Data (Seeded)

### Workspaces (4 total)
- Finance Workspace
  - Tasks: "Weekly finance recap", "Budget alert"
  - Skills: `finance_summary`, `schedule_reports`
  - Files: `reports/q4.csv`, `reports/notes.md`
- Home Workspace
  - Tasks: "Grocery order", "Family calendar summary"
  - Skills: `grocery_prep`, `calendar_digest`
  - Files: `home/meal-plan.md`, `home/groceries.json`
- Notes Workspace
  - Tasks: "Summarize meeting notes"
  - Skills: `note_summary`
  - Files: `notes/2026-01-15.md`
- Ops Workspace (advanced)
  - Tasks: "System health check"
  - Skills: `log_summary`, `scheduler_admin`, `browser_automation`

### Skills (7 total)
- finance_summary
- schedule_reports
- grocery_prep
- calendar_digest
- note_summary
- log_summary
- browser_automation (demo-only or feature-flagged)

### Task Runs (Recorded)
- Task A: Weekly finance recap
  - reads `reports/q4.csv`
  - writes `reports/summary.md`
  - schedules next run
- Task B: Grocery order
  - reads `home/meal-plan.md`
  - writes `home/grocery-list.md`
  - creates checkout-ready cart artifact (no actual purchase)
- Task C: Notes summary
  - reads `notes/2026-01-15.md`
  - writes `notes/summary.md`

### Artifacts
- Summary cards with short, human-friendly titles.
- File diff previews (2–3 lines) to show real updates.
- Scheduled job cards with next run time.

---

## Demo Harness (Recommended Approach)

### Approach: Record + Replay (Recommended)
Create a deterministic demo provider that replays recorded OpenCode sessions and task events.

Why:
- Stable and repeatable.
- Matches real UI data shapes.
- Avoids live engine failures during capture.

Key design:
- New demo scenario JSON file with:
  - workspace list
  - skills list per workspace
  - session list with pre-rendered messages and tool events
  - artifact list with file diffs and summaries
  - timeline cues for the montage

### Demo Mode Flag
- `OPENWORK_DEMO=1` or `--demo` flag.
- When enabled:
  - UI uses demo provider instead of live SDK.
  - Scenario runner controls transitions.
  - Recording overlay available (hidden in final export).

### Scenario Runner
- Minimal control panel:
  - Start / Pause / Restart
  - Jump to scene (montage, workspace switch, task run, end state)
  - Speed control (1x, 1.5x, 2x)
- Scenes are timestamped steps to keep the capture consistent.

---

## Alternative: Live Engine (Not Recommended)
- Running actual OpenCode tasks is realistic but fragile.
- Requires real files and stable permissions.
- Best used only for capturing source recordings for replay.

---

## UI Control Idea (For Recording)
A hidden "Demo Control" overlay accessible via a keyboard chord.

Features:
- Scene list with jump buttons.
- Timeline scrubber (0–60s).
- Toggle "Show overlay" (off during final capture).
- Capture hints (safe margins, fps, resolution).

---

## UX / Visual Requirements
- Typography follows existing OpenWork design (see `design.ts`).
- Motion: short, intentional transitions between scenes (150–300ms).
- Background: keep the default app theme, no custom gradients.
- Avoid raw logs in default view.
- Keep the montage readable at 0.5x playback speed.

---

## Implementation Plan (What I Would Do)

### Phase 0 — Preproduction (1–2 days)
1) Finalize voiceover script and timing beats.
2) Lock shot list and scene timing.
3) Define the demo data schema (workspaces, skills, tasks, artifacts).

### Phase 1 — Data + Recordings (2–3 days)
1) Create a demo workspace folder with safe sample files.
2) Run 3–4 real OpenCode sessions to generate logs, summaries, and diffs.
3) Export session events and artifacts into JSON fixtures.
4) Curate short, clean summaries for each task.

### Phase 2 — Demo Harness (3–5 days)
1) Add a demo provider to the data layer.
2) Implement scenario runner (timeline and scene jumps).
3) Wire demo mode to use fixtures instead of live SDK.
4) Add minimal recording overlay (toggleable).

### Phase 3 — Polish + Capture (2–4 days)
1) Tune animations for clarity in montage.
2) Validate voiceover sync with UI transitions.
3) Capture 2–3 takes at 60fps.
4) Deliver raw capture + shot list to editor.

---

## Data + Storage (Draft)
- `src/demo/scenarios/demo-cold-open.json`
- `src/demo/fixtures/workspaces.json`
- `src/demo/fixtures/sessions/*.json`
- `src/demo/fixtures/artifacts/*.json`

---

## Acceptance Criteria
- Demo can be re-run and captured without manual clicks.
- All voiceover beats map to a visual state.
- No UI errors, blank states, or loading spinners.
- Montage shows scheduling, file summaries, and grocery task.
- Ending state feels calm, complete, and premium.

---

## Risks + Mitigations
- Risk: Demo feels fake.
  - Mitigation: use real task outputs and real file diffs.
- Risk: Recording tool causes UI regressions.
  - Mitigation: demo mode is fully gated; zero impact in production.
- Risk: Grocery integration is misunderstood as a real checkout.
  - Mitigation: label artifact "Cart ready" or "Order draft".

---

## Open Questions
1) Should the grocery task show a real vendor (Instacart, etc.) or a neutral "Order draft"?
2) Should we show the permission prompt or keep it implied?
3) What is the desired final length (45s vs 60s)?
4) Do we want demo mode to remain in the product or only for internal builds?
5) Who provides the voiceover and edit timeline?
