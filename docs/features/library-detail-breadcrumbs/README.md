# Library detail breadcrumbs

- Feature: `libraryDetailBreadcrumbs`
- Deployments: Cloud and self-hosted
- Author: `benjaminshafii`
- Default: off

## What changes

Desktop Library detail pages show a breadcrumb trail instead of the single
Library back button. The current item is text, not an action; each ancestor
is a separate keyboard-accessible button.

- A standalone skill shows **Library / Skills / Skill name**.
- A skill opened inside a plugin shows **Library / Plugin name / Skill name**.
  Opening a plugin capability through its preferred standalone skill route no
  longer discards the plugin parent. Direct links and reloads also show a
  plugin ancestor when there is exactly one matching containing plugin.
- A category breadcrumb returns to that category. Library returns to All.
  The existing Close action returns to the selected Library category.
- The same detail frame is used for connectors, plugins, commands, and agents.
  Dialog presentations keep their existing controls.

This changes navigation only. It does not change skill instructions, grants,
sharing, sign-ins, or installation.

## Try it

Enable `libraryDetailBreadcrumbs` for a test organization. Open Library, select
Skills, and open a skill. Choose Skills in the trail: Skills should still be
selected, and the search should remain intact. Choose Library to return to All.

Open a plugin containing skills, then open a skill inside it. Choose the plugin
in the trail: that plugin's contents should appear, not the Library list.
Check keyboard focus and a narrow window with a long skill name.

## Turning it off

The original Library back button and root-return behavior are restored on the
next feature refresh. The already-open detail stays usable. No stored objects
or in-flight agent work change. There is no migration to undo.

## Evidence

The real app in headless Chrome, with a local skill open:

![Skill detail with Library, Skills, and the current skill in its breadcrumb trail](skill-breadcrumbs.png)

A skill opened from a plugin keeps its parent:

![Nested skill with a clickable Review toolkit parent](plugin-breadcrumbs.png)

## Verification

- `apps/app/tests/library-breadcrumbs.test.tsx` checks ancestor actions, the
  non-clickable current page, and truncation hooks.
- `evals/proofs/library-detail-breadcrumbs.proof.test.ts` drives the real app in
  headless Chrome, with the rollout off and on, then follows category and
  plugin ancestors. No desktop window is needed for this React surface.
- DESIGN rules: P5 (shared Button primitive), P10 (real screenshots), P11
  (navigation keeps context), V1/V2 (existing typography and semantic colors).
