# Deploy OpenWork EE on Google Cloud Run

Status: self-host operator guide (initial Cloud Run path)
Related: `packaging/cloud-run`, `packaging/helm/openwork-ee`

This guide maps the existing OpenWork Helm release to three Cloud Run resources:
Den API and Den Web services plus a one-shot database migration job. Use it when
you want a serverless Google Cloud deployment and do not need Kubernetes-only
features. GKE with Helm remains the path for the optional Gateway, custom CA
mounts, installer artifact volumes, and other pod-level customization.

Google's migration model maps Kubernetes Deployments and Services to Cloud Run
services, and Kubernetes Jobs to Cloud Run jobs. Cloud Run supplies service
endpoints and autoscaling, so the Helm chart's Kubernetes Services, Ingress,
replica counts, probes, ConfigMap, and Secret objects do not move across
directly. Secret values live in Secret Manager.

## Supported starter scope

- single-organization Den API and Den Web
- Cloud SQL for MySQL through Cloud Run's Unix socket
- one explicit migration job before each service rollout
- public Cloud Run endpoints for initial testing
- Artifact Registry copies of the published OpenWork images

Use an OpenWork release that includes Cloud SQL socket support in
`DATABASE_URL` (the `?socket=` option documented below). Until that change is in
a published release, build and push both images from this branch for testing.

The optional OpenWork Gateway and Automations runtime are disabled in this
starter. Cloud Run has no Kubernetes service discovery, persistent local disk,
or Helm hooks. Review those gaps before migrating an existing production GKE
installation.

## 1. Set variables and enable APIs

```bash
export GCP_PROJECT=REPLACE_PROJECT_ID
export GCP_REGION=us-central1
export OPENWORK_VERSION=REPLACE_OPENWORK_VERSION
export SQL_INSTANCE=openwork-ee-mysql
export ARTIFACT_REPOSITORY=openwork

gcloud config set project "$GCP_PROJECT"
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com
```

Create an Artifact Registry repository and a dedicated runtime identity:

```bash
gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
  --repository-format=docker \
  --location="$GCP_REGION"

gcloud iam service-accounts create openwork-cloud-run \
  --display-name="OpenWork Cloud Run"

export RUN_SERVICE_ACCOUNT="openwork-cloud-run@$GCP_PROJECT.iam.gserviceaccount.com"

for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:$RUN_SERVICE_ACCOUNT" \
    --role="$role"
done
```

## 2. Copy the release images to Artifact Registry

Cloud Run deploys the copies in your project. Authenticate Docker, then mirror
the Den images from the OpenWork release:

```bash
gcloud auth configure-docker "$GCP_REGION-docker.pkg.dev"

docker pull "ghcr.io/different-ai/openwork-den-api:$OPENWORK_VERSION"
docker tag "ghcr.io/different-ai/openwork-den-api:$OPENWORK_VERSION" \
  "$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPOSITORY/openwork-den-api:$OPENWORK_VERSION"
docker push "$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPOSITORY/openwork-den-api:$OPENWORK_VERSION"

docker pull "ghcr.io/different-ai/openwork-den-web:$OPENWORK_VERSION"
docker tag "ghcr.io/different-ai/openwork-den-web:$OPENWORK_VERSION" \
  "$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPOSITORY/openwork-den-web:$OPENWORK_VERSION"
docker push "$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPOSITORY/openwork-den-web:$OPENWORK_VERSION"
```

## 3. Create Cloud SQL and secrets

Create MySQL 8, its database, and its user. This starter uses Cloud Run's
authenticated Cloud SQL connector. The default instance public IP is used by
the connector, but you do not add an authorized network or expose database
credentials outside Secret Manager. For private-IP-only Cloud SQL, add Direct
VPC egress to all three manifests and select the connector's private IP path.

```bash
gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=MYSQL_8_0 \
  --region="$GCP_REGION"

gcloud sql databases create openwork_den --instance="$SQL_INSTANCE"
gcloud sql users create openwork \
  --instance="$SQL_INSTANCE" \
  --password=REPLACE_DB_PASSWORD

export SQL_CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
```

Percent-encode the database password and `/cloudsql/$SQL_CONNECTION_NAME`, then
construct this value locally:

```text
mysql://openwork:PERCENT_ENCODED_PASSWORD@localhost/openwork_den?socket=PERCENT_ENCODED_SOCKET_PATH
```

Create four Secret Manager secrets without putting their payloads on a command
line or in shell history:

```bash
gcloud secrets create openwork-database-url --replication-policy=automatic
gcloud secrets versions add openwork-database-url --data-file=-

gcloud secrets create openwork-better-auth-secret --replication-policy=automatic
gcloud secrets versions add openwork-better-auth-secret --data-file=-

gcloud secrets create openwork-db-encryption-key --replication-policy=automatic
gcloud secrets versions add openwork-db-encryption-key --data-file=-

gcloud secrets create openwork-bootstrap-code --replication-policy=automatic
gcloud secrets versions add openwork-bootstrap-code --data-file=-
```

Enter the database URL for the first prompt. Generate independent, high-entropy
values for the other prompts, for example with `openssl rand -base64 48`.

## 4. Render the starter manifests

Copy `packaging/cloud-run` to a private deployment directory and replace every
`REPLACE_*` token. Use the final HTTPS origins you intend users to access. For a
smoke test with generated `run.app` URLs, deploy once with temporary origins,
read each service URL, update `REPLACE_WEB_ORIGIN`, `REPLACE_WEB_HOST`, and
`REPLACE_API_ORIGIN`, then replace both services again before granting public
access.

Check that no placeholders or secret payloads remain:

```bash
rg 'REPLACE_' ./openwork-cloud-run
```

## 5. Run migrations, then deploy services

The order is deliberate. Database migration is a separate, observable release
step; never run it concurrently from service startup.

```bash
gcloud run jobs replace ./openwork-cloud-run/openwork-den-migrate.yaml \
  --region="$GCP_REGION"
gcloud run jobs execute openwork-den-migrate \
  --region="$GCP_REGION" \
  --wait

gcloud run services replace ./openwork-cloud-run/openwork-den-api.yaml \
  --region="$GCP_REGION"
gcloud run services replace ./openwork-cloud-run/openwork-den-web.yaml \
  --region="$GCP_REGION"
```

For public test endpoints, explicitly grant invocation only after both final
revisions are healthy:

```bash
for service in openwork-den-api openwork-den-web; do
  gcloud run services add-iam-policy-binding "$service" \
    --region="$GCP_REGION" \
    --member=allUsers \
    --role=roles/run.invoker
done
```

For production, put the services behind a global external Application Load
Balancer with managed certificates and disable the default `run.app` URLs if
your security model requires a single controlled entry point.

## 6. Verify

```bash
export API_URL="$(gcloud run services describe openwork-den-api --region="$GCP_REGION" --format='value(status.url)')"
export WEB_URL="$(gcloud run services describe openwork-den-web --region="$GCP_REGION" --format='value(status.url)')"

curl --fail --show-error "$API_URL/health"
curl --fail --show-error "$API_URL/ready"
curl --fail --show-error "$WEB_URL/api/health"
curl --fail --show-error "$WEB_URL/api/ready"
```

Open `$WEB_URL/setup` and use the bootstrap code to create the first
administrator. Rotate or remove the bootstrap secret after setup.

## Upgrades and rollback

Mirror the new versioned images, back up Cloud SQL, replace and execute the
migration job, then replace the API and Web services. Cloud Run can send traffic
back to a prior revision, but a service rollback does not reverse database
schema changes. Follow release-specific migration guidance and test restores.

For an existing GKE deployment, inventory external dependencies and cut over
one service at a time. Google's migration guide recommends a global external
Application Load Balancer when gradually splitting traffic between GKE and
Cloud Run.

## References

- Google: https://docs.cloud.google.com/run/docs/migrate/from-kubernetes
- Cloud Run service YAML: https://cloud.google.com/run/docs/reference/yaml/v1
- Cloud Run jobs: https://cloud.google.com/run/docs/create-jobs
- Cloud SQL connections from Cloud Run: https://cloud.google.com/sql/docs/mysql/connect-run
- Secret Manager with Cloud Run: https://cloud.google.com/run/docs/configuring/services/secrets
