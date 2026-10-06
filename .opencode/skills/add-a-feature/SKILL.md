---
name: add-a-feature
description: Add a new feature, put work behind a feature flag, roll something out gradually (percentage, per organization, cloud or self-hosted), revert or kill a feature, or make a big change to existing behavior such as a new engine. Use BEFORE writing the feature code, and when finishing or removing a rollout.
---

# Skill: Add a feature

Every new user-visible feature, and every change existing users would notice,
is a **feature** in the registry, declared **before any feature code**, at 0%.
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
4. **Organization override**: platform admins turn it on or off for one organization in `/admin`.
5. **Percentage**: how much of the feature's subject has it, 0% (dark) to 100% (everyone), changed in `/admin` without a deploy.

Steps 2, 4 and 5 are set per deployment in `/admin` (Features page and each
organization's row) or with the admin MCP tools `den_list_features`,
`den_set_feature_rollout` and `den_set_org_capability`.

## Does this need a feature?

Yes, if any of these is true:

- People get a new screen, tab, button, tool, route family, worker, or engine.
- Existing users would notice the change (a flow works differently, something moves or disappears).
- It should roll out gradually, be revertable, or might not belong on self-hosted installs.

No for bug fixes, copy changes, refactors and internal tooling.

Not a feature either: something that only keeps older clients working
(compat shim with a removal condition), something worked out from what is
configured (derive it in code), or a setting that changes *how* something
works rather than *whether* people get it (put it in `env.ts` / Helm `config.<area>`).

## 1. Declare it, at 0%

```ts
newThing: {
  label: "New thing",
  description: "What a person gets, in words they see in the product.",
  since: "2026-10",
  subject: "person",               // or "organization"
  deployments: ["cloud", "self_hosted"],
  start: 0,
},
```

- **Key**: lowerCamelCase, no consecutive capitals. Permanent: also the Helm key, `DEN_FEATURE_NEW_THING`, the API field and stored rows.
- **Subject**, ask: *could someone without an organization see this?*
  - Yes, it is in the app itself (desktop or web UI, an engine): `"person"`. Buckets by user id when signed in, install id when signed out, so signed-out desktop users are included.
  - No, it only exists with Den (dashboards, Connect, audit logs): `"organization"`.
- **Deployments**: leave one out on purpose (e.g. `["cloud"]` for a cloud-only feature).
- **start**: 0 for new work. A fresh offline install uses it, so never ship half-done work above 0.
- **permanent: true** only when the switch itself is part of the product (e.g. turning Connect off for one organization). Rollouts are temporary.

Then run `pnpm features:sync` and commit the regenerated Helm files.

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
- Clients without Den (signed-out desktop): read `GET /v1/features/rollouts` and call `resolveFeature` from `@openwork/features` with the install id; a missing key means off

Gated UI follows DESIGN.md P4: show a locked entry point with a plain reason
rather than silently removing it, when the person could act on it.

## 4. Roll it out

1. Turn it on for our own organization (override in `/admin`).
2. Raise the percentage in `/admin` › Features: 1, 5, 25, 50, 100. Compare errors before each step.
3. Anything wrong: **Turn off everywhere** (kill switch). Fix, restore, continue.
4. At 100% everywhere: set `start: 100`, then delete the entry and every check. `pnpm features:check` asks for a decision six months after `since` unless the entry is `permanent`.

Evals turn features on per organization through the admin API:
`enableOrganizationCapabilities(seed, admin, { newThing: true })` in
`evals/worlds/dashboards.ts`.

## Never

- Add a `DEN_*_ENABLED` env var for a product surface (CI rejects new ones).
- Read or write `organization.metadata.capabilities` (CI rejects it).
- Hand-write an `/admin` control, a `/v1/org` field, or a Helm line for a feature.
- Ship something on self-hosted by accident: choose `deployments` on purpose.

## In the PR

Name the feature, its subject and its deployments under "How is this
implemented?", e.g. "Behind `newThing` (person, cloud and self-hosted, 0%),
safe to kill: falls back to the old flow." Run `pnpm features:check` before
pushing.
