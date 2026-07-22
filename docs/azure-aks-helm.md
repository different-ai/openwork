# Deploy OpenWork EE on Azure with AKS and Helm

Status: self-host operator guide
Related: `packaging/helm/openwork-ee`, `packaging/helm/openwork-ee/examples/values.azure-ingress.yaml`

This is the recommended Azure path for a first production-like OpenWork EE
self-host install. Use Helm on Azure Kubernetes Service with Azure Database for
MySQL Flexible Server. For web/API exposure, use the AKS application routing
add-on's managed NGINX Ingress controller so OpenWork gets stable HTTPS host
names through a standard Kubernetes `Ingress`.

Azure is moving long-term L7 traffic management toward Gateway API, and
Microsoft notes that AKS application routing NGINX remains supported for
production workloads through November 2026. The current OpenWork chart emits
Ingress resources, so managed NGINX application routing is the simplest
supported Azure path today. Treat Gateway API support as a future chart/platform
hardening item.

Do not use raw Kubernetes `LoadBalancer` Services as the normal Azure path for
OpenWork. Azure Load Balancer is a layer 4 load balancer. It is useful for TCP
services and quick smoke tests, but it does not provide the browser-facing HTTPS
and host routing experience customers expect for auth and SSO.

## What this deploys

- Den API on port `8788`
- Den Web on port `3005`
- optional inference service, disabled by default
- one Azure Database for MySQL Flexible Server database
- one single-org OpenWork deployment
- one managed NGINX Ingress entry point for web and API hosts

Azure owns the AKS cluster, node lifecycle, VNet networking, managed ingress
controller, DNS, TLS certificate storage, MySQL Flexible Server, managed
identities, and network security groups. The OpenWork Helm chart owns OpenWork
Deployments, Services, ConfigMaps, Secrets, health probes, the optional Ingress,
and the database migration Job.

## Use Helm or something else?

Use Helm on AKS for Azure unless the customer explicitly cannot run Kubernetes.
The OpenWork EE release artifact is already a Helm chart, and AKS gives the
cleanest fit for separate web/API services, migration Jobs, and later enterprise
network controls. The gap to fill is Azure-specific infrastructure guidance,
not a different OpenWork packaging format.

## Prerequisites

- Azure CLI authenticated to the target subscription.
- `kubectl`, `kubelogin`, and `helm`.
- Permission to create AKS, virtual networks, managed identities, Azure Database
  for MySQL Flexible Server, Private DNS, Azure DNS, Key Vault or TLS secrets,
  and public IP resources.
- Enough regional and VM-family vCPU quota for the AKS node pool. Azure's
  default AKS node pool is commonly three 2-vCPU nodes, so a subscription with a
  4-vCPU regional limit must either request more quota or intentionally start
  smaller.
- A real admin email address for the first owner account.
- A domain you control, such as `openwork.example.com` and
  `api.openwork.example.com`.

Azure docs used for this guide:

- AKS application routing add-on: https://learn.microsoft.com/en-us/azure/aks/app-routing
- AKS public Standard Load Balancer: https://learn.microsoft.com/en-us/azure/aks/load-balancer-standard
- Azure regional vCPU quota: https://learn.microsoft.com/en-us/azure/quotas/regional-quota-requests
- MySQL Flexible Server private network access: https://learn.microsoft.com/en-us/azure/mysql/flexible-server/concepts-networking-vnet
- MySQL Flexible Server private access with Azure CLI: https://learn.microsoft.com/en-us/azure/mysql/flexible-server/how-to-manage-virtual-network-cli
- MySQL Flexible Server TLS: https://learn.microsoft.com/en-us/azure/mysql/flexible-server/security-tls-how-to-connect

## Before creating resources

Confirm Azure CLI can see an enabled subscription before provisioning:

```bash
az login --use-device-code
az account list --query "[].{name:name,id:id,state:state,isDefault:isDefault}" -o table
az account set --subscription REPLACE_SUBSCRIPTION_ID
az account show --query "{name:name,id:id,state:state,tenantId:tenantId}" -o json
```

Set the target region and disposable resource names once, then reuse them for
the preflight checks, AKS, MySQL, and Helm values. Choose a region that can
provision Azure Database for MySQL Flexible Server for your subscription before
you create AKS; if MySQL is not eligible in the region, build the whole
disposable deployment in a different region rather than splitting AKS and MySQL
across regions.

```bash
export AZURE_LOCATION=westus2
export RESOURCE_GROUP=openwork-ee-rg
export AKS_CLUSTER=openwork-ee
export VNET_NAME=openwork-ee-vnet
export AKS_SUBNET_NAME=aks
export MYSQL_SUBNET_NAME=mysql
export AKS_NODE_VM_SIZE=Standard_D2s_v7
export AKS_NODE_COUNT=1
```

New Azure subscriptions often need resource providers registered before AKS,
networking, monitoring, policy, and MySQL resources can be created:

```bash
for namespace in \
  Microsoft.ContainerService \
  Microsoft.DBforMySQL \
  Microsoft.Network \
  Microsoft.OperationalInsights \
  Microsoft.Insights \
  Microsoft.PolicyInsights
do
  az provider register --namespace "$namespace"
done

az provider list \
  --query "[?namespace=='Microsoft.ContainerService' || namespace=='Microsoft.DBforMySQL' || namespace=='Microsoft.Network' || namespace=='Microsoft.OperationalInsights' || namespace=='Microsoft.Insights' || namespace=='Microsoft.PolicyInsights'].{namespace:namespace,state:registrationState}" \
  -o table
```

Wait until each provider shows `Registered`.

Check that Azure Database for MySQL Flexible Server can list SKUs in the same
region before creating AKS:

```bash
az mysql flexible-server list-skus \
  --location "$AZURE_LOCATION" \
  --query "[0].supportedFlexibleServerEditions[].name" \
  -o table
```

The output should include at least one tier such as `Burstable`,
`GeneralPurpose`, or `BusinessCritical`. If this command returns
`InternalServerError`, `ProvisionNotSupportedForRegion`, or
`RequestDisallowedByAzure` with `locationineligible`, the subscription cannot
currently create MySQL Flexible Server in that region. Pick another region and
rerun this preflight before creating the resource group, VNet, AKS cluster, or
database. This is an Azure subscription/region eligibility issue, not OpenWork
quota usage.

Check regional quota before creating AKS. `Current` shows existing usage and
`Limit` shows the subscription cap; a failure can be caused by a low limit even
when `Current` is `0`:

```bash
az vm list-usage \
  --location "$AZURE_LOCATION" \
  --query "[?name.value=='cores' || contains(name.value, 'standardDS') || contains(name.value, 'standardD')].{name:name.localizedValue,current:currentValue,limit:limit}" \
  -o table
```

If `Total Regional vCPUs` is below `6`, either request a quota increase or use
the quota-friendly one-node example below for a first disposable validation.

## 1. Create the AKS cluster

For a first deployment, create an AKS cluster with the managed application
routing add-on enabled. Use one VNet with separate subnets for AKS and Azure
Database for MySQL Flexible Server. The MySQL subnet must be delegated to
`Microsoft.DBforMySQL/flexibleServers`, and it cannot contain AKS nodes or other
resource types.

```bash
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$AZURE_LOCATION"

az network vnet create \
  --resource-group "$RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --name "$VNET_NAME" \
  --address-prefixes 10.42.0.0/16 \
  --subnet-name "$AKS_SUBNET_NAME" \
  --subnet-prefixes 10.42.0.0/22

az network vnet subnet create \
  --resource-group "$RESOURCE_GROUP" \
  --vnet-name "$VNET_NAME" \
  --name "$MYSQL_SUBNET_NAME" \
  --address-prefixes 10.42.16.0/24 \
  --delegations Microsoft.DBforMySQL/flexibleServers

export AKS_SUBNET_ID="$(az network vnet subnet show \
  --resource-group "$RESOURCE_GROUP" \
  --vnet-name "$VNET_NAME" \
  --name "$AKS_SUBNET_NAME" \
  --query id -o tsv)"

az aks create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER" \
  --location "$AZURE_LOCATION" \
  --vnet-subnet-id "$AKS_SUBNET_ID" \
  --network-plugin azure \
  --network-plugin-mode overlay \
  --enable-app-routing \
  --node-vm-size "$AKS_NODE_VM_SIZE" \
  --node-count "$AKS_NODE_COUNT" \
  --generate-ssh-keys

az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER"

kubectl get nodes
kubectl get ingressclass
```

The application routing add-on creates an Ingress class named
`webapprouting.kubernetes.azure.com`. The starter values file uses that class.

For production capacity, increase `AKS_NODE_COUNT` and use the node SKU your
platform team standardizes on. The one-node example is intended to fit trial or
low-quota subscriptions during first validation; it is not a high-availability
production node pool.

If AKS reports `Standard_DS2_v2 is not allowed` or
`ErrCode_InsufficientVCPUQuota`, check `az vm list-usage` in the target region.
Those errors usually mean Azure picked a default node SKU or node count that the
subscription cannot use, not that OpenWork has consumed quota. Pick an allowed
SKU from Azure's error output, lower `AKS_NODE_COUNT` for a disposable test, or
request regional and VM-family quota increases before production.

If you use AKS Automatic instead of standard AKS, account for the additional
platform requirements before following the rest of this guide:

- Use `--no-ssh-key`; AKS Automatic with managed system node pools rejects SSH
  key configuration.
- If you bring your own VNet, use a user-assigned managed identity and grant it
  `Network Contributor` on the VNet before cluster creation.
- Keep separate subnets for AKS system nodes, AKS user nodes, the API server
  subnet if required by your design, and the delegated MySQL Flexible Server
  subnet.
- Region capacity varies. If AKS Automatic reports SKU/capacity failures, retry
  in a known-good region before debugging the OpenWork chart.

If you are using an existing AKS cluster, enable the add-on instead:

```bash
az aks approuting enable \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER"
```

AKS clusters that use Azure RBAC commonly require `kubelogin` and an explicit
cluster role assignment before normal `kubectl` checks work:

```bash
az aks install-cli

export AKS_ID="$(az aks show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER" \
  --query id -o tsv)"

export USER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"

az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Azure Kubernetes Service RBAC Cluster Admin" \
  --scope "$AKS_ID"

az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER" \
  --overwrite-existing

kubectl get nodes
```

## 2. Create Azure Database for MySQL

Create Azure Database for MySQL Flexible Server with private access in the same
virtual network reachability boundary as AKS. The most important requirements
are:

- MySQL 8-compatible Flexible Server.
- Database name: `openwork_den`.
- Private access through VNet integration or Private Link.
- AKS pods can resolve and reach the MySQL FQDN on TCP `3306`.
- TLS enforcement remains enabled.
- Backups enabled.
- Public access disabled for production unless there is a documented exception.

Azure's CLI can create a private-access server and delegate the MySQL subnet:

```bash
export MYSQL_SERVER_NAME=REPLACE_GLOBALLY_UNIQUE_MYSQL_SERVER_NAME
export MYSQL_ADMIN_USER=openwork
export MYSQL_ADMIN_PASSWORD=REPLACE_DB_PASSWORD

az mysql flexible-server create \
  --resource-group "$RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --name "$MYSQL_SERVER_NAME" \
  --admin-user "$MYSQL_ADMIN_USER" \
  --admin-password "$MYSQL_ADMIN_PASSWORD" \
  --database-name openwork_den \
  --version 8.0.21 \
  --vnet "$VNET_NAME" \
  --subnet "$MYSQL_SUBNET_NAME" \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --yes
```

Use a separate delegated subnet for MySQL Flexible Server. Do not put AKS node
resources in that delegated subnet. Azure Database for MySQL private access is
chosen at server creation time; after the server is deployed into a VNet/subnet,
Azure does not let you move that same server to another VNet, another subnet, or
public access.

Before retrying failed MySQL creation, reconfirm Azure can list Flexible Server
SKUs in the target region:

```bash
az mysql flexible-server list-skus --location "$AZURE_LOCATION" -o table
```

If MySQL creation or SKU listing returns Azure `InternalServerError`, capture
the tracking ID, region, subscription ID, and command that failed. Confirm the
provider is registered and that the `flexibleServers` resource type lists the
target region:

```bash
az provider show \
  --namespace Microsoft.DBforMySQL \
  --query "{state:registrationState, flexibleServerRegions:resourceTypes[?resourceType=='flexibleServers'].locations | [0]}" \
  -o json
```

If the provider is `Registered` and the region is listed, repeated
`InternalServerError`, `ProvisionNotSupportedForRegion`, or
`locationineligible` responses from `list-skus` or `flexible-server create`
indicate an Azure MySQL subscription/region eligibility issue before OpenWork or
Helm is involved. Switch to a region where `list-skus` succeeds and create AKS
and MySQL there, or open an Azure Support case with the tracking IDs. For
disposable chart-only validation, you may temporarily use an in-cluster MySQL
instance to separate chart behavior from Azure MySQL control plane availability,
but do not treat that as a production Azure deployment or as validation of the
documented Azure Database path.

Example database URL:

```text
mysql://openwork:<password>@<server>.mysql.database.azure.com:3306/openwork_den?sslaccept=accept
```

Use `?sslaccept=accept` for the simple private-MySQL smoke path. This keeps TLS
on without requiring a cloud CA bundle to be mounted into the OpenWork image.
Use strict certificate verification later, after you provide the required CA
bundle, with a hardened value such as `sslmode=verify-ca` or
`sslmode=verify-full`.

Before installing OpenWork, verify network access from the cluster:

```bash
kubectl run mysql-client \
  --rm \
  -it \
  --restart=Never \
  --image=mysql:8 \
  -- mysql \
    --host="${MYSQL_SERVER_NAME}.mysql.database.azure.com" \
    --user="$MYSQL_ADMIN_USER" \
    --password \
    --ssl-mode=REQUIRED \
    --execute "select 1"
```

## 3. Prepare Helm values

Copy the starter file:

```bash
cp packaging/helm/openwork-ee/examples/values.azure-ingress.yaml values.azure.yaml
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
Azure MySQL URL:

```bash
helm template openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  -f values.azure.yaml > /tmp/openwork-rendered.yaml

grep -E 'DATABASE_URL|BETTER_AUTH_URL|DEN_API_PUBLIC_URL|DEN_WEB_PUBLIC_ORIGIN|EMAIL_FROM|SMTP_HOST|SMTP_PORT|SMTP_SECURE' /tmp/openwork-rendered.yaml
```

Redact secrets before sharing rendered manifests or terminal output.

## 4. Configure TLS for the Ingress

The starter values reference this TLS secret:

```yaml
ingress:
  tls:
    - secretName: openwork-ee-tls
```

Create that secret from a certificate that covers both OpenWork hosts:

```bash
kubectl create namespace openwork-ee

kubectl create secret tls openwork-ee-tls \
  --namespace openwork-ee \
  --cert=REPLACE_FULL_CHAIN_CERT.pem \
  --key=REPLACE_PRIVATE_KEY.pem
```

For production, prefer an automated certificate flow owned by the platform team:
AKS application routing with Azure DNS and Key Vault, cert-manager, or an
existing ingress platform. Keep the Kubernetes secret name in the values file
aligned with whichever controller creates the certificate.

## 5. Install OpenWork

Published chart releases live in GHCR:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  --create-namespace \
  -f values.azure.yaml
```

For a checkout-local test:

```bash
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee \
  --namespace openwork-ee \
  --create-namespace \
  -f values.azure.yaml
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
  -f values.azure.yaml \
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

## 7. Point DNS at the Azure ingress address

Wait for AKS to allocate an ingress address:

```bash
kubectl get ingress -n openwork-ee
kubectl get service -n app-routing-system nginx
```

Create DNS records:

- `openwork.example.com` -> the application routing public IP.
- `api.openwork.example.com` -> the same application routing public IP.

For production domains, prefer HTTPS before testing SSO. Browser auth cookies
and identity-provider callback policies are much easier to validate on stable
HTTPS origins than on raw ingress IP addresses.

If you are still using temporary hosts before DNS/TLS is ready, temporarily
update the corresponding `config.public.*` origins in `values.azure.yaml`, then
run `helm upgrade` again. Do not leave production deployments on raw ingress IPs
or placeholder hostnames.

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
kubectl describe ingress openwork-ee -n openwork-ee
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
Auth0, Okta trial, and Microsoft Entra test tenants all work as realistic demo
IdPs.

For the full Microsoft Entra SAML and SCIM setup flow, use
`docs/microsoft-entra-sso-scim.md`.

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
assertions. For Microsoft Entra ID specifically, also make sure the Entra
**Identifier (Entity ID)** is the OpenWork auth origin and the certificate saved
in OpenWork is the active Entra token-signing certificate.

After SSO is configured, root sign-in shows the SSO-only experience for the
single organization. Password sign-in for that organization is rejected.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `kubectl get ingressclass` does not show `webapprouting.kubernetes.azure.com` | Application routing is not enabled | Run `az aks approuting enable` or install a different supported ingress controller and update `ingress.className` |
| Ingress has no address | Application routing controller is still reconciling or lacks public IP permission | Check `kubectl get pods -n app-routing-system` and the Ingress events |
| Browser shows certificate warnings | TLS secret is missing, wrong, or does not cover both hosts | Recreate `openwork-ee-tls` or configure the platform certificate automation |
| Migration Job fails to connect to MySQL | VNet, private DNS, credentials, or TLS settings are wrong | Test from `mysql-client`, confirm DNS resolves inside AKS, and use `?sslaccept=accept` for the private-MySQL smoke path |
| `ERROR 3159` from MySQL | Azure requires encrypted transport and the client is not using TLS | Keep TLS enabled with `?sslaccept=accept`, or configure strict CA verification explicitly |
| Migration Job logs show `self-signed certificate in certificate chain` | Strict certificate verification is being used without the cloud MySQL CA bundle | Use `?sslaccept=accept` for the smoke path or mount/configure the CA bundle before strict verification |
| `az login` succeeds but reports no subscriptions | The account has no visible enabled subscription | Create/activate a subscription, rerun device-code login, and confirm `az account show` before provisioning |
| AKS creation reports missing provider registration | New subscription providers are not registered yet | Register the providers listed in "Before creating resources" and wait for `Registered` |
| AKS creation reports `Standard_DS2_v2 is not allowed` | Azure selected a default node SKU that is unavailable in the subscription or region | Set `AKS_NODE_VM_SIZE` to an allowed SKU from Azure's error output, or choose another region |
| AKS creation reports `ErrCode_InsufficientVCPUQuota` | Regional or VM-family vCPU quota is lower than the requested node pool size | Check `az vm list-usage`, reduce `AKS_NODE_COUNT` only for disposable validation, or request regional and VM-family quota increases |
| AKS Automatic rejects SSH keys | Automatic managed system node pools do not accept SSH key configuration | Use `--no-ssh-key` for AKS Automatic, or use the standard AKS command in this guide |
| AKS Automatic with BYO VNet rejects system-assigned identity | BYO VNet requires a user-assigned managed identity | Create a UAMI and grant `Network Contributor` on the VNet before cluster creation |
| `az aks operation show` changes accepted CLI flags after running | Azure CLI may install/use the `aks-preview` extension, changing command behavior | Check `az extension list`; remove `aks-preview` unless you intentionally need preview AKS commands |
| `kubectl get nodes` is unauthorized on an Azure RBAC cluster | Signed-in user lacks AKS RBAC role assignment or `kubelogin` is missing | Install `kubelogin`, assign `Azure Kubernetes Service RBAC Cluster Admin`, and refresh credentials |
| MySQL private access creation rejects the subnet | The subnet is not dedicated to MySQL or is missing `Microsoft.DBforMySQL/flexibleServers` delegation | Use the separate `MYSQL_SUBNET_NAME` created in this guide; do not reuse the AKS subnet |
| `az mysql flexible-server create` or `list-skus` returns `InternalServerError`, `ProvisionNotSupportedForRegion`, or `locationineligible` | The subscription cannot currently create MySQL Flexible Server in that region, or the regional SKU service is failing before Helm install | Pick a new `AZURE_LOCATION` where `list-skus` succeeds before creating AKS; capture tracking IDs and region for Azure Support if every acceptable region fails; only use temporary in-cluster MySQL for chart-only smoke tests |
| `ImagePullBackOff` from GHCR | Private image or missing pull token | Add `imagePullSecrets` |
| Browser auth loops or CORS errors | Public origins do not match DNS/TLS | Set `webOrigin`, `apiOrigin`, `corsOrigins`, `betterAuthTrustedOrigins`, and `authCallbackUrl` to the final HTTPS domains |
| SSO callback rejected | IdP callback URL does not match OpenWork | Use the callback/ACS URL shown by OpenWork for that org/provider |
| SSO settings show Enterprise gating | `DEN_PLAN_GATING_ENABLED=true` or org is not entitled | Leave plan gating off for self-host smoke tests, or grant enterprise entitlement |

## 12. Cleanup

For a disposable test:

```bash
helm uninstall openwork-ee -n openwork-ee
az group delete --name "$RESOURCE_GROUP"
```

Delete any DNS records, Key Vault certificates, public IP resources, and
database backups or retained restore points if they were only for the test.
