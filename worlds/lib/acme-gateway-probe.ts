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
  const engine = `/workspace/${encodeURIComponent(workspace.id)}/opencode2/api`;
  const runtime = await request("/runtime-config/providers", "GET", undefined, host);
  const provider = record(runtime) && record(runtime.provider) ? runtime.provider[world.model.providerId] : undefined;
  const models = record(provider) && record(provider.models) ? provider.models : {};
  const model = models[world.model.modelId];
  if (!record(model) || model.name !== world.model.modelName) throw new Error("Gateway model title did not materialize in OpenCode.");
  const serialized = JSON.stringify(runtime);
  if (serialized.includes(world.upstream.key)) throw new Error("Upstream credential leaked into runtime configuration.");
  const created = await request(`${engine}/session`, "POST", {
    title: "Acme Gateway verification",
    model: { providerID: world.model.providerId, id: world.model.modelId },
  });
  const session = record(created) && record(created.data) ? created.data : undefined;
  if (typeof session?.id !== "string") throw new Error("Acme probe session missing.");
  const sessionId = session.id;
  const start = world.upstream.requests.length;
  await request(`${engine}/session/${sessionId}/prompt`, "POST", { text: "Verify the Acme AI Gateway." });
  // The engine admits the prompt and then runs it: wait for an assistant reply
  // once the session is no longer listed as active.
  const deadline = Date.now() + 120_000;
  let replies: Record<string, unknown>[] = [];
  for (;;) {
    const active = await request(`${engine}/session/active`);
    if (!(record(active) && record(active.data) && sessionId in active.data)) {
      const page = await request(`${engine}/session/${sessionId}/message?limit=20`);
      const messages = record(page) && Array.isArray(page.data) ? page.data.filter(record) : [];
      replies = messages.filter((message) => (message.role ?? message.type) === "assistant");
      if (replies.length > 0) break;
    }
    if (Date.now() > deadline) throw new Error("Acme probe reply did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (replies.some((message) => message.error)) throw new Error("Acme probe inference returned an error.");
  const texts = replies.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter(record).filter((part) => part.type === "text").map((part) => part.text)
    : [message.text]);
  if (!texts.includes(ACME_REPLY)) throw new Error("Acme probe did not receive the expected reply.");
  const requests = world.upstream.requests.slice(start);
  if (!requests.some((entry) => entry.authenticated && entry.model === ACME_MODEL)) throw new Error("Gateway did not translate the model alias and authenticate upstream.");
  return { sessionId, reply: ACME_REPLY, upstreamRequests: requests.length, modelName: world.model.modelName };
}
