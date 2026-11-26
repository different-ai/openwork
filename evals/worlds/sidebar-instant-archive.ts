import type { AppWeb, Seed } from "@openwork/env";
import { sidebarProofWorkspace } from "./sidebar-proof-workspace.ts";

/** Hold a single real archive write at the browser boundary, before the engine sees it. */
async function archiveGate(app: AppWeb, workspaceId: string, sessionId: string) {
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Archive witness requires the isolated browser's CDP endpoint");
  const socket = new WebSocket(endpoint);
  const path = `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}`;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  let held: string | undefined;
  let nextId = 0;
  let failure: unknown;
  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++nextId;
    const reply = Promise.withResolvers<void>();
    pending.set(id, reply);
    const timer = setTimeout(() => reply.reject(new Error(`Archive witness timed out: ${method}`)), 10_000);
    try {
      socket.send(JSON.stringify({ id, method, params }));
      await reply.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (typeof message.id === "number") {
      if (message.error) pending.get(message.id)?.reject(new Error("Archive witness CDP command failed"));
      else pending.get(message.id)?.resolve();
    }
    if (message.method !== "Fetch.requestPaused") return;
    const { request, requestId } = message.params;
    if (!held && request.method === "PATCH" && new URL(request.url).pathname === path && JSON.parse(request.postData ?? "{}").archived === true) {
      held = requestId;
    } else {
      void send("Fetch.continueRequest", { requestId }).catch(error => { failure = error; });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Archive witness could not connect")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Archive witness connection failed")); }, { once: true });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: `${new URL(app.openworkUrl).origin}${path}*`, requestStage: "Request" }] });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    isHeld() { if (failure) throw failure; return held !== undefined; },
    async reject() {
      if (!held) throw new Error("No archive write intercepted");
      await send("Fetch.fulfillRequest", {
        requestId: held, responseCode: 503,
        responseHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Access-Control-Allow-Origin", value: new URL(app.webUrl).origin },
          { name: "Access-Control-Allow-Credentials", value: "true" },
        ],
        body: Buffer.from(JSON.stringify({ message: "Synthetic archive service unavailable" })).toString("base64"),
      });
      held = undefined;
      await send("Fetch.disable");
    },
    close() { socket.close(); },
  };
}

export async function sidebarInstantArchive(seed: Seed) {
  const { app, workspace } = await sidebarProofWorkspace(seed, "sidebar-instant-archive");
  const archive = await seed.session(app, { title: "Draft the launch checklist" });
  const keep = await seed.session(app, { title: "Plan the team offsite" });
  const gate = await archiveGate(app, workspace.workspaceId, archive.sessionId);
  return { app, archive, keep, gate, async [Symbol.asyncDispose]() { gate.close(); } };
}
