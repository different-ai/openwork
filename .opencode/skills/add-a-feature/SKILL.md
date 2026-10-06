---
name: add-a-feature
description: Add a new feature, put work behind a feature flag, roll out to some organizations, enable or disable a feature per org, decide whether something ships on self-hosted, or make a big change to existing behavior. Use BEFORE writing the feature code, and when removing a flag.
---

# Skill: Add a feature

Every new user-visible feature, and every change existing users would notice,
starts as one entry in the feature registry, **before any feature code**.
Nothing big ships ungated. The registry is the only place a feature is
declared; the Helm chart, `/admin` toggles, API schemas and stored overrides
are generated from it.

Registry: `packages/features/src/registry.ts` in the `@openwork/features`
package. That file is the only one you edit to declare a feature; the
resolution rules live next to it in `resolve.ts` (tested in `resolve.test.ts`,
run with `pnpm --filter @openwork/features test`).

## Does this need a flag?

Yes, if any of these is true:

- People get a new screen, tab, button, tool, route family or background worker.
- Existing users would notice the change (a flow works differently, something moves or disappears).
- It needs a staged rollout, an off switch, or might not belong on self-hosted installs.

No for bug fixes, copy changes, refactors and internal tooling.

## Is it a feature at all?

Ask in order:

1. Exists only to keep older clients working until they update? **Compat** shim
   with a removal condition, not a feature.
2. Worked out from what is installed or configured (a runner URL, signing keys)?
   **Capability**: derive it in code, never make it a switch.
3. Changes *how* something works, not *whether* people get it (a mode, URL,
   limit)? **Setting** in `env.ts` / Helm `config.<area>`.
4. Otherwise it is a **feature**: continue here.

Plan entitlements (what an org paid for) and desktop policies (what org admins
allow their members) are separate gates; a feature can check them too.

## 1. Declare it, dark

Add the entry in its own first commit:

```ts
newThing: {
  label: "New thing",
  description: "What a person gets, in words they see in the product.",
  since: "2026-10",
  cloud: "off",
  selfHosted: "off",
},
```

- Key: lowerCamelCase, no consecutive capitals. It is permanent: it is also the
  Helm key, `DEN_FEATURE_NEW_THING`, the API field and the stored row.
- Decide `cloud` and `selfHosted` separately; both are required:

| Value | Meaning there | Helm key / `/admin` toggle |
|---|---|---|
| `"unavailable"` | Not part of this deployment, by design | No |
| `"off"` | Built but dark for now | No |
| `{ control: "platform", default }` | Platform admins turn it on per org in `/admin`; on self-hosted that is the customer's operator, who can also lock it in Helm | Yes |
| `"on"` | On for every org | No |

Organization-admin control (org admins toggling it themselves) is not built
yet; ask before inventing it.

Then run `pnpm features:sync` and commit the regenerated Helm files.

## 2. Gate the code

Only through the registry. Never read organization metadata or an
environment variable to decide whether a feature is on.

- den-api, one check: `await organizationFeatureEnabled(orgId, "newThing")`
- den-api, several checks in one request: `const features = await getOrganizationFeatures(orgId)`
- den-api route guard: `requireFeature("newThing")` after `orgMemberRoute()`; answers 404 `feature_disabled`
- Inside a transaction that must stay consistent: pass `{ database: tx, lock: "share" }`
- Den web: `orgFeatureEnabled(orgContext, "newThing")` (from `app/(den)/_lib/den-org.ts`)
- Desktop and other clients: read `features.newThing` from `GET /v1/org`; a missing key means an older server, so treat it as off

Gated UI follows DESIGN.md P4: show a locked entry point with a plain reason
rather than silently removing it, when the person could act on it.

## 3. Roll it out

1. `off` → `{ control: "platform", default: false }`: turn it on for our own org in `/admin`, then for selected orgs.
2. Widen with `default: true`, or let operators decide on self-hosted.
3. `"on"` when it is done. Update `since` whenever the state changes.
4. Delete the entry and every check once it has been `on` (or `off`) everywhere; `pnpm features:check` fails after six months.

Evals turn features on through the admin API:
`enableOrganizationCapabilities(seed, admin, { newThing: true })` in
`evals/worlds/dashboards.ts`.

## Never

- Add a `DEN_*_ENABLED` env var for a product surface (CI rejects new ones).
- Read or write `organization.metadata.capabilities` (CI rejects it).
- Hand-write an `/admin` checkbox, a `/v1/org` capability field, or a Helm line for a feature.
- Ship a feature on self-hosted by accident: decide `selfHosted` on purpose.

## In the PR

Name the feature and its two values under "How is this implemented?", e.g.
"Behind `newThing` (cloud: platform, default off; self-hosted: off)."
Run `pnpm features:check` before pushing. If you changed how features resolve
(not just added an entry), add a case to `resolve.test.ts`.
