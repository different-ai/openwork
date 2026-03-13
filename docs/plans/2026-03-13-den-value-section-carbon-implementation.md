# Den Value Section Carbon CTA Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the Den value section so its CTA and featured-card styling match the hero's black/carbon design language and stay readable on desktop and mobile.

**Architecture:** Keep the existing section/component structure intact and make the change entirely inside the landing package. Reuse the shared `doc-button` class for the worker CTA, keep the human CTA as a neutral pill, and tune only the value-section layout classes needed for responsive balance.

**Tech Stack:** Next.js, React, Tailwind utility classes, shared landing CSS in `packages/landing/app/globals.css`

---

### Task 1: Document the approved UI direction

**Files:**
- Create: `docs/plans/2026-03-13-den-value-section-carbon-design.md`

**Step 1:** Save the approved desktop/mobile layout and palette direction.

**Step 2:** Include the verification expectation for screenshots on `/den`.

**Step 3:** Commit with the implementation change once the section update is ready.

### Task 2: Update the Den value section styling

**Files:**
- Modify: `packages/landing/components/den-value-section.tsx`

**Step 1:** Reuse the shared `doc-button` class for the worker CTA.

**Step 2:** Replace the blue featured-card borders, backgrounds, rings, bullets, and badge accents with black/carbon gray treatments.

**Step 3:** Restyle the human CTA as a neutral rounded pill with border/shadow treatment compatible with the hero CTA system.

**Step 4:** Tighten spacing and width behavior so the two cards stack well on mobile and keep their CTAs visually aligned on desktop.

**Step 5:** Commit the UI change with a short imperative message.

### Task 3: Verify the live page and collect artifacts

**Files:**
- Capture: `packages/landing/pr/2026-03-13-den-value-section-carbon-cta/*.png`

**Step 1:** Start the landing page locally.

**Step 2:** Open `/den` in a browser and inspect the value section at desktop and mobile widths.

**Step 3:** Capture before/after screenshots for both widths.

**Step 4:** Use the screenshots in the PR description alongside the problem statement and fix summary.

### Task 4: Open the pull request

**Files:**
- No code changes

**Step 1:** Push `code-factory/den-value-section-carbon-cta`.

**Step 2:** Open a PR against `dev`.

**Step 3:** Describe the bug, the styling changes, the responsive polish, and the screenshot evidence.
