# Gateway dashboard opt-in verification

> Historical implementation receipt, not final-tree evidence. Later combined
> validation and repairs are recorded in [Independent integrated Gateway validation](gateway-independent-validation.md)
> and [Gateway publication validation](gateway-publication-validation.md).
> The SDK was regenerated again after the management-error schemas changed;
> the later full Web suite passed after the Workflow Runs assertion was updated.

Worktree: `inference-support-per-org-destinations`, PR #4358.
Base HEAD during verification: `dc297aefe4be74c95ab42ea29f31f2c75e03989a`.
Changes are uncommitted. No commits, pushes, resets, rebases, branch switches,
or migrations against shared databases were performed.

## Scope and administration

The existing organization capability `gatewayDashboard` is default-off. See
[Gateway dashboard administration](gateway-dashboard-administration.md) for
the exact platform-admin UI and per-organization GET/PUT requests. This change
does not use deployment runtime configuration as an organization flag.

## Results

Commands were run from the worktree root, serially. Database URL values below
are intentionally redacted; they referenced a newly created, disposable MySQL
8.4 container, not the existing local/shared MySQL service. The container was
stopped and removed after testing.

| Command | Result |
| --- | --- |
| `pnpm --dir ee/apps/den-web exec bun test --conditions development tests/dashboard-navigation.test.ts tests/gateway-providers-page.test.tsx tests/org-dashboard-provider.test.tsx tests/reauth-dialog.test.tsx` | Exit 0; **66 passed, 0 failed, 0 skipped**, 333 assertions |
| `pnpm --dir ee/apps/den-web typecheck` | Exit 0 |
| `pnpm --dir ee/apps/den-api exec bun test --conditions development test/organization-capabilities.test.ts test/auth-organization-metadata.test.ts` | Exit 0; **20 passed, 0 failed, 0 skipped**, 111 assertions |
| `DEN_TEST_DATABASE_URL=<isolated-test-url> pnpm --dir ee/apps/den-api run test:gateway-dashboard:db` | Exit 0; **4 passed, 0 failed, 0 skipped**, 82 assertions |
| `pnpm sdk:generate` | Exit 0; regenerated SDK from current worktree schemas |
| `DATABASE_URL=<isolated-test-url> pnpm sdk:check` | Exit 0; generated output matched, SDK typecheck passed |
| `git diff --check` | Exit 0 |
| `pnpm --dir ee/apps/den-web test && pnpm --dir ee/apps/den-web typecheck` | **Exit 1** in the first suite: **264 passed, 1 failed, 0 skipped**. Its subsequent provider-test subprocess and chained typecheck did not execute; both were run separately above. |

The broader suite's first actionable failure is
`tests/cloud-super-admins-role-hierarchy.test.ts:87`:
`Expected to contain: label: "Workflow Runs"`. The test reads the navigation
source; the builder places workflow analytics under Analytics instead of a
separate Workflow Runs item. This assertion was not changed for the flag work.
**Classification: unresolved**, not claimed pre-existing; no clean-control run
was performed. Overall broad-suite verification is **Failed**, not Passed.

Earlier, before concurrent backend rollout edits appeared, this regression
command also completed with exit 0, **16 passed, 0 failed, 0 skipped**, 703 assertions:

```sh
DATABASE_URL=<isolated-test-url> pnpm --dir ee/apps/den-api exec bun test --conditions development test/inference-providers.test.ts
```

That pass covered provider management, tenant isolation, member connect/key
flows, and migration. It is **not a final-tree verdict on the concurrent backend
rollout work**; its owner should rerun it after that work settles.

The disposable schema was prepared with the existing `db:push` script using only
the isolated URL and a test-only encryption key. No schema change or migration
is required to deploy this feature flag.

## Coverage boundaries

- Real React provider/route guard with deferred request responses: both switch
  directions, overlapping refreshes/switches, stale errors and recoveries,
  mismatched organization responses, failed refreshes, sign-out/unmount,
  setup pinning, and single-org behavior.
- Real list/new/detail/edit page elements underneath their shared layout:
  disabled routes redirect without mounting screens or starting provider requests.
- Enabled owner/super-admin/admin access; denied member access; missing,
  malformed and false capability payloads; keyed provider state and scoped loads.
- Shared navigation/search builder; BYOK remains present. In the final combined
  implementation, OpenWork Models remains for non-opted-in organizations and is
  hidden when both organization and deployment Gateway enablement are effective.
- Real BYOK detail screen: migration controls appear only on opt-in and an open
  migration confirmation disappears during an organization switch.
- Capability normalization, partial writes, explicit disable/null deletion,
  platform-admin versus organization-owner authorization, public-creation denial.

These are component/unit and database-backed API tests, **not a full browser or
Electron E2E run**. No browser/testkit journey was run and none is claimed passed.

## Files owned by this change

Under `ee/apps/den-api/`:

- `package.json`
- `src/auth.ts`
- `src/organization-capabilities.ts`
- `src/routes/admin/index.ts`
- `src/routes/org/core.ts` — only the organization capability advertisement/schema;
  concurrent deployment-capability changes in this same file were preserved.
- `test/admin-organization-capabilities.test.ts`
- `test/organization-capabilities.test.ts`
- `test/auth-organization-metadata.test.ts` (new)

Under `ee/apps/den-web/`:

- `package.json`
- `components/den-admin-panel.tsx`
- `app/(den)/_lib/den-org.ts`
- `app/(den)/dashboard/(admin)/gateway-providers/layout.tsx` (new)
- `app/(den)/dashboard/_components/gateway-dashboard-capability-guard.tsx` (new)
- `app/(den)/dashboard/_components/command-palette/den-command-palette.tsx`
- `app/(den)/dashboard/_components/inference-provider-data.tsx`
- `app/(den)/dashboard/_components/llm-provider-detail-screen.tsx`
- `app/(den)/dashboard/_components/org-dashboard-shell.tsx`
- `app/(den)/dashboard/_lib/gateway-dashboard-access.ts` (new)
- `app/(den)/dashboard/_lib/dashboard-navigation.ts`
- `app/(den)/dashboard/_providers/org-dashboard-provider.tsx`
- `tests/dashboard-navigation.test.ts`
- `tests/org-dashboard-provider.test.tsx` (new)

Also: this document and `docs/gateway-dashboard-administration.md`;
`packages/sdk/src/gen/types.gen.ts` and `sdk.gen.ts` regenerated against the
combined worktree; tracked Den-web `tsconfig.tsbuildinfo` refreshed by typecheck.

## Coordination and remaining decisions

The worktree was clean initially. Other agents subsequently changed deployment
configuration and backend Gateway management routes, Gateway environment tests,
and shared utility/type packages. Those edits were preserved, not authored or
reverted as part of the dashboard flag. Generated SDK output reflects the
combined schema, including their deployment capabilities.

The new organization flag is independent of that concurrent deployment rollout
control. Backend rollout behavior and its deployment prerequisites need to be
reviewed with that work's owner; the organization flag alone is not a promise
that the backend is deployed/enabled. Separately, resolve the broad-suite
Workflow Runs assertion before claiming the full Den-web suite is green.
