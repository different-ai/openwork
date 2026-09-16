# OpenWork on Google Cloud Run

These manifests map the OpenWork Helm workloads to Cloud Run:

- `openwork-den-api.yaml`: the Den API Kubernetes Deployment and Service
- `openwork-den-web.yaml`: the Den Web Kubernetes Deployment and Service
- `openwork-den-migrate.yaml`: the Helm pre-install/pre-upgrade migration Job

They are starter manifests, not a second Helm chart. Copy them to a private
deployment repository, replace every `REPLACE_*` value, and follow
`docs/gcp-cloud-run.md`. Never commit rendered manifests or secret values.

The API image now accepts a percent-encoded Cloud SQL socket in `DATABASE_URL`:

```text
mysql://openwork:PERCENT_ENCODED_PASSWORD@localhost/openwork_den?socket=%2Fcloudsql%2FPROJECT_ID%3AREGION%3AINSTANCE
```

Cloud Run injects that socket when the manifest's
`run.googleapis.com/cloudsql-instances` annotation is set. The hostname is
required by URL parsing but MySQL uses `socketPath` for the actual connection.

Cloud Run also injects its reserved `PORT` environment variable from each
container's `containerPort`; do not add `PORT` to a service manifest.
