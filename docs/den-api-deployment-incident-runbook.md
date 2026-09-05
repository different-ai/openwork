# Den API deployment incident runbook

Owner: OpenWork platform on-call

Service: production Den API on Render

## Prevention and promotion

The canonical native production contract is:

```sh
pnpm install --frozen-lockfile --trust-lockfile
pnpm --filter @openwork-ee/den-api run build
pnpm --filter @openwork-ee/den-api start
```

The build resolves Den API's workspace dependency graph, builds every package with
a build script, and rejects production exports whose target file is absent.
`packaging/docker/Dockerfile.den` invokes the same package build. CI additionally
cold-starts `dist/main.js` without development conditions in
`evals/specs/den-api-production-package.test.ts`.

Render must use the commands above or deploy the CI-validated
`ghcr.io/different-ai/openwork-den-api` image. Promotion must require both the
production-package spec and the `Publish EE Artifacts / Build openwork-den-api`
image smoke check.

## Alert contract

Configure Render deployment notifications for build failure, pre-deploy failure,
startup failure, unhealthy service, canceled deploy, and rollback. Route production
events to the platform incident channel and on-call integration. Alert within five
minutes of the first failed phase; deduplicate updates for the same Render deploy ID,
but escalate when `/ready` remains unhealthy for ten minutes or an automatic rollback
occurs.

Every alert must include:

- service and environment
- commit SHA and deployment URL
- Render deploy ID and failing phase
- error excerpt
- owner: OpenWork platform on-call
- this runbook URL
- Render rollback and redeploy links

Render notification destinations, on-call schedules, and secrets are intentionally
managed outside this public repository. Verify them quarterly with a safe synthetic
deployment that has an invalid start command, confirm receipt time is under five
minutes, then cancel or roll back that deploy. Record the drill in the incident
system without committing destination URLs or credentials.

## Response

1. Open the Render deployment and identify whether build, pre-deploy, startup, or health failed.
2. For `ERR_MODULE_NOT_FOUND`, run `pnpm evals:pr specs/den-api-production-package.test.ts` at the failing SHA. Do not promote a native build that differs from the canonical contract.
3. Inspect `/health` for process liveness and `/ready` for database readiness. A live process with a failing `/ready` usually indicates a database or migration incident rather than an artifact failure.
4. Roll back to the most recent healthy deploy when production impact persists. Do not rebuild the same unverified SHA with an ad hoc package list.
5. After recovery, attach the failed deploy, commit, alert-delivery timestamp, rollback, and corrective test evidence to the incident.
