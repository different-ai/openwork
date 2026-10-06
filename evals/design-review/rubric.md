# OpenWork design review rubric

The design review reads this file and `DESIGN.md` (repo root, read at review
time so a rule change applies on the next run) and judges every evidence
screenshot against both. DESIGN.md ids (P1–P11, S1–S6, C1–C7, V1–V7, T1–T5)
come from DESIGN.md; `OW-*` ids below come from the team's **OpenWork Design**
plugin in OpenWork Cloud, packed here so CI judges with the same rules
designers use:

| Pack section | Plugin skill |
| --- | --- |
| OW-LIST, OW-STATE, OW-ADD, OW-EMPTY, OW-CONFIRM, OW-SHELL, OW-REJECT-* | `openwork-paper-design` (Accepted patterns, Rejected every time, Shell rule) |
| OW-CONSIST-* | `paper-design-consistency-audit` (Visual, Structure, Copy) |
| OW-DECIDED-* | `openwork-ui-source-map` (Settled product decisions) |
| OW-CRAFT-* | `rams`, `web-design-guidelines`, `better-ui`, `impeccable`, `interface-design` |

When a plugin skill changes, update the matching section here in the same PR
(read it with OpenWork Cloud `get_skill`). Keep only rules a screenshot can
show; process rules (Paper mechanics, Linear updates) stay in the plugin.

## How to judge

- Judge only what is visible in this one screenshot. No hover, motion, code,
  or states you cannot see. Test data names (`docs-helper`, `Acme`) are fine.
- Judge the screen's main content. App chrome that is the same on every
  screen (the sidebar, its account row, the window title bar) is out of scope
  unless it is visibly broken (overlapping, clipped, misaligned). A persistent
  account "Sign in" in the sidebar is not a second door into a flow.
- A locked row that shows a lock already has its state (P4); do not ask it for
  a state word.
- Images inside the screen (screenshots, thumbnails, previews, artifacts) are
  content. Judge how they are placed and framed, never what they depict.
- Look for what is off; do not list what is fine. Most important first, at
  most six findings. An empty list is a valid answer for a clean screen.
- `medium`: a careful OpenWork designer would block it. Overlapping or
  clipped content, columns or actions out of their lane, a rule below or in
  DESIGN.md broken outright. `low`: likely wrong or a craft miss you cannot
  fully confirm from the pixels. Never `high`.
- Name the rule id the screen breaks. Quote the on-screen text in evidence.
- Measured layout findings are given to you exactly; do not repeat them, use
  them to aim.

## Lists and rows

- **OW-LIST** A list row is: logo or mark, name over a one-line muted
  description, a status word, then a fixed action lane, so a vertical line
  through statuses or actions is straight. Desktop rows are 44–52px at 13px
  type; Den rows are `ItemRow` (14px name, 13px description, 72px action lane).
  No mono ids in rows.
- **OW-LIST-HEADER** A list needs no count, no sort-order note, and no header
  row unless a column is a number the user compares. Column labels that
  describe the system instead of helping the choice are rejected.
- **OW-LIST-LANES** Related values sit next to each other. A row whose values
  float far from its name (a wide empty band in the middle of the row,
  repeated down the list) is out of its lane.
- **OW-STATE** State is one word next to the row (`Ready`, `Sign in`,
  `Set up`) plus at most one 28px action. Filled accent only when it is the
  primary path. Three connection states only: Ready, Sign in, Set up.

## Adding, empty states, dialogs

- **OW-ADD** Adding is a catalog picker. One global ⌘K search in the header;
  local filtering is a small inline `Filter by name` field. No mid-page search
  bars, no URL field as the default way to add. `Add to library` sits in the
  toolbar next to the collection. A custom MCP is `Add another MCP` beside the
  filter, not a row at the bottom of the list.
- **OW-EMPTY** Empty states: title, one line, one primary action, a quiet note.
  One door into the flow, not a primary button plus chips plus a migration
  button. Illustrations only from real marks.
- **OW-CONFIRM** Every `Remove` asks first: `Remove X?` / `Nobody can use it
  anymore. This cannot be undone.` / `Cancel` + destructive `Remove`. The action
  names the consequence, never `OK` or `Yes`. Never `Uninstall`.
- **OW-CATALOG** A catalog or picker is titled with the action that opened it
  (`Add a provider`), no subtitle, no stepper, one flat list most common first.
  No split into columns by access method.
- **OW-SEGMENTED** A segmented control switches views of the same content; it
  must not change the height of the page.

## Surface

- **OW-SHELL** Desktop-only state wears the Desktop chrome (sidebar,
  titlebar). Den-only state wears the Den shell (260px white sidebar, `#fafafa`
  canvas). A shared component has no sidebar. A Den sidebar on a desktop
  screen is a defect.

## Rejected every time

- **OW-REJECT-TINT** Tinted status panels: amber, green, yellow or beige washes
  with a matching border, including warning or info notices. A normal state is
  neutral; colour marks one dot or one word, never a panel (V2).
- **OW-REJECT-OUTLINE** Dark `#111827`/black outlines meaning selected or
  focused. Selected is a filled ink chip, an underline, or a check. Focus is a
  light hairline plus a faint ring.
- **OW-REJECT-PALETTE** Invented palettes (cream, plaster, slate moods). Den is
  a `#fafafa` canvas, white panels, gray-100/200 hairlines, `#0f172a`/`#011627`
  ink. Desktop uses its tokens.
- **OW-REJECT-SHADOW** Heavy drop shadows on cards, rows and buttons. Panels are
  flat with one hairline; only popovers and menus float.
- **OW-REJECT-AI-ICON** Sparkle, wand or robot icons for AI. Auto and OpenWork
  Models use the OpenWork mark (V5).
- **OW-REJECT-GENERIC-MARK** A generic icon where a company is named: Codex →
  OpenAI mark, Claude Code → Anthropic, Cursor, Slack, Linear, GitHub, Notion,
  Google → their own marks (V5).
- **OW-REJECT-OVERSIZE** Oversized controls: big shadowed sign-in buttons, tall
  catalog cards, three-line descriptions. Accepted density: one-line
  description, 26–32px inline action, 12px padding, 8px gap.
- **OW-REJECT-INTERNALS** Internals in the viewport: dollar amounts, `ipr_*` or
  `cob_*` ids, tool names, MCP URLs, `execute_capability`. Behind "Technical
  details" or nowhere (P3, C3).
- **OW-REJECT-META** Meta lines that describe the system: `24 sources · most
  used first`, `In your gateway`, `1 key`, `Added · 3 people`.
- **OW-REJECT-COPY** ALL-CAPS eyebrows, middle-dot meta strings as decoration,
  em dashes, mono type in product copy (C7).
- **OW-REJECT-PEOPLE** Real people's names, emails, customers or prospect
  logos. Placeholders like `sam@example.com` only.
- **OW-REJECT-TOOLTIP** A hover tooltip or popover as the way to explain a
  model or a state; explain in the row subtitle.
- **OW-REJECT-SURFACE** Wrong surface for a message: a blocked send is an
  inline card in the chat with the draft kept, not a toast, modal or composer
  footer; a first-run hint is a status line, not a hero.
- **OW-REJECT-DOORS** Several doors into the same flow on one screen.

## Consistency within the screen

- **OW-CONSIST-TYPE** One size and weight per role (page title, section header,
  row title, subtitle, caption). Headings at most 20px on Desktop.
- **OW-CONSIST-ICON** One icon set and stroke (lucide, 16px, 1.5 stroke); brand
  marks at one size in a fixed lane; no hand-drawn glyphs.
- **OW-CONSIST-RADIUS** One radius scale, concentric nesting (inner = outer −
  padding).
- **OW-CONSIST-SURFACE** One depth strategy per surface: hairline or shadow,
  never both (V3). Hairlines in one colour.
- **OW-CONSIST-BUTTON** Same variant for the same role; heights from the set
  (28 / 32 / 40). Secondary is outlined white, not a grey pill.
- **OW-CONSIST-DENSITY** Padding, gaps and row heights match within the screen;
  no group is visibly airier or more cramped than its siblings.
- **OW-CONSIST-WRAP** A label that should stay on one line does not wrap
  (buttons, kbd hints, status words).
- **OW-CONSIST-PHRASE** One phrase per state, used identically everywhere on
  screen. Sentence case, verb-first labels.

## Settled product decisions

- **OW-DECIDED-REMOVE** Taking something out is `Remove` on every surface.
- **OW-DECIDED-SEARCH** One global search; no second mid-page search bar.
- **OW-DECIDED-AUTO** The free OpenWork model is `Auto`; the upstream model
  name never shows in chrome. No paid-tier or upgrade UI, no dollar amounts.
- **OW-DECIDED-LIMIT** A hit limit is an inline chat card after the dimmed
  unsent message with `Sign in to OpenWork` and `Switch model`.
- **OW-DECIDED-MODELS** Model rows: provider mark, name over provider subtitle,
  source glyph on the right, a check for selected.

## Craft

- **OW-CRAFT-ALIGN** Elements that belong to one lane share an edge; optical
  alignment for icons next to text; repeated rows form straight vertical lanes.
- **OW-CRAFT-SPACE** Deliberate rhythm: tighter inside a group, looser between
  groups. No cramped clusters, no unexplained empty regions, no content
  floating away from what it labels.
- **OW-CRAFT-HIERARCHY** One focal element per screen (P7); hierarchy from
  weight and contrast before size.
- **OW-CRAFT-CONTRAST** Body text readable at a glance; muted text still
  readable; no grey text on coloured fills.
- **OW-CRAFT-FIT** Nothing clipped at the window edge or inside its container
  unless truncation is intended and marked with an ellipsis; no horizontal
  scrolling; the layout uses a wide window without leaving holes.
- **OW-CRAFT-STATES** Loading keeps the destination layout (skeleton, not
  "Loading…"); errors give the next action; blocked uses neutral ink and a lock.
