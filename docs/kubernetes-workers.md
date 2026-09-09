# Kubernetes Worker Provisioner

Status: self-host operator guide
Related: `packaging/helm/openwork-ee`, `ee/apps/den-api/src/workers/kubernetes.ts`, `ee/apps/den-api/src/workers/kubernetes-client.ts`, `packaging/docker/Dockerfile.microsandbox`, `scripts/build-microsandbox-openwork-image.sh`

`PROVISIONER_MODE=kubernetes` makes `den-api` provision every cloud worker directly in your Kubernetes cluster. Each worker becomes a Deployment, a ClusterIP Service, a token Secret, and two PersistentVolumeClaims (`/workspace`, `/data`). This is the fully self-hosted alternative to the hosted Daytona and Render providers: workers run on your nodes, store data in your storage classes, and never leave your network boundary.

## Architecture

```
den-api (release namespace, ServiceAccount <release>-den-api)
  │  Kubernetes REST API (in-cluster SA token or KUBERNETES_API_TOKEN)
  ▼
worker namespace (default: openwork-workers)
  ├─ Deployment/<worker-name>            openwork-server + managed opencode
  ├─ Service/<worker-name>               ClusterIP → pod :8787
  ├─ Secret/<worker-name>-tokens         OPENWORK_TOKEN, OPENWORK_HOST_TOKEN,
  │                                      DEN_ACTIVITY_HEARTBEAT_TOKEN (stringData)
  ├─ PVC/<worker-name>-workspace         mounted at /workspace
  └─ PVC/<worker-name>-data              mounted at /data (opencode + sidecar state)
```

Worker names derive from the worker id (`wrk_<base32>` → `wrk-<base32>`, already DNS-1123-safe). den-api waits for the worker's `/health` endpoint before recording the worker healthy, stores the instance URL, and relies on the same reconciler, wake, and idle-stop lifecycle as the other providers.

## Prerequisites

- A Kubernetes cluster (k3s, kubeadm, EKS, GKE, AKS all work) with a default or configured StorageClass that supports `ReadWriteOnce` PVCs.
- MySQL for den-api (unchanged from the standard chart install).
- The worker image, built from `packaging/docker/Dockerfile.microsandbox` and pushed to a registry the cluster can pull from:

  ```bash
  ./scripts/build-microsandbox-openwork-image.sh
  # tag + push to your registry, then set config.kubernetes.workerImage
  ```

- Out-of-cluster installs only: `KUBERNETES_API_URL` (+ optional `KUBERNETES_API_TOKEN` / `KUBERNETES_API_CA_FILE`). In-cluster, leave them empty — the ServiceAccount token and CA are used automatically.

## Helm values example

```yaml
config:
  provisioner:
    mode: kubernetes
    # Only needed if workers must be reachable by hostname outside the cluster.
    workerUrlTemplate: ""            # e.g. https://{workerId}.workers.example.com
  kubernetes:
    workerImage: registry.example.com/openwork-microsandbox:0.18.37
    workerNamespace: openwork-workers
    workerStorageClass: ceph-block   # omit for the cluster default
    workerWorkspaceVolumeSize: "10Gi"
    workerDataVolumeSize: "10Gi"

workers:
  kubernetes:
    createNamespace: true
    serviceAccount:
      create: true
    rbac:
      create: true
```

The chart then renders: the `den-api` ServiceAccount, the worker Namespace, and a namespaced Role + RoleBinding. Nothing cluster-scoped is created. The Role is limited to worker-object management (Deployments, Services, Secrets, PVCs) plus pod list/log reads for provisioning diagnostics, and worker pods run with `automountServiceAccountToken: false`.

## RBAC scope

| Resources | Verbs |
| --- | --- |
| `apps/deployments` | get, create, patch, delete |
| `services`, `secrets`, `persistentvolumeclaims` | get, create, delete |
| `pods` | get, list |
| `pods/log` | get |

`pods get` is required because den-api reads the `pods/log` subresource (health-timeout diagnostics) in addition to listing pods by label selector.

All rules apply to the worker namespace only.

## URLs and ingress

- In-cluster (default): den-api reaches workers at `http://<worker-name>.<worker-namespace>.svc.cluster.local:8787`. No ingress, no public exposure.
- Public hostnames: set `config.provisioner.workerUrlTemplate` (e.g. `https://{workerId}.workers.example.com`). The `{workerId}` placeholder receives the hyphenated worker NAME. You own the ingress, TLS, and auth for those hosts; the chart does not render worker ingresses.
- Heartbeats: worker pods call back to den-api (`WORKER_ACTIVITY_BASE_URL`, which follows the internal API URL) for activity heartbeats. Default-deny network policies must therefore allow worker-namespace egress to the den-api Service, plus DNS.

## Lifecycle

- **Provision**: PVCs → token Secret → Deployment → Service, then den-api polls the worker `/health` endpoint until healthy (timeout `KUBERNETES_HEALTHCHECK_TIMEOUT_MS`, default 5m). Health-timeout diagnostics include a redacted pod-log tail.
- **Idle stop**: the idle loop scales the Deployment to 0 after `CLOUD_IDLE_STOP_MINUTES` (default 30) without activity. PVCs and the token Secret survive.
- **Wake**: requesting worker tokens (or the reconciler/resume path) scales the Deployment back to 1. If the recorded image version is older than `KUBERNETES_WORKER_IMAGE`, the container image is patched first, so the workspace and data persist across image upgrades.
- **Deprovision**: deleting the worker removes the Deployment, Service, Secret, and both PVCs. **This is data erasure** — workspace files and opencode state are destroyed with the worker, matching the Daytona deprovision contract.

## Limitations in this release

- The hosted `/v1/cloud/*` browser surface (instance provisioning through the web app) remains Daytona-gated; the Kubernetes provisioner covers worker provisioning via the worker API and desktop flows.
- Migrating an existing Daytona/Render worker to Kubernetes (or back) is unsupported. Workers are tied to their provisioning mode.
- No pod-level autoscaling: one worker per user, scaled between 0 and 1 replicas.
- PVCs use `ReadWriteOnce`; the Deployment uses a Recreate strategy so image updates cannot MultiAttach-stall behind a terminating pod.

## Troubleshooting

- **Worker stuck in `provisioning`**: check `cloud_failure_code`/`cloud_failure_stage` on the worker row and den-api logs (`kubernetes_provisioner` component). Quota or scheduling failures surface through the cloud failure codes; pod log tails appear in health-timeout errors (tokens redacted).
- **`Multi-Attach` volume errors**: an image patch or rolling update raced a pod termination. The Recreate strategy prevents this; if you see it after manual edits, delete the old pod first.
- **Health timeout**: `kubectl get pods -n openwork-workers -l openwork.den.worker-id=<workerId>`; the pod may be ImagePullBackOff (bad `workerImage`), CrashLoopBackOff (check `kubectl logs`), or Pending (insufficient resources or unbound PVC — check the StorageClass).
- **Workers cannot reach den-api**: heartbeats stop, idle-stop may not observe activity. Verify egress from the worker namespace to the den-api Service port and DNS.
