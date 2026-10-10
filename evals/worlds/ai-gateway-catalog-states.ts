import type { Place, Seed } from "@openwork/env";
import type { Surface } from "@openwork/cdp";
import { aiGatewayAdmin } from "./ai-gateway-admin.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

type ReadKind = "catalog" | "models";
type ReadMode = "healthy" | "hold" | "fail" | "empty";

/** Fault only public catalog reads after Den has checked the real browser's identity. */
async function catalogTransportFaults(web: Surface, origin: string) {
  if (!web.client.webSocketDebuggerUrl) throw new Error("Catalog faults require browser CDP.");
  const socket = new WebSocket(web.client.webSocketDebuggerUrl);
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const active = new Set<Promise<void>>();
  const held = new Map<string, { kind: ReadKind; release: () => void }>();
  const errors: Error[] = [];
  const modes: Record<ReadKind, ReadMode> = { catalog: "healthy", models: "healthy" };
  const requests: { kind: ReadKind; mode: ReadMode; path: string; originalStatus: number; status: number; completed: boolean }[] = [];
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Catalog transport timeout: ${method}`)); }, 10_000);
    calls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });

  async function intercept(params: Record<string, unknown>) {
    if (typeof params.requestId !== "string") throw new Error("Catalog interception has no request ID.");
    const requestId = params.requestId;
    const request = record(params.request);
    const url = new URL(String(request.url));
    const kind: ReadKind = url.pathname.endsWith("/llm-provider-catalog") ? "catalog" : "models";
    const originalStatus = Number(params.responseStatusCode);
    // Never turn an authorization refusal into a successful empty catalog.
    const mode = originalStatus === 200 && request.method === "GET" ? modes[kind] : "healthy";
    const seen = { kind, mode, path: url.pathname, originalStatus, status: originalStatus, completed: false };
    requests.push(seen);
    if (mode === "hold") {
      await new Promise<void>((resolve) => held.set(requestId, { kind, release: resolve }));
      held.delete(requestId);
    }
    if (mode === "fail" || mode === "empty") {
      let payload: unknown = { error: "catalog_transport_unavailable" };
      if (mode === "empty") {
        if (kind === "catalog") payload = { providers: [] };
        else {
          const response = record(await send("Fetch.getResponseBody", { requestId }));
          if (typeof response.body !== "string") throw new Error("Catalog response body was unavailable.");
          const original = record(JSON.parse(response.base64Encoded === true ? Buffer.from(response.body, "base64").toString() : response.body));
          const provider = record(original.provider);
          if (typeof provider.id !== "string") throw new Error("Catalog response did not contain a provider.");
          payload = { ...original, provider: { ...provider, modelCount: 0, models: [] } };
        }
      }
      seen.status = mode === "fail" ? 503 : 200;
      await send("Fetch.fulfillRequest", {
        requestId, responseCode: seen.status,
        responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }],
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      });
    } else await send("Fetch.continueResponse", { requestId });
    seen.completed = true;
  }

  socket.addEventListener("message", (event) => {
    const message = record(JSON.parse(String(event.data)));
    if (typeof message.id === "number") {
      const call = calls.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        calls.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      }
    }
    if (message.method === "Fetch.requestPaused") {
      const task = intercept(record(message.params)).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // React can cancel a read during navigation or Strict Mode cleanup.
        if (!/Invalid (InterceptionId|interceptionId)|Invalid Fetch request id/i.test(failure.message)) errors.push(failure);
      });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Catalog transport connection timed out.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Catalog transport connection failed.")); }, { once: true });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/api/browser/v1/llm-provider-catalog*`, requestStage: "Response" }] });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    async hold(kind: ReadKind) { modes[kind] = "hold"; },
    async fail(kind: ReadKind) { modes[kind] = "fail"; },
    async empty(kind: ReadKind) { modes[kind] = "empty"; },
    async recover(kind: ReadKind) {
      modes[kind] = "healthy";
      for (const pending of held.values()) if (pending.kind === kind) pending.release();
    },
    async requests() {
      if (errors[0]) throw errors[0];
      return requests.map((request) => ({ ...request }));
    },
    async [Symbol.asyncDispose]() {
      modes.catalog = "healthy";
      modes.models = "healthy";
      for (const pending of held.values()) pending.release();
      await Promise.all(active);
      await send("Fetch.disable", {}).finally(() => socket.close());
    },
  };
}

/** The ordinary owner/member world with read faults, and a real team to grant access to. */
export async function aiGatewayCatalogStates(seed: Seed, context: { place: Place }) {
  const world = await aiGatewayAdmin(seed, context);
  const teammateOrg = record((await seed.api(world.teammate, "/v1/org")).body);
  const teammateId = String(record(teammateOrg.currentMember).id);
  const teamName = "Gateway Reviewers";
  const created = await seed.api(world.den.admin, "/v1/teams", {
    method: "POST", body: JSON.stringify({ name: teamName, memberIds: [teammateId] }),
  });
  if (!created.response.ok) throw new Error(`Gateway team setup failed: HTTP ${created.response.status}`);
  const teamId = String(record(record(created.body).team).id);
  const catalogFaults = await catalogTransportFaults(world.web, new URL(world.den.ref.webUrl).origin);
  // Re-read the organization after arranging its team, before the journey acts.
  await world.web.client.send("Page.navigate", { url: `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers` });
  return { ...world, catalogFaults, teammateId, teamId, teamName, async [Symbol.asyncDispose]() { await catalogFaults[Symbol.asyncDispose](); } };
}
