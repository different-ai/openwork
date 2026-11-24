# AI Gateway Terraform — offline verification for #7400

**2026-11-13 · macOS arm64 · offline evidence only. Live conformance: NotRun.**

Code tested: `1de30f7ed522fef7061359eb80703c7a0e79a70e`, based on remote dev
`1833adcdd10a8368b397f69f00d8bab9a9a4224c`. Subsequent documentation does not
change the tested implementation. Both isolated CLI copies were byte-compared
with the source/test/example files (126 file comparisons).

No live apply, paid resource provisioning, production mutation, infrastructure
provider credential access, secret rotation, deployment, merge or issue comment
was performed. Native
`command = apply` blocks below run **against mocked cloud/Helm/Kubernetes
providers only** to establish synthetic off/on state. Random generation is local.
No AI Gateway image was pulled or run; its digests are synthetic syntax fixtures.
This report is not a release, production-readiness or managed-install receipt.

## Results

| Module | Terraform 1.16.5 | OpenTofu 1.11.14 | Failed / errored / skipped |
| --- | ---: | ---: | --- |
| `openwork-aws-ecs` | 53 passed | 53 passed | 0 / 0 / 0 on each |
| `openwork-gcp-cloud-run` | 50 passed | 50 passed | 0 / 0 / 0 on each |
| `openwork-azure-container-apps` | 45 passed | 45 passed | 0 / 0 / 0 on each |
| `openwork-self-host` | 8 passed | 8 passed | 0 / 0 / 0 on each |
| **Total** | **156 passed** | **156 passed** | **312 passes, no failures/errors/skips** |

Both tools passed module `init -backend=false`, subsequent
`init -backend=false -lockfile=readonly`, format checks and native tests.
Library `validate` passed for AWS, GCP and the wrapper; Azure validation uses
its supported provider-bound `examples/complete` root, not a missing caller alias.
Every executable example passed registry-matching read-only initialization and
validation (14 validation checks total including supported bare modules).
Azure's separate OpenTofu root lock was selected; GCP's example lock was
regenerated in the isolated OpenTofu copy. No library locks/caches/state are
committed.

The wrapper also passed `init -backend=false` and `validate` on **Terraform
1.5.7**, retaining its existing minimum. Mock-test language requires newer tools;
this is not a 1.5 native-test or live-cluster result.

## Reviewer questions and observed facts

The native facts are in each module's `tests/ai_gateway.tftest.hcl` (`assert` and
`expect_failures`). Additional resource-action inspection used Terraform's
`test -json -verbose` output; OpenTofu's verdict was independently obtained with
`test -json`, not inferred from Terraform. All values below are neutral fixtures.

| Question | Observed fact |
| --- | --- |
| Does the default create anything or advertise capability? | Native modules: **0** AI Gateway services/routes; `ai_gateway_url=null`; **0** new `GATEWAY_*` / `INFERENCE_*` names in Den API. Wrapper: **0** AI ingresses and exactly the original **2** Helm values documents. |
| What does enabling add? | Each native module: services **0 → 1**, inference image@digest, port **8791**, `/health`, public origin **`null → https://models.example.com`**. Azure also has `/ready`. Distinct mock backend/app IDs verify routing to inference, not Den. |
| Where does Den send requests? | AWS: **`http://ai-gateway.openwork.internal:8791`** over Cloud Map. GCP: **`https://models.example.com`** through the HTTPS LB, explicitly **not private DNS**. Azure: **`https://openwork-ai-gateway.happy-sky-1234.eastus.azurecontainerapps.io`**, the generated same-environment FQDN. |
| Where do desktops go? | All three native modules advertise **`https://models.example.com`** as both `GATEWAY_PUBLIC_BASE_URL` and the legacy Models destination `INFERENCE_PROXY_BASE_URL`; no internal hostname leaks into that destination. |
| Are the database and encryption values shared? | Both serving containers reference the same existing `DATABASE_URL` and `DEN_DB_ENCRYPTION_KEY` store/version. AWS/GCP keep **4 → 4** core secret entries, with **no database, generator, secret-parent or secret-version actions** on enable/disable. Azure keeps encryption/database rotation counters **1 → 1** and only metadata in the persistent Gateway body; values use the existing ephemeral recovery/write-only path. Live Azure secret fingerprints were **not measured**. |
| Does adding inference replace Den's GCP certificate? | Existing two-host Den certificate action is **`["no-op"]`**. A separate AI certificate is attached. Supplied covering certificate IDs remain operator-owned, with no generated certificate. |
| Does Azure inference gain unrelated identities? | With two identities on Den, Gateway identity count is **1**, registry-pull only; the Key Vault/integration identity is absent. |
| Can it coexist with den-gateway? | AWS: both services present, **8791 vs 8788**, distinct hosts and listener priorities (**50 vs 30** by default). GCP/Azure do not deploy den-gateway; their three Den/AI hosts/backends coexist without adding Web support. |
| Does an unchanged enabled configuration drift? | **0 managed-resource changes** on all three native modules; protected database/secret mutations **0**. These are synthetic-state plans, **not live unchanged applies**. |
| What happens on disable? | Services **1 → 0**, URL **HTTPS → null**, generated Gateway env removed. Protected database/secret mutations **0**. Plan-only managed-resource change counts are AWS **11**, GCP **18**, Azure **6**, including stateless service/routing removal and serving configuration updates. No real database rows were created or deleted in these tests. |
| Do invalid inputs fail before deployment? | Expected failures observed for missing domains, conflicting Gateway/Inference/shared runtime overrides, mutable image references, duplicate hosts, AWS rule priorities, Azure missing certificates, and wrapper conflicting values/missing TLS/shared hosts. |
| Does first-class false break an advanced Helm installation? | Advanced `gateway.enabled=true` values remain present and the values list remains **2** documents while the first-class switch is false; the new output is null because the operator owns that advanced URL. |

## Additional checks

| Check | Result | What it proves / does not prove |
| --- | --- | --- |
| Exact inline Cloud SQL entrypoint against production Gateway validator and MySQL parser | **4 passed, 0 failed/skipped**, Node **24.22.1** | Cloud SQL socket hostname changes `localhost → cloudsql` only in memory; parsed credentials/socket/TLS unchanged. External strict-TLS URL unchanged. TCP/non-Cloud-SQL localhost still rejected. No DB/network connection. |
| Existing Helm Gateway render matrix | **78 passed, 0 failed/skipped**, Helm **4.2.2** | In-tree chart compatibility/validation; no cluster or published image qualification. |
| Actual planned wrapper values rendered through the in-tree chart (`helm template --skip-tests`) | Passed | **2** serving `GATEWAY_ENABLED` entries, **2** shared encryption references; private service origin and public Models origin present. This is not a Kubernetes apply. |
| GCP installer unit/packaging suite | **41 passed, 0 failed** | Synthetic installer/release archive checks, including payload references and backend-disabled validation. Installer console messages in its fixtures are **not live readiness**. |
| Trivy **0.75.0** default/example scan of all four modules | **4 gates passed**, **0 unaccepted HIGH/CRITICAL** | Existing file-scoped exceptions unchanged; no new ignores. Default/example static scan, not enabled-cloud or runtime certification. |
| Mintlify `pnpm dlx mint validate` and `broken-links` | Build/validation passed; no broken links | Documentation build/link structure only. CLI `--version` reports `unknown`; no version is invented. Nothing published. |
| Both CLI recursive format checks and `git diff --check` | Passed | Formatting/whitespace only. |

Native library provider selections were identical by version on both registries:

- AWS **6.73.0**, archive **2.8.1**, HTTP **3.6.3**, random **3.9.1**.
- GCP Google **8.11.0**, random **3.9.1**.
- AzureRM **5.14.0**, AzAPI **2.13.0**, external **2.4.2**, random **3.9.1**.
- Wrapper Helm provider **2.17.0**, Kubernetes **3.5.0**, random **3.9.1**.

Executable roots retain their own provider selections, including GCP Google
8.7.0 and AzureRM 5.10.0. Root validation is not a live install with those versions.

## Reproduction

Use separate copied module roots/locks for Terraform and OpenTofu. In each module:

```sh
terraform init -backend=false -input=false
terraform init -backend=false -input=false -lockfile=readonly
terraform validate # Azure: validate examples/complete with its caller alias
terraform test
# Repeat independently with tofu and its matching registry lock.
```

From the repository root:

```sh
terraform fmt -check -recursive infra/terraform
tofu fmt -check -recursive infra/terraform
node --test infra/terraform/modules/openwork-gcp-cloud-run/scripts/cloud-sql-entrypoint.test.mjs
bash packaging/helm/openwork-ee/tests/gateway.sh
python3 -m unittest discover -s infra/managed-deployments/tests -p 'test_gcp_installer.py'
```

The installer packaging test requires backend-disabled initialization of its
managed GCP Terraform root first, so its offline provider mirror exists. No
credentials or real provider plan/apply are needed for that prerequisite.

## Required live follow-up — NotRun

Only a separately authorized disposable run can establish DNS/certificate
activation, actual private/public routing, `/health` and `/ready`, admin
`/v1/org` capability, provider creation and a desktop inference request using the
public origin. It must also measure secret fingerprints/versions and no-diff
unchanged apply, disable with retained data, and destroy with independent absence
verification. Repeat through the separately approved managed installers before
claiming managed readiness. No permission, bootstrap, installer-publication or
managed root/default change is included here. See [the operator guide](AI_GATEWAY.md).
