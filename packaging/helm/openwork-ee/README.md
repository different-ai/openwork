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
  --version 0.17.1 \
  -f values.prod.yaml
```

Use the matching image tag in `values.prod.yaml`:

Create a values file for the target environment:

```yaml
image:
  tag: "0.17.1"

config:
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
    authCallbackUrl: "https://openwork.example.com"

secret:
  values:
    databaseUrl: "mysql://openwork:REPLACE_ME@mysql.example.internal:3306/openwork_den"
    betterAuthSecret: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"
    denDbEncryptionKey: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"

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

## Internal Service URLs

By default, the chart wires internal services through Kubernetes DNS:

- `DEN_API_BASE=http://<release>-openwork-ee-den-api:8788`
- `DEN_AUTH_FALLBACK_BASE=http://<release>-openwork-ee-den-api:8788`
- `INFERENCE_PROXY_BASE_URL=http://<release>-openwork-ee-inference:8791` when `inference.enabled=true`

Override `config.internal.*` only when routing through a mesh, gateway, or external service.

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
  args:
    - pnpm --dir /app/ee/packages/den-db run db:bootstrap
```

`db:bootstrap` uses `db:migrate` for normal upgrades. On a completely empty database it applies the current schema once, records the committed migrations as the baseline, then runs migrations. On an existing schema without a Drizzle ledger, it records the baseline before migrating.

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
