# Managed deployments: automatic release and one-click updates

> **Status:** proposal. Nothing here is built. Current behavior is in
> `docs/managed-deployments.md` and `infra/managed-deployments/README.md`.

## Outcome

1. A stable OpenWork release reaches every managed deployment's **Update to X**
   button without an operator doing anything, once it has passed a real AWS
   install and update.
2. A customer who opted in updates by clicking **Update** in Den. No CloudShell,
   unless the release adds IAM permissions.

## Why

A managed instance only offers an update when hosted Den advertises a newer
installer than it runs. Today that requires, per release:

- an operator to qualify the candidate by hand on an isolated AWS account,
- a protected manual dispatch of **Managed Stable Installer** with
  `promote=true`, the manifest hash and a review URL,
- the customer to paste a generated `aws cloudformation update-stack` command
  into CloudShell (`updateStackCommand` in `packages/managed-deployments/src/aws.ts`).

Candidates are prepared automatically after every stable release, but none has
ever been promoted, so installed deployments sit several releases behind the
app (for example 0.18.58 against 0.18.66).

## Phase 1: automatic qualification and promotion (no product change)

The docs already say promotion stays manual "until a real cloud qualification
gate is automated". Phase 1 builds that gate.

**New job `qualify` in `.github/workflows/managed-stable-release.yml`**, after
`prepare`, only on the trusted default branch:

1. Assume a GitHub OIDC role in a **dedicated qualification AWS account** (not
   the release account, not any customer account). Its own environment
   `managed-installer-qualification`, scoped to that account only.
2. **Fresh install:** create the candidate's bootstrap stack against an
   isolated qualification Den (or a Den test double that implements the
   enrollment, milestone and heartbeat routes) and wait for `health_verified`.
3. **Update:** install the currently advertised release, seed data (an org, a
   user, a session, a skill), then update to the candidate with the same
   `update-stack` command Den generates. Assert: one migration, data and
   sessions preserved, secret fingerprints unchanged, health operational.
4. **Teardown:** `terraform destroy` against the retained state, delete the
   stack and state bucket, then independently list the account for anything
   tagged with the run's deployment ids. Teardown runs in `always()` and a
   scheduled sweeper removes leftovers older than 6 hours.
5. Write a **qualification receipt** (manifest SHA-256, version, image digests,
   step outcomes, durations) as a workflow artifact.

**Promotion becomes automatic** when `qualify` succeeds: the existing `promote`
job takes the receipt's manifest hash instead of a human-supplied one, and the
receipt's run URL replaces the review URL. Everything else in `promote` stays:
stale/downgrade/conflict refusal, immutable object versions, one Den config
write, one deploy, post-deploy check of `GET /v1/managed-deployments/configuration`.

**Controls**

- `MANAGED_DEPLOYMENT_AWS_AUTO_PROMOTE` (repository variable, default off).
  Off keeps today's manual dispatch path. On means a green `qualify` promotes.
- The `managed-installer-production` reviewer gate stays for manual dispatches.
  Auto-promotion uses a separate environment whose only rule is "default
  branch, triggered by `qualify`".
- A failed `qualify` never promotes and posts to the release channel.
- Releases that add IAM permissions to the bootstrap template still promote
  automatically. Customers re-approve those in phase 2's console path.

**Cost:** one dedicated-VPC install plus one update per stable release, torn
down within the run (roughly an hour of RDS, ECS, ALB and NAT time).

## Phase 2: one-click customer updates (behind a flag)

### Why not just call AWS from OpenWork

A cross-account role that lets OpenWork update the stack is the simplest build,
but it breaks the current promise that OpenWork holds no access to the
customer's account. Enterprise security review would reject it. Phase 2 keeps
OpenWork outside the account: the account pulls an approved update and checks it
itself.

### How it works

Today the bundle URL, checksum, version, run id and challenge are CloudFormation
parameters copied into the CodeBuild runner's environment, so every update is a
stack update. Phase 2 adds a path that starts the same runner with new values
without a stack update:

1. **Opt-in at install.** New bootstrap parameter `AllowDenUpdates`
   (`false` by default). When `true`, the stack also creates:
   - an **updater** Lambda and role allowed only `codebuild:StartBuild` on this
     stack's runner, with the same denies the launcher has today (no buildspec,
     image or privileged-mode overrides),
   - a pinned **release signing public key** as a stack parameter.
2. **Customer clicks Update in Den.** Den creates the run exactly as it does
   now (run id, challenge, frozen release coordinates) and marks it
   `awaiting_runner`. The click needs `deployments.manage`.
3. **Updater checks in.** Every 5 minutes (its own EventBridge rule, like the
   health agent's) the updater calls a new Den route with an STS identity proof, the same
   mechanism the runner and health agent use. Den answers with nothing, or one
   pending approved run.
4. **The account verifies before acting.** The updater requires:
   - a release signature over `{version, bundleUrl, bundleSha256, protocolVersion}`
     that matches the pinned public key (signed in the `promote` job by a KMS
     key in the release account),
   - the version is newer than the installed one,
   - the bundle's `release.json` declares that it needs **no bootstrap template
     change** (`bootstrapTemplateSha256` equal to the running stack's).
5. **Updater starts the runner** with environment overrides for `RUN_ID`,
   `CHALLENGE`, `BUNDLE_URL`, `BUNDLE_SHA256`, `OPENWORK_VERSION`. From here
   the existing runner flow is unchanged: enroll, verify checksum, plan with
   retained state, refuse data-bearing changes, apply, verify health, report
   milestones.

If any check in step 4 fails, the updater reports `update_requires_console`
and Den falls back to today's CloudShell command for that run.

### What still needs the AWS console

- **Releases that change the bootstrap template**, including any new IAM
  permission. The updater cannot grant itself permissions, by design.
- **Turning on `AllowDenUpdates`** for an existing deployment (one stack
  update, then one-click from the next release).

### Trust model

| Who | Can | Cannot |
| --- | --- | --- |
| Customer AWS admin | Opt in or out at any time by changing `AllowDenUpdates` | — |
| Customer Den admin (`deployments.manage`) | Approve an update to a **signed, newer** release | Choose an arbitrary bundle, downgrade, change IAM |
| OpenWork release pipeline | Sign releases after qualification | Start anything in the account, or bypass the signature |
| Compromised Den alone | Offer a pending run | Get an unsigned or older bundle executed |

A compromised release signing key plus Den could still run code through the
runner's existing permissions. That is why the key lives in KMS in the release
account, signing happens only in the `promote` job, and customers can keep the
default CloudShell path.

### Product surface (flag `managedDeploymentOneClickUpdates`, off)

- Deployment detail: **Update to X** runs in place when the deployment reports
  `AllowDenUpdates`, with milestones shown as today. Otherwise it shows the
  CloudShell handoff.
- Launch form: an "Allow updates from OpenWork" checkbox, off by default, with
  one line on what it allows.
- Agents keep using the existing launch capability. The handoff becomes
  `none` when the account will pull the run.

Killing the flag hides the in-place button and stops Den offering pending runs
to updaters. Running deployments, health reports and the CloudShell path are
unaffected.

## Order of work

1. Qualification AWS account, OIDC role, environment.
2. `qualify` job and teardown sweeper, with auto-promote off. Run it on the
   next stable candidate and compare with a manual qualification.
3. Turn on `MANAGED_DEPLOYMENT_AWS_AUTO_PROMOTE`.
4. Release signing in `promote`, plus `bootstrapTemplateSha256` in `release.json`.
5. Bootstrap `AllowDenUpdates`, updater Lambda, Den check-in route, flag and UI.

Steps 1 to 3 remove most of the delay and change nothing customers see.

## Open questions

- Qualification against a real isolated Den or a contract-level test double?
  A real Den is stronger evidence. A double is cheaper and faster.
- Should auto-promotion wait a soak period (for example 24 hours after the app
  release) before advertising to customers?
- GCP: same design, with Cloud Build and a service-account ID token. Out of
  scope until the GCP installer is configured.
