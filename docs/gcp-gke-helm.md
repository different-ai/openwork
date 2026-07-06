# Deploy OpenWork EE on Google Cloud with GKE and Helm

Status: self-host operator guide
Related: `packaging/helm/openwork-ee`, `packaging/helm/openwork-ee/examples/values.gcp-ingress.yaml`

This is the recommended Google Cloud path for a first production-like OpenWork
EE self-host install. Use Helm on GKE Autopilot with Cloud SQL for MySQL. For
web/API exposure, use GKE Ingress with Google-managed certificates, a reserved
global IP address, and explicit backend health checks.

Google recommends Gateway API for new L7 traffic management, and GKE Ingress is
in maintenance mode. The current OpenWork chart emits Ingress resources, so GKE
Ingress is the simplest supported GCP path today. Treat Gateway API support as a
future chart/platform hardening item.

Do not use raw Kubernetes `LoadBalancer` Services as the normal GCP path for
OpenWork. GKE `LoadBalancer` Services are useful for TCP services and quick
smoke tests, but the customer-facing web app and SSO flow need HTTP(S) load
balancing, host routing, managed certificates, and backend health checks.

## What this deploys

- Den API on port `8788`
- Den Web on port `3005`
- optional inference service, disabled by default
- one Cloud SQL for MySQL database
- one single-org OpenWork deployment
- one external GKE Ingress backed by a Google Cloud Application Load Balancer
- one Google-managed certificate covering web and API hosts

Google Cloud owns the GKE cluster, Autopilot compute lifecycle, VPC networking,
Cloud Load Balancing, managed certificates, Cloud SQL, IAM, and firewall rules.
The OpenWork Helm chart owns OpenWork Deployments, Services, ConfigMaps,
Secrets, health probes, the optional Ingress, and the database migration Job.
The `BackendConfig` and `ManagedCertificate` resources in this guide are
GKE-specific platform resources applied alongside the chart.

## Use Helm or something else?

Use Helm on GKE for Google Cloud unless the customer explicitly cannot run
Kubernetes. The OpenWork EE release artifact is already a Helm chart, and GKE
Autopilot keeps the first customer path small while still supporting migration
Jobs, separate web/API services, SSO-ready HTTPS, and later enterprise network
controls. The practical gap to fill is GCP-specific ingress and database
guidance, not a different OpenWork packaging format.

## Prerequisites

- Google Cloud CLI authenticated to the target project.
- `kubectl` and `helm`.
- Permission to create GKE, Compute Engine networking and global addresses,
  Cloud SQL, Service Networking, DNS, IAM, and Kubernetes resources.
- Enabled APIs: Kubernetes Engine API, Compute Engine API, Cloud SQL Admin API,
  and Service Networking API.
- A real admin email address for the first owner account.
- A domain you control, such as `openwork.example.com` and
  `api.openwork.example.com`.

Google Cloud docs used for this guide:

- GKE Autopilot clusters: https://cloud.google.com/kubernetes-engine/docs/how-to/creating-an-autopilot-cluster
- GKE Ingress for Application Load Balancers: https://cloud.google.com/kubernetes-engine/docs/concepts/ingress
- GKE external Ingress and NEGs: https://cloud.google.com/kubernetes-engine/docs/how-to/container-native-load-balancing
- GKE managed certificates: https://cloud.google.com/kubernetes-engine/docs/how-to/managed-certs
- GKE Ingress configuration and BackendConfig: https://cloud.google.com/kubernetes-engine/docs/how-to/ingress-configuration
- GKE Ingress health checks: https://cloud.google.com/kubernetes-engine/docs/troubleshooting/ingress-health-checks
- Cloud SQL private IP: https://cloud.google.com/sql/docs/mysql/private-ip
- Cloud SQL from GKE: https://cloud.google.com/sql/docs/mysql/connect-kubernetes-engine

## 1. Create the GKE cluster

For a first deployment, create a regional Autopilot cluster:

```bash
export GCP_PROJECT=REPLACE_PROJECT_ID
export GCP_REGION=us-central1
export GKE_CLUSTER=openwork-ee

gcloud config set project "$GCP_PROJECT"

gcloud services enable \
  container.googleapis.com \
  compute.googleapis.com \
  sqladmin.googleapis.com \
  servicenetworking.googleapis.com

gcloud container clusters create-auto "$GKE_CLUSTER" \
  --location "$GCP_REGION" \
  --project "$GCP_PROJECT"

gcloud container clusters get-credentials "$GKE_CLUSTER" \
  --location "$GCP_REGION" \
  --project "$GCP_PROJECT"

kubectl get nodes
```

GKE enables HTTP load balancing by default. Do not disable it; GKE Ingress needs
that add-on.

## 2. Create Cloud SQL for MySQL

Create Cloud SQL for MySQL with private IP in the same VPC as the GKE cluster.
The most important requirements are:

- MySQL 8-compatible Cloud SQL instance.
- Database name: `openwork_den`.
- Private services access configured for the VPC.
- Private IP enabled on the Cloud SQL instance.
- GKE is VPC-native and can reach the private IP.
- Backups enabled.
- Public IP disabled for production unless there is a documented exception.

Private IP requires a one-time private services access connection for the VPC:

```bash
export VPC_NETWORK=default
export SQL_RANGE=openwork-sql-range

gcloud compute addresses create "$SQL_RANGE" \
  --global \
  --purpose=VPC_PEERING \
  --prefix-length=16 \
  --network="$VPC_NETWORK"

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges="$SQL_RANGE" \
  --network="$VPC_NETWORK"
```

Create the instance and database:

```bash
export SQL_INSTANCE=openwork-ee-mysql

gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=MYSQL_8_0 \
  --region="$GCP_REGION" \
  --network="projects/$GCP_PROJECT/global/networks/$VPC_NETWORK" \
  --no-assign-ip

gcloud sql databases create openwork_den \
  --instance="$SQL_INSTANCE"

gcloud sql users create openwork \
  --instance="$SQL_INSTANCE" \
  --password=REPLACE_DB_PASSWORD
```

Get the private IP:

```bash
gcloud sql instances describe "$SQL_INSTANCE" \
  --format='value(ipAddresses[0].ipAddress)'
```

Example database URL:

```text
mysql://openwork:<password>@<cloud-sql-private-ip>:3306/openwork_den
```

This guide uses direct private IP because the current OpenWork chart does not
inject Cloud SQL Auth Proxy sidecars. Cloud SQL Auth Proxy is a stronger future
hardening path when the chart supports sidecars or an operator-managed proxy
pattern.

If the Cloud SQL instance enforces encrypted client connections, use
`?sslaccept=accept` for the simple private-MySQL smoke path. This keeps TLS on
without requiring a cloud CA bundle to be mounted into the OpenWork image. Use
strict certificate verification later, after you provide the required CA bundle,
with a hardened value such as `sslmode=verify-ca` or `sslmode=verify-full`.
Verify the same URL works for both the migration Job and runtime pods before
testing the browser flow.

Before installing OpenWork, verify network access from the cluster:

```bash
kubectl run mysql-client \
  --rm \
  -it \
  --restart=Never \
  --image=mysql:8 \
  -- mysql \
    --host="REPLACE_CLOUD_SQL_PRIVATE_IP" \
    --user=openwork \
    --password \
    --execute "select 1"
```

## 3. Reserve a global IP and create GKE resources

Reserve a global IP address for the HTTPS load balancer:

```bash
gcloud compute addresses create openwork-ee-ip \
  --global

gcloud compute addresses describe openwork-ee-ip \
  --global \
  --format='value(address)'
```

Create the namespace:

```bash
kubectl create namespace openwork-ee
```

Create a Google-managed certificate resource:

```bash
kubectl apply -n openwork-ee -f - <<'YAML'
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: openwork-ee-cert
spec:
  domains:
    - REPLACE_WEB_HOST
    - REPLACE_API_HOST
YAML
```

Create explicit backend health checks for the two OpenWork services:

```bash
kubectl apply -n openwork-ee -f - <<'YAML'
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: openwork-ee-den-api-backend
spec:
  healthCheck:
    type: HTTP
    requestPath: /ready
    port: 8788
---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: openwork-ee-den-web-backend
spec:
  healthCheck:
    type: HTTP
    requestPath: /api/ready
    port: 3005
YAML
```

The Helm values annotate the OpenWork Services so GKE associates these
`BackendConfig` objects with the Google Cloud backend services.

## 4. Prepare Helm values

Copy the starter file:

```bash
cp packaging/helm/openwork-ee/examples/values.gcp-ingress.yaml values.gcp.yaml
```

Replace every `REPLACE_*` placeholder.

Generate secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use the first value for `secret.values.betterAuthSecret` and the second for
`secret.values.denDbEncryptionKey`. Do not reuse either value across
environments.

To send transactional email, configure SMTP in the same values file:

```yaml
secret:
  values:
    emailFrom: "OpenWork <no-reply@example.com>"
    smtpHost: "smtp.example.com"
    smtpPort: "587"
    smtpUser: "openwork@example.com"
    smtpPass: "REPLACE_SMTP_PASSWORD"
    smtpSecure: "false"
```

These values become `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, and `SMTP_SECURE` in Den API. If you use `secret.create=false`,
add those keys to the existing Kubernetes Secret referenced by
`secret.existingSecret`. SMTP delivery requires both `EMAIL_FROM` and
`SMTP_HOST`; leave `smtpHost` blank only when SMTP-backed transactional email
should be disabled.

Use a values file, not a long list of `--set` flags. Several OpenWork values are
comma-separated strings, such as `config.public.corsOrigins`, and plain `--set`
parsing commonly breaks them.

Make sure your file uses the current chart keys. Public URL values belong under
`config.public.*`; database and app secrets belong under `secret.values.*`.
Values such as `config.urls`, `config.databaseUrl`, or `secrets.*` are ignored
by the chart.

Before installing, render the chart and verify the migration Job will use your
Cloud SQL URL:

```bash
helm template openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  -f values.gcp.yaml > /tmp/openwork-rendered.yaml

grep -E 'DATABASE_URL|BETTER_AUTH_URL|DEN_API_PUBLIC_URL|DEN_WEB_PUBLIC_ORIGIN|EMAIL_FROM|SMTP_HOST|SMTP_PORT|SMTP_SECURE' /tmp/openwork-rendered.yaml
```

Redact secrets before sharing rendered manifests or terminal output.

## 5. Install OpenWork

Published chart releases live in GHCR:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  --create-namespace \
  -f values.gcp.yaml
```

For a checkout-local test:

```bash
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee \
  --namespace openwork-ee \
  --create-namespace \
  -f values.gcp.yaml
```

If GHCR image pulls fail with `ImagePullBackOff`, authenticate to GHCR and add
an `imagePullSecrets` entry. Public releases should not require this, but
private packages or private forks do:

```bash
kubectl create secret docker-registry ghcr-pull-secret \
  --namespace openwork-ee \
  --docker-server=ghcr.io \
  --docker-username="$GITHUB_USER" \
  --docker-password="$GITHUB_TOKEN"
```

```yaml
imagePullSecrets:
  - name: ghcr-pull-secret
```

## 6. Migration troubleshooting

The migration Job runs before the Deployments are useful. If it fails, fix that
before debugging web/API readiness.

Avoid `kubectl describe job openwork-ee-migrate` in shared reports because the
hook Job currently includes `DATABASE_URL` and `DEN_DB_ENCRYPTION_KEY` in the
rendered environment. Use logs and redacted rendered manifests instead.

For a retained-log debug attempt, temporarily disable hook behavior:

```yaml
migrations:
  enabled: true
  hook: false
  backoffLimit: 0
```

Then run Helm and inspect the normal Job logs:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  --create-namespace \
  -f values.gcp.yaml \
  --wait=false

kubectl get jobs,pods -n openwork-ee
kubectl logs -n openwork-ee -l job-name=openwork-ee-migrate --all-containers=true
```

Return to the default hook mode after debugging:

```yaml
migrations:
  enabled: true
  hook: true
  backoffLimit: 2
```

## 7. Point DNS at the global load balancer IP

Get the reserved IP address:

```bash
gcloud compute addresses describe openwork-ee-ip \
  --global \
  --format='value(address)'
```

Create DNS records:

- `openwork.example.com` -> the reserved global IP address.
- `api.openwork.example.com` -> the reserved global IP address.

GKE can take several minutes to provision the load balancer. Google-managed
certificates can take up to an hour to become active after DNS points at the
load balancer.

Check status:

```bash
kubectl get ingress -n openwork-ee
kubectl describe managedcertificate openwork-ee-cert -n openwork-ee
kubectl describe ingress openwork-ee -n openwork-ee
```

If you are still using temporary hosts before DNS/TLS is ready, temporarily
update the corresponding `config.public.*` origins in `values.gcp.yaml`, then
run `helm upgrade` again. Do not leave production deployments on raw IPs or
placeholder hostnames.

The current chart rolls the Den API, Den Web, and inference pods automatically
when ConfigMap or Secret content changes. On older chart versions, manually
restart the deployments after changing public origin values:

```bash
kubectl rollout restart deployment/openwork-ee-den-api deployment/openwork-ee-den-web -n openwork-ee
kubectl rollout status deployment/openwork-ee-den-api -n openwork-ee --timeout=180s
kubectl rollout status deployment/openwork-ee-den-web -n openwork-ee --timeout=180s
```

## 8. Verify readiness

Check Kubernetes state:

```bash
helm status openwork-ee -n openwork-ee
kubectl get pods -n openwork-ee
kubectl get jobs -n openwork-ee
kubectl get ingress -n openwork-ee
kubectl describe backendconfig openwork-ee-den-api-backend -n openwork-ee
kubectl describe backendconfig openwork-ee-den-web-backend -n openwork-ee
kubectl logs -n openwork-ee deploy/openwork-ee-den-api
kubectl logs -n openwork-ee deploy/openwork-ee-den-web
```

Check readiness from your machine:

```bash
curl -fsS https://api.openwork.example.com/ready
curl -fsS https://openwork.example.com/api/ready
```

## 9. Bootstrap the first owner

The chart defaults to `single_org`. Set these before first sign-in:

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

Open `https://openwork.example.com` and sign up with the owner email. OpenWork
creates the singleton organization and makes that user the owner. Later users
join the same organization. If `ownerEmails` is blank, the first user to reach
the deployment can claim ownership, which is not recommended for production.

## 10. Configure SSO with a test IdP

Self-hosted installs keep plan gating off unless the operator explicitly sets
`DEN_PLAN_GATING_ENABLED=true`, so SSO management should be available in the EE
self-host default.

Use OIDC first for a smoke test because most IdPs provide discovery metadata.
Auth0, Okta trial, and Google Cloud Identity test tenants all work as realistic
demo IdPs.

Configure the IdP application with this callback URL:

```text
https://openwork.example.com/api/auth/sso/callback/openwork-sso-<org-id>
```

In OpenWork, sign in as the owner, open the organization SSO settings, and enter
the IdP issuer/client details. After saving, the organization sign-in path is:

```text
https://openwork.example.com/sso/<singleOrgSlug>
```

For SAML, OpenWork shows the generated ACS URL and metadata URL after the SAML
connection is registered. Use those values in the IdP rather than guessing.
OpenWork rejects unsigned or weak SAML responses, so configure the IdP to sign
assertions.

After SSO is configured, root sign-in shows the SSO-only experience for the
single organization. Password sign-in for that organization is rejected.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Ingress does not reconcile | HTTP load balancing add-on is disabled or Ingress annotation is wrong | Keep HTTP load balancing enabled and use `kubernetes.io/ingress.class: gce` |
| Backends are unhealthy | GKE load balancer health checks do not match OpenWork readiness endpoints | Apply the `BackendConfig` resources and keep the service annotations from the starter values |
| Managed certificate is not `Active` | DNS does not point at the load balancer or provisioning is still running | Point both hosts at the reserved global IP and wait; check `kubectl describe managedcertificate` |
| Migration Job fails to connect to MySQL | Private services access, VPC, credentials, IP, or TLS mode are wrong | Test from `mysql-client`, confirm the private IP, and confirm GKE and Cloud SQL share VPC reachability |
| Migration Job logs show `self-signed certificate in certificate chain` | Strict certificate verification is being used without the cloud MySQL CA bundle | Use `?sslaccept=accept` for the smoke path or mount/configure the CA bundle before strict verification |
| `ImagePullBackOff` from GHCR | Private image or missing pull token | Add `imagePullSecrets` |
| Browser auth loops or CORS errors | Public origins do not match DNS/TLS | Set `webOrigin`, `apiOrigin`, `corsOrigins`, `betterAuthTrustedOrigins`, and `authCallbackUrl` to the final HTTPS domains |
| SSO callback rejected | IdP callback URL does not match OpenWork | Use the callback/ACS URL shown by OpenWork for that org/provider |
| SSO settings show Enterprise gating | `DEN_PLAN_GATING_ENABLED=true` or org is not entitled | Leave plan gating off for self-host smoke tests, or grant enterprise entitlement |

## 12. Cleanup

For a disposable test:

```bash
helm uninstall openwork-ee -n openwork-ee
gcloud compute addresses delete openwork-ee-ip --global
gcloud container clusters delete "$GKE_CLUSTER" --location "$GCP_REGION"
gcloud sql instances delete "$SQL_INSTANCE"
```

Delete DNS records, retained backups, private service access ranges, and any IAM
resources if they were only for the test.
