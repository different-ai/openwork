import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? record(JSON.parse(raw)) : {};
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function metadataOf(manifest: Record<string, unknown>) {
  return record(manifest.metadata ?? {});
}

function nameOf(manifest: Record<string, unknown>) {
  return String(metadataOf(manifest).name ?? "");
}

function labelsOf(manifest: Record<string, unknown>) {
  const labels = metadataOf(manifest).labels;
  return isRecord(labels) ? labels : {};
}

/**
 * Kubernetes strategic-merge-patch, reduced to what the worker provisioner
 * sends: plain object deep merge, with `containers` lists merged per container
 * name instead of replaced.
 */
function strategicMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (key === "containers" && Array.isArray(current) && Array.isArray(value)) {
      const byName = new Map(current.map((container) => [String(record(container).name ?? ""), container as Record<string, unknown>]));
      for (const entry of value) {
        const container = record(entry);
        const name = String(container.name ?? "");
        const existing = byName.get(name);
        byName.set(name, existing ? strategicMerge(existing, container) : container);
      }
      merged[key] = [...byName.values()];
      continue;
    }
    if (isRecord(current) && isRecord(value)) {
      merged[key] = strategicMerge(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export type MockKubernetesObjectKind = "deployments" | "services" | "secrets" | "persistentvolumeclaims";

/** HTTP witness faking the Kubernetes API surface the worker provisioner uses. */
export async function startMockKubernetesApiserver() {
  const deployments = new Map<string, Record<string, unknown>>();
  const services = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  const pvcs = new Map<string, Record<string, unknown>>();
  const patches: Array<{ kind: MockKubernetesObjectKind; name: string; patch: Record<string, unknown>; at: number }> = [];
  const deletes: Array<{ kind: MockKubernetesObjectKind; name: string; at: number }> = [];
  const requests: Array<{ method: string; path: string; at: number }> = [];
  const unexpected: string[] = [];
  let healthy = false;
  let url = "";

  const stores: Record<MockKubernetesObjectKind, Map<string, Record<string, unknown>>> = {
    deployments,
    services,
    secrets,
    persistentvolumeclaims: pvcs,
  };

  function workerDeploymentManifests(workerId: string) {
    return [...deployments.values()].filter((manifest) => labelsOf(manifest)["openwork.den.worker-id"] === workerId);
  }

  function deploymentPodItems() {
    return [...deployments.values()].map((manifest, index) => {
      const replicas = record(record(manifest.spec ?? {}).template ?? {});
      const pod = {
        metadata: {
          name: `${nameOf(manifest)}-pod-${index + 1}`,
          namespace: metadataOf(manifest).namespace ?? "",
          labels: labelsOf(manifest),
        },
        status: { phase: healthy ? "Running" : "Pending" },
        spec: replicas,
      };
      return pod;
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({ method, path, at: Date.now() });

    // Worker-pod health probes arrive here through the eval fetch shim (the
    // in-cluster service DNS name is rewritten to the witness base URL).
    if (path === "/health") {
      return json(response, healthy ? 200 : 503, { ready: healthy });
    }

    const deploymentCollection = path.match(/^\/apis\/apps\/v1\/namespaces\/[^/]+\/deployments$/);
    const deploymentItem = path.match(/^\/apis\/apps\/v1\/namespaces\/[^/]+\/deployments\/([^/]+)$/);
    const coreCollection = path.match(/^\/api\/v1\/namespaces\/[^/]+\/(services|secrets|persistentvolumeclaims)$/);
    const coreItem = path.match(/^\/api\/v1\/namespaces\/[^/]+\/(services|secrets|persistentvolumeclaims)\/([^/]+)$/);
    const pods = path.match(/^\/api\/v1\/namespaces\/[^/]+\/pods$/);
    const podLogs = path.match(/^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)\/log$/);

    if (method === "POST" && deploymentCollection) {
      const manifest = await body(request);
      const name = nameOf(manifest);
      if (deployments.has(name)) {
        return json(response, 409, { message: `deployments.apps "${name}" already exists`, reason: "AlreadyExists", code: 409 });
      }
      deployments.set(name, manifest);
      return json(response, 201, manifest);
    }
    if (deploymentItem) {
      const name = decodeURIComponent(deploymentItem[1] ?? "");
      const existing = deployments.get(name);
      if (method === "GET") {
        return existing ? json(response, 200, existing) : json(response, 404, { message: "not found", reason: "NotFound", code: 404 });
      }
      if (method === "PATCH" && existing) {
        const patch = await body(request);
        const merged = strategicMerge(existing, patch);
        deployments.set(name, merged);
        patches.push({ kind: "deployments", name, patch, at: Date.now() });
        return json(response, 200, merged);
      }
      if (method === "DELETE" && existing) {
        deployments.delete(name);
        deletes.push({ kind: "deployments", name, at: Date.now() });
        return json(response, 200, existing);
      }
      if (!existing && method !== "GET") {
        return json(response, 404, { message: "not found", reason: "NotFound", code: 404 });
      }
    }
    if (method === "POST" && coreCollection) {
      const kind = coreCollection[1] as MockKubernetesObjectKind;
      const manifest = await body(request);
      const name = nameOf(manifest);
      const store = stores[kind];
      if (store.has(name)) {
        return json(response, 409, { message: `${kind} "${name}" already exists`, reason: "AlreadyExists", code: 409 });
      }
      store.set(name, manifest);
      return json(response, 201, manifest);
    }
    if (coreItem) {
      const kind = coreItem[1] as MockKubernetesObjectKind;
      const name = decodeURIComponent(coreItem[2] ?? "");
      const store = stores[kind];
      const existing = store.get(name);
      if (method === "GET") {
        return existing ? json(response, 200, existing) : json(response, 404, { message: "not found", reason: "NotFound", code: 404 });
      }
      if (method === "DELETE" && existing) {
        store.delete(name);
        deletes.push({ kind, name, at: Date.now() });
        return json(response, 200, existing);
      }
      if (!existing && method !== "GET") {
        return json(response, 404, { message: "not found", reason: "NotFound", code: 404 });
      }
    }
    if (method === "GET" && pods) {
      const incoming = new URL(request.url ?? "/", "http://localhost");
      const selector = incoming.searchParams.get("labelSelector") ?? "";
      const [key, value] = selector.split("=");
      const items = deploymentPodItems().filter((pod) => key && record(pod.metadata).labels && record(record(pod.metadata).labels)[key] === value);
      return json(response, 200, { items });
    }
    if (method === "GET" && podLogs) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("openwork-server starting\n");
      return;
    }

    unexpected.push(`${method} ${path}`);
    json(response, 404, { message: `Unimplemented Kubernetes witness route: ${method} ${path}` });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      unexpected.push(error instanceof Error ? error.message : String(error));
      json(response, 500, { message: "Kubernetes witness failed" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Kubernetes witness has no listening address");
  url = `http://127.0.0.1:${address.port}`;

  function allOf(kind: MockKubernetesObjectKind) {
    return [...stores[kind].values()];
  }

  function deploymentReplicas(deploymentName: string) {
    const manifest = deployments.get(deploymentName);
    if (!manifest) return null;
    const replicas = record(record(manifest).spec ?? {}).replicas;
    return typeof replicas === "number" ? replicas : null;
  }

  function deploymentContainers(deploymentName: string) {
    const manifest = deployments.get(deploymentName);
    if (!manifest) return null;
    const containers = record(record(record(record(manifest).spec ?? {}).template ?? {}).spec ?? {}).containers;
    return Array.isArray(containers) ? containers as Array<Record<string, unknown>> : null;
  }

  return {
    url,
    requests,
    unexpected,
    patches,
    deletes,
    allOf,
    names: (kind: MockKubernetesObjectKind) => [...stores[kind].keys()],
    count: (kind: MockKubernetesObjectKind) => stores[kind].size,
    deploymentNames: () => [...deployments.keys()],
    deploymentForWorker: (workerId: string) => workerDeploymentManifests(workerId)[0] ?? null,
    secretStringData: (name: string) => {
      const secret = secrets.get(name);
      const stringData = secret ? record(secret).stringData : undefined;
      return isRecord(stringData) ? stringData : null;
    },
    containerEnv: (deploymentName: string) => deploymentContainers(deploymentName)?.[0]?.env as Array<Record<string, unknown>> | undefined ?? null,
    deploymentImage: (deploymentName: string) => deploymentContainers(deploymentName)?.[0]?.image as string | undefined ?? null,
    replicasOf: deploymentReplicas,
    ready() {
      healthy = true;
    },
    setHealthy(value: boolean) {
      healthy = value;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export type MockKubernetesApiserver = Awaited<ReturnType<typeof startMockKubernetesApiserver>>;

/**
 * Node preload script (--require) for eval journeys: den-api probes worker
 * pods at their in-cluster service DNS name, which cannot resolve outside a
 * cluster. When KUBERNETES_HEALTH_WITNESS_URL is set, fetches to any
 * *.svc.cluster.local host are rewritten to the witness so the REAL
 * provisioner health polling runs against the mock control plane.
 */
export const KUBERNETES_HEALTH_SHIM_SCRIPT = String.raw`try {
  const witness = process.env.KUBERNETES_HEALTH_WITNESS_URL;
  if (witness) {
    const original = globalThis.fetch;
    globalThis.fetch = function patchedFetch(input, init) {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url) {
          const parsed = new URL(url);
          if (parsed.hostname.endsWith(".svc.cluster.local")) {
            const rewritten = new URL(parsed.pathname + parsed.search, witness);
            return original(rewritten, init);
          }
        }
      } catch {
      }
      return original(input, init);
    };
  }
} catch {
}
`;
