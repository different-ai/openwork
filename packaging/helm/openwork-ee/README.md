# OpenWork EE Helm Chart

Initial Helm chart for the OpenWork EE Den stack:

- `den-api` control plane on port `8788`
- `den-web` web app on port `3005`
- optional `inference` service on port `8791`
- shared ConfigMap and Secret templating
- optional Ingress for web and API hosts
- pre-install/pre-upgrade migration Job scaffold

## Install

Published releases are available as an OCI Helm chart:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  -f values.prod.yaml
```

Use the matching image tag in `values.prod.yaml`:

Create a values file for the target environment:

```yaml
image:
  tag: "REPLACE_OPENWORK_VERSION"

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
    webOrigin: "https://openwork.example.com"
    apiOrigin: "https://api.openwork.example.com"
    mcpResourceUrl: "https://api.openwork.example.com/mcp"
    mcpClaimNamespace: "https://openwork.example.com"
    desktopDenBaseUrl: "https://openwork.example.com"
    corsOrigins: "https://openwork.example.com,https://api.openwork.example.com"
    betterAuthTrustedOrigins: "https://openwork.example.com"
    webAppHosts: "openwork.example.com"
    bootstrapAdminEmails: "admin@example.com"
    # Self-hosted default: every organization gets install downloads.
    installLinksGatingEnabled: "false"
    authCallbackUrl: "https://openwork.example.com"
  githubConnector:
    appId: ""
    clientId: ""

secret:
  values:
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

For local development from a repository checkout, render or install directly:

```bash
helm template openwork-ee ./packaging/helm/openwork-ee -f values.prod.yaml
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee -f values.prod.yaml
```

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

Set `DAYTONA_API_KEY` when `config.provisioner.mode` is `daytona`. Set `POLAR_ACCESS_TOKEN` when Polar feature gating is enabled. Set `OPENROUTER_MANAGEMENT_API_KEY` when enabling OpenWork Models management.

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
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee \
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
  http://127.0.0.1:3005/api/den/openapi.json >/dev/null
```

Your observability backend should show `openwork-den-web` and
`openwork-den-api`, with one connected trace for the request. Logs from both
services carry trace and span IDs. Den API also exports Hono request-duration
and active-request metrics.

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
    tracesSampleRate: "1"
    environment: production
    release: "2026.07.11"
```

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

After the release is installed and the web host is reachable, sign up or sign in
with one of the emails in `config.tenancy.ownerEmails`. If the singleton
organization does not exist yet, Den creates it with `singleOrgName` and
`singleOrgSlug`, then makes that eligible first user the organization owner.

Later users are attached to the same singleton organization. They do not see an
organization creation step, and attempts to create another organization return a
single-org-mode error. If no `ownerEmails` are configured, the first user who
reaches the deployment can claim the owner role, so production deployments
should set `ownerEmails` explicitly.

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

```yaml
config:
  denApiNodeOptions: "--use-openssl-ca --max-old-space-size=4096"
```

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

Den API, Den Web, and inference pods include checksums for the chart-managed
ConfigMap and Secret. Helm upgrades that change runtime config or secrets roll
the pods automatically so environment variables such as public origins, CORS
origins, and database URLs are refreshed.

## Isolated Networks

The chart disables external password breach screening by default so isolated self-hosted installs do not depend on the Have I Been Pwned Pwned Passwords range API. If your deployment has approved egress and you want password creation and reset to reject known-compromised passwords through that service, enable it:

```yaml
config:
  auth:
    passwordBreachScreeningEnabled: "true"
```

Local sign-in lockout protections stay enabled either way.

## Migrations

The migration Job runs as a Helm `pre-install,pre-upgrade` hook by default:

```yaml
migrations:
  enabled: true
  hook: true
  hookDeletePolicy: before-hook-creation,hook-succeeded
  args:
    - pnpm --dir /app/ee/packages/den-db run db:bootstrap
```

`db:bootstrap` uses `db:migrate` for normal upgrades. On a completely empty database it applies the current schema once, records the committed migrations as the baseline, then runs migrations. On an existing schema without a Drizzle ledger, it records the baseline before migrating.

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

## Install links

The migration Job creates the `install_link` table automatically when `migrations.enabled=true`. Install links remain dark until a platform admin opens `/admin` and enables the `Install links` capability for an org. See the [operator guide](../../../docs/org-install-links.md).

Optional installer artifact values:

```yaml
config:
  public:
    installerReleaseTag: "v0.17.9"
    installerReleaseRepo: "different-ai/openwork"

installerArtifacts:
  enabled: true
  existingClaim: openwork-installer-artifacts
  mountPath: /var/lib/openwork/installer-artifacts
```

Use either `installerArtifacts.existingClaim` or `installerArtifacts.hostPath`, not both. The mounted directory must contain `openwork-installer-mac-arm64.zip`, `openwork-installer-mac-x64.zip`, and `openwork-installer-win-x64.exe`.

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
