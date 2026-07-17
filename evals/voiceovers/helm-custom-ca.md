# helm-custom-ca — Private certificate authorities work across the self-hosted Helm release

1. Here is an existing Kubernetes Secret containing our private CA certificate. OpenWork's Helm values reference it globally without embedding certificate material.

2. Rendering the chart shows the CA mounted read-only into Den API, Den Web, inference, and the database migration Job.

3. Each workload receives `NODE_EXTRA_CA_CERTS`, extending Node's normal public trust store with the private CA.

4. With strict certificate verification enabled, the migration completes and OpenWork connects successfully to a MySQL endpoint signed by that private CA.

5. Invalid configurations—missing sources, multiple sources, or conflicting environment overrides—fail during Helm rendering with a clear message.

6. With custom CA support disabled, the chart renders exactly as before, preserving compatibility for existing installations.
