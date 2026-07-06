# Deploy OpenWork EE on AWS with EKS and Helm

Status: self-host operator guide
Related: `packaging/helm/openwork-ee`, `packaging/helm/openwork-ee/examples/values.aws-load-balancer.yaml`, `packaging/helm/openwork-ee/examples/values.aws-load-balancer-http-smoke.yaml`

This is the recommended AWS path for a first production-like OpenWork EE
self-host install. Use Helm on Amazon EKS with Amazon RDS for MySQL. For the
simplest customer deployment, use EKS Auto Mode and Kubernetes
`LoadBalancer` Services so AWS provisions Network Load Balancers directly from
the chart. Use an Ingress/ALB path later when you need one shared ALB, advanced
HTTP routing, WAF rules, or an existing ingress platform.

## What this deploys

- Den API on port `8788`
- Den Web on port `3005`
- optional inference service, disabled by default
- one RDS MySQL database
- one single-org OpenWork deployment
- two public AWS Network Load Balancers by default: one for web and one for API

AWS owns the EKS cluster, node lifecycle, VPC networking, load balancers, RDS,
DNS, TLS certificates, IAM, and security groups. The OpenWork Helm chart owns
OpenWork Deployments, Services, ConfigMaps, Secrets, health probes, and the
database migration Job.

## Use Helm or something else?

Use Helm on EKS for AWS unless the customer explicitly cannot run Kubernetes.
The OpenWork EE release artifact is already a Helm chart, the service split maps
cleanly to Kubernetes, and EKS Auto Mode removes most node and load balancer
setup from the customer path. A VM or ECS guide can be useful later, but it
would be a separate packaging surface to maintain. The practical gap found by
AWS testing was not Helm itself; it was missing AWS-specific infra guidance and
missing chart knobs for AWS service annotations.

## Prerequisites

- AWS CLI authenticated to the target account.
- `kubectl`, `helm`, and `eksctl`.
- `eksctl` version `0.195.0` or newer for EKS Auto Mode.
- Permission to create EKS, EC2/VPC, IAM, Elastic Load Balancing, RDS, Secrets
  Manager, Route 53, and ACM resources.
- A real admin email address for the first owner account.
- A domain you control, such as `openwork.example.com` and
  `api.openwork.example.com`.

Do not run production installs as the AWS root account. Use AWS SSO or an IAM
role with only the permissions needed for the cluster, VPC/load balancer, RDS,
DNS, and certificate resources.

AWS docs used for this guide:

- EKS Auto Mode: https://docs.aws.amazon.com/eks/latest/userguide/automode.html
- EKS Auto Mode with `eksctl`: https://docs.aws.amazon.com/eks/latest/userguide/automode-get-started-eksctl.html
- EKS Auto Mode NLB service annotations: https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-nlb.html
- AWS Load Balancer Controller: https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
- RDS TLS: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html

## CloudShell quickstart

If you start from the AWS Console, CloudShell is a reasonable test environment,
but it may not have every required tool or a default region configured. Set the
region explicitly even if the console region selector already shows the right
region:

```bash
export AWS_REGION=us-east-1
aws sts get-caller-identity
aws configure get region
```

Install Helm and `eksctl` if they are missing:

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

curl -fsSL "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz" \
  -o /tmp/eksctl.tar.gz
tar -xzf /tmp/eksctl.tar.gz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin/eksctl

helm version
eksctl version
kubectl version --client
```

## 1. Create the EKS cluster

For a first deployment, create an EKS Auto Mode cluster:

```bash
export AWS_REGION=us-east-1
export CLUSTER_NAME=openwork-ee

eksctl create cluster \
  --name "$CLUSTER_NAME" \
  --region "$AWS_REGION" \
  --enable-auto-mode

aws eks update-kubeconfig \
  --region "$AWS_REGION" \
  --name "$CLUSTER_NAME"

kubectl get nodes
```

EKS Auto Mode handles default compute, pod networking, DNS, block storage, and
load balancer integration. It also makes Network Load Balancers available for
Kubernetes Services of type `LoadBalancer`.

Fresh EKS Auto Mode clusters can show no nodes at first. Auto Mode provisions
compute when there is pending workload demand, so `kubectl get nodes` may return
`No resources found` until the first pods are scheduled.

## 2. Create RDS MySQL

Create a MySQL database reachable from the EKS worker security group. The exact
VPC and subnet commands vary by account, so the important requirements are:

- RDS MySQL 8-compatible engine.
- Database name: `openwork_den`.
- Private subnets in the same VPC as the EKS cluster.
- RDS security group inbound TCP `3306` from the EKS node/pod security group.
- Storage encryption enabled.
- Backups enabled.
- Public accessibility disabled for production.
- TLS required or at least supported.

Example database URL:

```text
mysql://openwork:<password>@<rds-endpoint>:3306/openwork_den?sslaccept=accept
```

Use `?sslaccept=accept` for the simple private-RDS smoke path. This keeps TLS on
but does not require the RDS CA bundle to be mounted into the OpenWork image.
Use strict certificate verification later, after you provide the RDS CA bundle,
with a hardened value such as `sslmode=verify-ca` or `sslmode=verify-full`.

Wait until the EKS cluster is `ACTIVE` before wiring RDS security groups. Then
allow MySQL traffic from both the EKS cluster security group and the eksctl
shared node security group:

```bash
export CLUSTER_SG_ID=$(aws eks describe-cluster \
  --region "$AWS_REGION" \
  --name "$CLUSTER_NAME" \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
  --output text)

export NODE_SG_ID=$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "eksctl-${CLUSTER_NAME}-cluster" \
  --query 'Stacks[0].Outputs[?OutputKey==`SharedNodeSecurityGroup`].OutputValue' \
  --output text)

aws ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$RDS_SG_ID" \
  --protocol tcp \
  --port 3306 \
  --source-group "$CLUSTER_SG_ID"

aws ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$RDS_SG_ID" \
  --protocol tcp \
  --port 3306 \
  --source-group "$NODE_SG_ID"
```

Before installing OpenWork, verify network access from the cluster. One simple
way is to run a temporary MySQL client pod:

```bash
kubectl run mysql-client \
  --rm \
  -it \
  --restart=Never \
  --image=mysql:8 \
  -- mysql \
    --host="$RDS_ENDPOINT" \
    --user=openwork \
    --password \
    --ssl-mode=REQUIRED \
    --execute "select 1"
```

## 3. Prepare Helm values

Copy the starter file:

```bash
cp packaging/helm/openwork-ee/examples/values.aws-load-balancer.yaml values.aws.yaml
```

If you do not have DNS and ACM ready yet, use the HTTP smoke-test starter
instead:

```bash
cp packaging/helm/openwork-ee/examples/values.aws-load-balancer-http-smoke.yaml values.aws.yaml
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
comma-separated strings, such as `config.public.corsOrigins`, and plain
`--set` parsing commonly breaks them.

Make sure your file uses the current chart keys. Public URL values belong under
`config.public.*`; database and app secrets belong under `secret.values.*`.
Values such as `config.urls`, `config.databaseUrl`, or `secrets.*` are ignored
by the chart.

Before installing, render the chart and verify the migration Job will use your
RDS URL:

```bash
helm template openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  -f values.aws.yaml > /tmp/openwork-rendered.yaml

grep -E 'DATABASE_URL|BETTER_AUTH_URL|DEN_API_PUBLIC_URL|DEN_WEB_PUBLIC_ORIGIN|EMAIL_FROM|SMTP_HOST|SMTP_PORT|SMTP_SECURE' /tmp/openwork-rendered.yaml
```

Redact secrets before sharing rendered manifests or terminal output.

## 4. Install OpenWork

Published chart releases live in GHCR:

```bash
helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \
  --version REPLACE_OPENWORK_VERSION \
  --namespace openwork-ee \
  --create-namespace \
  -f values.aws.yaml
```

For a checkout-local test:

```bash
helm upgrade --install openwork-ee ./packaging/helm/openwork-ee \
  --namespace openwork-ee \
  --create-namespace \
  -f values.aws.yaml
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

## 5. Migration troubleshooting

The migration Job runs before the Deployments and Services are installed. If it
fails, fix that before debugging web/API readiness.

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
  -f values.aws.yaml \
  --wait=false

kubectl get jobs,pods -n openwork-ee
kubectl logs -n openwork-ee -l job-name=openwork-ee-migrate --all-containers=true
```

If you see `self-signed certificate in certificate chain` against RDS, use the
documented private-RDS smoke URL with `?sslaccept=accept`, or mount/configure
the RDS CA bundle before using strict certificate verification.

Return to the default hook mode after debugging:

```yaml
migrations:
  enabled: true
  hook: true
  backoffLimit: 2
```

## 6. Point DNS at AWS load balancers

Wait for AWS to allocate load balancer hostnames:

```bash
kubectl get svc -n openwork-ee
```

You should see external hostnames for:

- `openwork-ee-den-web`
- `openwork-ee-den-api`

Create DNS records:

- `openwork.example.com` -> Den Web load balancer hostname.
- `api.openwork.example.com` -> Den API load balancer hostname.

The starter values terminate TLS on port `443` at each Network Load Balancer
and forward clear HTTP to the Kubernetes service target port. Use an ACM
certificate that covers both the web and API hosts:

```yaml
denWeb:
  service:
    port: 443
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-ssl-cert: arn:aws:acm:...
      service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
denApi:
  service:
    port: 443
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-ssl-cert: arn:aws:acm:...
      service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
```

For production domains, prefer HTTPS before testing SSO. Browser auth cookies
and identity-provider callback policies are much easier to validate on stable
HTTPS origins than on raw load balancer hostnames.

For a temporary HTTP-only smoke test, remove the SSL annotations, set
`denWeb.service.port` back to `3005`, set `denApi.service.port` back to `8788`,
and use explicit `http://host:port` origins in `values.aws.yaml`.

If you are still using raw AWS load balancer hostnames before DNS/TLS is ready,
temporarily update the corresponding `config.public.*` origins in
`values.aws.yaml`, then run `helm upgrade` again. Do not leave production
deployments on raw load balancer hostnames.

The current chart rolls the Den API, Den Web, and inference pods automatically
when ConfigMap or Secret content changes. On older chart versions, manually
restart the deployments after changing public origin values:

```bash
kubectl rollout restart deployment/openwork-ee-den-api deployment/openwork-ee-den-web -n openwork-ee
kubectl rollout status deployment/openwork-ee-den-api -n openwork-ee --timeout=180s
kubectl rollout status deployment/openwork-ee-den-web -n openwork-ee --timeout=180s
```

## 7. Verify readiness

Check Kubernetes state:

```bash
helm status openwork-ee -n openwork-ee
kubectl get pods -n openwork-ee
kubectl get jobs -n openwork-ee
kubectl describe pods -n openwork-ee
kubectl logs -n openwork-ee deploy/openwork-ee-den-api
kubectl logs -n openwork-ee deploy/openwork-ee-den-web
```

Check service readiness from your machine:

```bash
curl -fsS https://api.openwork.example.com/ready
curl -fsS https://openwork.example.com/api/ready
```

For HTTP smoke tests, use the raw NLB hostnames and ports:

```bash
curl -fsS http://REPLACE_API_NLB_HOST:8788/ready
curl -fsS http://REPLACE_WEB_NLB_HOST:3005/api/ready
```

## 8. Bootstrap the first owner

The chart defaults to `single_org`. Set these before first sign-in:

```yaml
config:
  tenancy:
    mode: single_org
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

## 9. Configure SSO with a test IdP

Self-hosted installs keep plan gating off unless the operator explicitly sets
`DEN_PLAN_GATING_ENABLED=true`, so SSO management should be available in the EE
self-host default.

Use OIDC first for a smoke test because most IdPs provide discovery metadata.
Auth0, Okta trial, and Microsoft Entra test tenants all work as realistic demo
IdPs.

Configure the IdP application with these callback URLs:

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

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `helm` is missing in CloudShell | CloudShell does not always include Helm | Install Helm in CloudShell or run Helm locally with AWS credentials |
| `aws sts get-caller-identity` returns `NoCredentials` | AWS CLI is not authenticated | Configure AWS SSO/profile or use authenticated CloudShell |
| Initial `kubectl get nodes` is empty | EKS Auto Mode has not needed to provision nodes yet | Continue after the cluster is active; nodes appear when workloads are pending |
| Pods show untolerated Auto Mode taints | Auto Mode is still selecting/provisioning matching capacity | Wait for the NodeClaim, then check pod events again |
| Pod sandbox fails with `aws-cni failed ... failed to assign an IP address` | Subnet/IP or EKS CNI capacity problem | Check subnet free IPs, node events, and retry after Auto Mode provisions replacement capacity |
| Migration Job fails to connect to MySQL | RDS security group, DB credentials, or TLS mode are wrong | Allow TCP `3306` from EKS, verify with `mysql-client`, and use `?sslaccept=accept` for the private-RDS smoke path |
| Migration Job logs show `self-signed certificate in certificate chain` | Strict certificate verification is being used without the RDS CA bundle | Use `?sslaccept=accept` for the smoke path or mount/configure the RDS CA bundle before strict verification |
| Runtime is ready but migration failed | Helm hook did not complete | Check `kubectl get jobs` and the migration Job logs before testing web |
| `ImagePullBackOff` from GHCR | Private image or missing pull token | Add `imagePullSecrets` |
| Browser auth loops or CORS errors | Public origins do not match DNS/TLS | Set `webOrigin`, `apiOrigin`, `corsOrigins`, `betterAuthTrustedOrigins`, and `authCallbackUrl` to the final HTTPS domains |
| SSO callback rejected | IdP callback URL does not match OpenWork | Use the callback/ACS URL shown by OpenWork for that org/provider |
| SSO settings show Enterprise gating | `DEN_PLAN_GATING_ENABLED=true` or org is not entitled | Leave plan gating off for self-host smoke tests, or grant enterprise entitlement |

## 11. Cleanup

For a disposable test:

```bash
helm uninstall openwork-ee -n openwork-ee
eksctl delete cluster --name "$CLUSTER_NAME" --region "$AWS_REGION"
```

Delete RDS snapshots, Secrets Manager secrets, Route 53 records, ACM
certificates, and any manually created security groups if they were only for
the test.
