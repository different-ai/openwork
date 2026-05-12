# OpenWork Design Language

# NOTE: do not use for `apps/app`

This is the definitive visual system for OpenWork product and landing work.

OpenWork should feel like a premium work tool: calm, useful, technical, and trustworthy. The design should read as software first, not a flashy marketing site. The goal is clarity with taste, not visual noise.

---

## 1. Core Design Position

OpenWork design is:

- quiet
- premium
- operational
- flat-first
- structured by typography, spacing, and borders
- atmospheric only in controlled places

OpenWork design is **not**:

- glossy
- glassy
- beige
- aggressively gradient-heavy
- border-heavy
- shadow-led
- decorative for its own sake

The basic rule:

> Use structure before effects.

If something needs emphasis, prefer this order:

1. layout
2. spacing
3. typography
4. opacity
5. background tint
6. border
7. shadow

Shadow should almost never be the first tool.

---

## 2. The OpenWork Mood

The product should feel like:

- a serious desktop tool
- a clean command center
- a modern open-source alternative to Claude Cowork
- something you would trust with real workflows, team sharing, and remote workers

Tone:

- polished, but restrained
- modern, but not trendy
- friendly, but not cute
- futuristic through discipline, not chrome

---

## 3. Color + Surface Rules

### Base page color

- Default page/background base: very light cool neutral (`#f6f9fc` or equivalent)
- Prefer white and near-white surfaces over tinted beige panels
- Avoid warm paper/beige backgrounds unless there is a very strong reason

### Surface hierarchy

Use only a few layers:

1. **Page background**
2. **Primary white surface**
3. **Soft secondary surface**
4. **Interactive selected state**

Do not create lots of micro-layers.

### Preferred surface treatments

#### Flat app surface

For most application UI:

- white or near-white background
- 1px subtle border
- no visible shadow or only the smallest shadow possible

#### Soft shell

Use for landing sections that need grouping but should still feel calm.

- `landing-shell-soft` style direction
- near-white background
- subtle edge definition
- **no box shadow by default**

This is no longer landing-only in spirit. For app surfaces like modals, package builders,
and share flows, the same shell language is often the right starting point when the surface
represents a workflow object instead of generic settings chrome.

#### Elevated showcase shell

Use only when a hero/demo needs one extra level of emphasis.

- may use `landing-shell`
- still soft
- never dark or “floating card everywhere”
- should be rare, not the default wrapper for all sections

### Background imagery

Allowed only when all of the following are true:

- it sits behind content, not under core text blocks directly
- it is subtle
- it fades away or is spatially constrained
- it does not compete with reading

Pattern/background image rules:

- top-of-page background patterns should be low-opacity and fade out down the page
- section-specific image backgrounds are allowed for showcase frames
- content cards that sit on top of image backgrounds should still be white and legible
- use images as atmosphere, not content

---

## 4. Borders

Borders are one of the main structure tools in OpenWork.

### Border philosophy

- prefer soft gray borders
- prefer low contrast
- prefer consistency over emphasis

### What not to do

- do **not** use harsh black borders for selection
- do **not** outline selected cards with strong dark strokes
- do **not** stack border + heavy shadow + tint all at once

### Good border usage

- `border-gray-200`
- `border-gray-300` for stronger but still soft selection
- low-alpha white borders for translucent landing shells
- soft shell borders like `#eceef1` for app sidebars and large rounded utility panels

Do not use a dark or high-contrast outline as the main styling for a small icon tile,
badge shell, or compact decorative container. If the element is just carrying an icon,
prefer a soft filled tile over an outlined chip.

Selection should usually feel like:

- soft neutral fill
- darker text
- optional tiny border or tiny shadow only when needed

not:

- dark outline
- glow
- hard stroke

---

## 5. Shadows

Shadows must be restrained.

### General rule

- App UI: almost flat
- Landing UI: soft and selective
- Selection states: tiny shadow only

### Approved shadow levels

#### None

Default for most grouped surfaces.

#### Tiny control shadow

Use for active pills and secondary buttons:

```css
0 0 0 1px rgba(0,0,0,0.06),
0 1px 2px 0 rgba(0,0,0,0.04)
```

#### Light card shadow

Use sparingly for a main demo shell or one hero card.

#### Strong CTA shadow

Reserved for the primary CTA only.

### Never do

- large ambient shadows across many cards on one page
- floaty SaaS-marketing shadows everywhere
- using shadow as the main selected-state signal
- glassmorphism blur shadows in the app

---

## 6. Geometry + Radius

OpenWork should have a small set of radii and use them consistently.

### Radius system

- **Pills / buttons / chips:** `rounded-full`
- **Small controls / rows / compact cards:** `rounded-xl`
- **Medium panels / embedded demos:** `rounded-2xl`
- **Large showcase wrappers:** `rounded-3xl` or `rounded-[2.5rem]`
- **Sidebar/app shell wrappers:** `rounded-[2rem]` to `rounded-[2.5rem]`

### Rules

- Don’t mix too many different radii in one section
- If the outer shell is very rounded, inner panels should step down cleanly
- Pills should look intentional, not bubbly

---

## 7. Typography

Typography does most of the hierarchy work.

### General tone

- clean sans-serif
- medium weight for important labels
- gray text for explanatory copy
- no overly stylized headings

### Hierarchy

#### Eyebrows

- uppercase
- tracked
- small (`text-[11px]`)
- muted gray

#### Headlines

- medium weight
- tight tracking
- dark ink (`#011627` or equivalent)
- large enough to lead, not shout

#### Body

- `text-sm` or `text-base`
- relaxed line height
- `text-gray-500` or `text-gray-600`

#### Active explanatory text

If paired with an active state (like a selected workflow descriptor), the copy may move from muted gray to dark ink.

### Avoid

- giant type jumps
- ultra-light weights
- loud uppercase body copy
- dense paragraphs without breathing room

---

## 7.5 Copy Direction

OpenWork copy should feel as disciplined as the UI.

### General tone

- concise
- product-led
- operational
- calm
- confident without overselling

### Good copy behavior

- lead with the main user value, not the implementation detail
- prefer one clear idea per sentence
- keep interface copy shorter than marketing copy
- make support text explain utility, not restate the headline in different words

### Avoid

- repetitive copy that says the same thing three ways
- enterprise filler words like "provisioned setups" when a simpler phrase exists
- admin-heavy or billing-heavy framing when the main value is team workflow
- overdescribing secondary features

### Preferred OpenWork Cloud framing

For OpenWork Cloud, the primary story is:

1. share setup across the team/org
2. keep everything in sync
3. background agents are secondary / alpha
4. custom LLM providers are tertiary / coming soon

Do not make the product read like:

- a billing page first
- a hosting toggle first
- an equal split between desktop and Cloud

It should read like:

- team setup sharing first
- operational consistency second
- advanced/cloud extensions after that

### Preferred terminology

Use:

- **OpenWork Cloud**
- **Shared setups**
- **Shared templates**
- **Custom LLM providers**
- **Background agents**

Prefer:

- "Manage your team’s setup, invite teammates, and keep everything in sync."
- "Create and update shared templates your team can use right away."
- "Standardize provider access for your team."

Avoid:

- "Den" in user-facing copy
- "Provisioned setups"
- "Configured setups"
- "Choose how to run..." when the real goal is to explain team value

### Hierarchy rules for product pages

For sign-in, checkout, and dashboard copy:

- headline should state the core team value
- subcopy should explain the workflow benefit in one sentence
- supporting bullets/cards should not compete equally with the main value
- desktop should often appear as a fallback or secondary path, not a co-equal hero choice

### Docs CTA language

When linking to supporting documentation, prefer short utility labels:

- **Learn how**
- **How sharing works**
- **Read the guide**

These should feel like helpful follow-through, not a second headline.

---

## 8. Buttons

There are only a few button families in OpenWork.

### 8.1 Primary button

Use for the main action only.

Characteristics:

- dark fill (`#011627`)
- white text
- fully rounded pill
- slightly stronger shadow than the rest of the system
- feels decisive but still clean

Canonical pattern: `doc-button`

Use for:

- Download
- Run task
- other main conversion/action moments

### 8.2 Secondary button

Use for support actions.

Characteristics:

- white fill
- no hard border
- tiny ring + small shadow
- black/dark text
- fully rounded pill

Canonical pattern: `secondary-button`

This is also the reference style for:

- active segmented controls
- selected pills inside a track

### 8.3 Tertiary / text actions

Use for less important actions.

Characteristics:

- no heavy box treatment
- rely on text color and hover only

### Button rules

- Do not invent many new button styles
- Reuse the primary and secondary button logic whenever possible
- If a selector pill is active, it should usually resemble the secondary button family

---

## 9. Selectors, Tabs, and Pills

This is now one of the clearest OpenWork patterns.

### Track pattern

Use a soft segmented track:

- light border
- subtle gray background
- full pill radius
- tiny inset padding

Example structure:

- track: `border border-gray-200 bg-gray-50/50 rounded-full p-1`
- active item: white pill + tiny shadow
- inactive item: muted text only

### Active state

Active tab/pill should look like:

- white pill
- soft ring/shadow
- dark text

### Inactive state

Inactive tab/pill should look like:

- no card chrome
- muted gray text
- stronger text on hover

### Do not

- use harsh dark borders for selection
- create heavy segmented controls with thick strokes
- use loud fills for tabs

### Flat selected row pattern

For app navigation, especially dashboard sidebars:

- selected state should usually be a soft gray fill (`bg-gray-100` / `bg-slate-100` family)
- selected items should not default to white floating pills inside a white or near-white shell
- rely on fill + text weight before adding chrome
- hover state should usually be one step lighter than selected, not a different visual language

---

## 10. Lists and Row Systems

OpenWork has two primary list patterns.

### 10.1 Operational row list

Use for sessions, workspaces, activity rows, and compact app lists.

Pattern:

- flat container
- rounded-xl row
- light hover tint
- selected row uses a subtle fill and stronger text
- metadata remains quiet

Good signals:

- `font-medium`
- subtle background tint
- tiny status accent if needed
- rounded-2xl row inside a softer outer shell when the list is acting as a primary sidebar

Bad signals:

- white card floating above white page
- hard selected outline
- large shadows on list rows

### 10.1a Sidebar shell pattern

Use for app/dashboard sidebars when the sidebar itself should feel like a calm standalone object.

Pattern:

- outer shell uses a near-white neutral background, not pure white
- shell gets a large radius (`rounded-[2rem]` range)
- shell uses a faint border, often enough without any visible shadow
- internal rows stay flatter than the outer shell
- selected row uses a soft gray fill, not a stronger border treatment
- footer actions may appear as floating white pills/cards inside the shell if they need separation

This is the right pattern for:

- workspace sidebars
- Cloud dashboard sidebars
- utility navigation that should feel product-like rather than admin-like

### 10.2 Text-led preview list

Use when a list controls a larger preview panel to the right.

Pattern:

- no boxed cards for each item
- text blocks stacked vertically
- inactive items use lower opacity
- active item uses full opacity and darker copy

This is the right pattern for:

- feature explanation lists next to a demo panel
- “build / import / ready” style narratives

---

## 11. Cards and Section Layouts

### Explanatory cards

Use only when the card itself is the unit of information.

Should be:

- simple
- lightly bordered
- white
- softly rounded

### When not to use cards

If the user is just choosing between three conceptual options, don’t force every option into a boxed card. Use:

- pill selector
- text-only list
- opacity-driven stacked copy

### Product object cards

Use when the UI is presenting a reusable worker, template, integration, or packaged setup.

Pattern:

- soft shell or near-white card
- generous padding
- title first
- one short supporting sentence
- compact status pill in the top-right if needed
- actions inline underneath or within the card

These should feel like curated product objects, not admin rows.

### Icon tiles inside cards

When a card uses an icon block:

- use a soft filled tile (`bg-slate-50` / similar)
- prefer no visible border by default
- let size, radius, and fill define the tile
- if a muted version is needed, use a quieter fill rather than an outline

Do not:

- put a dark stroke around the icon tile
- make the icon tile look like a separate outlined button unless it actually is one
- introduce standalone black/ink borders for decorative icon wrappers

### Section composition

Most sections should follow one of these layouts:

1. **Headline + supporting copy + CTA**
2. **Selector on left + live descriptor on right**
3. **Text list on left + preview/demo on right**
4. **Three-column summary cards**

Do not mix too many interaction models in one section.

---

## 12. Demo and Mockup Styling

Embedded product demos should feel like software, not like illustrations.

### Demo shell rules

- white inner content area
- subtle chrome
- soft border
- restrained shadow
- clear spacing

### If the outer frame is atmospheric

Then the inner mockup must become simpler.

Meaning:

- image/pattern on outer background is okay
- inner card should stay clean and white
- do not combine colorful outer frame with complex inner effects

### Content in demos

- use real-looking interaction states
- keep labels readable
- emphasize utility over visual flourish

### Packaged workflow surfaces

When showing a workflow like share/package/export:

- prefer a soft shell over default modal chrome
- make the core object the hero (template, worker, integration, package)
- reduce the number of nested bordered panels
- use one or two strong cards, then flatter supporting sections
- present actions as intentional product actions, not generic form controls

---

## 13. Selection States

Selection should usually be shown through one or more of:

- darker text
- stronger opacity
- soft neutral fill
- soft gray border
- tiny shadow

Selection should **not** usually be shown through:

- black outline
- bright accent fill
- glow
- thick stroke

OpenWork selection should feel confident, not loud.

When a selected item sits inside a soft app shell, prefer:

- tinted gray fill first
- then weight and text color
- then at most a tiny white badge or tiny control shadow for supporting UI

Avoid making the selected state look like a separate floating card unless the interface is explicitly using segmented pills.

---

## 13.5 Modal Surfaces

Not every modal should look like a system dialog.

For workflow modals (share, package, connect, publish, save to team):

- use a large soft shell with a near-white background
- keep the header airy and typographic
- avoid harsh header separators unless they add real structure
- prefer one scrollable content region inside the shell
- use soft cards for major choices
- reduce mini-panels and stacked utility boxes

Good modal direction:

- feels like a product surface
- can contain object cards and actions
- uses soft hierarchy and breathing room

Bad modal direction:

- dense settings sheet
- too many small bordered sub-panels
- generic dialog chrome with no product feel

---

## 14. Motion

Motion should be tight and purposeful.

### Allowed motion

- pill transitions with spring
- short opacity transitions
- tiny translateY on primary CTA hover
- soft content crossfades

### Avoid

- floaty delayed animations everywhere
- scale-heavy hover effects
- decorative motion on non-interactive surfaces

### Timing

- interactions should feel immediate
- most transitions should live around `150ms–300ms`
- spring motion should be controlled, not bouncy

---

## 15. OpenWork App vs Landing

The app and the landing share one system, but not the same degree of atmosphere.

### App

- flatter
- more structural
- almost no decorative shadow
- almost no background texture
- strong emphasis on state clarity and density

### Landing

- may use soft shells
- may use one atmospheric background image/pattern in a controlled region
- may use more spacing and larger radii
- still must obey the same button, border, and selection rules

Landing should feel like the same product family, not a separate visual brand.

---

## 16. Anti-Patterns

Do not introduce these:

- beige canvases as default backgrounds
- harsh black selected borders
- random glassmorphism
- multiple heavy shadow systems on one screen
- over-rounded cards everywhere
- boxed selectors when text or pills would be clearer
- giant gradients behind readable text
- decorative badges/counters with no functional meaning
- hiding anchor labels just to show hover actions
- outlined icon chips that read darker than the card they sit inside

If something looks “designed” before it looks “useful,” it is probably wrong.

---

## 17. Canonical Component Patterns

### Primary CTA

- dark pill
- white text
- slight elevation

### Secondary CTA / active segmented pill

- white pill
- tiny ring + tiny shadow
- dark text

### Selector track

- light gray border
- soft neutral background
- internal padding
- active item is white

### Text-led feature list

- no cards
- stacked copy
- inactive items at reduced opacity
- active item at full opacity

### Operational list row

- rounded-xl
- subtle hover tint
- selected row uses fill/weight, not loud chrome

### App sidebar shell

- large rounded outer shell
- faint neutral background
- subtle border
- flat internal rows
- selected row uses soft gray fill
- floating footer action can be white if it needs separation from the shell

### Share/package modal

- soft shell modal
- object cards for reusable templates or integrations
- compact status pills
- strong dark primary CTA
- white secondary CTA with tiny ring/shadow
- avoid form-heavy utility styling unless the step is truly form-driven

### Landing shell

- reserved for hero/showcase moments
- use sparingly

### Landing soft shell

- flat, near-white, subtle border
- no shadow by default

---

## 18. Design Decision Tests

Before shipping a UI change, ask:

1. Is this relying on layout and typography first, or on effects first?
2. Is the selected state soft and obvious, rather than harsh?
3. Are we reusing the existing primary/secondary button language?
4. Does this section need cards, or would pills / text / opacity be cleaner?
5. Is the shadow doing real work, or is it just decoration?
6. Would this still feel like OpenWork if all colors were muted?
7. Does this feel like one coherent product across app and landing?

If the answer to those is not clearly yes, simplify.

---

## 19. Canonical References in This Repo

Use these as implementation references:

- Landing button + shell primitives: `_repos/openwork/ee/apps/landing/app/globals.css`
- Landing hero and selector patterns: `_repos/openwork/ee/apps/landing/components/landing-home.tsx`
- Landing demo list rhythm: `_repos/openwork/ee/apps/landing/components/landing-app-demo-panel.tsx`
- Cloud dashboard sidebar shell + selected state: `_repos/openwork/ee/apps/den-web/app/(den)/o/[orgSlug]/dashboard/_components/org-dashboard-shell.tsx`
- Share/package modal direction: `_repos/openwork/apps/app/src/app/components/share-workspace-modal.tsx`
- App workspace/session list rhythm: `_repos/openwork/apps/app/src/app/components/session/workspace-session-list.tsx`

When in doubt, prefer the calmer version.
