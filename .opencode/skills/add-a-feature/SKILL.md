---
name: add-a-feature
description: Add a feature or feature flag, roll it out (per organization, everyone, cloud or self-hosted), revert or kill it, or make a big behavior change such as a new engine. Use BEFORE writing feature code, and when finishing a rollout.
---

# Add a feature

Every new user-visible feature, and every change existing users would notice, is declared off in `packages/features/src/registry.ts` before any feature code. That file is the only one you edit to declare it. One function, `resolveFeature` (`resolve.ts`), decides in this order: deployments (in code), kill switch, self-hosted operator lock (Helm `config.features.<key>`), organization override, everyone. The last three are set in `/admin` or with `den_list_features`, `den_set_feature_rollout`, `den_set_org_capability`.

## Does it need one?

Yes for a new screen, tab, button, tool, route family, worker or engine; a change existing users would notice; anything that should roll out gradually, be revertable, or might not belong on self-hosted. No for bug fixes, copy, refactors, internal tooling, compat shims with a removal condition, values derived from config, or settings that change how something works (put those in `env.ts` / Helm `config.<area>`).

## Steps

1. Declare it:

   ```ts
   newThing: {
     label: "New thing",
     description: "What a person gets, in words they see in the product.",
     since: "2026-10",
     deployments: ["cloud", "self_hosted"],   // leave one out on purpose
     default: false,                          // fresh installs and offline clients use this
   },
   ```

   The key is permanent: it becomes the Helm key, `DEN_FEATURE_NEW_THING`, the API field and stored rows. Add `permanent: true` only when the switch itself is product.
2. Run `pnpm features:sync` with MySQL up (`pnpm dev:den:mysql`). Commit the Helm files, `packages/docs/openapi.json` and `packages/sdk/src/gen/**` together. Do not stop if the contract step fails.
3. Answer "what happens when the kill switch is used?" In-flight work, stored data and the screen must survive a revert (e.g. a new engine switches only when idle, falls back on failure, keeps history readable).
4. Gate only through the registry:
   - den-api: `organizationFeatureEnabled(orgId, "newThing", { userId })`, `getOrganizationFeatures(orgId, { userId })`, or `requireFeature("newThing")` after `orgMemberRoute()` (404 `feature_disabled`). In a transaction pass `{ database: tx, lock: "share" }`.
   - Den web: `orgFeatureEnabled(orgContext, "newThing")` from `app/(den)/_lib/den-org.ts`.
   - No organization (signed-out desktop): `GET /v1/features`; a missing key is off.
   - Gated UI shows a locked entry point with a plain reason when the person could act on it (DESIGN.md P4).
5. Roll out: our org override, then more orgs one at a time, then everyone in `/admin` › Features. Anything wrong: **Turn off everywhere**, fix, restore.
6. Finish: set `default: true`, then delete the entry and every check.

Evals enable it per org with `enableOrganizationCapabilities(seed, admin, { newThing: true })` (`evals/worlds/dashboards.ts`).

`pnpm features:check` enforces key format, label, `since`, deployments, Helm and contract drift, the six-month finish-or-`permanent` decision, and rejects new `DEN_*_ENABLED` switches and `organization.metadata.capabilities` reads. Run it before pushing. Never hand-write an `/admin` control, `/v1/org` field or Helm line for a feature.

In the PR, under "How is this implemented?": "Behind `newThing` (cloud and self-hosted, off), safe to kill: falls back to the old flow."
