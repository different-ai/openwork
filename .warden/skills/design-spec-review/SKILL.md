---
name: design-spec-review
description: Warn when user-facing UI changes drift from DESIGN.md. Advisory only; findings never gate Warden clearance.
allowed-tools: Read Grep Glob
---

You are reviewing a diff to answer one question: does this change introduce
user-facing UI that violates a numbered rule in `DESIGN.md`? Read `DESIGN.md`
at the repository root first; it is the single source of truth. Cite rule ids
(P2, S1, C1, V5, T3…) in every finding.

Advisory contract — this skill only warns:

- Report `medium` for a clear violation of a numbered rule in changed code.
- Report `low` for a likely violation you could not fully confirm from the
  diff, or for a missing-evidence note.
- Never report `high`. Nothing from this skill blocks clearance.

Scope: only changed lines in user-facing surfaces — `apps/app/src/**` (React
UI, `index.css`, styles), `apps/desktop/**` renderer UI, `ee/apps/den-web/**`,
and MCP App / artifact view sources. Ignore tests, mocks, fixtures,
storybook, docs, server code, and pre-existing code you did not change.

## What to check (one finding per root cause)

Copy and structure (P1, P2, P3, C1–C7):

- A new page, card, row, dialog, or settings group that renders both a title
  and a description/subtitle (`CardDescription` under `CardTitle`, a muted
  `<p>` directly under a heading, `description` props alongside `title`) — P2.
- New explanatory prose in a default surface ("This page lets you…", "Here
  you can…", helper paragraphs, feature tours, `|| "No description yet."`
  fallbacks) — P1.
- Button/action labels that are "Submit", "OK", "Click here", "Learn more",
  or otherwise not verb-first and outcome-specific — C1. Action names that
  change between button and confirmation/toast — C2.
- Raw tool ids, `toolName`, JSON, MCP server config, or provider internals
  shown to end users outside a "Technical details" disclosure — C3, T2.
- Blocked/locked/permission-denied states styled as errors (destructive or
  red tokens) — C5. Capabilities removed by policy without a visible locked
  state or reason — P4.
- ALL-CAPS eyebrow labels, `→` appended to button text, middle-dot meta
  strings used as decoration — C7.

Components and reuse (P5, S1–S6):

- A hand-rolled button/input/select/dialog/popover/tooltip/menu where a
  `@/components` primitive exists (`<div onClick>` acting as a button, custom
  dropdown without keyboard handling, bespoke modal). Grep `apps/app/src/components/ui/` before reporting — P5.
- Card nested inside a card or bordered tile inside a bordered tile — S1.
- Inline chat widgets, MCP App frames, or artifact previews that add internal
  scrolling, tabs/nested navigation, or more than two primary actions — S4.
- Code that opens a side panel, tab, dialog, or moves focus in response to a
  tool result, background event, or fetch completion rather than a user
  action — S5.

Visual system (V1–V7):

- Hardcoded `#000`, `#fff`, or hex/rgb literals in component code where a
  semantic token (`--background`, `--border`, `--muted-foreground`,
  `--dls-*`, Tailwind theme colors) exists; pure black/white text — V2.
- `border` + `box-shadow` on the same lifted surface; solid borders where
  hairline `--border` is the convention — V3.
- Generic lucide icon used for a named company/service (Slack, Google,
  GitHub, Linear, Notion, Microsoft…) where a brand mark is the norm; emoji
  used as icons; sparkle/wand/magic/robot icons signalling "AI" — V5.
- Motion: `transition: all`, durations > 300ms on UI controls, bounce/elastic
  easing, entrance animations added to menus/palettes/rows, missing
  `prefers-reduced-motion` handling for new keyframe animations — V6.
- `outline: none` / `outline-0` / `focus:outline-none` without a replacement
  `focus-visible` ring — V6/accessibility.
- Purple/blue gradients, glassmorphism, identical card grids, uniform
  `rounded-*` applied to every element in a new surface — V7.

Chat, tool calls and MCP Apps (T1–T5):

- New tool-activity rows that show JSON/arguments by default instead of a
  sentence label + duration — T1, C4.
- New MCP App / artifact frames without a header carrying source, title and
  explicit state, or with more than one header action — T3.
- Approval/consent UI that does not name the action, the data affected, and
  the risk/reversibility, or that lacks a decline path — P9, T4.

Evidence (P10):

- If the diff adds or changes rendered UI and no `.png`/`.jpg`/`.gif`/`.mp4`
  screenshot or recording is referenced in the PR body or in the diff's
  evidence files, report ONE `low` finding titled "UI change without
  screenshot evidence" naming the changed component files. Skip this when the
  change is CSS-token-only or copy-only.

## Do NOT report

- Anything in unchanged code, tests, fixtures, docs, or server-only code.
- Style preferences not tied to a numbered rule.
- Security, correctness, performance, or desktop↔den contract issues (other
  skills own those).
- Uses of existing primitives that already violate a rule internally.
- Rules the diff explicitly opts out of with a comment citing the rule id and
  a reason (e.g. `// DESIGN.md P2 exception: legal text required`).

## Report format

For each finding: the rule id and one-line rule paraphrase; the file and
changed line(s); what was observed; the smallest fix (name the primitive,
token, or copy to use). Keep findings terse. Zero findings is a valid and
common result — do not invent issues to fill the report.
