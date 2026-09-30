import type { AcmeWebWorld } from "../acme-web.ts";
import { ACME_MODEL, ACME_REPLY, record } from "./acme-gateway.ts";

/** Real managed OpenCode -> AI Gateway -> deterministic upstream, with no direct provider injection. */
export async function probeAcmeGateway(world: AcmeWebWorld) {
  const { manifest } = world.web;
  const client = { authorization: `Bearer ${manifest.token}`, "content-type": "application/json" };
  const host = { "x-openwork-host-token": manifest.hostToken, "content-type": "application/json" };
  async function request(path: string, method = "GET", body?: unknown, headers = client): Promise<unknown> {
    const response = await fetch(`${manifest.openworkUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Acme probe ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }
  await request("/cloud-provider-sync/run", "POST", {}, host);
  const workspaces = await request("/workspaces");
  const workspace = record(workspaces) && Array.isArray(workspaces.items) ? workspaces.items.find(record) : undefined;
  if (typeof workspace?.id !== "string") throw new Error("Acme probe workspace missing.");
  const engine = `/workspace/${encodeURIComponent(workspace.id)}/opencode`;
  const runtime = await request("/runtime-config/providers", "GET", undefined, host);
  const provider = record(runtime) && record(runtime.provider) ? runtime.provider[world.model.providerId] : undefined;
  const models = record(provider) && record(provider.models) ? provider.models : {};
  const model = models[world.model.modelId];
  if (!record(model) || model.name !== world.model.modelName) throw new Error("Gateway model title did not materialize in OpenCode.");
  const serialized = JSON.stringify(runtime);
  if (serialized.includes(world.upstream.key)) throw new Error("Upstream credential leaked into runtime configuration.");
  const session = await request(`${engine}/session`, "POST", { title: "Acme Gateway verification" });
  if (!record(session) || typeof session.id !== "string") throw new Error("Acme probe session missing.");
  const start = world.upstream.requests.length;
  const result = await request(`${engine}/session/${session.id}/message`, "POST", {
    model: { providerID: world.model.providerId, modelID: world.model.modelId },
    parts: [{ type: "text", text: "Verify the Acme AI Gateway." }],
  });
  const parts = record(result) && Array.isArray(result.parts) ? result.parts.filter(record) : [];
  if (record(result) && record(result.info) && result.info.error) throw new Error("Acme probe inference returned an error.");
  if (!parts.some((part) => part.type === "text" && part.text === ACME_REPLY)) throw new Error("Acme probe did not receive the expected reply.");
  const requests = world.upstream.requests.slice(start);
  if (!requests.some((entry) => entry.authenticated && entry.model === ACME_MODEL)) throw new Error("Gateway did not translate the model alias and authenticate upstream.");
  return { sessionId: session.id, reply: ACME_REPLY, upstreamRequests: requests.length, modelName: world.model.modelName };
}
