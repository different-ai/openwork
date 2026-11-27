# Optional runner and Workbot

This chart can manage a private headless runner and a Workbot web service.
`headlessRunner.enabled` and `workbot.enabled` are separate workload switches,
both off by default. They are deployment configuration, not new product feature
flags. Existing organization features and access controls still apply.

Offline rendering and contract tests are provided. They do not establish runtime
compatibility for an arbitrary image release, cluster or ingress controller.
Use the isolated application lifecycle checks below before a production rollout;
include real member sign-in, a granted model reply and stored-data recovery.

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
- Set `config.public.webOrigin` to the browser-facing Den HTTPS origin. A blank
  `config.public.apiOrigin` follows Den's DNS derivation: `https://den.example.com`
  becomes `https://api.den.example.com`, not the web origin. The whole hostname
  is prefixed, even if it already begins with `api.`. Nondefault HTTPS ports are
  preserved and port 443 is normalized away. Set `apiOrigin` explicitly for
  same-origin routing, IP-based web origins or any different public API route.
  Ambiguous non-DNS derivation is rejected. Companion chart `apiOrigin` accepts
  an HTTPS origin only, not a pathful API base such as `https://den.example.com/api`.
  Prefix-mounted API deployments are not supported by this companion interface;
  expose the API's root routes at its public origin instead. These origins must
  be reachable from both companions. The runner
  uses the public API for MCP, callbacks and telemetry. Its default model base
  is derived from `config.public.gatewayPublicBaseUrl` with `/api/v1` appended.
  Member turns supply scoped Gateway credentials and provider-specific routing;
  there is no shared model API key in the companion pods.
- Provide RWO storage and a tested backup/restore procedure. This slice is one
  SQLite writer, not an HA service. Recreate upgrades stop the old pod before
  starting its replacement and cause an availability gap. Never scale it or
  mount its claim in another writer. Take a consistent SQLite backup including
  its WAL, and back up `/var/data/files` together with the database.

### Companion Secrets

Create operator-owned Secrets before the upgrade, in the release namespace.
The deployment operator generates all four values. OpenWork does not issue them.
The chart never creates, updates, rotates or deletes these companion Secrets.
Use your secret manager, External Secrets, or another approved secure path.
Never put the values in Helm values, command-line flags or Git.

| Secret | Required key (default name) | Purpose | Contract |
| --- | --- | --- | --- |
| Runner Secret | `HEADLESS_API_TOKEN` | Authenticates calls to the runner. | At least 32 characters. Shared by the runner, Den API and Workbot through targeted `secretKeyRef`s. |
| Runner Secret | `HEADLESS_DEN_CALLBACK_TOKEN` | Authenticates callbacks from the runner to Den. | At least 32 characters. Must differ from `HEADLESS_API_TOKEN`. Shared only by the runner and Den API. |
| Runner Secret | `HEADLESS_GRANT_KEY` | Encrypts the runner's stored resume grants. | Independent, stable value of at least 32 characters. Runner only. |
| Workbot Secret | `WORKBOT_SESSION_SECRET` | Encrypts Workbot sign-in cookies. | Independent, stable value of at least 32 characters. Workbot only. |

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

## Pod Security admission constraints

This slice does not add a Restricted Pod Security override interface. The
existing chart has no security-context convention to reuse, and the published
companion images currently start as root. These manifests do not set
`runAsNonRoot`, `allowPrivilegeEscalation: false`, a restricted seccomp profile
or dropped capabilities. They are **not compatible with Restricted admission
as rendered**. Disabling service-account-token mounting is not sufficient.
The core chart has its own hardening requirements too.

If your namespace enforces Restricted, do not enable these workloads as-is.
A separately tested hardening change must establish a supported non-root UID,
SQLite/files PVC ownership and writable directories, then set the required pod
and container contexts. Do not assume setting a random UID will preserve access
to an existing claim. This guide does not recommend weakening namespace or
cluster admission policies. No non-root, read-only-root-filesystem or Restricted
runtime compatibility has been proven by the offline tests.

## Stage 1: core only

Install or upgrade the core chart with your existing reviewed values. Leaving
both companion roots absent or `{}` creates no companion workloads, PVCs,
Ingresses or Den environment entries. Existing manual `denApi.env` and
`denWeb.env` configuration still renders when the chart opt-ins are off.
Existing installs retain the historical hosted `/workbot` fallback. To opt a
self-hosted deployment into returning 404 when Workbot is unconfigured, add this
to the complete values file:

```yaml
config:
  deployment: self_hosted
  features:
    workbotConfiguredEntry: "true"
```

This registry feature is **off by default** and available only on self-hosted
Den. Keep it in the complete values file when disabling Workbot or both
companions; it is independent of the workload switches. An explicit manual
`DEN_WORKBOT_URL` still wins, including path/query and organization forwarding.
Cloud, unset and unknown deployment classifications keep the hosted fallback.
No new setting is required on existing hosted installations.

Den Web reads the canonical public deployment feature response from
`DEN_API_BASE`. Missing, invalid or unavailable discovery keeps the feature off
and preserves the hosted fallback, so this is **not an offline isolation or
security boundary**. Registry kill switches, operator locks and deployment-wide
rollout apply; organization overrides do not govern this public entry. See the
[feature guide](../../../docs/features/workbot-configured-entry/README.md).

Both Den API and Den Web need matching images containing this feature. Selecting
older published images does not acquire it from chart values alone. Earlier
companion runtime checks do not prove this newly gated route.

### Manual destinations and Terraform classification

With the chart-managed companion switches off, an operator keeping a manual
Workbot installation must configure the destination on **both** processes:

```yaml
denApi:
  env:
    DEN_WORKBOT_URL: https://chat.example.com
denWeb:
  env:
    DEN_WORKBOT_URL: https://chat.example.com
```

Den API uses its setting for the Workbot integration/OAuth origin; Den Web uses
its own setting for `/workbot`. Setting only the API value does not configure
the Web redirect. Use the same canonical HTTPS Workbot origin on both.
Historical explicit manual Web destinations retain path/query parameters and
organization forwarding; that compatibility does not add path-prefix hosting
to chart-managed Workbot. Remove these overrides before enabling chart-managed
companions, which derive and inject the destination themselves.

The Terraform source modules were inspected, not deployed or changed here.
`infra/terraform/modules/openwork-self-host` wraps a selected Helm chart; only
a chart version that supplies `DEN_DEPLOYMENT=self_hosted` gives this marker by
default. The direct AWS ECS, GCP Cloud Run and Azure Container Apps modules do
not currently supply that marker in their environment maps. The marker alone
also does not enable the new entry feature: canonical deployment discovery must
resolve it on. Those installs otherwise retain the historical hosted fallback
when Workbot is unconfigured, even though the infrastructure is self-hosted.

For direct AWS/GCP installs, the existing `extra_environment` map can explicitly
supply `DEN_DEPLOYMENT = "self_hosted"` to the applications when the operator
intends this classification. Azure's plaintext `extra_environment` allowlist
does not permit this key; no automatic self-hosted-off guarantee is made for
that module in this slice. Review its supported configuration separately rather
than bypassing its allowlist or applying unreviewed Terraform changes. None of
these settings or infrastructure changes is applied by this chart guide.

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
`ClusterIP` is not a NetworkPolicy boundary: the chart does not create network
isolation. The internal runner connection uses HTTP bearer authentication, so
use a trusted private cluster network and your reviewed network isolation policy.
No native runner TLS or cross-cluster public runner exposure is included.
Its SQLite database is `/var/data/headless.sqlite`; attachments are on disk at
`/var/data/files` on the same PVC. Computer provisioning and S3 storage are not
included. Den API receives the private runner URL and targeted API/callback
Secret refs. Den Web does not receive runner credentials.

### Existing consumers and model scope

Enabling the runner changes existing eligible cloud agent Automations: when
headless Automations are included by the organization's plan (or plan gating is
off), Den's existing runtime selector can choose headless instead of the web
runtime. Already scheduled eligible work can therefore start using this runner
without enabling Workbot. This is the existing selection policy; the chart adds
no independent scheduling-policy feature or pause switch. Review scheduled
work and its model grants before enabling the runner.

Already installed, connector-enabled Slack assistants can also start using this
runner. Configuring a runner does **not** install a Slack bot, opt in a connector,
grant a member access or enable Slack across organizations. Existing connector
setup, member OAuth, grants, assistant opt-in and worker settings remain
required. Workbot does not have to be running for Automations or Slack.

One runner serves the deployment, potentially multiple organizations, while
Den binds each turn to its authenticated organization/member and supplies
member-scoped model access. The explicit startup `model.alias` identifies one
Gateway model group/credential-set/model selection in this installation. It is
not a universal model alias across organizations, a member grant, or an
instruction to rewrite every organization's model settings. Configure and
verify each organization's/member's intended model choices and grants in Den;
per-turn model access can select a different authorized model/protocol. An
organization-specific alias must not be copied into another organization's
settings as a substitute for its own catalog. The chart cannot prove those
live catalog mappings or multi-organization isolation by rendering.

Monitor Den's Services page and service logs before adding Workbot. Pod probes
check HTTP process health only; they are not evidence of working Gateway
inference, model access or callbacks.

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
    className: REPLACE_WITH_YOUR_INGRESS_CLASS
    # Supply controller-specific annotations after validating streaming and TLS.
    annotations: {}
    tlsSecretName: workbot-tls
  resources: {}
```

Provision DNS, an ingress controller and the TLS certificate Secret through your
normal process. The Ingress host and TLS host are derived from `publicUrl`,
with `/` routed to the Workbot `ClusterIP` Service on 3020. Workbot is stateless
and uses `RollingUpdate`; its cookies depend on the stable operator session
Secret, while conversations live on the runner. Only the SQLite runner uses
`Recreate`.

Den API must also resolve, reach and trust Workbot's public HTTPS URL, including
`/internal/readiness`; browser reachability alone is insufficient. Ensure pod
egress, DNS, hairpin routing and CA trust permit that path. Den presents the
runner service token to the authenticated readiness endpoint. A healthy Workbot
process probe does not prove this Den-to-public-edge path.

The chart leaves controller-specific streaming configuration to
`workbot.ingress.annotations` and the operator's controller configuration.
No controller-specific buffering or timeout annotations are enabled by default.
Select a maintained controller and validate its exact version and configuration;
annotation names and timeout semantics are not portable between controllers.
Set suitable streaming/idle limits at every ingress, load balancer and proxy hop,
not just this Ingress, and test a long response with a deliberate quiet interval.
An ingress timeout can disconnect the browser while a runner turn is still
active, so do not interpret disconnect as cancellation. Do not reuse the
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
   automatic drain or promise that an interrupted turn resumes. Slack and
   persisted headless execution paths cannot use the stopped runner. New cloud
   Automation runtime selection can fall back to the existing web runtime when
   no runner is configured, subject to that runtime's availability; this does
   not migrate stored headless runs or their data. Stored conversations and files
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
shared Den Secret. Remove any manual `DEN_BASE_URL`/`DEN_API_PUBLIC_URL` overrides
from the shared Secret too, and use the public-origin values; conflicting direct
Den API env overrides are rejected while managed companions are enabled.
The chart cannot inspect an external Secret offline and does not edit it. Legacy external settings can otherwise survive workload
disable, so their removal is a required migration preflight.

## Offline checks and runtime proof plan

```sh
pnpm --dir evals exec vitest run --config vitest.config.ts \
  --project pr scripts/helm-companions.test.ts scripts/den-workbot-redirect.test.ts
node --test 'ee/apps/den-web/app/(den)/workbot/destination.test.mjs'
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
