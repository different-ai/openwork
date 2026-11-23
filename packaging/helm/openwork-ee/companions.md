# Optional runner and Workbot

This chart can manage a private headless runner and a Workbot web service.
`headlessRunner.enabled` and `workbot.enabled` are separate workload switches,
both off by default. They are deployment configuration, not new product feature
flags. Existing organization features and access controls still apply.

**Verification status:** offline rendering and contract tests are provided.
Kubernetes install, upgrade, disable, re-enable and a member reply through this
chart have not yet been exercised. A successful manually applied companion
installation is not this chart's runtime proof. Use an isolated lab before
production rollout.

## Before enabling

- Keep the same Helm release name and namespace across stages. Save your complete
  reviewed values in version control without secrets. Use `--reset-values -f`
  with that complete file for each upgrade; do not depend on `--reuse-values`
  silently dropping old overrides.
- Use one published release for Den API, Den Web, Gateway, runner and Workbot.
  `image.tag` or the packaged chart's `appVersion` applies to all of them.
  Per-component tags must resolve to the same tag. Mirrored repositories are
  supported; the operator must ensure each mirror contains matching bytes.
  A tag equality check cannot establish image digest identity.
- Configure Gateway using the existing [Gateway instructions](README.md).
  `gateway.enabled: true` is required for chart-managed runner execution. This
  validates the shared Den/Gateway database wiring too. Configure a provider,
  a model group, credentials and the intended members' grants in Den first.
- Record the model's exact `gwm_...` wire alias from the Gateway catalog and its
  protocol: `anthropic`, `openai` (Chat Completions), or `openai-responses`.
  The alias must exist in this installation. The chart validates its shape,
  not its existence or the member's permissions. Do not copy the synthetic alias
  from the contract test. Alias-free runner startup is not included in this slice.
- Set `config.public.webOrigin` to the browser-facing Den HTTPS origin. Set
  `config.public.apiOrigin` for split-origin installs; otherwise it inherits the
  web origin. These origins must be reachable from both companions. The runner
  uses the public API for MCP, callbacks and telemetry. Its default model base
  is derived from `config.public.gatewayPublicBaseUrl` with `/api/v1` appended.
  Member turns supply scoped Gateway credentials and provider-specific routing;
  there is no shared model API key in the companion pods.
- Provide RWO storage and a tested backup/restore procedure. This slice is one
  SQLite writer, not an HA service. Recreate upgrades stop the old pod before
  starting its replacement and cause an availability gap. Never scale it or
  mount its claim in another writer. Take a consistent SQLite backup including
  its WAL, and back up `/var/data/files` together with the database.
- Create operator-owned Secrets before the upgrade, in the release namespace.
  The chart never creates, updates, rotates or deletes these companion Secrets.
  Use your secret manager, External Secrets, or another approved secure path.
  Never put the values in Helm values, command-line flags or Git.

| Secret | Required keys (defaults) | Contract |
| --- | --- | --- |
| runner Secret | `HEADLESS_API_TOKEN` | At least 32 characters. Shared by runner, Den API and Workbot through targeted `secretKeyRef`s. |
| same runner Secret | `HEADLESS_DEN_CALLBACK_TOKEN` | At least 32 characters, different from the API token. Shared only by runner and Den API. |
| same runner Secret | `HEADLESS_GRANT_KEY` | Independent stable value of at least 32 characters. Runner only, for encrypted resume grants. |
| Workbot Secret | `WORKBOT_SESSION_SECRET` | Independent stable value of at least 32 characters. Workbot only, for encrypted sign-in cookies. |

Keys can be remapped with `headlessRunner.secret.apiTokenKey`, `callbackTokenKey`,
`grantKey` and `workbot.secret.sessionSecretKey`. Required keys use
`optional: false`. The chart checks that key names are distinct; Kubernetes
checks existence, and the applications validate actual values. Offline Helm
cannot check lengths, equality, permissions or contents of an existing Secret.
The companion Secret names must differ from the shared Den Secret, because
Den's pre-existing broad `envFrom` import must not receive runner-only material.
Do not put companion configuration in that shared Secret. Restrict Kubernetes
RBAC and Secret-manager permissions accordingly.

Rotation requires a coordinated rollout of consumers; editing an operator
Secret does not restart pods. Changing the API token without restarting Den,
runner and Workbot together temporarily breaks service calls. Rotating the
callback token requires Den and runner together. Losing or changing the grant
key prevents old grants from resuming. Rotating the session secret signs people
out. Preserve all four values across disable/re-enable unless rotating on purpose.

## Stage 1: core only

Install or upgrade the core chart with your existing reviewed values. Leaving
both companion roots absent or `{}` creates no companion workloads, PVCs,
Ingresses or Den environment entries. Existing manual `denApi.env` and
`denWeb.env` configuration still renders when the chart opt-ins are off.

This does **not** adopt a manually applied Deployment, Service, PVC or Secret.
Before switching from a manual installation, inventory ownership, names,
settings and data, then plan a stopped-writer storage migration and rollback.
There is no automatic adoption or migration promise. Do not run the manual
runner alongside the new runner against the same database.

## Stage 2: private runner

Add the following to your complete values file. Existing core database,
Gateway and public origin values remain required.

```yaml
headlessRunner:
  enabled: true
  model:
    protocol: openai-responses
    alias: REPLACE_WITH_THIS_INSTALLS_GATEWAY_WIRE_ALIAS
  secret:
    existingSecret: runner-runtime
  persistence:
    enabled: true
    size: 10Gi
    # null/omitted: cluster default; "": explicitly no StorageClass
    storageClass: null
    # To use operator-owned or previously retained storage instead:
    existingClaim: ""
  resources: {}
workbot:
  enabled: false
```

Render and inspect the change before applying:

```sh
helm lint packaging/helm/openwork-ee -f complete-values.yaml
helm template openwork-ee packaging/helm/openwork-ee -f complete-values.yaml
# Only in an approved isolated lab or after your deployment approval:
helm upgrade --install openwork-ee packaging/helm/openwork-ee \
  --namespace openwork --reset-values -f complete-values.yaml --wait
```

The runner is a separate Deployment: one replica, `Recreate`, no mounted service
account token, private `ClusterIP` on 8795. It has no ingress or public Service.
Its SQLite database is `/var/data/headless.sqlite`; attachments are on disk at
`/var/data/files` on the same PVC. Computer provisioning and S3 storage are not
included. Den API receives the private runner URL and targeted API/callback
Secret refs. Den Web does not receive runner credentials.

Enabling the runner also makes it available to existing eligible cloud agent
Automations and Slack Assistant paths, subject to their organization settings
and entitlements. Workbot does not have to be running. Monitor Den's Services
page and service logs before adding Workbot. Pod probes check HTTP process
health only; they are not evidence of working Gateway inference or callbacks.

## Stage 3: Workbot

Keep the runner configuration, and add:

```yaml
workbot:
  enabled: true
  publicUrl: https://chat.example.com
  secret:
    existingSecret: workbot-runtime
  ingress:
    enabled: true
    className: nginx
    annotations: {}
    tlsSecretName: workbot-tls
  resources: {}
```

Provision DNS, an ingress controller and the TLS certificate Secret through your
normal process. The Ingress host and TLS host are derived from `publicUrl`,
with `/` routed to the Workbot `ClusterIP` Service on 3020. Do not reuse the
Den web, API or Gateway hostname for Workbot; there is no path-prefix hosting.
For an existing HTTPS reverse proxy, leave `workbot.ingress.enabled: false`
and pass requests to the Workbot Service yourself, preserving host and forwarded
scheme. Support streaming responses and long-lived connections at that edge.
This is HTTP behind TLS termination, not raw TLS passthrough to the pod.
Neither companion serves native TLS, and disabling certificate verification is
not supported. TLS certificates and external edge configuration are operator-owned.

Den API and Den Web both receive the same `DEN_WORKBOT_URL`. Workbot receives
that canonical public URL, the existing Den public origins and the private
runner URL. A Workbot-only install using an external runner is not part of this
chart interface and is rejected. Manual companion installs remain a separate
operator-managed path with the chart switches off.

The existing `customCa` configuration mounts the same trust bundle into both
companions and sets `NODE_EXTRA_CA_CERTS`; it also continues to configure Den
and Gateway. The bundle must cover all private issuers on outbound HTTPS paths.
Restart consumers after changing an existing CA object. There is no arbitrary
companion `env`, `envFrom`, port, replica or storage-path override; unsupported
settings fail rendering instead of silently diverging from the managed wiring.
Mobile association settings and additional runner backends are not included.

## Stage 4: disable and re-enable

1. Disable **only Workbot** with `workbot.enabled: false` in the complete values
   file and upgrade. Its Deployment, Service and chart Ingress disappear, even
   if `workbot.ingress.enabled` remains true in saved values. Both Den Workbot
   entries disappear. The runner, its Den API wiring, PVC and Secrets remain.
   Existing Workbot connections stop; ongoing runner turns may continue. Den's
   other eligible runner consumers remain connected. Core Desktop usage stays up.
2. To stop the runner too, set both workload switches false and upgrade.
   **Keep `headlessRunner.persistence.enabled: true` and the same claim settings.**
   Runner Deployment and Service disappear. All chart-injected runner URL and
   token/callback refs disappear from Den API. No chart-injected Workbot entries
   remain in either Den process. Running turns are interrupted; there is no
   automatic drain or promise that an interrupted turn resumes. Cloud runner
   consumers are unavailable until it returns. Stored conversations and files
   stay on the still-rendered PVC. Core resources are not disabled.
3. To re-enable, retain the release, namespace, claim settings, secrets, model
   alias and compatible image release. Enable runner first and inspect its
   health and stored conversations, then Workbot. The same still-managed PVC is
   mounted again; no new data directory or purge job is created.

The PVC alone carries `helm.sh/resource-policy: keep`. Workloads **do not**:
`keep` on a Deployment would leave a live service after disable. The chart never
performs a destructive purge. If you also remove the persistence settings or
uninstall the release, Helm retains the PVC but no longer manages it. Inventory
it explicitly. On a later install, set `persistence.enabled: true` and
`persistence.existingClaim` to that retained claim's name; the chart then mounts
it without rendering/adopting a PVC. Do not assume removing the value creates
an empty claim, or that Helm will adopt an orphaned retained resource.

PVC capacity and StorageClass changes are subject to Kubernetes immutability
and storage-driver expansion support. Do not change claim identity, StorageClass
or release name as a storage migration. Back up first and perform a separate,
reviewed stopped-writer migration when needed. Deleting retained PVCs, snapshots
or Secrets is a separate operator decision after retention and backup review.

Before a managed rollout, remove old `DEN_HEADLESS_RUNNER_*` and `DEN_WORKBOT_URL`
entries from manual env configuration; the chart rejects those conflicts while
the runner opt-in is on. Also remove those keys from any externally managed
shared Den Secret. The chart cannot inspect an external Secret offline and
does not edit it. Legacy external settings can otherwise survive workload
disable, so their removal is a required migration preflight.

## Offline checks and runtime proof plan

```sh
pnpm --dir evals exec vitest run --config vitest.config.ts \
  --project pr scripts/helm-companions.test.ts
for test in packaging/helm/openwork-ee/tests/*.sh; do bash "$test"; done
node --test packaging/helm/openwork-ee/tests/node-runtime.mjs
pnpm check
```

The testkit test exercises actual Helm renders, independent switches, derived
URLs, Secret refs, default-off/manual compatibility, dependency/configuration
rejections, image alignment, CA/TLS and retained/existing storage wiring. These
are manifest contracts, **not** proof of a running Helm upgrade or member reply.

Run the following lifecycle in a separately approved, exclusively owned lab.
Do not start a shared container VM or pull large images as an incidental test.
Record owner, disk/RAM budget, image inventory, exact commit and image digests,
namespace, release and cleanup obligations before starting. No cloud resources,
real provider credentials or paid inference are needed.

1. Use the smallest existing local Kubernetes capacity approved for this test,
   or stop and request capacity. Pin published matching application images and
   use only synthetic credentials, isolated MySQL/Redis, local DNS/HTTPS and a
   deterministic Responses fixture. Configure Gateway through its real admin
   API with that fixture and a member grant. Keep fixture egress loopback/lab
   only, with no fallthrough to public providers. Use `customCa` for lab HTTPS.
2. Install core with both workload switches absent. Capture `helm get manifest`,
   Deployment/Service/PVC inventories and an authenticated core health check.
   Confirm companion resources and all injected companion Den settings are absent.
3. Reject Workbot without runner before applying anything. Upgrade runner-only
   with an explicit real fixture-backed Gateway alias and `openai-responses`.
   Wait for PVC Bound and one Ready runner pod. Check rendered and actual
   Deployment strategy, mounted claim UID and target Secret refs. Verify Den
   Services detects the runner and callbacks. Do not print Secret contents.
4. Upgrade Workbot with HTTPS edge routing. Sign in as the test member through
   the real OAuth flow. Send a unique prompt and receive the deterministic reply
   in Workbot. Record Gateway/fixture request witnesses and identity-scoped
   conversation evidence. Prove an ungranted member cannot execute the model.
   Record the conversation identifier, claim UID and a harmless attachment hash.
5. Disable only Workbot, leaving its ingress child setting true. Wait until its
   pods/Service/Ingress are absent. Check actual Den pods have no Workbot env,
   retain runner refs, and core health still succeeds. Verify a supported
   non-Workbot runner client can still reach the same runner. Do not claim this
   from desired manifests alone.
6. Disable runner as well, leaving persistence enabled. Wait for zero runner
   pods/Service. Verify actual restarted Den pods have no injected companion
   settings. Check the same PVC remains Bound with the same UID and no second
   writer. Capture that no companion workload has a keep annotation.
7. Re-enable runner then Workbot with the same claim and secrets. Confirm the
   original conversation and attachment still read correctly, and another
   deterministic member reply succeeds. Check any in-flight turn's documented
   interrupted state rather than promising resume.
8. Uninstall the lab release, verify only the retained PVC and operator-owned
   Secrets/CA/cert objects remain from the companion setup, then reinstall with
   `existingClaim` to verify the documented reuse path without adoption. Finally
   stop owned workloads. Delete lab data/credentials only under the explicit
   cleanup approval; record what remains and why. Never use an automatic purge
   hook or delete shared resources.

Publish exact commands, statuses, before/after resource inventories, member-turn
witnesses and failures/skips. Until these steps run, lifecycle/runtime coverage
is incomplete even if every offline check passes.
