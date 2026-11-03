# OpenWork EE Helm Chart

Initial Helm chart for the OpenWork EE Den stack:

- `den-api` control plane on port `8788`
- `den-web` web app on port `3005`
- optional OpenWork Gateway service on port `8791` (`gateway.enabled`)

Gateway retains the chart's legacy `inference.*` aliases, secret keys, image
repository, resource names and selectors for upgrade safety. Only explicit
`gateway.enabled: true` advertises the new capability; legacy service enablement
alone does not. Gateway here means `ee/apps/gateway`, not the separate
`den-gateway` web edge application.
See [Gateway configuration and stable contracts](../../../ee/apps/gateway/README.md).
- shared ConfigMap and Secret templating
- optional Ingress for web and API hosts
- pre-install/pre-upgrade migration Job scaffold

## Gateway Compatibility (Chart 0.2.0)

`gateway: {}` is intentionally sparse, with **no canonical defaults** that could
mask an existing `inference.enabled: true`. An absent root (including old
`--reuse-values` releases) is treated as `{}`; an explicitly supplied non-map is
rejected. Supported structural overrides are
`enabled`, `replicaCount`, `image`, `service`, `containerPort`, `env`,
`podAnnotations`, `podLabels`, `resources`, `probes`, and `retention`.

| Configuration | Service | `GATEWAY_ENABLED` in Den API / Gateway |
| --- | --- | --- |
| Defaults | Absent | `false` / absent |
| `inference.enabled: true`, no canonical enablement | Retained | `false` / `false` |
| `gateway.enabled: false`, even with legacy true | Absent | `false` / absent |
| `gateway.enabled: true` with valid configuration | Present | `true` / `true` |

For every structural key, canonical **presence** wins, not truthiness. Nonempty
maps merge recursively; `{}`, `[]`, `false`, `0`, and `""` replace the inherited
value. For example, `gateway.env: {}` clears all inherited env overrides,
`gateway.service.annotations: {}` clears legacy annotations, and
`gateway.replicaCount: 0` scales down without disabling capability intent.
`gateway.probes: {}` removes both probes. Clearing a required field (such as
`gateway.image: {}` or service port `0`) fails with a configuration error when
the service is enabled. An empty image **tag** clears a legacy tag and uses
`image.tag`, then `Chart.appVersion`, for both the Deployment and retention job.
These clear semantics apply to the canonical-over-legacy merge **after Helm has
coalesced its values**. They work when migrating reused legacy `inference.*`
configuration: for example, a new `gateway.env: {}` clears old `inference.env`.
The root `gateway: {}` itself means no overrides, not removal of the legacy service.

Helm can refill an empty map with saved **canonical** values before any chart
template runs. After a release has saved `gateway.env.SAVED`, a later
`--reuse-values --set-json 'gateway.env={}'` retains that entry; the chart cannot
recover the original empty-map intent. The same limitation applies to nested
maps from earlier values files. To clear previously canonical maps, use
`--reset-values` with a complete, reviewed values file that omits the old entries
and explicitly includes the desired empty maps. Preserve all other deployment
configuration and Secret references in that file. Do not rely on a final empty
override file or `--reset-then-reuse-values` to discard saved maps. `null` is
Helm's deletion operator, not a supported chart clear value here.

The `*-inference` Service, Deployment, container name, selectors and default
`ghcr.io/different-ai/openwork-inference` repository are unchanged. Existing Den
web/API ingress hosts and resource names are untouched. This chart does not
create Gateway ingress automatically: provision a desktop-reachable TLS endpoint
using your existing ingress/mesh or `gateway.service` load balancer settings.

Explicit enablement with an existing Secret:

```yaml
gateway:
  enabled: true
config:
  internal:
    gatewayProxyBaseUrl: http://openwork-ee-inference:8791
    inferenceProxyBaseUrl: https://existing-models.example.com # Keep your existing Models endpoint.
  public:
    gatewayPublicBaseUrl: https://gateway.example.com
secret:
  create: false
  existingSecret: openwork-ee-secrets
```

Set the internal hostname to your release's retained Service name. Both URLs
must be explicit origins without credentials, non-root paths, queries, or
fragments. Public origins must use HTTPS and a qualified, non-local hostname;
internal origins may use HTTP. Loopback origins are rejected. A trailing `/`
is permitted. Helm performs static validation; the application's shared Gateway
environment parser performs final URL, database and encryption validation at
startup. Rendering cannot verify DNS, TLS, Secret contents, or reachability.

`config.internal.gatewayProxyBaseUrl` overrides legacy
`config.internal.inferenceProxyBaseUrl` **by presence**, including `""`. An empty
canonical URL clears the legacy one and fails validation if Gateway is enabled.
Without the canonical key, an explicitly configured legacy URL satisfies the
internal origin requirement. The generated in-cluster URL remains available for
legacy service-only installations, but is not sufficient for new opt-in.
`config.public.gatewayPublicBaseUrl` has no inferred public fallback. Legacy
Models retain a valid desktop origin from `INFERENCE_PROXY_BASE_URL`, otherwise
use the configured public Gateway origin, never its internal Service address.
When a canonical proxy or public destination is configured, Helm emits the nonempty existing `config.internal.inferenceProxyBaseUrl`
as that legacy variable, or the public origin if unset/empty; keep your existing
Models endpoint in this legacy setting despite its `internal` name. Gateway's
canonical internal URL still wins for internal resolution, including empty clears.
Public destinations survive management disable: runtime Models selection prefers a
valid legacy Models public origin, then a valid Gateway public origin, regardless
of the flag. The chart retains shared public configuration on disabled deployments;
existing per-app public URL overrides remain honored there. Without a usable public
destination, historical disabled Models fallback remains and may be private/loopback.
Optional malformed Gateway settings do not add disabled-mode startup requirements.
`config.inference.*` Models billing and upstream settings remain unchanged.

The enabled Den API and Gateway receive required `secretKeyRef` entries for the
same `DEN_DB_ENCRYPTION_KEY` and database credentials. `config.databaseMode: mysql`
uses `secret.keys.databaseUrl`; `planetscale` uses `databaseHost`,
`databaseUsername`, and `databasePassword`. Key remapping is supported. The
existing Secret must contain nonempty credentials and an encryption key of at
least 32 characters; it is never read by Helm. Chart-created Secrets use
`secret.values` and reject missing/placeholder Gateway credentials early.
Pre-install migration hooks keep their existing inline-secret behavior for
chart-created Secrets; use an existing Secret to avoid inline hook credentials.
Regardless of runtime mode, enabled migration Jobs also require the existing
`secret.keys.databaseUrl` / `secret.values.databaseUrl` TCP configuration described
under [Migration TCP configuration](#migration-tcp-configuration).

Admin and webhook endpoints are independently opt-in for canonical deployments:

```yaml
gateway:
  enabled: true
  admin:
    enabled: true
  webhook:
    enabled: true
secret:
  keys:
    gatewayAdminToken: GATEWAY_ADMIN_TOKEN
    gatewayWebhookSecret: GATEWAY_WEBHOOK_SECRET
```

These optional `secret.keys.gateway*` and `secret.values.gateway*` keys override
their `inference*` aliases by presence. Defaults retain the old Secret keys.
Only enabled features require token references; disabled features explicitly
clear both token env aliases so `envFrom` cannot accidentally turn them on.
Shared deployment flags, origins, database keys, and tokens must not be overridden
through per-app `env` when enabled; Helm rejects conflicting configuration.

The Smart Model Router (feature `autoRouter`) asks Jev, through TypeSafe's
API, how well each Smart request fits each task of the member's Smart Router
and how much thinking it needs. Give the gateway a TypeSafe API key; without
one, Smart is off and Den refuses to save Smart Routers:

```yaml
secret:
  keys:
    typesafeApiKey: TYPESAFE_API_KEY # key name in the Secret
  values:
    typesafeApiKey: "<TypeSafe API key>" # or add it to secret.existingSecret
```

The gateway reads it as `TYPESAFE_API_KEY` (optional). `AUTO_ROUTER_JEV_MODEL`
and `AUTO_ROUTER_JEV_TIMEOUT_MS` can be set through `gateway.env`. The feature
is cloud-only, so it also needs `config.deployment: cloud`.

Retention is separate from member Automations and remains opt-in after the
accounting migration:

```yaml
gateway:
  retention:
    enabled: true
    adminTokenSecret: gateway-retention
    adminTokenKey: GATEWAY_ADMIN_TOKEN
```

Set service enablement as well (`gateway.enabled` or legacy `inference.enabled`).
Retention's reference is authoritative for **both** `GATEWAY_ADMIN_TOKEN` and
`INFERENCE_ADMIN_TOKEN` on the Gateway and CronJob, even if the shared Secret
contains different tokens. It enables admin access without requiring
`gateway.admin.enabled`. Do not set token env overrides. Moving from legacy
`inference.*` to canonical `gateway.*` values does not rename the CronJob or
change its internal Service target.

The CronJob runs hourly, like the hosted deployment. Each run calls the Gateway's
`POST /internal/rollups/run`, folds closed request-log hours older than two days
into hourly usage rollups, and deletes the raw rows it folded in the same
transaction. Hourly rollups older than 90 days fold into daily rollups the same
way. The usage dashboard reads raw rows and rollups together, so totals are
correct whether or not a run has happened yet.

| Setting | Default | Notes |
| --- | --- | --- |
| `schedule` | `5 * * * *` | Five minutes past every hour. Older charts defaulted to nightly `0 3 * * *`; an install that set `schedule` explicitly keeps its value. |
| `timeZone` | `Etc/UTC` | |
| `maxBucketsPerRun` | `48` | Hours (and days) handled per run. Gateway accepts 1 to 1000. |
| `maxSourceRowsPerBucket` | `5000` | Rows consumed per hour per run, in one transaction. Gateway accepts 1 to 5000. |

One run consumes at most `maxBucketsPerRun x maxSourceRowsPerBucket` rows
(240,000 by default). An hour with more rows than `maxSourceRowsPerBucket` is
finished over the following runs, so hourly runs keep up with up to about
240,000 requests per hour. The previous defaults (nightly, 1,000 rows) kept up
with only about 48,000 requests per day. The job logs a summary such as
`{"hourBuckets":1,"dayBuckets":0,"rawRowsDeleted":1253,...}`. `hourBuckets`
staying above 1 for several runs means the job is catching up; raise
`maxSourceRowsPerBucket` toward 5000 before running it more often.

Non-Helm deployments need their own hourly caller with the same body:

```sh
curl -fsS -X POST -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"maxBucketsPerRun":48,"maxSourceRowsPerBucket":5000}' \
  http://<gateway>:8791/internal/rollups/run
```

Render-only verification: `bash packaging/helm/openwork-ee/tests/gateway.sh`.
This does not deploy resources, run migrations, or invoke the retention endpoint.
`bash packaging/helm/openwork-ee/tests/upgrade-and-migration.sh` additionally
simulates reused computed chart values without the new Gateway defaults and
checks the rendered migration environment against the real bootstrap connection
parser functions in isolation. It never executes the bootstrap entrypoint or
opens a database connection. Run this contract test from a repository checkout
with Node.js and Helm available; it reads the backend parser source, not a deployed
application or a database.

## Install

Published releases are available as an OCI Helm chart:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  -f values.prod.yaml
```

`--version` pins the chart and the images: the published chart's `appVersion`
equals its version and `image.tag` defaults to that `appVersion`, so
`--version X` deploys the `X` images. Set `image.tag` only to deviate from the
chart version, for example when you mirror a specific image build. Charts
published before this default (0.18.46 and earlier) ship `image.tag: latest`,
which floats to the newest release on every pull; check with
`helm show values oci://ghcr.io/different-ai/charts/openwork-ee --version X | grep -A1 '^image:'`
and, when it prints `tag: latest`, also pass `--set image.tag=X`.

OpenCode v2 history migration is automatic; no Helm feature value or admin
switch is required. Upgrade the desktop application as well as the chart/server.
Old `config.features.engineV2ForceUpgrade` entries are accepted but ignored and
can be removed. Migration keeps backups, waits for idle, and respects explicit
manual engine choices. See [engine migration](../../../docs/opencode-engine-migration.md).

### Node.js security baseline and image upgrades

Deploy newly published OpenWork application images built with **stable Node.js
24.x >=24.22.1**. Re-rendering or upgrading only the chart does not patch the
runtime inside an existing image. Pin the new OpenWork application release with
`image.tag` (or upgrade to its matching published chart), and review any
per-component image tag overrides, including legacy `inference.image.tag` and
canonical `gateway.image.tag`, so they do not retain older images. Update mirrored
images to the newly built release as well; do not merely retag an old image.

`Chart.appVersion` is the **OpenWork application release**, not the Node.js
version. Do not set it or `image.tag` to `24.22.1` to request a runtime upgrade.

After upgrading, run the existing test hook:

```sh
helm test openwork-ee --logs
```

The `env-probe` Job uses the configured Den API image and reports its actual
Node.js version, platform, and architecture. It fails for older runtimes,
prereleases, or other Node.js major versions, in addition to its existing
environment and custom-CA checks. This is an operator-invoked post-deployment
check, not an install/upgrade admission gate. It proves the runtime in the probe's
Den API image only: separately verify the Den web, Gateway/inference, and any other
application images you deploy, especially with per-component overrides. Helm
rendering cannot inspect an image's runtime or prove that running pods have
pulled the new image.

Local regression checks (no cluster required):

```sh
node --test packaging/helm/openwork-ee/tests/node-runtime.mjs
bash packaging/helm/openwork-ee/tests/image-tag-and-migration-hook.sh
```

Create a values file for the target environment:

```yaml
config:
  tenancy:
    # Default chart behavior is single-org for private/self-hosted installs.
    # Hosted OpenWork Cloud should set this to "multi_org" explicitly.
    mode: "single_org"
    singleOrgName: "OpenWork"
    singleOrgSlug: "default"
    ownerEmails: "admin@example.com"
    allowPublicSignup: "false"
    requireEmailVerification: "false"
  public:
    # Single public Den web origin. The chart renders this as DEN_BASE_URL and
    # den-api derives Better Auth, CORS/trusted origins, web-app hosts, API
    # defaults, and MCP resource defaults from it.
    webOrigin: "https://openwork.example.com"
    # Leave these blank unless you intentionally expose a split Den API origin
    # or need migration compatibility with an older topology.
    apiOrigin: ""
    mcpResourceUrl: ""
    mcpClaimNamespace: "https://openwork.example.com"
    desktopDenBaseUrl: ""
    corsOrigins: ""
    betterAuthTrustedOrigins: ""
    webAppHosts: ""
    bootstrapAdminEmails: "admin@example.com"
    authCallbackUrl: "https://openwork.example.com"
  githubConnector:
    appId: ""
    clientId: ""

secret:
  values:
    # Transitional/smoke TLS only: sslaccept=accept encrypts without certificate verification.
    # For production verification, use customCa plus sslmode=verify-full or verify-ca.
    databaseUrl: "mysql://openwork:REPLACE_ME@mysql.example.internal:3306/openwork_den?sslaccept=accept"
    betterAuthSecret: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"
    denDbEncryptionKey: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"
    emailFrom: "OpenWork <no-reply@example.com>"
    smtpHost: "smtp.example.com"
    smtpPort: "587"
    smtpUser: "openwork@example.com"
    smtpPass: "REPLACE_ME"
    smtpSecure: "false"
    githubConnectorAppClientSecret: ""
    githubConnectorAppPrivateKey: ""
    githubConnectorAppWebhookSecret: ""

ingress:
  enabled: true
  className: nginx
  web:
    host: openwork.example.com
  api:
    host: api.openwork.example.com
```

### Upgrade note: public URL values

Current chart versions make `config.public.webOrigin` the primary public URL.
It renders as `DEN_BASE_URL`, and Den derives these values from it unless you
set explicit compatibility overrides:

- `BETTER_AUTH_URL`
- `CORS_ORIGINS`
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS`
- `DEN_WEB_APP_HOSTS`
- `DEN_API_PUBLIC_URL`
- `DEN_MCP_RESOURCE_URL`

When upgrading an existing release, inspect your values file for the older
split-origin keys under `config.public`. If your deployment is single-origin,
remove `apiOrigin`, `mcpResourceUrl`, `desktopDenBaseUrl`, `corsOrigins`,
`betterAuthTrustedOrigins`, and `webAppHosts` or set them to `""` so Den can
derive them from `webOrigin`. Keep `apiOrigin`/`mcpResourceUrl` only when you
intentionally expose a separate API origin for install-link exchange or external
MCP clients.

For private GHCR packages, authenticate before installing:

```bash
helm registry login ghcr.io
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<github-token>
```

Then add:

```yaml
imagePullSecrets:
  - name: ghcr-pull-secret
```

For local development from a repository checkout, render or install directly.
The checkout's `Chart.yaml` carries a placeholder `appVersion` (the publish
workflow stamps the real one with `helm package --app-version`), so a checkout
install must set `image.tag` explicitly:

```bash
helm template openwork-ee ./packaging/helm/openwork-ee -f values.prod.yaml
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee \
  --set image.tag=REPLACE_OPENWORK_VERSION \
  -f values.prod.yaml
```

### Features

OpenWork features are declared once, in `packages/features/src/registry.ts`,
and rolled out along several dimensions: which products a feature exists on,
on or off for everyone, per-organization overrides, and a kill switch.
Platform admins change these in `/admin` without a redeploy. As the operator,
you can also lock a feature for the whole install under `config.features`:

```yaml
config:
  features:
    permissions: "true"            # on for everyone on this install
    computerUse: "false" # off for everyone on this install
```

- `""` (the default) follows `/admin`, which starts from the default listed
  in `values.yaml`.
- `"true"` or `"false"` locks the feature for everyone. `/admin` shows "Set by
  deployment config" for it. The `/admin` kill switch still turns it off.

Each key renders `DEN_FEATURE_<KEY>` for den-api. Features that are not part
of self-hosted installs have no key, so they can't be turned on here. A key
that isn't declared in `values.schema.json` fails `helm install`.

`config.deployment` (`DEN_DEPLOYMENT`) is `self_hosted` unless this is
OpenWork Cloud. Don't change it on a customer install.

See [`config.features` in values.yaml](./values.yaml) for supported keys,
defaults and descriptions. The
[feature registry](../../../packages/features/src/registry.ts) is the source
of truth.

The `config.features` block and values schema are generated: run
`pnpm features:sync` after changing the registry.

### Automations settings

Automations are on by default. Organization admins choose in **Settings ›
Automations** whether members can use Desktop Automations (run on a member's
signed-in desktop) and Cloud Automations (run headlessly in OpenWork Cloud;
these also need the headless runner, `DEN_HEADLESS_RUNNER_URL`). These settings
are generally available on cloud and self-hosted deployments.

Availability and server shutdown remain separate so a Den upgrade cannot remove
routes beneath an older published Desktop:

| `automationsEnabled` | `automationsRuntimeEnabled` | Behavior |
| --- | --- | --- |
| `"true"` (default) | `"true"` (default) | Automations are available and execute normally. |
| `"false"` | `"true"` | New Desktops hide Automations; legacy routes and scheduling remain available during the upgrade window. |
| `"false"` | `"false"` | Automations are hard-disabled: routes, MCP resources, and scheduler startup are omitted. |
| `"true"` | `"false"` | The runtime shutdown wins and Desktop receives `automationsEnabled: false`. |

To turn Automations off for the whole install:

```yaml
config:
  public:
    automationsEnabled: "false"
```

These render `DEN_AUTOMATIONS_ENABLED=true` and
`DEN_AUTOMATIONS_RUNTIME_ENABLED=true` for Den. An entirely unconfigured Den
keeps availability fail-closed while preserving the legacy runtime. When using
raw environment variables, an explicit `DEN_AUTOMATIONS_ENABLED` value also
becomes the runtime default: `false` is therefore a complete shutdown unless
`DEN_AUTOMATIONS_RUNTIME_ENABLED=true` explicitly selects mixed-version
compatibility. The chart always renders both values to make that choice
unambiguous. Hosted OpenWork Cloud explicitly enables availability.

Desktop v0.18.35 and newer consume the value from `/v1/me/desktop-config`, hide
the Automation surface, and do not register a runner unless the value is
explicitly true. Older clients predate that contract, so the runtime flag must
remain true while they are in use even when availability is false.

For an existing deployment, stage the upgrade so independently released Den
and Desktop versions never observe an unintended flag state:

1. Keep `config.public.automationsRuntimeEnabled: "true"` while any connected
   Desktop is older than v0.18.35.
2. Upgrade Den. Legacy Desktops retain their existing routes and scheduling;
   compatible Desktops honor `automationsEnabled` from desktop config.
3. Roll out Desktop v0.18.35 or newer to the whole deployment.
4. To keep Automations, set both values to true. To disable them, set both
   values to false only after the Desktop rollout is complete.

New installations with no legacy Desktop clients can hard-disable Automations
immediately by setting both values to false.

### Dashboards rollout

The personal desktop Dashboard is unavailable by default. Enable it for a
self-hosted or customer-managed deployment with:

```yaml
config:
  public:
    dashboardsEnabled: "true"
```

The chart renders this value as `DEN_DASHBOARDS_ENABLED`. Raw environment-based
deployments can set the same variable directly. Hosted environments use that
same flag, so Dashboard availability does not depend on a per-device preference.
Desktop reads `dashboardEnabled` from `/v1/me/desktop-config` and hides both the
sidebar entry and route unless the server explicitly returns `true`.

### OpenWork Web rollout

OpenWork Web is unavailable by default for self-hosted and customer-managed
deployments. OpenWork Cloud enables it in its deployment values with:

```yaml
config:
  public:
    openworkWebEnabled: "true"
```

The chart renders this value as `DEN_OPENWORK_WEB_ENABLED`. A raw environment
deployment can set the same variable directly. Missing, blank, false, or an
unrecognized value fails closed: Den omits Web from its advertised
capabilities, the sidebar and Billing offer stay hidden, and Web billing routes
return the deployment-unavailable response. Availability is deployment-wide;
it does not depend on organization mode, Stripe-variable presence, or mutable
organization metadata.

Enabling the flag advertises the hosted product. The deployment must also
configure `STRIPE_SECRET_KEY` and `STRIPE_OPENWORK_WEB_PRICE_ID` before the
purchase action becomes available. This separate billing-readiness check keeps
a partially configured hosted rollout visible but non-purchasable instead of
mistaking secrets for an availability signal.

Provider-specific starter guides:

- AWS EKS:
  [guide](../../../docs/aws-eks-helm.md),
  [`examples/values.aws-load-balancer.yaml`](examples/values.aws-load-balancer.yaml),
  [`examples/values.aws-load-balancer-http-smoke.yaml`](examples/values.aws-load-balancer-http-smoke.yaml).
  The recommended first AWS path is EKS Auto Mode plus `LoadBalancer` Services,
  which provisions AWS Network Load Balancers without installing an ingress
  controller.
- Azure AKS:
  [guide](../../../docs/azure-aks-helm.md),
  [`examples/values.azure-ingress.yaml`](examples/values.azure-ingress.yaml).
  The recommended first Azure path is VNet-first AKS application routing plus
  Azure Database for MySQL Flexible Server private access, with
  `ingress.enabled=true`.
- Google Cloud GKE:
  [guide](../../../docs/gcp-gke-helm.md),
  [`examples/values.gcp-ingress.yaml`](examples/values.gcp-ingress.yaml).
  The recommended first GCP path is GKE Ingress with a reserved global IP,
  Google-managed certificate, and BackendConfig health checks.

`ingress.enabled=true` only emits Kubernetes `Ingress` resources; it does not
install an ingress controller. Use it only when the cluster already has a
compatible provider ingress controller.

Published self-host planning pages:

- [Private network deployment](../../../packages/docs/start-here/private-network-deployment.mdx)
- [Air-gapped deployment](../../../packages/docs/start-here/air-gapped-deployment.mdx)
- [Installer delivery](../../../packages/docs/start-here/installer-delivery.mdx)
- [Certificate trust and proxies](../../../packages/docs/start-here/certificate-trust-and-proxies.mdx)

## Secrets

The chart can create an Opaque Secret from `secret.values`, or consume an existing Secret:

```yaml
secret:
  create: false
  existingSecret: openwork-ee-secrets
```

The existing Secret must contain the keys listed under `secret.keys`, especially:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `DEN_DB_ENCRYPTION_KEY`

Set optional `DATABASE_REDIS_URL` to enable Den API Redis-backed session and query caching. Set `DAYTONA_API_KEY` when `config.provisioner.mode` is `daytona`. Set `OPENROUTER_MANAGEMENT_API_KEY` when enabling OpenWork Models management.

Redis cache examples:

```yaml
secret:
  values:
    databaseRedisUrl: "rediss://redis-master.openwork.svc.cluster.local:6379"
```

Prefer `rediss://`. For hosting platforms that only provide a private internal
`redis://` URL, such as Render internal Redis, explicitly acknowledge the trust
boundary with `redis.allowInsecureInternal=true`. Use this only when the Redis
endpoint is non-public and reachable only from trusted services in the private
network.

```yaml
redis:
  allowInsecureInternal: true
secret:
  values:
    databaseRedisUrl: "redis://red-...:6379"
```

## Audit usage refresh

Audit writes never update an organization's audit usage totals (retained
operations, events, logical bytes). That keeps each audit write independent, so
writes never queue behind each other on a shared row. A daily CronJob recomputes
the totals instead by calling den-api's `POST /internal/audit/usage/refresh`
with a maintenance token. The audit usage screen shows when the totals were last
measured. The CronJob is off by default. Turn it on with a token of 24 or more
characters, either in the chart Secret:

```yaml
denApi:
  auditUsage:
    enabled: true
secret:
  values:
    maintenanceToken: "<random 32+ character string>"
```

or from your own Secret:

```yaml
denApi:
  auditUsage:
    enabled: true
    tokenSecret: den-maintenance
    tokenKey: token
```

The same token is passed to den-api as `DEN_MAINTENANCE_TOKEN`; den-api answers
404 on `/internal/*` when it is unset. `schedule` (default `30 3 * * *`) and
`timeZone` (default `Etc/UTC`) are configurable. Non-Helm deployments need their
own scheduled caller, for example:

```sh
curl -fsS -X POST -H "Authorization: Bearer $DEN_MAINTENANCE_TOKEN" \
  http://<den-api>/internal/audit/usage/refresh
```

Render-only verification: `bash packaging/helm/openwork-ee/tests/den-audit-usage.sh`.

## Custom CA certificates

For higher-level planning across desktop, sidecar, Den, and MySQL trust
surfaces, see the published
[Certificate trust and proxies](../../../packages/docs/start-here/certificate-trust-and-proxies.mdx)
page. This section remains the authoritative chart values reference.

Use `customCa` when OpenWork must trust a private certificate authority for
strict TLS verification, such as a MySQL endpoint signed by an internal or cloud
private CA. The chart does not accept PEM material in values and does not create
the CA resource for you; create the Kubernetes Secret or ConfigMap in the
release namespace before running `helm install` or `helm upgrade`.

Secret example:

```bash
kubectl create secret generic openwork-custom-ca \
  --namespace openwork \
  --from-file=ca.crt=./corp-root-ca.pem
```

```yaml
customCa:
  enabled: true
  existingSecret: openwork-custom-ca
  existingConfigMap: ""
  key: ca.crt
```

ConfigMap example:

```bash
kubectl create configmap openwork-custom-ca \
  --namespace openwork \
  --from-file=ca.crt=./corp-root-ca.pem
```

```yaml
customCa:
  enabled: true
  existingSecret: ""
  existingConfigMap: openwork-custom-ca
  key: ca.crt
```

When enabled, set exactly one of `existingSecret` or `existingConfigMap`, and set
`key` to the data key containing the CA bundle. The chart mounts only that key as
`/etc/openwork/custom-ca/ca-bundle.pem` and sets `NODE_EXTRA_CA_CERTS` to that
file for `den-api`, `den-web`, enabled `inference`, and the migration Job. Do
not also set `denApi.env.NODE_EXTRA_CA_CERTS`, `denWeb.env.NODE_EXTRA_CA_CERTS`,
or `inference.env.NODE_EXTRA_CA_CERTS`; Helm rejects those conflicts while
`customCa.enabled=true`.

For strict MySQL TLS verification, pair the mounted CA with a verifying
`DATABASE_URL`, for example:

```yaml
secret:
  values:
    databaseUrl: "mysql://openwork:REPLACE_DB_PASSWORD@mysql.example.internal:3306/openwork_den?sslmode=verify-full"
```

`sslmode=require`, `sslmode=verify-ca`, `sslmode=verify-full`, and
`sslaccept=strict` all enable strict certificate verification in Den's MySQL
client: the chain must be trusted and the certificate must carry the database
hostname in its SAN (`verify-ca` behaves like `verify-full`). A private-CA
database therefore needs `customCa` with every one of these modes. Only
`sslaccept=accept` keeps TLS enabled without verifying the certificate chain, so
use it only for smoke tests or while preparing the CA bundle.

The custom CA is release-wide for Node.js processes in this chart. Treat it as a
global trust decision for outbound TLS from those workloads, and include only CA
roots your OpenWork deployment should trust. On CA rotation, update the existing
Secret or ConfigMap and restart the running workloads so Node reloads the CA
file, for example:

```bash
kubectl rollout restart deployment/openwork-ee-den-api --namespace openwork
kubectl rollout restart deployment/openwork-ee-den-web --namespace openwork
kubectl rollout restart deployment/openwork-ee-inference --namespace openwork
```

The next migration hook Job will mount the current CA data; rerun a failed
upgrade after the CA resource is corrected.

## Observability

The chart exposes first-class runtime observability settings for `den-api` and
`den-web` only. `observability.backend` defaults to `none`; set it to `otel` or
`sentry` to enable the matching runtime environment. The chart injects distinct
`OTEL_SERVICE_NAME` values directly into each Deployment, so the shared
ConfigMap is not used for service identity or auth-like observability values.

OpenTelemetry uses OTLP over `http/protobuf`, with a shared endpoint and
optional per-signal endpoint overrides. Per-signal exporters default to `otlp`,
and trace sampling defaults to the standard parent-based always-on sampler.

### OpenTelemetry quick start

Before starting, you need:

- An OpenTelemetry Collector or vendor endpoint reachable from the Kubernetes
  cluster over OTLP HTTP. Port `4318` is the usual Collector port.
- The endpoint's authentication token or headers, if it requires
  authentication.
- `kubectl` and Helm configured for the target cluster.

The chart configures telemetry export from OpenWork; it does not install an
OpenTelemetry Collector. For an in-cluster Collector, use its Kubernetes DNS
name, for example
`http://otel-collector.observability.svc.cluster.local:4318`. Do not use
`localhost`, because that would refer to the OpenWork container itself.

First create the namespace used by this example:

```bash
kubectl create namespace openwork
```

If the Collector does not require authentication, skip the Secret and leave
`observability.otel.headers.existingSecret` empty.

If it requires a bearer token, create the header Secret in the **same
namespace as OpenWork**:

```bash
kubectl create secret generic openwork-otel-headers \
  --namespace openwork \
  --from-literal=OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer <token>'
```

Replace `<token>` with the real token. Keep the single quotes so your shell
passes the complete header as one value. To update an existing Secret without
deleting it first, use:

```bash
kubectl create secret generic openwork-otel-headers \
  --namespace openwork \
  --from-literal=OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer <token>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Multiple OTLP headers use the standard comma-separated `key=value` format:

```bash
kubectl create secret generic openwork-otel-headers \
  --namespace openwork \
  --from-literal=OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer <token>,x-scope-orgid=<tenant>'
```

Do not put tokens directly in a values file. Kubernetes Secrets are not
encrypted by default unless your cluster enables encryption at rest, so use
your organization's external-secret or secret-management system in production
when available.

Create `values-observability.yaml`:

```yaml
observability:
  backend: otel
  serviceNames:
    denApi: openwork-den-api
    denWeb: openwork-den-web
  otel:
    endpoint: "http://otel-collector.observability.svc.cluster.local:4318"
    tracesEndpoint: ""
    metricsEndpoint: ""
    logsEndpoint: ""
    exporters:
      traces: otlp
      metrics: otlp
      logs: otlp
    tracesSampler: parentbased_always_on
    tracesSamplerArg: ""
    headers:
      existingSecret: openwork-otel-headers
      key: OTEL_EXPORTER_OTLP_HEADERS
```

For a Collector without authentication, use:

```yaml
    headers:
      existingSecret: ""
      key: OTEL_EXPORTER_OTLP_HEADERS
```

Install or upgrade OpenWork with the values file:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork \
  --create-namespace \
  --values values-observability.yaml
```

`observability.otel.headers.existingSecret` must name an existing Kubernetes
Secret. Its key is exposed as `OTEL_EXPORTER_OTLP_HEADERS` only on `den-api` and
`den-web`; it is not added to inference pods or migration Jobs.

### Verify the OpenTelemetry setup

The commands below assume the Helm release is named `openwork-ee`. If you use a
different release name, run `kubectl get deployments,services --namespace
openwork` to find the generated resource names.

Confirm that the workloads are ready:

```bash
kubectl get pods --namespace openwork
kubectl rollout status deployment/openwork-ee-den-api --namespace openwork
kubectl rollout status deployment/openwork-ee-den-web --namespace openwork
```

Inspect the rendered environment references without printing the Secret's
value:

```bash
kubectl describe deployment/openwork-ee-den-api --namespace openwork
kubectl describe deployment/openwork-ee-den-web --namespace openwork
```

Look for `DEN_OBSERVABILITY_BACKEND=otel`, distinct `OTEL_SERVICE_NAME` values,
the OTLP endpoint, and an `OTEL_EXPORTER_OTLP_HEADERS` reference to
`openwork-otel-headers`.

Generate a request that crosses both services. Keep this port-forward running:

```bash
kubectl port-forward service/openwork-ee-den-web 3005:3005 --namespace openwork
```

In another terminal:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3005/api/auth/get-session >/dev/null
```

Den Web proxies `/api/auth/*` server-side to Den API and forwards the active
`traceparent`, so your observability backend should show `openwork-den-web` and
`openwork-den-api` with one connected trace for the request; an anonymous
session lookup returns `200` with a `null` body. Logs from both services carry
trace and span IDs. Den API also exports Hono request-duration and
active-request metrics.

Do not use `/api/den/...` for this check: Den Web answers those paths with a
`307` redirect to the public API origin instead of proxying them, `curl --fail`
treats the redirect as success, and Den API never receives the request. Health
paths (`/api/health`, `/api/ready`, and Den API `/health` and `/ready`) are
excluded from tracing on purpose.

### Endpoint and troubleshooting notes

- `observability.otel.endpoint` is a base endpoint. OpenWork appends
  `/v1/traces`, `/v1/metrics`, and `/v1/logs`.
- Signal-specific endpoints are used exactly as written. Include the full
  signal path, such as `https://collector.example.com/v1/traces`.
- Only OTLP HTTP/protobuf is supported. Port `4317` is normally OTLP gRPC and
  will not work; use the HTTP receiver, usually port `4318`.
- The Secret must be in the OpenWork release namespace, and its key must match
  `observability.otel.headers.key` exactly.
- A `401` or `403` exporter error usually means the token or header syntax is
  wrong. A connection error usually means the endpoint is not reachable from
  the pod or a NetworkPolicy blocks it.
- After changing an externally managed Secret, restart the deployments if your
  secret controller does not trigger a rollout:

  ```bash
  kubectl rollout restart deployment/openwork-ee-den-api --namespace openwork
  kubectl rollout restart deployment/openwork-ee-den-web --namespace openwork
  ```
- For lower production trace volume, use
  `tracesSampler: parentbased_traceidratio` with `tracesSamplerArg: "0.1"` to
  sample approximately ten percent of root traces.

For Sentry runtime capture, configure the DSN directly or through an existing
Secret. Helm runtime pods intentionally do not receive `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, or `SENTRY_URL`; those are build-time source-map
upload settings, not runtime settings.

```yaml
observability:
  backend: sentry
  sentry:
    dsnSecret:
      existingSecret: openwork-sentry-runtime
      key: SENTRY_DSN
    tracesSampleRate: "0.01"
    environment: production
    release: "2026.07.11"
```

Sentry Logs default to warning-and-error only through `SENTRY_LOG_LEVEL=warn`.
Set `SENTRY_LOG_LEVEL=info` only during short debugging windows if you need
successful request logs in Sentry; stdout JSON logs remain available either way.

Sentry source-map upload is build-time behavior. Helm configures runtime pods
after images already exist, so it cannot retroactively upload source maps for
Vercel or CI builds. Set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
and `SENTRY_URL` in the build environment that creates the image (for example,
Vercel project build environment variables), not in Helm values or the chart
ConfigMap. The generic published images cannot upload source maps after they
are built; build your own image with CI/BuildKit source-map secrets when you
need uploaded artifacts. `packaging/docker/Dockerfile.den-web` accepts optional
BuildKit secret IDs `sentry_auth_token`, `sentry_org`, `sentry_project`,
`sentry_url`, `sentry_release`, and `sentry_dist`; the EE image publish workflow
wires these IDs from GitHub Secrets when present.

## GitHub Connector

The GitHub repository connector uses a GitHub App. It is separate from GitHub
OAuth social sign-in. Follow the full setup guide in
[`packages/docs/start-here/github-connector-helm.mdx`](../../../packages/docs/start-here/github-connector-helm.mdx).

Use these public URLs when creating the GitHub App:

- Setup URL: `https://openwork.example.com/dashboard/integrations/github`
- Webhook URL: `https://api.openwork.example.com/v1/webhooks/connectors/github`

Then set the chart values:

```yaml
config:
  githubConnector:
    appId: "123456"
    clientId: "Iv1.example"

secret:
  values:
    githubConnectorAppClientSecret: "github-app-client-secret-if-used"
    githubConnectorAppPrivateKey: |-
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
    githubConnectorAppWebhookSecret: "replace-with-the-github-webhook-secret"
```

The chart exposes these to Den API as:

- `GITHUB_CONNECTOR_APP_ID`
- `GITHUB_CONNECTOR_APP_CLIENT_ID`
- `GITHUB_CONNECTOR_APP_CLIENT_SECRET`
- `GITHUB_CONNECTOR_APP_PRIVATE_KEY`
- `GITHUB_CONNECTOR_APP_WEBHOOK_SECRET`

If `secret.create=false`, add the three secret-backed keys to the existing
Secret referenced by `secret.existingSecret`. The app ID and client ID come from
the chart ConfigMap.

## Transactional Email

Den API can send transactional email through SMTP. Configure the SMTP values in
the chart Secret:

```yaml
secret:
  values:
    emailFrom: "OpenWork <no-reply@example.com>"
    smtpHost: "smtp.example.com"
    smtpPort: "587"
    smtpUser: "openwork@example.com"
    smtpPass: "REPLACE_ME"
    smtpSecure: "false"
```

These values are exposed to Den API as:

- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SECURE`

If `secret.create=false`, add those keys to the existing Secret referenced by
`secret.existingSecret`. SMTP delivery requires both `EMAIL_FROM` and
`SMTP_HOST`; leave `smtpHost` blank only when SMTP-backed transactional email
should be disabled.

Invitation emails tell people to reply for help and include a "Report abuse"
link. Set `config.email.supportAddress` (rendered as `EMAIL_SUPPORT_ADDRESS`)
to send both to your help desk; when it is blank, replies go to the person who
sent the invitation and the email omits the report link:

```yaml
config:
  email:
    supportAddress: "it-help@example.com"
```

## Tenancy Mode

The chart defaults to a private single-org deployment:

```yaml
config:
  tenancy:
    mode: "single_org"
    singleOrgName: "OpenWork"
    singleOrgSlug: "default"
    ownerEmails: "admin@example.com"
    allowPublicSignup: "false"
    requireEmailVerification: "false"
```

These values are exposed to both `den-api` and `den-web` as:

- `DEN_ORG_MODE`
- `DEN_SINGLE_ORG_NAME`
- `DEN_SINGLE_ORG_SLUG`
- `DEN_SINGLE_ORG_OWNER_EMAILS`
- `DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP`
- `DEN_REQUIRE_EMAIL_VERIFICATION`

In the implemented target state, blank or unset `DEN_ORG_MODE` is treated as `single_org`. The Helm chart sets it explicitly to make rendered manifests clear. Hosted or cloud-style multi-organization deployments should set:

```yaml
config:
  tenancy:
    mode: "multi_org"
    requireEmailVerification: "true"
```

`config.tenancy.ownerEmails` controls who can claim ownership of the singleton deployment organization. `config.public.bootstrapAdminEmails` is separate: it seeds platform/admin allowlist access and does not by itself make a user the singleton organization owner.

## Initial Organization Setup

For self-hosted installs, configure the singleton organization before the first
user signs in:

```yaml
config:
  tenancy:
    mode: "single_org"
    singleOrgName: "Acme"
    singleOrgSlug: "acme"
    ownerEmails: "admin@acme.com"
    requireEmailVerification: "false"
  public:
    bootstrapAdminEmails: "admin@acme.com"
```

For releases that include initial-administrator bootstrap, inject the
release-documented one-time setup secret through the chart's Secret integration.
Do not put the setup code in Helm values, a ConfigMap, source control, logs, or a
PR. After the release is installed and the web host is reachable, open `/setup`,
enter an email configured in `config.tenancy.ownerEmails`, and verify it with the
one-time operator code. Den then creates the Better Auth account, creates or
claims the singleton organization identified by `singleOrgName` and
`singleOrgSlug`, grants owner and configured platform-admin access, and consumes
the setup claim. The code cannot be reused and public signup remains disabled.

Configuring `ownerEmails` or `bootstrapAdminEmails` does not create an account or
password. `ownerEmails` controls singleton-organization ownership;
`bootstrapAdminEmails` controls platform-admin allowlist access. Configure the
initial administrator in both lists when that person needs both roles.

Chart versions without the `/setup` route do not support this private bootstrap
flow. Upgrade to a release that includes initial-administrator bootstrap before
attempting first-user setup; entering the configured email on the normal sign-in
page cannot create the account and no default administrator password exists.

Later users are attached to the same singleton organization. They do not see an
organization creation step, and attempts to create another organization return a
single-org-mode error. If no eligible initial-administrator email is configured,
the private setup flow remains unavailable; it never falls back to allowing an
arbitrary first visitor to claim ownership.

For most production installs, use this first owner account as the break-glass
setup path, then configure SAML/OIDC SSO and SCIM from the organization
settings. Keep `bootstrapAdminEmails` aligned only if that same person should
also have platform/admin allowlist access; it is not a replacement for
`ownerEmails`.

After SAML/OIDC SSO is configured on the singleton organization, the auth
experience becomes SSO-only: root sign-in and sign-up show one "Continue with
SSO" action, other sign-in/sign-up entry points redirect there, and raw
email/password sign-in or sign-up requests are rejected by Den API.

## Internal Service URLs

By default, the chart wires internal services through Kubernetes DNS:

- `DEN_API_BASE=http://<release>-openwork-ee-den-api:8788`
- `DEN_AUTH_FALLBACK_BASE=http://<release>-openwork-ee-den-api:8788`
- `INFERENCE_PROXY_BASE_URL=http://<release>-openwork-ee-inference:8791` when `inference.enabled=true`

Override `config.internal.*` only when routing through a mesh, gateway, or external service.

## Den API Node Options

Set `config.denApiNodeOptions` to pass Node.js runtime flags to `den-api` through
`NODE_OPTIONS` when the container starts. The configured value is stored in the
chart ConfigMap as `DEN_API_NODE_OPTIONS` and defaults to an empty string.
Existing values files that set `denApi.env.NODE_OPTIONS` remain supported and
take precedence, so upgrading does not require changing that configuration.

```yaml
config:
  denApiNodeOptions: "--max-old-space-size=4096"
```

`--use-openssl-ca` only changes how Node reads operating-system trust. It does
not create or mount a private CA bundle into the container; use `customCa` for
that.

## Service Exposure

Each service supports Kubernetes Service metadata and load balancer settings:

```yaml
denWeb:
  service:
    type: LoadBalancer
    port: 443
    loadBalancerClass: eks.amazonaws.com/nlb
    loadBalancerSourceRanges:
      - 203.0.113.0/24
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
      service.beta.kubernetes.io/aws-load-balancer-ssl-cert: arn:aws:acm:...
      service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
```

The same shape is available under `denApi.service` and `inference.service`.
`ingress.enabled=true` only emits Kubernetes `Ingress` resources; it does not
install an ingress controller.

## Config Rollouts

Den API, Den Web, and Gateway pods include checksums for the chart-managed
ConfigMap and Secret. Helm upgrades that change runtime config or secrets roll
the pods automatically so environment variables such as public origins, CORS
origins, and database URLs are refreshed.

## Isolated Networks

Use the published [Air-gapped deployment](../../../packages/docs/start-here/air-gapped-deployment.mdx)
and [Outbound network access](../../../packages/docs/start-here/outbound-network-access.mdx)
pages for customer-facing isolation and allowlist planning. The values below are
the chart-level controls.

The chart disables external password breach screening by default so isolated self-hosted installs do not depend on the Have I Been Pwned Pwned Passwords range API. If your deployment has approved outbound access and you want password creation and reset to reject known-compromised passwords through that service, enable it:

```yaml
config:
  auth:
    passwordBreachScreeningEnabled: "true"
```

Local sign-in lockout protections stay enabled either way.

Den API also protects External MCP connection URLs with an SSRF guard. On a
hosted multi-tenant deployment, someone who can add an MCP connection could
otherwise make Den fetch localhost, private-network services, or cloud metadata
addresses from Den's network position.

If a legitimate internal MCP server is blocked in an isolated private-network
deployment, the diagnostic code is `MCP_URL_BLOCKED` and the operator-facing
message is: "Use a public HTTPS MCP URL or change the deployment's
private-network policy through security review."

To allow private-address MCP servers for Den API, enable:

```yaml
config:
  public:
    allowPrivateMcpUrls: "1"
```

This disables SSRF protection for external MCP connection URLs. Enable it only
on a deployment where Den's network position and the set of people who can add
MCP connections are both trusted.

## Migrations

### Migration TCP configuration

The bootstrap script requires a TCP MySQL connection even when the application
runtime uses the PlanetScale HTTP driver. The chart always gives the migration
Job `DATABASE_URL` through the existing `secret.keys.databaseUrl` mapping,
independently of `config.databaseMode`. This preserves the legacy URL path and
its TLS options. No new migration values are required.

For chart-created Secrets, set `secret.values.databaseUrl` to an explicit
`mysql://user:password@tcp-host:3306/database?sslmode=verify-full` URL for the
**same database** used by the application. For an existing Secret, put that URL
in its mapped `DATABASE_URL` key. Runtime `DATABASE_HOST`, `DATABASE_USERNAME`
and `DATABASE_PASSWORD` alone are not sufficient for bootstrap's TCP phase;
the application database mode must not determine the migration environment.
The chart does not expose bootstrap's alternative `DATABASE_NAME`/`DATABASE_PORT`
configuration: specify the database name and TCP port in the URL instead.

When migrations are enabled, Helm validates the required key mappings and, for
chart-created Secrets, a nonempty MySQL URL with username, host, database and a
valid TCP port. PlanetScale mode also rejects the chart's placeholder URL rather
than silently targeting the default MySQL host. Existing Secret contents cannot
be checked at render time; the required key reference and bootstrap parser enforce
them at startup. TCP connectivity, TLS trust, DDL privileges, and matching the
runtime database remain operator responsibilities. With `migrations.enabled:
false`, no migration TCP configuration is required by this chart validation.

The migration Job runs as a Helm `pre-install,pre-upgrade` hook by default:

```yaml
migrations:
  enabled: true
  hook: true
  hookDeletePolicy: before-hook-creation,hook-succeeded
  backoffLimit: 2
  activeDeadlineSeconds: 1800
  command:
    - node
  args:
    - /app/ee/packages/den-db/dist/scripts/bootstrap.js
```

The default hook executes the precompiled Den DB bootstrap runner already built into the Den API image. On a completely empty database it applies the build-time current-schema SQL snapshot, records the committed migrations as the baseline, then runs pending migrations with Drizzle ORM. On an existing schema without a Drizzle ledger, it records the baseline before migrating.

### First install on a cold cluster

The hook Job runs the Den API image, and `activeDeadlineSeconds` counts from Job
creation, so it includes pulling that image (about 800 MB) onto a node that has
never run OpenWork. A `DeadlineExceeded` failure on a first install, with
`kubectl describe pod` showing the pod still `Pulling`, means the pull took
longer than the deadline, not that the migration failed. Two timers apply:

- `migrations.activeDeadlineSeconds` (default `1800`): the Job's own limit.
- Helm `--timeout` (default `5m0s`): how long Helm waits for the hook. Pass at
  least `--timeout 30m` on a first install so Helm does not give up before the
  Job does.

To keep a cold install predictable, pre-pull or mirror the images so the hook
starts immediately: mirror `openwork-den-api` and `openwork-den-web` into a
registry near the cluster and set `denApi.image.repository` and
`denWeb.image.repository` (see
[Air-gapped deployment](../../../packages/docs/start-here/air-gapped-deployment.mdx)),
or pull the tag on each node ahead of time with the node's container runtime
(`crictl pull ghcr.io/different-ai/openwork-den-api:<version>`). The default
`image.pullPolicy: IfNotPresent` reuses a pre-pulled image.

To recover from a failed first install, rerun the same `helm upgrade --install`
command: the `before-hook-creation` delete policy replaces the failed Job and
Helm 3.2.1 or newer upgrades over a `failed` first revision. Only if Helm
reports `has no deployed releases`, or `helm list` shows the release as
`pending-install`, run `helm uninstall` and install again.

For retained-log troubleshooting, temporarily disable hook behavior and reduce
retries:

```yaml
migrations:
  enabled: true
  hook: false
  backoffLimit: 0
```

The hook Job currently renders `DATABASE_URL` and `DEN_DB_ENCRYPTION_KEY` into
the Job environment when `secret.create=true`, because pre-install hooks run
before normal chart resources. Avoid sharing `kubectl describe job` output
without redacting secrets.

## Admin-team permission recovery

### Quick example — dummy installation

**Prerequisite:** complete the normal application/database upgrade with the
recovery feature disabled first. This example is synthetic: namespace
`my-openwork`, release `openwork`, one organization **Example Corp**, and its
only designated, non-SCIM Admin team `admins`. Keep your usual `values.yaml`
untouched; add a separate **recovery.yaml** overlay:

```yaml
config:
  features:
    administratorRecovery: "true"
  administratorRecovery:
    mode: apply
    team: admins
    expectedMembers: 4
```

#### 1. Run the repair and read the Job log

First find the release name and chart version:

```sh
helm list --namespace my-openwork
```

Use that release name in the upgrade command. This example uses `openwork`:

```sh
helm upgrade openwork <chart> --namespace my-openwork -f values.yaml -f recovery.yaml
```

The Job always uses the normal `migrations.hookDeletePolicy` in both Secret
modes (default: delete after success). Capture the result **during the upgrade
in a second terminal**, before successful-hook cleanup removes it. Replace the
Job placeholder with `<release fullname>-migrate`, including any fullname override:

```sh
umask 077
until kubectl --namespace my-openwork logs -f job/<release-fullname>-migrate > recovery.log 2>/dev/null; do
  sleep 2
done
```

This explicit loop retries startup errors without relying on the kubectl client's
own retry behavior. Start it promptly for the new migration Job. When retrying a
failed upgrade, wait until Helm has replaced the previous failed Job so you do
not capture its old log. If the loop does not finish, inspect the Job's status
and your access rather than leaving it unattended.

Keep `recovery.log` privately; it contains the full member roster. A refused run
(for example, an `expectedMembers` mismatch) makes Helm report **`UPGRADE FAILED`**.
That failure is expected for a refusal: in this single-organization example, no
repair changes are written and the existing Den workloads keep running. It is
not a successful upgrade. Under the normal default policy, the failed Job and
its log stay readable until the next upgrade:

```sh
kubectl --namespace my-openwork logs job/<release-fullname>-migrate
```

Read that log, correct the reported configuration, and only then retry.

With the default `migrations.hook: true`, this is a **pre-upgrade** Job: a
recovery refusal or SQL error makes bootstrap exit nonzero and, once the Job
fails, **blocks `helm upgrade` before the new application resources are applied**.
Existing application resources are not replaced by that failed hook. Correct the
reported configuration or disable the recovery overlay before retrying; disabling
it does not revoke a previously committed repair. If hooks are disabled, the
migration Job is an ordinary resource and does not provide this pre-upgrade gate.

Apply is transactional **per organization**. A failed organization's set, grants,
team link and membership revision roll back together, leaving no consumed repair
fence. An earlier organization in a multi-organization `teams` map may already
have committed; the whole map is not one transaction. Retrying skips those
committed repairs. Recovery never converts existing table charsets or collations.

**Illustrative REFUSED output**, generated by the real compiled checker on lab
Example Corp data, with random IDs normalized to obvious dummy placeholders.
The lab initially had an extra fifth member. These are not real people or IDs:

```text
ADMIN RECOVERY REFUSED — nothing was changed. Expected 4 members in team admins (tem_00000000000000000000000001), found 5.
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000001","name":"Example Owner","role":"owner","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":true}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000002","name":"Example Admin","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000003","name":"Example Teammate","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000004","name":"Example Member","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000005","name":"Example Extra Member","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
Next step 1: If this list is right, set expectedMembers to 5 and run again.
Next step 2: Otherwise, ask the owner to remove the person from the team first, then run again.
```

Approve the **whole list**, not just its count. If five is correct, change the
overlay's count to five. Otherwise ask the owner to remove the unexpected person
before retrying. The synthetic owner removed the fifth member, so the same
four-member overlay then produced this **real-output-derived illustrative log**:

```text
APPLIED — these 4 members now have the 14 permissions
{"event":"administrator_recovery_applied","organization":{"id":"org_00000000000000000000000001","slug":"org_00000000000000000000000001","name":"Example Corp"},"team":{"id":"tem_00000000000000000000000001","name":"admins"},"role":{"id":"pms_00000000000000000000000001","name":"Restored administrator permissions"},"peopleCount":4}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000001","name":"Example Owner","role":"owner","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":true}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000002","name":"Example Admin","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000003","name":"Example Teammate","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
{"event":"administrator_recovery_recipient","memberId":"mem_00000000000000000000000004","name":"Example Member","role":"member","viaTeam":true,"connected":true,"setupAgent":false,"ownerUnchanged":false}
UNDO — Members > Roles: unlink or delete Restored administrator permissions (pms_00000000000000000000000001). Disabling or removing the recovery setting stops future runs; it does not revoke these permissions.
Existing Admin-role user decisions remain in force; owners already had all permissions.
```

`role` is the direct role; `viaTeam: true` shows that the recovery is through
this team. Owners are listed but already had all permissions. Do not copy the
illustrative IDs into a real installation.

#### 2. Verify in Den

Open **Members > Roles**, find **Restored administrator permissions** and inspect
its team and 14-key policy. As an intended recipient, test changing a different
non-owner test member's role, then restore that test member's role. If undo is
needed, the owner can unlink or delete this custom role in **Members > Roles**.
The repair does not undo unrelated actions performed while access was granted.

#### 3. Drop the overlay on the next upgrade

```sh
helm upgrade openwork <chart> --namespace my-openwork -f values.yaml
```

Do not pass `recovery.yaml` or `--reuse-values`. The feature returns to its
disabled default; the granted role stays. Disabling/removing the setting stops
future runs, **not existing access**. Re-running an already-consumed repair
prints `ALREADY APPLIED` and does not recreate access the owner removed.

### Optional: preview first

Use the same overlay with `mode: check` (the default mode when the flag is on),
then run the same two-file Helm command and read the migrate Job log. It prints
the resolved organization/team, existing custom roles and full active roster,
plus what apply would do, without database changes. Change only the overlay to
`mode: apply` after approval. A count mismatch refuses in check mode too.

### Multiple Admin teams and multiple organizations

A **name** is accepted only when the organization has exactly one designated,
non-SCIM Admin team. With several Admin teams, name selection refuses and prints
the candidate IDs/names. Use the intended team's ID, even if its name is unique.
Ordinary admins can rename teams; they cannot use renaming to get past this
multiple-Admin-team refusal. IDs remain stable and still require designation,
same-org scope and no SCIM mappings/projections.

When more than one organization exists, add its ID or exact slug:

```yaml
config:
  administratorRecovery:
    organization: "<organization-id-or-slug>"
    team: "<designated-admin-team-id>"
```

The alternative `teams` map also accepts org IDs/slugs and team IDs/names. Use it
**instead of** the single `organization`/`team` fields, never both. Duplicate org
aliases and ambiguous matches refuse rather than choosing a first row.

### Detailed behavior and caveats

- The **explicit feature flag** is the ON/OFF switch. Flag off is a silent
  recovery no-op: no target resolution, preview or repair writes. Ordinary
  database upgrades continue normally. Neither the chart nor bootstrap enables
  the flag automatically. Global kill and an explicit org override false win
  even over an installation-level enable. Hosted Cloud uses only its existing
  per-org override, not a new operator tool.
- `check` and `apply` are maintenance operations on an already-upgraded database.
  They refuse missing migration receipts or pending migrations instead of running
  migration, schema-repair or default-reconciliation writes first. Check is a
  read-only transaction; apply validates the count before any repair write.
- Logs list every active team membership with ID, display name, direct role and
  via-team/connection/setup-agent status. Email columns are not selected/logged;
  address-like labels are redacted. Restrict log access, capture the result during
  the upgrade before normal Job cleanup, and keep the reviewed log privately.
  The chart still passes database credentials as literal Job values when it
  creates the Secret itself; that pre-existing injection behavior is unchanged.
- Existing Admin-role user decisions remain in force. The roster output is not a
  complete effective-access difference against every other role. Existing custom
  roles are not merged or replaced; review them separately.
- **Expected count is not exact roster binding.** A same-size swap is not caught;
  fingerprint/roster binding remains a follow-up. An authorized change before apply
  is included. Later authorized additions inherit the team's role.
- Apply uses existing permission storage and does not change direct member roles,
  built-in Admin defaults or ownership. A permanent fence prevents replay after
  owner key revocation, roster removal or role deletion. API-pod restart is not a
  repair trigger. Physical deletion of all repair history is outside this fence.

## Install links

The migration Job creates the `install_link` and `desktop_connect_grant` tables
automatically when `migrations.enabled=true`. Hosted deployments that enable
install-link gating must opt organizations in through `/admin`; self-hosted
deployments default to enabled. See the
[operator guide](../../../docs/org-install-links.md) and the published
[Installer delivery](../../../packages/docs/start-here/installer-delivery.mdx)
page.

Optional installer artifact values:

```yaml
config:
  public:
    installerReleaseTag: "v0.17.9"
    installerReleaseRepo: "different-ai/openwork"

installerArtifacts:
  enabled: true
  existingClaim: openwork-desktop-artifacts
  mountPath: /var/lib/openwork/installer-artifacts
```

Use either `installerArtifacts.existingClaim` or `installerArtifacts.hostPath`,
not both.

### Desktop downloads

The install page (`/install`) asks people to sign in, then downloads the
standard OpenWork app approved for their organization. Den either:

- streams the standard installer already mounted at
  `installerArtifacts.mountPath`; or
- redirects the browser directly to the exact configured GitHub release asset.

Den does not download, cache, wrap, or ZIP GitHub artifacts. After installing,
people sign in to the desktop app with the same account. Older
`/install?token=…` links still open the install page; the token is ignored.
The former `connectLinkMode`, `connectLinkKeyId` and `connectLinkPrivateKey`
values are no longer used and can be removed.

For a semi-air-gapped deployment, mount these normal release filenames (where
`<version>` is `installerReleaseTag` without its leading `v`):

- `openwork-mac-arm64-<version>.dmg`
- `openwork-mac-x64-<version>.dmg`
- `openwork-win-x64-<version>.exe`
- `openwork-linux-x86_64-<version>.AppImage`
- `openwork-linux-arm64-<version>.AppImage`

Without mounted artifacts, client networks must permit the configured GitHub
release URL and GitHub's redirected release-asset host. With mounted artifacts,
the browser only talks to Den. Use a shared read-only PVC when
`denApi.replicaCount` is greater than one. Connection grants are stored and
consumed in MySQL, so the guided flow is safe when preview and acceptance land
on different API replicas.

## Health Probes

The chart uses the existing service health endpoints:

- `den-api`: `GET /health`
- `den-web`: `GET /api/health`
- `inference`: `GET /health`

Readiness probes use dependency-aware endpoints:

- `den-api`: `GET /ready`
- `den-web`: `GET /api/ready`
- `inference`: `GET /ready`

## Worker Provisioning Recovery

`den-api` periodically reconciles cloud workers that remain in `provisioning` beyond `config.provisioner.reconcileStaleMs`. This lets a replacement pod resume provisioning after a crash. Keep `denApi.replicaCount: 1` unless your worker provider operations are idempotent or you add external leader election.
