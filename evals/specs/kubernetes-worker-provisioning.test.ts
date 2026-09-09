import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { KUBERNETES_HEALTH_SHIM_SCRIPT, startMockKubernetesApiserver } from "@openwork/labs";
import { eventually, localMysqlIsRunning, localRedisIsRunning, needs, server, test } from "@openwork/testkit";

const available = await localMysqlIsRunning() && await localRedisIsRunning();

const WORKER_IMAGE = "registry.example/openwork-microsandbox:journey";
const STALE_WORKER_IMAGE = "registry.example/openwork-microsandbox:stale";
const WORKER_URL_TEMPLATE = "https://{workerId}.workers.example.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} missing`);
  return value;
}

function dnsSafeWorkerName(workerId: string) {
  return workerId.replace(/_/g, "-");
}

test("kubernetes provisioner drives real worker provisioning, idle stop, wake, and deprovision", { timeout: 300_000 }, async ({ place, evidence, skip }) => {
  needs({ placement: "local" });
  if (!available) skip("needs: local MySQL and Redis");
  await using witness = await startMockKubernetesApiserver();

  // den-api probes worker pods at their in-cluster service DNS name, which
  // cannot resolve outside a cluster. The preload shim rewrites those fetches
  // to the witness so the REAL provisioner health polling runs unchanged.
  const shimDir = await mkdtemp(join(tmpdir(), "kubernetes-health-shim-"));
  const shimPath = join(shimDir, "kubernetes-health-shim.cjs");
  await writeFile(shimPath, KUBERNETES_HEALTH_SHIM_SCRIPT);

  try {
    await using den = await server({
      place,
      web: false,
      env: {
        PROVISIONER_MODE: "kubernetes",
        KUBERNETES_API_URL: witness.url,
        KUBERNETES_API_TOKEN: "witness-not-a-real-token",
        KUBERNETES_WORKER_IMAGE: WORKER_IMAGE,
        KUBERNETES_WORKER_NAMESPACE: "openwork-workers",
        KUBERNETES_HEALTHCHECK_TIMEOUT_MS: "20000",
        KUBERNETES_POLL_INTERVAL_MS: "100",
        WORKER_URL_TEMPLATE,
        WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
        CLOUD_IDLE_STOP_MINUTES: "1",
        CLOUD_IDLE_LOOP_SECONDS: "1",
        NODE_OPTIONS: `--require ${shimPath}`,
        KUBERNETES_HEALTH_WITNESS_URL: witness.url,
      },
    });
    if (!den.database) throw new Error("This isolated HTTP journey requires its own database");
    const databaseUrl = den.database.url;

    const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
    const organizations = record(orgs.body).orgs;
    if (!Array.isArray(organizations) || organizations.length !== 1) throw new Error("Expected one isolated organization");
    const orgId = expectString(record(organizations[0]).id, "Organization id");
    // Seed the paid entitlement so the cloud-destination gate opens; all access
    // checks and provisioning still run the real API and database.
    await queryDenDatabase(databaseUrl,
      "INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, quantity) VALUES (?, ?, 'web', 'active', ?, ?, ?, 1)",
      ["osub_000000000000000000000000k8", orgId, "cus_kubernetes_witness", "sub_kubernetes_witness", "price_kubernetes_witness"],
    );

    const workers = async () => {
      return queryDenDatabase(databaseUrl, "SELECT id, status, image_version FROM worker WHERE org_id = ?", [orgId]);
    };

    async function workerInstanceUrl(workerId: string) {
      const rows = await queryDenDatabase(databaseUrl, "SELECT url, status FROM worker_instance WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1", [workerId]);
      return rows[0] ?? null;
    }

    const create = await denFetch(den.admin, "/v1/workers", {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Kubernetes witness worker", destination: "cloud" }),
    });
    expect(create.response.status, create.text).toBe(202);
    const workerId = expectString(record(record(create.body).worker).id, "Worker id");
    const workerName = dnsSafeWorkerName(workerId);
    evidence.recordAssertionEvidence("Cloud worker creation is accepted asynchronously", "POST /v1/workers returned 202 with a provisioning worker row; provisioning continues in the background.", true);

    await eventually(() => witness.count("deployments") + witness.count("services") + witness.count("secrets") + witness.count("persistentvolumeclaims"), {
      within: 20_000,
      label: "provisioner creates the worker object set",
      until: (total) => total === 5,
    });
    expect(witness.count("deployments")).toBe(1);
    expect(witness.count("services")).toBe(1);
    expect(witness.count("persistentvolumeclaims")).toBe(2);
    expect(witness.count("secrets")).toBe(1);
    expect(witness.deploymentNames()).toEqual([workerName]);
    const tokenSecret = witness.secretStringData(`${workerName}-tokens`);
    expect(tokenSecret).toMatchObject({ OPENWORK_TOKEN: expect.any(String), OPENWORK_HOST_TOKEN: expect.any(String), DEN_ACTIVITY_HEARTBEAT_TOKEN: expect.any(String) });
    const deployment = witness.deploymentForWorker(workerId);
    if (!deployment) throw new Error("Witness has no deployment for the worker");
    expect(record(deployment.metadata ?? {}).labels).toMatchObject({ "openwork.den.worker-id": workerId });
    const env = witness.containerEnv(workerName) ?? [];
    const tokenEnv = env.filter((entry) => entry.name === "OPENWORK_TOKEN" || entry.name === "OPENWORK_HOST_TOKEN" || entry.name === "DEN_ACTIVITY_HEARTBEAT_TOKEN");
    expect(tokenEnv.length).toBe(3);
    for (const entry of tokenEnv) {
      // Tokens must be referenced from the Secret, never inlined as values.
      expect(entry.value).toBeUndefined();
      expect(JSON.stringify(entry)).toContain("secretKeyRef");
    }
    evidence.recordAssertionEvidence("Provisioning creates exactly one object set with Secret-backed tokens", "The real provisioner created 1 Deployment, 1 Service, 2 PVCs, and 1 Secret; worker tokens live in Secret stringData and are mounted via secretKeyRef; labels carry the worker id.", true);

    witness.ready();
    await eventually(async () => (await workers()).map((entry) => record(entry).status), {
      within: 60_000,
      label: "worker becomes healthy after witness health",
      until: (statuses) => statuses.length === 1 && statuses[0] === "healthy",
    });
    const instance = await workerInstanceUrl(workerId);
    expect(record(instance).status).toBe("healthy");
    expect(record(instance).url).toBe(WORKER_URL_TEMPLATE.replace("{workerId}", workerName));
    expect(record((await workers())[0]).image_version).toBe(WORKER_IMAGE);
    evidence.recordAssertionEvidence("Healthy worker records the template-substituted instance URL", "After the worker pod reported healthy, the worker row became healthy and its instance URL substituted the DNS-safe worker name into WORKER_URL_TEMPLATE.", true);

    // Idle stop scales the deployment to zero but keeps stateful objects.
    await queryDenDatabase(databaseUrl,
      "UPDATE worker SET last_active_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR), last_heartbeat_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR), updated_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ?",
      [workerId],
    );
    await eventually(() => witness.replicasOf(workerName), {
      within: 30_000,
      label: "idle stop scales the worker deployment to zero",
      until: (replicas) => replicas === 0,
    });
    await eventually(async () => (await workers()).map((entry) => record(entry).status), {
      within: 20_000,
      label: "worker row reports stopped",
      until: (statuses) => statuses.length === 1 && statuses[0] === "stopped",
    });
    expect(witness.count("persistentvolumeclaims")).toBe(2);
    expect(witness.count("secrets")).toBe(1);
    evidence.recordAssertionEvidence("Idle stop scales to zero without erasing worker state", "The idle loop patched the deployment to 0 replicas, the worker row became stopped, and the PVCs and token secret survived for the next wake.", true);

    // Refresh activity so the idle loop cannot race the wake below: the aged
    // timestamps only exist to trigger the idle stop above.
    await queryDenDatabase(databaseUrl,
      "UPDATE worker SET last_active_at = NOW(3), last_heartbeat_at = NOW(3), updated_at = NOW(3) WHERE id = ?",
      [workerId],
    );

    // Wake through the tokens path: replicas return to one and health passes.
    const wake = await denFetch(den.admin, `/v1/workers/${workerId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ includeExpiringOpenworkUrl: true }),
    });
    expect(wake.response.status, wake.text).toBe(200);
    await eventually(() => witness.replicasOf(workerName), {
      within: 30_000,
      label: "wake scales the worker deployment back up",
      until: (replicas) => replicas === 1,
    });
    await eventually(async () => (await workers()).map((entry) => record(entry).status), {
      within: 60_000,
      label: "woken worker becomes healthy again",
      until: (statuses) => statuses.length === 1 && statuses[0] === "healthy",
    });
    expect(witness.patches.some((entry) => entry.kind === "deployments" && entry.name === workerName && record(entry.patch.spec ?? {}).replicas === 1)).toBe(true);
    evidence.recordAssertionEvidence("Access tokens wake a stopped worker in place", "Requesting worker tokens with the expiring URL patched the stopped deployment back to 1 replica and the worker became healthy without recreating its objects.", true);

    // Stale-image recycle: a stopped worker on an old image is patched to the
    // configured image before it scales up.
    await queryDenDatabase(databaseUrl,
      "UPDATE worker SET status = 'stopped', image_version = ?, last_active_at = NOW(3), last_heartbeat_at = NOW(3), updated_at = NOW(3) WHERE id = ?",
      [STALE_WORKER_IMAGE, workerId],
    );
    const wakeStale = await denFetch(den.admin, `/v1/workers/${workerId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ includeExpiringOpenworkUrl: true }),
    });
    expect(wakeStale.response.status, wakeStale.text).toBe(200);
    await eventually(() => witness.deploymentImage(workerName), {
      within: 30_000,
      label: "stale-image wake patches the container image",
      until: (image) => image === WORKER_IMAGE,
    });
    await eventually(async () => (await workers()).map((entry) => record(entry).status), {
      within: 60_000,
      label: "stale-image woken worker becomes healthy",
      until: (statuses) => statuses.length === 1 && statuses[0] === "healthy",
    });
    expect(record((await workers())[0]).image_version).toBe(WORKER_IMAGE);
    evidence.recordAssertionEvidence("Stale-image wake updates the image before scale-up", "A stopped worker whose recorded image_version was old was patched to the configured worker image during wake, keeping the database and the running pod in agreement.", true);

    // Deprovision deletes every object the provisioner created.
    const del = await denFetch(den.admin, `/v1/workers/${workerId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${den.admin.token}` },
    });
    expect(del.response.status, del.text).toBe(204);
    await eventually(() => witness.count("deployments") + witness.count("services") + witness.count("secrets") + witness.count("persistentvolumeclaims"), {
      within: 30_000,
      label: "deprovision deletes the whole object set",
      until: (total) => total === 0,
    });
    const deletedKinds = witness.deletes.map((entry) => entry.kind).sort();
    expect(deletedKinds).toEqual(["deployments", "persistentvolumeclaims", "persistentvolumeclaims", "secrets", "services"]);
    evidence.recordAssertionEvidence("Worker deletion erases its Kubernetes objects", "DELETE /v1/workers removed the Deployment, Service, token Secret, and both PVCs, matching the documented data-erasure contract.", true);

    expect(witness.unexpected).toEqual([]);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
});

test("stub mode never calls the Kubernetes API", { timeout: 300_000 }, async ({ place, evidence, skip }) => {
  needs({ placement: "local" });
  if (!available) skip("needs: local MySQL and Redis");
  await using witness = await startMockKubernetesApiserver();
  await using den = await server({
    place,
    web: false,
    env: {
      PROVISIONER_MODE: "stub",
      KUBERNETES_API_URL: witness.url,
      KUBERNETES_API_TOKEN: "witness-not-a-real-token",
      KUBERNETES_WORKER_IMAGE: WORKER_IMAGE,
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
    },
  });
  if (!den.database) throw new Error("This isolated HTTP journey requires its own database");
  const databaseUrl = den.database.url;
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const organizations = record(orgs.body).orgs;
  if (!Array.isArray(organizations) || organizations.length !== 1) throw new Error("Expected one isolated organization");
  const orgId = expectString(record(organizations[0]).id, "Organization id");
  await queryDenDatabase(databaseUrl,
    "INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, quantity) VALUES (?, ?, 'web', 'active', ?, ?, ?, 1)",
    ["osub_000000000000000000000000st", orgId, "cus_stub_witness", "sub_stub_witness", "price_stub_witness"],
  );
  const create = await denFetch(den.admin, "/v1/workers", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Stub worker", destination: "cloud" }),
  });
  expect(create.response.status, create.text).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(witness.requests).toEqual([]);
  expect(witness.unexpected).toEqual([]);
  evidence.recordAssertionEvidence("Stub mode leaves the Kubernetes API untouched", "A cloud worker created under PROVISIONER_MODE=stub produced zero requests against the Kubernetes witness.", true);
});
