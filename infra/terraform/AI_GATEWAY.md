# Optional AI Gateway in Terraform

The native AWS ECS, Google Cloud Run and Azure Container Apps modules can deploy
**the AI Gateway** (`ee/apps/gateway`, image `openwork-inference`, port **8791**).
Select a reviewed source revision containing these inputs; older module versions
do not support them. This guide is not a live qualification or release receipt.
It manages organization inference providers, member keys and limits. This is not
**den-gateway**, the AWS OpenWork Web/sandbox proxy on port **8788**, nor Den API's
**MCP gateway**. Enabling one does not enable the others.

## Common native-module interface

Add these inputs to an existing module call (alongside its required inputs):

```hcl
ai_gateway_enabled     = true
ai_gateway_domain_name = "models.example.com"
ai_gateway_image       = var.ai_gateway_image # image@sha256:<verified manifest digest>
```

| Input/output | Default | Meaning |
| --- | --- | --- |
| `ai_gateway_enabled` | `false` | Installation configuration, like Helm `gateway.enabled`, not a product rollout flag |
| `ai_gateway_domain_name` | `""` | Required when enabled; dedicated qualified non-local hostname, without scheme, port or path |
| `ai_gateway_image` | `""` | Required when enabled; digest-pinned `openwork-inference` image from the **same release as Den** (or its mirror) |
| `ai_gateway_url` (output) | `null` | When enabled, `https://<ai_gateway_domain_name>` for desktops |

No digest is invented or selected from a mutable tag. Use **Gateway-capable Den
API/web and Gateway images from the same release**; the historical built-in Den
0.18.57/0.18.58 conformance pins are not proof of Gateway capability. For another
release, supply the Den image overrides required by that module as well. Verify
the release's image manifests before deployment. Cloud Run cannot pull directly from GHCR: mirror
`ghcr.io/different-ai/openwork-inference` to Artifact Registry, or use its existing
pull-through repository and the corresponding digest-pinned repository path.
`ai_gateway_image` is explicit even if `allow_mutable_image_tags` is enabled for
legacy Den images. All native Gateway services reserve 1 vCPU / 2 GiB; ECS/Azure
run one replica, Cloud Run keeps one warm and permits up to three. These are
unbenchmarked starting sizes, not production capacity recommendations.

When disabled, the module creates no AI Gateway service, route, DNS/certificate
addition or new `GATEWAY_*` environment names. Missing `GATEWAY_ENABLED` is false
at runtime. Existing explicit environment overrides remain unchanged on AWS/GCP;
they still do **not** deploy a service. Remove manual Gateway/Inference overrides
before opting in. Enabled modules reject `GATEWAY_*`, legacy `INFERENCE_*` and
shared database/runtime overrides in `extra_environment` **and** `extra_secrets`.
Azure's narrower plaintext allowlist continues to apply even when disabled.

## Wiring and networking

The chart's `_gateway.tpl` / `inference.yaml` are the reference. Both den-api and
the AI Gateway get `GATEWAY_ENABLED=true`, `DB_MODE=mysql`, production mode,
`GATEWAY_PROXY_BASE_URL`, `GATEWAY_PUBLIC_BASE_URL` and the **existing** database
URL and `DEN_DB_ENCRYPTION_KEY`. `INFERENCE_PROXY_BASE_URL` is the public origin,
so legacy desktop model destinations never receive a private service address.
Only the singleton Den migrator owns schema upgrades; Gateway replicas never
migrate. Optional admin/webhook tokens and scheduled retention are not enabled by
these inputs. Native Gateway containers receive only database/encryption secrets,
not Den's auth/bootstrap/SMTP secrets. Azure attaches only an explicitly configured
registry-pull identity to the Gateway, not Den's Key Vault/integration identities.
The Helm wrapper retains the chart's shared Secret/envFrom behavior. No new secret generator or rotation counter is added.

| Cloud | Den → AI Gateway | Desktop → AI Gateway | Operator prerequisites |
| --- | --- | --- | --- |
| AWS ECS | Private Cloud Map `http://ai-gateway.<name>.internal:8791`, tasks security group only | Existing HTTPS ALB host rule → target group 8791, `/health` | Cover the hostname in ACM and DNS; module-created ACM/Route 53 include it. Existing ALB/listener DNS/cert ownership stays external. `ai_gateway_listener_rule_priority` defaults to **50**, validated against other enabled module rules; check external rules too. |
| Google Cloud Run | **HTTPS load-balancer origin**, same as public URL; no private service-discovery guarantee | Dedicated serverless NEG/backend and host rule; default run.app URI disabled; separate managed AI certificate preserves the existing Den certificate | DNS A record to `load_balancer_ip`; Compute API and LB permissions. A Gateway-only hostname creates an LB even when Den keeps run.app URLs. With `ALL_TRAFFIC`, supply Cloud NAT/egress to the public HTTPS origin and model providers. |
| Azure Container Apps | Generated HTTPS FQDN, routed within the same environment | Dedicated HTTPS ingress 8791 and custom-domain SNI binding; `/health` and `/ready` probes | Preconfigure CNAME + `asuid` TXT using the known app/environment hostname; supply `custom_domain_certificate` PFX covering the Gateway (and Den custom hosts, if used). The environment must exist before DNS verification. Certificate material uses the existing state-backed provider path. |

AWS private ALBs and Azure internal environments still require desktop VPN/private
network reachability and trusted HTTPS. This option does not punch through an
existing private boundary. AWS allows 8791 only from ALB/tasks security groups;
it does not open a public container port. Cloud Run delegates authentication to
the Gateway's member keys, not Google ID tokens, as desktops do not supply those.

### Cloud SQL socket compatibility

Existing Cloud SQL secrets encode `mysql://...@localhost/...?...socket=/cloudsql/...`.
Enabled-Gateway production validation rejects localhost even for a Unix socket.
The Cloud Run packaging entrypoint changes **only the unused hostname in process
memory** to `cloudsql`, before importing den-api or the Gateway server. It preserves
credentials, database, socket path, IAM-authenticated connector and TLS settings;
the stored secret is unchanged. TCP/non-Cloud-SQL localhost URLs remain invalid.
The adapter is tested against the real production validator and MySQL URL parser.
Default-off serving commands and the migration Job's bootstrap command are unchanged.

## Secrets, upgrades and disabling

Keep the existing secret mode, values, resource addresses and all version counters.
**Enabling the Gateway is not permission to convert secret modes, replace secrets
or rotate an encryption key.** Follow each module's existing preservation/recovery
procedure first if adopting older infrastructure. AWS/GCP reference existing cloud
secret versions; Azure reuses its existing ephemeral recovery and write-only PUT
payload mechanism. Azure may resend the same values when deployment configuration
changes; it does not advance rotation counters. Back up keys securely outside
Terraform state. Losing the encryption key loses access to encrypted providers.

Disabling removes the optional service/routing and generated Gateway env settings;
runtime defaults back to disabled. It does not delete providers, keys, usage rows,
the shared database or its secrets. Existing externally managed DNS/certificates
remain operator-owned. GCP explicitly leaves deletion protection off for this
stateless optional service so disabling is possible; core protection is unchanged.

## Kubernetes wrapper

`openwork-self-host` adds `ai_gateway_enabled` (false), `ai_gateway_domain_name`
(empty) and `ai_gateway_url` (null). It **reuses the chart's deployment**, not a
second Gateway implementation. First-class enablement passes canonical Helm
values and creates one additional TLS ingress to the existing `-inference`
Service. Supply `ingress.tls_secret_name` covering the Gateway hostname. With
`ingress.enabled=false`, the operator must provide external HTTPS routing.
Use a chart/release containing the current `gateway.enabled` contract.

Chart image/version policy and shared Secret ownership are unchanged; use the
chart's image overrides for mirrors. The wrapper does not add the native modules'
`ai_gateway_image` input. Existing advanced `extra_helm_values` Gateway installs
remain untouched with the first-class switch off (the output stays null). Do not
combine first-class enablement with chart enable/URL/name/port overrides; those
conflicts fail validation. Chart-level per-app env/secret validation still applies.
Generated wrapper secrets remain state-backed as before: preserve existing state
and keys. The wrapper remains a draft without live-cluster qualification.

## Managed-install boundary

The AWS and Google Cloud managed installers call the **native modules directly**;
they do not use Helm or `openwork-self-host`. These module capabilities alone do
not change a managed install. Their root calls keep the Gateway **off** in this
change. There are no bootstrap IAM, installer publication, feature rollout or
managed-default changes. Enabling support in a managed installer requires a
separately reviewed root/image/DNS/certificate/permission change, any required
customer re-approval, and a fresh live managed-install receipt. Module mock plans
are not proof that managed installation or upgrades work live.

## Verification boundary

See [recorded offline evidence](AI_GATEWAY_VERIFICATION.md) for dated tool/provider
versions, pass/fail counts and observed plan values.

`tests/ai_gateway.tftest.hcl` in each module uses mocked cloud/Helm/Kubernetes
providers. **Mock applies** establish synthetic off/on state only; enable,
coexistence, unchanged, disable and invalid-input checks inspect **plans**. Distinct
mock backend IDs also verify route targets in the synthetic enabled state.
No cloud account or credentials are needed. The tests inspect actual planned service/image/port/route/env/secret
fields, not screenshots of absent services. Run `init -backend=false`, `validate`
(Azure through its provider-bound example) and `test` with **both Terraform and
OpenTofu**; the shared module contract still applies. The Cloud SQL adapter tests
run with `node --test scripts/cloud-sql-entrypoint.test.mjs` on Node 24.

**Live AI Gateway conformance: NotRun.** A separately authorized disposable run
must prove `/health` returns `{"ok":true,"service":"gateway"}`, readiness, admin
`/v1/org` advertises `deploymentCapabilities.aiGateway=true`, provider creation,
Desktop receives and uses the public origin, unchanged apply preserves secrets
and has no diff, disable retains data, and destroy/independent inventory is clean.
DNS/certificate activation, real routing, cloud migration ordering, IAM, load,
state-secret absence and managed-installer behavior are not certified by mock
plans. Do not advertise a production-ready or live-tested cloud installation from
these checks.
