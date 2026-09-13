import assert from "node:assert/strict";
import test from "node:test";

import { startMockKubernetesApiserver } from "../src/mock-kubernetes-apiserver.ts";

const WORKER_ID = "wrk_abcdefghijklmnopqrstuvwxyz";

function workerLabels() {
  return {
    "openwork.den.provider": "kubernetes",
    "openwork.den.worker-id": WORKER_ID,
  };
}

function deploymentManifest() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: WORKER_ID.replace(/_/g, "-"), namespace: "openwork-workers", labels: workerLabels() },
    spec: {
      replicas: 1,
      selector: { matchLabels: workerLabels() },
      template: {
        metadata: { labels: workerLabels() },
        spec: {
          containers: [{ name: "openwork-server", image: "registry.example/worker:test", env: [{ name: "A", value: "b" }] }],
        },
      },
    },
  };
}

test("witness stores manifests, returns 409 on duplicate create, and 404 on missing get", async () => {
  await using witness = await startMockKubernetesApiserver();
  const create = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments`, {
    method: "POST", body: JSON.stringify(deploymentManifest()),
  });
  assert.equal(create.status, 201);
  const duplicate = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments`, {
    method: "POST", body: JSON.stringify(deploymentManifest()),
  });
  assert.equal(duplicate.status, 409);
  const get = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments/${WORKER_ID.replace(/_/g, "-")}`);
  assert.equal(get.status, 200);
  const missing = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments/wrk_missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(witness.deploymentNames(), [WORKER_ID.replace(/_/g, "-")]);
});

test("witness applies strategic merge patches and records them", async () => {
  await using witness = await startMockKubernetesApiserver();
  await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments`, {
    method: "POST", body: JSON.stringify(deploymentManifest()),
  });
  const patch = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments/${WORKER_ID.replace(/_/g, "-")}`, {
    method: "PATCH",
    headers: { "content-type": "application/strategic-merge-patch+json" },
    body: JSON.stringify({ spec: { replicas: 0 } }),
  });
  assert.equal(patch.status, 200);
  assert.equal(witness.replicasOf(WORKER_ID.replace(/_/g, "-")), 0);
  assert.equal(witness.patches.length, 1);
  // Container-level patches merge by container name instead of replacing.
  await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments/${WORKER_ID.replace(/_/g, "-")}`, {
    method: "PATCH",
    headers: { "content-type": "application/strategic-merge-patch+json" },
    body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: "openwork-server", image: "registry.example/worker:new" }] } } } }),
  });
  assert.equal(witness.deploymentImage(WORKER_ID.replace(/_/g, "-")), "registry.example/worker:new");
  assert.equal(witness.containerEnv(WORKER_ID.replace(/_/g, "-"))?.length, 1);
});

test("witness rejects non strategic-merge PATCH content types with 415", async () => {
  await using witness = await startMockKubernetesApiserver();
  await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments`, {
    method: "POST", body: JSON.stringify(deploymentManifest()),
  });
  const wrongType = await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments/${WORKER_ID.replace(/_/g, "-")}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { replicas: 0 } }),
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).reason, "UnsupportedMediaType");
  // The rejected patch must not have been applied.
  assert.equal(witness.replicasOf(WORKER_ID.replace(/_/g, "-")), 1);
  assert.equal(witness.patches.length, 0);
  // The rejected request is still recorded, with its content type.
  const patchRequest = witness.requests.find((request) => request.method === "PATCH");
  assert.equal(patchRequest?.contentType, "application/json");
});

test("witness lists pods by label selector and serves health readiness", async () => {
  await using witness = await startMockKubernetesApiserver();
  await fetch(`${witness.url}/apis/apps/v1/namespaces/openwork-workers/deployments`, {
    method: "POST", body: JSON.stringify(deploymentManifest()),
  });
  witness.setHealthy(false);
  const health = await fetch(`${witness.url}/health`);
  assert.equal(health.status, 503);
  witness.ready();
  assert.equal((await fetch(`${witness.url}/health`)).status, 200);
  const pods = await fetch(`${witness.url}/api/v1/namespaces/openwork-workers/pods?labelSelector=${encodeURIComponent(`openwork.den.worker-id=${WORKER_ID}`)}`);
  assert.equal(pods.status, 200);
  const payload = await pods.json() as { items: Array<{ metadata: { labels: Record<string, string> } }> };
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0]?.metadata.labels["openwork.den.worker-id"], WORKER_ID);
});

test("witness records deletes and flags unexpected routes", async () => {
  await using witness = await startMockKubernetesApiserver();
  await fetch(`${witness.url}/api/v1/namespaces/openwork-workers/secrets`, {
    method: "POST",
    body: JSON.stringify({ metadata: { name: "wrk-tokens", namespace: "openwork-workers" }, stringData: { OPENWORK_TOKEN: "t" } }),
  });
  const del = await fetch(`${witness.url}/api/v1/namespaces/openwork-workers/secrets/wrk-tokens`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const missing = await fetch(`${witness.url}/api/v1/namespaces/openwork-workers/secrets/wrk-tokens`, { method: "DELETE" });
  assert.equal(missing.status, 404);
  assert.deepEqual(witness.names("secrets"), []);
  assert.equal(witness.deletes.length, 1);
  assert.equal(witness.deletes[0]?.kind, "secrets");
  await fetch(`${witness.url}/definitely/not/a/route`);
  assert.equal(witness.unexpected.length, 1);
});
