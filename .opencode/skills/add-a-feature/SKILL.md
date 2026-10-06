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
4. **Organization override**: platform admins turn it on or off for one organization in `/admin`.
5. **Everyone**: on or off for everyone on the deployment, changed in `/admin` without a deploy.

Steps 2, 4 and 5 are set per deployment in `/admin` (Features page and each
organization's row) or with the admin MCP tools `den_list_features`,
`den_set_feature_rollout` and `den_set_org_capability`.

## Modules vs features

Modules and feature flags are separate layers, and every flag belongs to
exactly one module (`module` in the registry entry, required).

| | Module | Feature flag |
|---|---|---|
| Answers | What does this organization have? | Is this new code safe to show yet? |
| Lifetime | Permanent | Temporary: deleted when the rollout is done |
| Decided by | Plan or license entitlement, plus the organization's own opt-outs | The platform team: deployment, kill switch, operator lock, per-organization override, everyone on or off |
| Declared in | `packages/license-contracts/src/module-id-list.ts` and `modules.ts` | `packages/features/src/registry.ts` |
| Stored in | License snapshot and `organization.modules` | `feature_rollout` and `organization_feature` |

- **On means both.** A feature is on only when its module is on and its flag
  is on (`isFeatureEffective` in `@openwork/features`). A flag can hold a
  module back; it never grants one.
- **Pick the module first.** Work in an existing product area uses that
  area's module id. A brand-new product area adds a module id first in
  `packages/license-contracts` (ids are append-only: never rename, remove or
  reorder one), then declares its flag here with that `module`.
- **Finishing a rollout** deletes the flag and its checks. From then on the
  module's entitlement is the only gate.
- `pnpm features:check` rejects a feature with no `module` or an unknown one.

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

## 1. Declare it, off

```ts
newThing: {
  label: "New thing",
  description: "What a person gets, in words they see in the product.",
  module: "connect",
  since: "2026-10",
  deployments: ["cloud", "self_hosted"],
  default: false,
},
```

- **Key**: lowerCamelCase, no consecutive capitals. Permanent: also the Helm key, `DEN_FEATURE_NEW_THING`, the API field and stored rows.
- **Module**: the module id the feature belongs to (see "Modules vs features"). Required.
- **Deployments**: leave one out on purpose (e.g. `["cloud"]` for a cloud-only feature).
- **default**: false for new work. A fresh deployment, and a client that cannot reach Den, uses it, so never ship half-done work as `true`.
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
- People without an organization (signed-out desktop): read `GET /v1/features`; a missing key means off

Gated UI follows DESIGN.md P4: show a locked entry point with a plain reason
rather than silently removing it, when the person could act on it.

## 4. Roll it out

1. Turn it on for our own organization (override in `/admin`).
2. Turn it on for more organizations, one override at a time, checking errors as you go.
3. Turn it on for everyone in `/admin` › Features. Organizations can still be turned off one by one.
4. Anything wrong: **Turn off everywhere** (kill switch). Fix, restore, continue.
5. Once it is on everywhere: set `default: true`, then delete the entry and every check; the module's entitlement then decides. `pnpm features:check` asks for a decision six months after `since` unless the entry is `permanent`.

Evals turn features on per organization through the admin API:
`enableOrganizationCapabilities(seed, admin, { newThing: true })` in
`evals/worlds/dashboards.ts`.

## Never

- Add a `DEN_*_ENABLED` env var for a product surface (CI rejects new ones).
- Read or write `organization.metadata.capabilities` (CI rejects it).
- Hand-write an `/admin` control, a `/v1/org` field, or a Helm line for a feature.
- Ship something on self-hosted by accident: choose `deployments` on purpose.

## In the PR

Name the feature and its deployments under "How is this implemented?", e.g.
"Behind `newThing` (cloud and self-hosted, off), safe to kill: falls back to
the old flow." Run `pnpm features:check` before
pushing.
