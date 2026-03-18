# Den Page Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the public `/den` marketing page so a founder or team lead can understand Den in one fast scroll and take the "deploy your first worker" action.

**Architecture:** Implement the refresh in the landing app that actually serves `openwork.software/den`, not in the Den control-plane service. Keep the existing nav/footer/layout primitives, replace the page body with the new hero, use-case cards, details, and pricing sections, and add a reusable carbon-window activity panel plus a small set of landing-specific style tokens and motion helpers.

**Tech Stack:** Next.js app router, React, Tailwind utility classes, landing global CSS in `packages/landing/app/globals.css`, Framer Motion for staggered reveals.

---

## Recommended Target

The brief says the page "should be under `services/den`", but the live route is currently rendered from:

- `packages/landing/app/den/page.tsx`
- `packages/landing/components/landing-den.tsx`

`services/den` currently serves a plain control-plane demo at `/`, not the public marketing site. Updating only `services/den` would not update `openwork.software/den` unless routing/deployment architecture also changes.

## Approach Options

### Option A: Update `packages/landing` only (recommended)

```text
Browser -> openwork.software
        -> packages/landing app
        -> /den page
```

Why:
- Matches the current production route.
- Reuses existing nav, footer, background, chips, and page shell.
- Smallest diff with the highest confidence.

### Option B: Move `/den` ownership to `services/den`

```text
Browser -> openwork.software/den
        -> services/den
        -> marketing page + control-plane demo
```

Why not:
- Requires routing/deployment changes, not just page work.
- Mixes marketing and control-plane demo concerns in one service.
- Higher risk for no product gain.

### Option C: Build shared Den page primitives used by both apps

```text
shared Den UI
   -> packages/landing /den
   -> services/den demo shell
```

Why not:
- Premature abstraction for a single landing page refresh.
- Adds coordination cost between two runtimes.

## Recommendation

Use Option A. If the team later wants the Den service to host the same marketing content, extract shared pieces after the copy and layout settle.

## Affected Files

**Primary edits**
- Modify: `packages/landing/components/landing-den.tsx`
- Modify: `packages/landing/app/den/page.tsx`
- Modify: `packages/landing/components/site-footer.tsx`
- Modify: `packages/landing/app/globals.css`

**Reference files**
- Check: `DESIGN-LANGUAGE.md`
- Check: `packages/landing/components/site-nav.tsx`
- Check: `packages/landing/components/landing-home.tsx`
- Check: `packages/landing/README.md`

**Verification artifacts**
- Create: `packages/landing/pr/screenshots/den-page-refresh/` (or the repo’s current PR artifact location for landing screenshots)

---

### Task 1: Lock the real target and content model

**Files:**
- Check: `packages/landing/app/den/page.tsx`
- Check: `packages/landing/components/landing-den.tsx`
- Check: `packages/landing/components/site-footer.tsx`
- Check: `DESIGN-LANGUAGE.md`

**Step 1: Confirm routing assumption**

Run:

```bash
rg -n "LandingDen|app/den/page" packages/landing -S
```

Expected: `/den` resolves through `packages/landing`.

**Step 2: Map the brief into concrete page sections**

Create a small in-file content model in `packages/landing/components/landing-den.tsx` for:
- hero trust chips
- activity timeline entries
- use-case cards
- details grid items

Keep copy literal and short. Do not introduce CMS-style abstractions.

**Step 3: Commit**

```bash
git add packages/landing/components/landing-den.tsx
git commit -m "refactor(landing): prepare den page content structure"
```

---

### Task 2: Rebuild the hero around the new value prop

**Files:**
- Modify: `packages/landing/components/landing-den.tsx`
- Check: `packages/landing/components/site-nav.tsx`

**Step 1: Replace the current hero copy**

Update the hero to:
- keep eyebrow `OpenWork hosted`
- keep heading `Swarms`
- change subheading to `Always-on AI workers for your team.`
- change body to the new brief copy
- change CTA label to `Deploy your first worker`
- change pricing line to `$50/mo per worker · Cancel anytime`
- remove the expired early-adopter line

**Step 2: Add trust chips below the CTA**

Render four chips:
- `YC backed`
- `11.5K stars`
- `Open source`
- `50+ LLMs`

Use the existing chip/shell styling instead of inventing a new component.

**Step 3: Convert the hero layout to a two-column grid**

Use a layout equivalent to:

```text
| left: copy + CTA + trust chips | right: carbon worker activity panel |
```

On mobile, stack the carbon panel below the copy.

**Step 4: Commit**

```bash
git add packages/landing/components/landing-den.tsx
git commit -m "feat(landing): rebuild den hero"
```

---

### Task 3: Add the carbon-window worker activity panel

**Files:**
- Modify: `packages/landing/components/landing-den.tsx`
- Modify: `packages/landing/app/globals.css`

**Step 1: Build a small presentational carbon-window block**

Inside `landing-den.tsx`, add a lightweight presentational component or local JSX block for:
- dark panel shell
- titlebar with mac dots
- worker name `ops-worker-01`
- `RUNNING` status row
- 5 activity entries from the brief

Do not pull in unrelated shared app window code. The landing page only needs a visual panel.

**Step 2: Add semantic styling hooks**

Add CSS classes for:
- carbon shell background `#151718`
- carbon titlebar `#1d1f21`
- mono timestamps
- small source pills
- status dots for success, warning, critical
- pulsing running indicator

**Step 3: Add staggered reveal motion**

Use Framer Motion or CSS animation for entry fade-up with small stagger.
Respect `prefers-reduced-motion` by disabling pulse/stagger in `globals.css`.

**Step 4: Commit**

```bash
git add packages/landing/components/landing-den.tsx packages/landing/app/globals.css
git commit -m "feat(landing): add den worker activity panel"
```

---

### Task 4: Replace feature cards with use-case cards

**Files:**
- Modify: `packages/landing/components/landing-den.tsx`
- Modify: `packages/landing/app/globals.css`

**Step 1: Remove the current infrastructure-first feature card section**

Delete:
- `Hosted sandboxed workers`
- `Desktop, Slack, and Telegram access`
- `Skills, agents, and MCP included`

**Step 2: Add three use-case cards**

Render cards for:
- Ops
- Code
- Content

Each card should contain:
- gradient category dot
- uppercase label
- short title
- one-sentence description
- mono detail line

**Step 3: Reuse the existing frosted-card treatment**

Keep:
- rounded cards
- hover lift
- frosted shell feel

Only add minimal new CSS if utility classes are not enough.

**Step 4: Commit**

```bash
git add packages/landing/components/landing-den.tsx packages/landing/app/globals.css
git commit -m "feat(landing): turn den features into use cases"
```

---

### Task 5: Replace the OpenCode block with details + pricing

**Files:**
- Modify: `packages/landing/components/landing-den.tsx`
- Modify: `packages/landing/components/site-footer.tsx`

**Step 1: Replace the current lower section**

Add a two-column details section:

Left:
- `How it works`
- short paragraph from the brief

Right:
- 2x3 grid of short feature labels with blue arrow markers

**Step 2: Add a dedicated pricing section**

Centered section with:
- bold `$50/month per worker.`
- the human-time comparison sentence
- CTA `Deploy your first worker`
- subtext `No credit card to start`

**Step 3: Update the footer copy**

Keep the structure, but add `Backed by Y Combinator` to the copyright line.
Do not move footer nav around unless needed for spacing.

**Step 4: Commit**

```bash
git add packages/landing/components/landing-den.tsx packages/landing/components/site-footer.tsx
git commit -m "feat(landing): add den details and pricing sections"
```

---

### Task 6: Tighten metadata and CTA wiring

**Files:**
- Modify: `packages/landing/app/den/page.tsx`
- Check: `packages/landing/components/landing-den.tsx`

**Step 1: Update metadata description**

Replace the current infrastructure description with copy aligned to the new positioning:

```ts
"Always-on AI workers that handle repetitive work for your team and report back in Slack, Telegram, or the desktop app."
```

**Step 2: Confirm CTA destination**

Keep `getStartedHref="https://app.openwork.software"` unless product wants a different checkout or onboarding URL. The brief changes the label, not necessarily the target.

**Step 3: Commit**

```bash
git add packages/landing/app/den/page.tsx
git commit -m "chore(landing): update den metadata"
```

---

### Task 7: Verify the real page and capture artifacts

**Files:**
- Check: `packages/landing/README.md`
- Create: `packages/landing/pr/screenshots/den-page-refresh/`

**Step 1: Run the landing app locally**

Run:

```bash
pnpm --filter @different-ai/openwork-landing dev
```

Expected: local Next.js landing app starts successfully.

**Step 2: Validate the `/den` route**

Open the local landing URL in Chrome MCP and check:
- desktop layout
- mobile layout
- hero copy readability in one viewport
- carbon panel animation and reduced-motion sanity
- trust chips and CTA placement
- details and pricing sections fit the brief
- footer line includes YC wording

**Step 3: Run a production build**

Run:

```bash
pnpm --filter @different-ai/openwork-landing build
```

Expected: successful Next.js production build.

**Step 4: Save screenshots**

Capture at minimum:
- desktop hero
- desktop full page
- mobile hero
- mobile lower sections

**Step 5: Optional service cleanup decision**

Decide whether to leave `services/den/public/index.html` as the control-plane demo or move that demo to a non-root path later. Do not combine that cleanup with this marketing refresh unless there is explicit product direction.

**Step 6: Commit**

```bash
git add packages/landing/pr/screenshots/den-page-refresh
git commit -m "docs(pr): add den page verification artifacts"
```

---

## Risks and Guardrails

- Do not implement this in `services/den` unless the routing/deployment target changes first.
- Do not over-componentize the page. One local component for the activity panel is enough.
- Do not preserve the old "Powered by OpenCode" section on this page. The brief is explicit that it weakens the pitch.
- Keep the page tight. Each major section should fit roughly in one viewport.
- Keep motion subtle. The panel should feel alive, not noisy.

## Verification Checklist

- `/den` reads like a product pitch, not infra documentation.
- The hero can be understood in under 10 seconds.
- The CTA is specific.
- Use cases are concrete and map to real team work.
- Details and pricing are scannable.
- Desktop and mobile both hold together.
- `pnpm --filter @different-ai/openwork-landing build` passes.

