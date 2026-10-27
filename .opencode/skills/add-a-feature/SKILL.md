---
name: add-a-feature
description: Add a new feature, put work behind a feature flag, roll something out (per organization, for everyone, cloud or self-hosted), revert or kill a feature, or make a big change to existing behavior such as a new engine. Use BEFORE writing the feature code, and when finishing or removing a rollout.
---

# Skill: Add a feature

Every new user-visible feature, and every change existing users would notice,
is a **feature** in the registry, declared **before any feature code**, off.
Nothing big ships ungated.

Registry: `packages/features/src/registry.ts` (package `@openwork/features`).
That file is the only one you edit to declare a feature. The rules live in
`resolve.ts` and are tested in `resolve.test.ts`
(`pnpm --filter @openwork/features test`).

## The model: one rollout, several dimensions

A feature is rolled out, and reverted, along these dimensions, resolved in
this order by one function (`resolveFeature`) everywhere it is checked:

1. **Deployments**: products it exists on (`cloud`, `self_hosted`). Fixed in code.
2. **Kill switch**: off everywhere at once, outranking everything below. This is the revert; no deploy.
3. **Operator lock**: a self-hosted operator forces it on or off for the whole install (Helm `config.features.<key>`).
4. **Member override**: platform admins turn it on or off for one active organization member from the organization’s Members page in `/admin`. No override inherits the organization setting.
5. **Organization override**: platform admins turn it on or off for one organization in `/admin`.
6. **Everyone**: on or off for everyone on the deployment, changed in `/admin` without a deploy.

Steps 2, 5 and 6 are set per deployment in `/admin` (Features page and each
organization's row) or with the admin MCP tools `den_list_features`,
`den_set_feature_rollout` and `den_set_org_capability`.

Every change made in `/admin` or by those tools (on, off, reset, kill switch,
restore) is appended to the `feature_change` table with who made it and when.
`/admin` shows the latest one on each row, e.g. "Last change: On for this
organization by Omar McAdam · 26 Oct 2026, 14:03". Deploy-time operator locks
(`DEN_FEATURE_*`) are not changes and are not recorded.

Member overrides are scoped to a membership, never a user globally. Pass `{ userId }` for caller-specific checks; organization-owned background policy without a person intentionally uses only organization state. The member editor supports true/false and null to restore inheritance.

## Does this need a feature?

Yes, if any of these is true:

- People get a new screen, tab, button, tool, route family, worker, or engine.
- Existing users would notice the change (a flow works differently, something moves or disappears).
- It should roll out gradually, be revertable, or might not belong on self-hosted installs.

No for bug fixes, copy changes, refactors and internal tooling.

Not a feature: anything that only platform admins see in `/admin` (the
pages we use to manage the deployment itself: Features, organizations, grants,
plans, sandboxes, recovery). Feature flags control what people in
organizations get, not the tools of the people running the deployment. Ship
those `/admin` controls without a flag; platform admin access already gates
them. This is about `/admin` only: organization admin screens in Den (the
dashboard, Manage, team settings) are things customers get, so they still need
a feature when they are new.

Not a feature either: something that only keeps older clients working
(compat shim with a removal condition), something worked out from what is
configured (derive it in code), or a setting that changes *how* something
works rather than *whether* people get it (put it in `env.ts` / Helm `config.<area>`).

## 1. Declare it, off

```ts
newThing: {
  label: "New thing",
  description: "What a person gets, in words they see in the product.",
  category: "workbot",
  added: "2026-10-26",
  since: "2026-10",
  author: "your-github-handle",
  docs: "docs/features/new-thing/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
},
```

- **Key**: lowerCamelCase, no consecutive capitals. Permanent: also the Helm key, `DEN_FEATURE_NEW_THING`, the API field and stored rows.
- **category**: the group `/admin` lists it under, one of `FEATURE_CATEGORIES` at the top of the registry. Pick the one a platform admin would look under; add a group there only when none fits.
- **added**: the day you add the flag, `YYYY-MM-DD`. It never changes (`since` moves when the entry changes). Shown in `/admin` as "Added 26 Oct 2026".
- **Deployments**: leave one out on purpose (e.g. `["cloud"]` for a cloud-only feature).
- **default**: false for new work. A fresh deployment, and a client that cannot reach Den, uses it, so never ship half-done work as `true`.
- **author**: GitHub handle of the person who owns the feature: who platform admins ask what it does, whether it is safe to turn on, and when the flag can go. Shown on `/admin` › Features with a link to their profile.
- **docs**: repo path of an internal doc, linked from `/admin` › Features as **Internal docs**. Internal docs live in the repo's `docs/` folder (e.g. `docs/features/new-thing/README.md`), never the published `packages/docs` site. Write it in the same PR:
  - **Visual feature** (a screen, button, card, panel): show at least one screenshot of it working, stored next to the doc (`docs/features/new-thing/new-thing.png`) and referenced with a relative path. Screenshot the real app, on and off if the difference matters.
  - **Not visual** (a backend change, engine, sync, token handling): enough for someone who did not build it to decide whether to turn it on: what changes, for whom, how to try it, what turning it off does, and what to watch (logs, errors, metrics).
  - Both: the feature key, its deployments, and the author.
- **permanent: true** only when the switch itself is part of the product (e.g. turning Connect off for one organization). Rollouts are temporary.

Then run `pnpm features:sync` and commit the Helm files with the registry.
OpenAPI and SDK outputs are ignored build artifacts: CI regenerates, lints and
typechecks them from the source change. `pnpm sdk:build` generates them locally
when needed; use `pnpm den:contract` for a forced generation with disposable
local MySQL. Do not commit generated contracts.

## 2. Make it safe to turn off at any moment

Before shipping, answer: **what happens when the kill switch is used?**
In-flight work, stored data, and what the person sees must survive a revert.
For example, a new engine switches only when nothing is running, falls back
on failure, and keeps history readable after a revert.

## 3. Gate the code

Only through the registry. Never read organization metadata or an
environment variable to decide whether a feature is on.

- den-api, one check: `await organizationFeatureEnabled(orgId, "newThing", { userId })`
- den-api, several checks: `const features = await getOrganizationFeatures(orgId, { userId })`
- den-api route guard: `requireFeature("newThing")` after `orgMemberRoute()`; answers 404 `feature_disabled`
- Inside a transaction that must stay consistent: pass `{ database: tx, lock: "share" }`
- Den web: `orgFeatureEnabled(orgContext, "newThing")` (from `app/(den)/_lib/den-org.ts`), backed by `GET /v1/org` `features`
- People without an organization (signed-out desktop): read `GET /v1/features`; a missing key means off

Gated UI follows DESIGN.md P4: show a locked entry point with a plain reason
rather than silently removing it, when the person could act on it.

## 4. Roll it out

1. Turn it on for our own organization (override in `/admin`).
2. Turn it on for more organizations, one override at a time, checking errors as you go.
3. Turn it on for everyone in `/admin` › Features. Organizations can still be turned off one by one.
4. Anything wrong: **Turn off everywhere** (kill switch). Fix, restore, continue.
5. Once it is on everywhere: set `default: true`, then delete the entry and every check. `pnpm features:check` asks for a decision six months after `since` unless the entry is `permanent`.

Evals turn features on per organization through the admin API:
`enableOrganizationCapabilities(seed, admin, { newThing: true })` in
`evals/worlds/dashboards.ts`.

## Never

- Add a `DEN_*_ENABLED` env var for a product surface (CI rejects new ones).
- Read or write `organization.metadata.capabilities` (CI rejects it).
- Hand-write an `/admin` control, a `/v1/org` field, or a Helm line for a feature.
- Ship something on self-hosted by accident: choose `deployments` on purpose.
- Put an `/admin`-only control behind a feature.
- Declare a feature without an `author`, or a new one without an internal doc.

## In the PR

Name the feature and its deployments under "How is this implemented?", e.g.
"Behind `newThing` (cloud and self-hosted, off), safe to kill: falls back to
the old flow." Link its internal doc. Run `pnpm features:check` before
pushing: it fails when a feature has no author, when a new feature has no
`docs`, or when the doc or an image it shows does not exist. Features declared
before docs were required are listed in `FEATURES_WITHOUT_DOCS` in
`scripts/features-sync.mjs`; when you add docs for one, remove it there.
