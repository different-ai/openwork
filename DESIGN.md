# DESIGN.md

How OpenWork UI is designed. Agents read this before building or reviewing any
user-facing surface (`apps/app`, `apps/desktop`, `ee/apps/den-web`, MCP Apps,
generated artifact views). The optional `.warden/skills/design-spec-review` skill
can review the numbered rules below locally. Automated Warden reviews focus on
security and confidentiality.

## Who we design for

Non-technical knowledge workers doing real work with agents on their own
files and connected services. Chat is the home surface; everything else
(tool activity, apps, panels, settings) supports the conversation. The user is
usually a *perpetual intermediate*: make the common path fast and obvious, keep
advanced options discoverable but quiet.

## Principles

- **P1 · Show state, don't explain the UI.** A surface reports what is true
  ("Verified 2 min ago", "Blocked by your team", "Not posted") instead of
  describing itself. Count the sentences in the first viewport; if a sentence
  explains the interface rather than reporting state, delete it.
- **P2 · Title *or* description, never both.** Pages, cards, rows, dialogs,
  settings groups get one or the other. Detail lives in a tooltip, an
  expandable row, or nowhere.
- **P3 · Progressive disclosure.** Default surface = the decision the user is
  here to make. Advanced, rare, or diagnostic detail goes behind a labeled
  collapsed row ("Technical details", "Blocked patterns") — label only, no
  preview of the contents.
- **P4 · Presence with a lock beats absence.** When policy or permissions
  remove a capability, keep the control visible, mark it blocked, and say
  *why* and *who can change it*. Never let features silently disappear.
- **P5 · Reuse before you build.** Use the existing `@/components` primitive
  (Button, Switch, Dialog, Popover, Command, Tool, Message…). Hand-rolling a
  control that already exists is a defect. If no primitive fits, compose a
  headless one; never re-implement keyboard/focus/ARIA behavior.
- **P6 · Density from data, not prose.** Linear/Vercel-dense: rows, values,
  chips, state. Tight desktop density (12–16px padding), chosen once and held.
- **P7 · One focal element per screen.** Name it before building; make it win
  through weight, contrast, or whitespace. Demote everything else.
- **P8 · Undo over confirm.** Confirm only destructive or external actions
  (post, send, delete, pay). Everything else is reversible in place
  ("Requested today · Undo").
- **P9 · Consent names action, data and risk.** Approval cards say exactly
  what will happen, to what, who sees it, and what is reversible — in one
  state line. No apologies, no "please".
- **P10 · Evidence or it didn't ship.** New or changed UI needs a screenshot
  (or short recording) in the PR at the real size. No screenshot, no review.
- **P11 · Continuity over lifecycle.** A person's action produces the object
  they asked for; the system's internal steps to get there are not UI states.
  Keep the user's object and layout on screen while work continues (their
  message, row, or document stays put), and add a visible intermediate state
  only when it needs a decision or recovery. Interstitials such as
  "Creating…", "Preparing…", or setup screens invented from implementation
  steps are defects.

## Structure

- **S1** Flat, not boxed: no card-in-card, no bordered tile inside a bordered
  tile. Group with whitespace and a single hairline.
- **S2** Settings and lists are compact rows: label left, current state right,
  at most one action on the right. Rows 40–48px, hairline dividers.
- **S3** Expandable rows use `<details>`-style disclosure with a chevron that
  rotates 90°. Open by default only when the content *is* the answer.
- **S4** Inline widgets (MCP Apps, tool cards, artifact previews) fit in one
  scroll of the response, carry ≤ 2 primary actions, never scroll internally,
  and never duplicate the assistant's text. Escalate to the side panel when
  the task needs iteration, comparison, or editing — and say so with the
  panel button, not by growing the widget.
- **S5** Nothing auto-navigates, steals focus, or opens a pane because a tool
  produced something. A result may *offer* an inline action to open it.
- **S6** One action, one home: keyboard, palette, and visible control invoke
  the same command. Show keyboard chords for frequent actions (`⏎`, `⌘⏎`,
  `esc`).

## Copy

- **C1** Verb-first, outcome-specific labels: "Post to #launch", "Request
  access", "Save changes" — never "Submit", "OK", "Click here".
- **C2** An action keeps its name through the flow: button "Post" → toast
  "Posted"; "Publish" → "Published".
- **C3** Name things by what people control, not how the system works: a
  person manages "connections", not "MCP server config"; never expose tool
  ids, JSON, or `toolName` to end users.
- **C4** Tool activity is sentence-first and past/present tense: "Searched
  Linear for open issues · 8 issues", "Read #launch", "Ran `pnpm test`",
  "Drafting for #launch". Show duration, not internals.
- **C5** Blocked is not an error. Blocked/locked states use neutral ink and a
  lock; red is reserved for failures.
- **C6** Errors and empty states give direction: what happened + the next
  action. Empty states invite; errors never blame or say "Oops".
- **C7** Sentence case. No ALL-CAPS eyebrow labels, no middle-dot meta strings
  as decoration, no "→" appended to buttons.

## States

Every data-bearing surface designs, and the PR shows, these states where they
apply: loading (layout-matching skeleton, not "Loading…" text), empty,
error, blocked/locked, offline or "couldn't verify" (show the last known
state and when it was confirmed), and success. Never rely on model text alone
to communicate system status. Loading preserves the destination layout: the
object appears where it will live, then fills in.

## Visual system

Tokens live in `apps/app/src/app/index.css`, `styles/colors.css`,
`styles/tailwind-theme.css`. Use them; never hardcode.

- **V1** Type: system stack, 13px/1.5 body, `--text-sm` 0.8125rem, mono for
  commands, ids and file chips. Hierarchy comes from weight + opacity
  (600 / 500 / 400, `text-foreground` / `text-muted-foreground`) at the same
  size before it comes from size. Headings ≤ 20px with slight negative
  tracking.
- **V2** Color: Radix slate/blue/amber/red/green/violet scales via semantic
  vars (`--background`, `--muted`, `--border`, `--primary`, `--destructive`).
  Brand accent `--dls-accent` (#011627) for the primary action. Tinted
  neutrals only — never `#000` / `#fff` literals in components. Color marks
  the minority that needs attention; a normal state is neutral.
- **V3** Depth: hairlines as `rgba` (`--border`), lifted surfaces use the
  layered `--dls-card-shadow` / `--dls-shell-shadow`, never a solid border
  plus a shadow. Choose one depth strategy per surface and hold it.
- **V4** Radius: `--radius` (0.45rem) scale for controls, `--dls-radius`
  (16px) for shells and the composer, `--dls-radius-lg` (24px) for windows.
  Nested elements use concentric radii (inner = outer − padding).
- **V5** Icons: lucide, 16px, 1.5px stroke, round caps. Generic icons only in
  navigation and toolbars. When a company/service is shown (Slack, Linear,
  Google, GitHub…) use its logo mark, not a generic icon. No emoji as icons.
  No sparkle / wand / magic / robot icons for "AI".
- **V6** Motion: 120–200ms, `ease-out` or `cubic-bezier(.2,.8,.2,1)`, no
  bounce/elastic, no entrance animation on high-frequency surfaces (command
  palette, menus, rows), exit faster than enter, `prefers-reduced-motion`
  respected. Shimmer only on the currently running step.
- **V7** Anti-patterns (auto-flagged): purple/blue gradients, glassmorphism,
  identical card grids, uniform rounding on everything, `transition: all`,
  `outline: none` without a replacement focus ring, gray text on colored
  backgrounds, decorative badges/chips soup.

## Chat, tool calls and MCP Apps

- **T1** A turn's steps read as one rail: leading slot (connector logo, file
  icon, terminal glyph or reasoning dot), sentence label, duration right.
  Finished turns collapse to one line ("Worked for 1m 19s · 12 steps").
- **T2** Failures stay inline with the fix: "Slack needs a fresh sign-in ·
  Reconnect", not a stack trace. Raw input/output lives under "Technical
  details".
- **T3** MCP Apps and generated views get a 40px header (source logo, title,
  explicit state such as "Ready" / "Draft" / "Not posted") and one icon
  action ("Open in panel"). Body is the app; footer holds ≤ 2 actions.
- **T4** The consent card is the focal element while a decision is pending.
  It sits where the user acts (above the composer), names action · data ·
  risk, and offers primary / edit / decline with keyboard chords.
- **T5** Composer: one round send/stop button, model and run-mode as quiet
  pills, queue/steer hints as chords only.

## Before opening a UI PR

- [ ] Screenshot(s) of the new/changed UI at real size, including non-happy
      states you touched (P10).
- [ ] Every new control reuses a `@/components` primitive or justifies why not
      (P5).
- [ ] No surface has both a title and a description (P2).
- [ ] No explanatory sentences in the default viewport (P1).
- [ ] Blocked/locked states visible with reason and owner (P4, C5).
- [ ] Company/service references use logos; no generic icons outside nav
      (V5).
- [ ] Tokens only; no hex/px literals that duplicate a token (V2–V4).
- [ ] Motion within V6; focus ring visible; reduced-motion respected.
- [ ] Async flows keep the user's object and layout in place; no interstitial
      built from an internal step (P11).
