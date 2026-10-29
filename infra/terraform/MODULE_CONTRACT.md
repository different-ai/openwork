# Terraform module contract

One contract, three native modules: `openwork-aws-ecs`,
`openwork-gcp-cloud-run`, and `openwork-azure-container-apps`.
These rules describe the deployment baseline exercised in the October 2026
conformance runs, including the exceptions below. They are not a claim that every
module is released, production-qualified, or interchangeable. The modules are
**beta**; consult each module's tested-scenarios table for its exact coverage.

Keep cloud-native resources and a small common interface rather than building a
single multi-cloud abstraction. See HashiCorp's
[module composition guidance](https://developer.hashicorp.com/terraform/language/modules/develop/composition).

## C1. One migration step before rollout

- Run database migrations in one dedicated step, completing successfully before
  new Den API replicas serve traffic. Application replicas never run migrations;
  do not add per-replica migration or init containers.
- Use a native Cloud Run Job on Google Cloud, a Container Apps Job started through
  AzAPI on Azure, and a Lambda invocation that starts and waits for one standalone
  ECS task on AWS. Azure's terminal-status observer is the exception listed below.
- Fail the apply and block rollout on a failed or unknown migration outcome.
  Inspect an unknown outcome before any deliberate rerun; do not retry SQL blindly.
- For legacy per-replica deployments, document a maintenance-first handover:
  stop and drain all old schema owners, disable their restart/retry paths, fence
  old credentials where necessary, preserve secrets, migrate, then roll out.
- One deployment coordinator owns each physical schema. This is deployment
  ordering, not a cross-state database mutex, dirty marker, or schema rollback.

**Why:** Autoscaled replicas must not race to alter the same schema. A separate
job gives the rollout one observable completion result; native
[Cloud Run jobs](https://cloud.google.com/run/docs/execute/jobs) and
[Container Apps jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)
provide execution identities distinct from serving replicas.

**How it's checked:** Upgrade a live deployment with two Den API replicas (minimum
two instances on Cloud Run). Inspect execution IDs, exit-zero logs, container/task
definitions, and readiness ordering: one migrator per deployment, no migrator in
any API replica. Test failed/unknown gates offline; record separately whether a
live failure drill or legacy handover was exercised.

## C2. Security and stable secrets

- Inject credentials through cloud secret references, never plain environment
  values. Assert this for every supported secret-bearing input.
- Pin every default and custom container image by digest. Any retained legacy
  mutable-tag escape hatch must be explicit, off by default, and not recommended.
- Require HTTPS for public endpoints and verified database TLS or the cloud's
  authenticated database connector. No permissive `sslaccept=accept` path.
  Document the precise verification boundary, not just an encryption claim.
- Use least-privilege identities. Prefer separate migration DDL and application
  DML users; where not provisioned, document that limitation.
- Default to ephemeral values and provider write-only arguments so core database,
  authentication, encryption, and bootstrap values do not enter plans or state.
  Document unsupported provider paths and protect state even in write-only mode.
- Never regenerate or rotate existing secrets implicitly. Missing preservation
  inputs must block an existing deployment's conversion before changes. Explain
  legacy opt-outs, deliberate version-counter rotation, state loss, and recovery.
  Auth-secret rotation invalidates sessions; encryption-key rotation requires a
  re-encryption procedure to keep stored credentials readable.
- The cloud secret store may be the only managed copy. Protect its access and
  deletion lifecycle and document backup/recovery; write-only values do not
  provide ordinary value-drift detection or erase historical state copies.

**Why:** Marking an input `sensitive` hides display, not state storage.
[Ephemeral values and write-only arguments](https://developer.hashicorp.com/terraform/language/manage-sensitive-data)
reduce credential persistence, but require an explicit preservation and rotation
strategy so upgrades do not invalidate sessions or encrypted data.

**How it's checked:** Run both tools' native tests, security review, and live
secret-reference/TLS checks. Audit actual raw and provider-private state for the
core values without publishing those values. Compare secret versions or
fingerprints across unchanged apply and upgrade; verify the existing-deployment
guards. Do not relabel offline recovery/rotation tests as live certification.

## C3. Protect stateful resources and accept existing infrastructure

- Default database deletion protection to `true`, with an explicit disposable-test
  override. Describe whether protection also blocks Terraform destroy.
- Retain inputs for existing networks and databases. Document independent database
  lifecycle/state where stronger protection or different ownership is needed.

**Why:** Database data outlives application revisions. Dependency inversion lets
operators retain existing infrastructure instead of coupling its destruction to
an application stack; see Google's
[reusable-module guidance](https://cloud.google.com/docs/terraform/best-practices/reusable-modules).

**How it's checked:** Assert the protected default and override precedence on
both tools. Set protection off explicitly for a disposable live run, then destroy
and independently verify absence. Test existing-infrastructure inputs separately;
mock coverage alone does not certify an external database live.

## C4. Terraform and OpenTofu compatibility

- Require `>= 1.11, < 2.0` and test Terraform and OpenTofu independently.
- Stay on the common language/test subset: no tool-specific `enabled`, Actions,
  Stacks, or `override_during` options.
- Declare provider minimums with pessimistic (`~>`) constraints. The shared AWS
  module uses the tested 6.x line; the managed executable root commits its own
  exact provider lock. Do not configure providers or backends inside reusable
  modules; those belong to the executable root.
- Keep registry-specific dependency lock files only in executable examples/roots,
  with explicit instructions to select or regenerate the correct tool's lock.
  Do not combine registry namespaces or ship a reusable-module lock.

**Why:** The tools use different registry identities and can prune each other's
lock entries. Root-owned locks make installations reproducible without imposing
provider configuration on callers. See
[OpenTofu dependency locks](https://opentofu.org/docs/language/files/dependency-lock/)
and Google's [root-module guidance](https://cloud.google.com/docs/terraform/best-practices/root-modules).

**How it's checked:** For each tool, run `init`, `validate`, and `test` on the
module and validate the executable example. If an example ships a lock, select
that registry's lock and run `init -lockfile=readonly`. Record versions, pass/fail
counts, and skips; do not count one tool's result for the other.

## C5. Common interface and measured defaults

- Use the same names where meanings match: `openwork_version`, image/digest
  overrides, `domain_name`, `api_domain_name`, `owner_emails`, `org_name`,
  `deletion_protection`, and cloud-native `labels`/`tags`. Preserve existing
  network/database inputs. Retain deprecated aliases and document precedence
  instead of breaking existing inputs silently.
- Default Den API to at least 1 vCPU / 2 GiB and Den web to at least 0.5 vCPU /
  1 GiB. Cloud Run uses 1 vCPU / 1 GiB for web. Cloud SQL's baseline is
  `db-g1-small` (1.7 GB), not `db-f1-micro`.
- Expose `web_url`, `api_url`, `database_identifier`, and
  `migration_step_identifier`, retaining native outputs. Explain each identifier's
  cloud-specific meaning and the value returned for external infrastructure.
- Document all defaults in the README. These smoke-tested floors are not
  production load-sizing guarantees.

**Why:** A small consistent interface makes cloud choices understandable without
hiding native constraints. Conservative memory floors avoid known startup/idle
pressure, while real workloads still need capacity testing.

**How it's checked:** Compare README input/output/default tables across all three
modules; assert common outputs and deprecated-alias behavior in native tests.
Record live capacity observations and missing samples without inferring a load
benchmark from a short smoke run.

## C6. Consistent documentation and beta support

Use these section names and this order in each module README and its Terraform
docs-page section:

1. What it deploys
2. Tested scenarios (tool versions, OpenWork release/candidate, date, result)
3. Support level
4. Upgrade notes (including legacy migration handover and secrets preservation)
5. State guidance
6. Cost notes

Additional setup/reference sections may follow. Show a visible callout using:

> OpenWork's Terraform modules are **beta**. If you hit an issue:
> - **Customers with a support agreement:** contact your OpenWork team through your usual support channel.
> - **Everyone else:** [open a GitHub issue](https://github.com/different-ai/openwork/issues/new/choose).
> - **Security issues:** report them privately ([SECURITY.md](https://github.com/different-ai/openwork/blob/dev/SECURITY.md)).

Keep reports free of secrets and private state. Public bug/usage reporting follows
[SUPPORT.md](../../SUPPORT.md); existing support agreements retain their usual
channel.
State guidance must cover encrypted, access-controlled remote state and locking.
For S3 use `use_lockfile = true`, not deprecated DynamoDB locking.

**Why:** Matching sections let operators compare what was actually tested,
support boundaries, upgrade risks, and recurring costs. Locking prevents
concurrent state writers; see the [S3 backend guidance](https://developer.hashicorp.com/terraform/language/backend/s3).

**How it's checked:** Review the README and rendered provider page together,
including links, beta/support callouts, tested-scenario dates and limits. Run
Mintlify validation and broken-link checks. Do not advertise unmerged modules as
already available on the default branch.

## C7. Live conformance sequence

1. Pass both native test suites.
2. Deploy the recorded release baseline (`0.18.58` in the initial runs), pinned by
   digest, with two API replicas. Create the first administrator and a recognizable
   organization, and sign in.
3. Upgrade to the latest available `origin/dev` image pair at discovery, pinning
   both digests and recording the source commit. Keep two API replicas. Require
   one successful migrator, no replica migrations, retained user/organization and
   secrets, browser sign-in, and isolated desktop sign-in to the same deployment.
4. Include an unchanged-configuration apply to check that secrets and migration
   executions do not change unexpectedly.
5. Destroy, independently inventory remaining resources, and report cost with
   estimates distinguished from settled billing.

**Why:** Mocked plans cannot prove cloud execution order, authentication,
persistence, or cleanup. An upgrade of the same database exercises a different
risk from a fresh install; the [Terraform test guidance](https://developer.hashicorp.com/terraform/language/tests)
also warns that live tests create real resources.

**How it's checked:** Retain assertion results and native execution/state/log
observations for each step, tied to the actual source and images. Label missing
coverage NotRun and failed steps Failed. Later offline hardening is not a new
live run; fixture-established desktop authentication is not proof of an OS-level
OAuth/protocol-handler handoff. Screenshots illustrate results, not decide them.

## Known per-cloud limitations

- **Azure migration waiter:** job start is native AzAPI, but terminal waiting is a
  read-only Python/Azure CLI observer. It must not start or retry executions; a
  provider-native terminal waiter remains a portability follow-up.
- **Azure database protection:** the default `CanNotDelete` lock blocks
  out-of-band deletion, but Terraform can remove its own lock during destroy.
  It is not equivalent to RDS deletion protection or `prevent_destroy`.
- **Azure custom-domain certificate:** optional PFX material can be stored in
  state through the provider's certificate arguments. Protect state or manage
  certificates externally; core state-free credentials do not cover this path.
- **AWS managed-installer boundary:** the installer consumes the shared AWS 6.x
  module but explicitly retains state-backed secrets for existing and fresh
  managed installs. Its runner drains migration-capable legacy tasks, disables
  legacy rollback, replans desired counts and verifies a completed forced strict
  redeployment. CA definitions precede strict promotion, which precedes the native
  single migration and application rollout. Bootstrap migration grants require
  customer re-approval. Historical revisions are retained without deregistration;
  manual legacy RunTask remains unsupported. Native synthetic state tests and
  direct-module conformance are not a live managed version-increasing Update
  receipt; see the managed installer README for the separate proof gate.
- **AWS database TLS:** the tested RDS path verifies the certificate chain;
  separate MySQL hostname-identity enforcement is not claimed by that run.
- **Database privileges:** automatic separate DDL/DML users remain a follow-up
  where the managed database still shares a principal. Optional agents, existing
  infrastructure, custom domains, production load, backup restoration, and legacy
  adoption are not certified merely by the core conformance run.

Application-level migration locking, dirty detection, schema compatibility,
Workbot/runner/Slack/OpenWork Web parity, size presets, Actions, Stacks, and OCI
module distribution are outside this contract's validated core scope.
