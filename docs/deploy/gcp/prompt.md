# GCP Deployment Agent Prompt Template

Copy this prompt into your agent and replace every `{{PLACEHOLDER}}` before running it. The agent is expected to operate from a local OpenWork repository checkout and use CLI/API tools for infrastructure. Any browser-only step should be handed back to the operator.

```text
You are deploying OpenWork EE to Google Cloud from this repository checkout:

{{REPOSITORY_PATH}}

Read and obey `AGENTS.md`. Use the current repository documentation as the source of truth, especially:

- `packages/docs/self-host/deploy-to-your-cloud/overview.mdx`
- `packages/docs/self-host/deploy-to-your-cloud/google-cloud.mdx`
- `packages/docs/self-host/deploy-to-your-cloud/first-administrator.mdx`
- `docs/gcp-gke-helm.md`
- `packaging/helm/openwork-ee/README.md`
- `packaging/helm/openwork-ee/examples/values.gcp-ingress.yaml`

Goal: provision and deploy a production-like OpenWork EE install on GCP using the latest published Helm chart that contains the documented first-administrator setup flow. Leave the deployment running unless I ask for cleanup.

Customer inputs:

- GCP project: `{{GCP_PROJECT_ID}}`
- GCP region: `{{GCP_REGION}}`
- VPC: `{{VPC_NAME}}`
- Web hostname: `{{WEB_HOSTNAME}}`
- API hostname: `{{API_HOSTNAME}}`
- Organization name: `{{ORGANIZATION_NAME}}`
- Initial owner email: `{{INITIAL_OWNER_EMAIL}}`
- Platform/bootstrap admin email, if separate: `{{PLATFORM_ADMIN_EMAIL_OR_SAME_AS_OWNER}}`
- OpenWork version: `{{OPENWORK_VERSION_OR_LATEST_RELEASE}}` where `latest` means check GitHub releases and the published Helm chart before deploying.
- Administrator setup code: `{{OPERATOR_PROVIDES_CODE_OR_AGENT_GENERATES_ONE}}`. If the agent generates the code, give it to me through an agreed secure channel and never print it in task logs.

Agent-created resource names and defaults (change if required):

- GKE cluster name: Kubernetes cluster to create, default `openwork-ee`.
- Kubernetes namespace: Kubernetes namespace for OpenWork workloads, default `openwork-ee`.
- Helm release name: Helm's install/upgrade release name, default `openwork-ee`.
- Cloud SQL instance name: GCP Cloud SQL resource to create, default `openwork-ee-mysql`.
- Cloud SQL database name: MySQL database to create inside Cloud SQL, default `openwork_den`.
- Cloud SQL user: MySQL user to create for OpenWork, default `openwork`.
- Reserved global address name: GCP resource name for the static global IPv4 address used by the HTTPS load balancer, default `openwork-ee-ip`. This is not the IP address; the agent creates the address and reports the allocated IP.

Operating rules:

- Fetch the latest `origin/dev` first and verify the referenced docs, chart, and first-administrator implementation exist.
- Do not assume merged code has been released. Identify the first published chart version that includes the required setup flow, confirm its image tag alignment, and render the chart to verify required configuration and Secret keys.
- If no published chart contains the setup flow, stop and ask whether to wait for a release or explicitly test unreleased images.
- Never print, commit, screenshot, or store secrets in repository files, Helm values, ConfigMaps, shell history, or task commentary.
- Generate strong independent values for the database password, `BETTER_AUTH_SECRET`, and `DEN_DB_ENCRYPTION_KEY`. For the administrator setup code, either use the operator-provided code or generate one and provide it to the operator securely, exactly as the current chart and code require.
- Store runtime secrets only in Kubernetes Secrets or another approved secret store.
- Keep public signup disabled. Do not enable signup as a workaround.
- If a choice materially changes security, cost, domain ownership, chart version, or resource naming, ask before proceeding.
- Do not use a browser yourself unless I explicitly say browser automation is available. For browser-only steps, give me exact instructions and wait for my confirmation.

Preflight before provisioning:

1. Confirm active `gcloud` account and project.
2. Confirm billing is enabled.
3. Inventory existing GKE, Cloud SQL, global addresses, forwarding rules, certificates, DNS zones, and Service Networking resources that may conflict or be reusable.
4. Confirm required APIs are enabled: Kubernetes Engine, Compute Engine, Cloud SQL Admin, and Service Networking.
5. Confirm local tools work: `gcloud`, `gke-gcloud-auth-plugin`, `kubectl`, `helm`, and `openssl`.
6. Confirm the selected Helm chart version and image tag include the first-administrator setup flow.

Provision and deploy according to the GCP runbook:

- Create or reuse private services access for the target VPC.
- Create a regional GKE Autopilot cluster using the requested/default cluster name.
- Create Cloud SQL for MySQL 8 with private IP, backups enabled, and public IP disabled unless the docs require otherwise.
- Reserve a global IPv4 address.
- Apply the documented GKE `BackendConfig` and `ManagedCertificate` resources.
- Create the namespace and runtime Secret.
- Install the Helm release using GCP ingress values and the requested/default release name.
- Run and verify migrations.
- Verify Den API and Den Web readiness, pod health, database connectivity, Ingress address assignment, and backend health.

DNS handoff:

- After the reserved global IP exists, pause and tell me the exact DNS records to create for `{{WEB_HOSTNAME}}` and `{{API_HOSTNAME}}`.
- Wait for my confirmation that DNS is updated.
- Verify public DNS resolution yourself before continuing.
- Do not claim HTTPS is ready until the managed certificate is active and `openssl` or equivalent external checks show trusted certificates for both hostnames.

First-administrator handoff:

- Verify the database has zero users before setup.
- Verify public signup is disabled.
- Give me the setup URL: `https://{{WEB_HOSTNAME}}/setup`.
- Tell me exactly what to enter, except do not reveal secrets in logs. If the setup code is needed, provide it through an agreed secure channel outside task output.
- Ask me to complete browser-only setup for `{{INITIAL_OWNER_EMAIL}}`, including choosing a password.
- Wait for my confirmation that setup completed and I can sign in.
- Then verify server-side, where possible, that the user exists, owns the singleton organization, platform-admin access is present when configured, setup cannot be replayed, and public signup remains disabled.
- Ask me to sign out and sign back in normally, then report whether authenticated navigation works.

Validation standard:

Do not call this passed because Helm is deployed or pods are running. A passed result requires healthy infrastructure, successful migrations, database connectivity, correct DNS, trusted HTTPS, successful first-administrator setup, owner/admin authorization, one-time setup consumption, public signup disabled, and normal sign-in after sign-out.

Documentation feedback:

Track any reusable documentation gaps, failed commands, unclear values, required Secret keys, health-check issues, DNS/certificate timing, or setup-flow confusion. If docs need changes, make only generic reusable edits in a separate branch/worktree and open a ready-for-review PR against `dev`. Do not commit environment-specific deployment records.

Final report:

Report `Passed`, `Incomplete`, or `Failed`, plus chart/app version, resources created, reserved IP, DNS records, Cloud SQL tier/region/private-IP/backup state, GKE type/region, Helm revision/status, migration result, pod readiness, backend health, certificate status, external readiness checks, administrator setup result, replay/signup rejection result, sign-out/sign-in result, browser handoffs completed by the operator, non-secret commands run, deviations from docs, documentation PRs, ongoing cost items, and exact cleanup commands.
```
