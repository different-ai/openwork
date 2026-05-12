# OpenWork Design System

# NOTE: do not use for `apps/app`

This document turns the visual direction in `DESIGN-LANGUAGE.md` into an implementation system that can unify:

- `ee/apps/den-web` (OpenWork Cloud / Den web surfaces)
- `ee/apps/landing` (marketing + product storytelling)

The goal is not to create three similar styles. The goal is one OpenWork design system with a few environment-specific expressions.

---

## 1. Why this exists

Today the product already has the beginnings of a system, but it is split across:

- app-specific CSS variables in `apps/app/src/app/index.css`
- Tailwind theme setup in `apps/app/tailwind.config.ts`
- Radix color tokens in `apps/app/src/styles/colors.css`
- repeated utility-class decisions across app, Cloud, and landing

That creates three problems:

1. the app and Cloud can feel related but not identical
2. visual decisions are made at the screen level instead of the system level
3. tokens, primitives, and page composition rules are not clearly separated

This file defines the missing structure.

---

## 2. System model

OpenWork should use a three-layer design system:

### Layer 1: Foundations

Raw design tokens:

- color
- typography
- spacing
- radius
- shadow
- motion

These are the only values components should depend on directly.

### Layer 2: Semantic tokens

Product-meaning tokens:

- `surface.page`
- `surface.panel`
- `surface.sidebar`
- `text.primary`
- `text.secondary`
- `border.subtle`
- `action.primary.bg`
- `state.hover`
- `state.selected`

These should map foundation tokens into product meaning.

### Layer 3: Component primitives

Reusable building blocks:

- Button
- Card
- Input
- Modal shell
- Sidebar shell
- List row
- Status pill
- Section header
- Empty state

Pages should mostly compose these primitives, not invent their own visual logic.

---

## 3. Relationship to existing docs

- `DESIGN-LANGUAGE.md` = visual philosophy and qualitative rules
- `DESIGN-SYSTEM.md` = implementation structure and migration plan

If there is a conflict:

1. `DESIGN-LANGUAGE.md` decides what the product should feel like
2. `DESIGN-SYSTEM.md` decides how to encode that in tokens and primitives

---

## 4. Core principle: one system, three expressions

OpenWork has three main UI contexts:

1. **App expression** — denser, flatter, operational
2. **Cloud expression** — still operational, slightly more editorial and roomy
3. **Landing expression** — more atmospheric, but still clearly the same product family

These should differ mostly in:

- spacing density
- shell scale
- amount of atmosphere
- page composition

They should **not** differ in:

- brand color logic
- button language
- border philosophy
- type hierarchy
- selection behavior

---

## 5. Canonical token architecture

We should converge on a small token set that works everywhere.

### 5.1 Foundation color tokens

Use Radix as the raw palette source, but not as the public API for product styling.

Raw palette source:

- Radix gray/slate/sage for neutrals
- Radix red/amber/green/blue for semantic states

### 5.2 Semantic color tokens

Canonical semantic token set:

- `--ow-color-page`
- `--ow-color-surface`
- `--ow-color-surface-subtle`
- `--ow-color-surface-sidebar`
- `--ow-color-border`
- `--ow-color-border-strong`
- `--ow-color-text`
- `--ow-color-text-muted`
- `--ow-color-text-subtle`
- `--ow-color-accent`
- `--ow-color-accent-hover`
- `--ow-color-hover`
- `--ow-color-active`
- `--ow-color-success`
- `--ow-color-warning`
- `--ow-color-danger`

These should become the shared API across app and Cloud.

### 5.3 Current mapping from app tokens

Existing app tokens already point in the right direction:

- `--dls-app-bg` -> `--ow-color-page`
- `--dls-surface` -> `--ow-color-surface`
- `--dls-sidebar` -> `--ow-color-surface-sidebar`
- `--dls-border` -> `--ow-color-border`
- `--dls-text-primary` -> `--ow-color-text`
- `--dls-text-secondary` -> `--ow-color-text-muted`
- `--dls-accent` -> `--ow-color-accent`
- `--dls-accent-hover` -> `--ow-color-accent-hover`

We should migrate by aliasing first, not by breaking everything at once.

---

## 6. Typography system

Typography should be systemized into roles, not ad hoc text sizes.

### Roles

- **display** — rare marketing or hero usage
- **headline** — page and section headers
- **title** — card and object titles
- **body** — default reading text
- **meta** — labels, helper copy, secondary information
- **micro** — pills, badges, tiny metadata

### Shared rules

- one main sans family across product surfaces
- medium weight does the majority of hierarchy work
- muted text is the default support color
- avoid large type jumps inside the app

---

## 7. Spacing system

OpenWork should use a consistent spacing scale instead of one-off values.

Recommended base scale:

- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40
- 48
- 64

### Usage guidance

- micro control padding: 8–12
- row padding: 12–16
- card padding: 20–24
- major section padding: 32–48
- page rhythm: 48–64 on roomy surfaces, 24–32 in dense app surfaces

---

## 8. Radius system

Canonical radius roles:

- `--ow-radius-control` — small controls and rows
- `--ow-radius-card` — cards and panels
- `--ow-radius-shell` — sidebars, large grouped containers, modal shells
- `--ow-radius-pill` — buttons, tabs, chips

Suggested mapping:

- control: 12px
- card: 16px
- shell: 24px–32px
- pill: 9999px

---

## 9. Shadow system

Shadow should be a named system with very few levels.

- `--ow-shadow-none`
- `--ow-shadow-control`
- `--ow-shadow-card`
- `--ow-shadow-shell`

Default behavior:

- app: mostly `none` or `control`
- Cloud: mostly `none`, `control`, occasional `card`
- landing: selective `card` or `shell`

---

## 10. Component primitive families

We should explicitly define a small primitive set shared across product surfaces.

### 10.1 Action primitives

- Primary button
- Secondary button
- Ghost button
- Destructive button
- Segmented pill / tab item

### 10.2 Structure primitives

- Page shell
- Sidebar shell
- Card
- Quiet card
- Modal shell
- Section divider

### 10.3 Input primitives

- Text input
- Textarea
- Select
- Checkbox/radio treatment
- Inline field group

### 10.4 Navigation primitives

- Sidebar row
- List row
- Topbar item
- Breadcrumb / section tab

### 10.5 Feedback primitives

- Status pill
- Banner
- Empty state
- Toast

---

## 11. System-first implementation rules

### Rule 1: prefer semantic tokens over raw utility colors

Prefer:

- `bg-[var(--ow-color-surface)]`
- `text-[var(--ow-color-text-muted)]`

Over:

- `bg-white`
- `text-gray-500`

Raw grays are still acceptable for temporary legacy usage, but new primitives should use semantic tokens.

### Rule 2: page code should not define new visual language

Page files can compose primitives and choose layouts.
They should not invent new button styles, new shadow rules, or new selection patterns.

### Rule 3: Radix stays underneath the system

Radix is the palette source.
OpenWork tokens are the product API.

### Rule 4: app and Cloud should share primitives even if frameworks differ

Even when implementations differ, the primitive names and behaviors should match.

Example:

- `Button` in app
- `Button` in den-web

Both should resolve to the same token logic and visual rules.

---

## 12. Migration strategy

Do not redesign everything at once.
Use this sequence.

### Phase 1: lock the foundations

1. create canonical semantic tokens
2. alias current app tokens to the new token names
3. document primitive families and approved variants

### Phase 2: unify the most reused primitives

Start with:

1. Button
2. Card
3. Input
4. Sidebar row
5. Modal shell

These give the largest visual consistency gain.

### Phase 3: unify shell patterns

Standardize:

- page background
- sidebar shell
- panel/card shell
- list row selection
- headers and section spacing

### Phase 4: refactor high-traffic screens

Prioritize:

- workspace/session surfaces in `apps/app`
- Cloud dashboard shells in `ee/apps/den-web`
- share/package/connect flows in `apps/app`

### Phase 5: remove local style drift

As primitives stabilize:

- reduce repeated one-off class recipes
- replace raw gray classes in repeated patterns
- collapse duplicate card/button/input styles into primitives

---

## 13. Recommended initial source of truth files

If we implement this system, the likely canonical files should be:

- `DESIGN-LANGUAGE.md` — philosophy
- `DESIGN-SYSTEM.md` — system rules and migration plan
- `apps/app/src/app/index.css` — initial token host for app runtime
- `apps/app/tailwind.config.ts` — Tailwind token exposure
- `apps/app/src/app/components/button.tsx` — canonical action primitive start
- `apps/app/src/app/components/card.tsx` — canonical surface primitive start
- `apps/app/src/app/components/text-input.tsx` — canonical field primitive start

Later, a shared package may make sense, but not before the token model is stable.

---

## 14. Recommended file plan for the next step

The smallest safe implementation path is:

### Step A

Introduce canonical `--ow-*` aliases in `apps/app/src/app/index.css` without removing `--dls-*` yet.

### Step B

Refactor `Button`, `Card`, and `TextInput` to consume shared semantic tokens.

### Step C

Use the Den dashboard shell as the reference for:

- sidebar shell
- row selection
- neutral panel rhythm

### Step D

Restyle one OpenWork app screen fully using the system to prove the direction.

Recommended pilot screens:

- `apps/app/src/app/pages/settings.tsx`
- session/workspace sidebar surfaces
- share workspace modal

---

## 15. What a successful system looks like

We will know this is working when:

1. app, Cloud, and landing feel obviously from the same product family
2. a new screen can be built mostly from existing primitives
3. visual changes happen by adjusting tokens or primitives, not by editing many pages
4. selection, buttons, cards, and inputs behave consistently everywhere
5. raw color classes become uncommon outside truly local exceptions

---

## 16. Anti-goals

This system should not:

- introduce a trendy visual reboot disconnected from the current product
- replace the OpenWork mood described in `DESIGN-LANGUAGE.md`
- depend on a large new dependency just to manage styling
- force a shared package too early
- block incremental improvements until a perfect system exists

The correct approach is a strong design system built through small, boring, compounding steps.

---

## 17. Immediate next recommendation

If continuing from this doc, the best next change is:

1. add `--ow-*` semantic token aliases in `apps/app/src/app/index.css`
2. standardize `Button`, `Card`, and `TextInput`
3. then restyle one app shell to match the calmer Den dashboard direction

That gives a real system foothold without a broad rewrite.
