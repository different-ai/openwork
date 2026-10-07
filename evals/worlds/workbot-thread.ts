import { createServer as viteServer } from "vite";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface, setViewport } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

type TaskStatus = "queued" | "working" | "paused" | "done" | "failed" | "stopped";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real Workbot client and styles; local API responses isolate thread rendering from Den and model execution. */
export async function workbotThreadWorld(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("Workbot thread UI proof requires local placement.");
  const resources = new AsyncDisposableStack();
  const streams = new Set<ServerResponse>();
  const now = Date.now();
  const task = (id: string, title: string): { id: string; title: string; status: TaskStatus; startedAt: number; finishedAt: number | null; update: string; updates: string[] } => ({ id, title, status: "working", startedAt: now, finishedAt: null, update: "Drafting", updates: ["Drafting"] });
  const tasks = [task("brief", "Launch brief"), task("notes", "Meeting notes")];
  tasks[1].status = "queued";
  const turns = [{ id: "request", text: "Draft the brief and meeting notes.", sentAt: now, finishedAt: now, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "On it, drafting both now." }], modelSteps: 1, error: null, tasks }];
  let editAttempts = 0;
  const change = () => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "changed", messageId: "request" })}\n\n`);
  };
  try {
    const appRoot = fileURLToPath(new URL("../../ee/apps/workbot/", import.meta.url));
    const vite = await viteServer({
      configFile: `${appRoot}vite.config.ts`, cacheDir: fileURLToPath(new URL("../results/workbot-thread-vite", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [{ name: "workbot-thread-api-fixture", configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          if (!path.startsWith("/v1/workbot")) { next(); return; }
          response.setHeader("cache-control", "no-store");
          if (path === "/v1/workbot/events") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("event: ready\ndata: {}\n\n");
            streams.add(response);
            response.on("close", () => streams.delete(response));
            return;
          }
          response.setHeader("content-type", "application/json");
          if (path === "/v1/workbot/me") { response.end(JSON.stringify({ name: "Alex", email: "alex@acme.test", organizationName: "Acme", enabled: true, denUrl: null })); return; }
          if (path === "/v1/workbot" && request.method === "GET") {
            response.end(JSON.stringify({ available: true, name: "Workbot", organizationName: "Acme", status: turns.some((turn) => turn.status === "working") ? "busy" : "idle", turns, hasEarlier: false, filesEnabled: false })); return;
          }
          if (path === "/v1/workbot/messages" && request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk.toString();
            const input: unknown = JSON.parse(body);
            if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string" || !("text" in input) || typeof input.text !== "string") { response.writeHead(400).end("{}"); return; }
            turns.push({ id: input.id, text: input.text, sentAt: Date.now(), finishedAt: Date.now(), status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "Four." }], modelSteps: 1, error: null, tasks: [] });
            response.writeHead(201).end("{}"); change(); return;
          }
          // Edits fail, so the spec can see a failed edit come back with its reason.
          if (/^\/v1\/workbot\/messages\/[^/]+\/edit$/.test(path) && request.method === "POST") {
            editAttempts++;
            response.writeHead(503).end("{}"); return;
          }
          response.writeHead(404).end("{}");
        });
      } }],
    });
    resources.defer(async () => { for (const stream of streams) stream.end(); await vite.close(); });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Thread fixture did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    // The spec proves hover-only Edit; a member on a desktop has a mouse even when the runner's headless Chrome finds none.
    const app = resources.use(await chrome({ name: "workbot-thread", host: place.host(), startUrl: "about:blank", headless: true, mouse: true }));
    await setViewport(app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    return {
      app, url,
      respond(id: string, status: TaskStatus) {
        const item = tasks.find((entry) => entry.id === id);
        if (!item) throw new Error("Unknown fixture task");
        item.status = status;
        item.update = status === "done" ? "Ready" : status === "failed" ? "Unavailable" : "Drafting";
        item.finishedAt = ["done", "failed", "stopped"].includes(status) ? Date.now() : null;
        change();
      },
      /** The latest turn starts another model step, with nothing of it written yet. */
      startReply() {
        const turn = turns.at(-1);
        if (!turn) throw new Error("Missing reply turn");
        turn.status = "working";
        change();
      },
      streamReply() {
        const turn = turns.at(-1);
        if (!turn || turn.status !== "working") throw new Error("Start the reply before streaming it");
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "text", messageId: turn.id, step: turn.modelSteps, delta: "I'm still checking.", reset: true })}\n\n`);
      },
      finishReply() {
        const turn = turns.at(-1);
        if (!turn) throw new Error("Missing reply turn");
        turn.status = "done";
        turn.modelSteps++;
        turn.parts = [{ kind: "text", text: "Four. Checked." }];
        change();
      },
      editAttempts: () => editAttempts,
      editHidden: () => evaluateOnSurface(app, () => Array.from(document.querySelectorAll('button[aria-label="Edit message"]')).every((button) => button.parentElement !== null && getComputedStyle(button.parentElement).opacity === "0")),
      /** A phone: touch input (so `hover: none`) at a phone's width. */
      async phone() {
        await app.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await setViewport(app, { width: 390, height: 844, deviceScaleFactor: 1 });
      },
      /** Where each Edit sits relative to its own message bubble. */
      editLayout: () => evaluateOnSurface(app, () => Array.from(document.querySelectorAll('button[aria-label="Edit message"]')).map((button) => {
        const bubble = button.closest(".group\\/own")?.querySelector("p")?.getBoundingClientRect();
        const icon = button.querySelector("svg")?.getBoundingClientRect();
        const target = button.getBoundingClientRect();
        return {
          shown: button.parentElement !== null && getComputedStyle(button.parentElement).opacity === "1",
          underTrailingEdge: Boolean(bubble && icon && icon.top >= bubble.bottom && icon.left >= bubble.left && icon.right <= bubble.right && bubble.right - icon.right < 16),
          tapTarget: Math.min(target.width, target.height),
        };
      })),
      async cardNode(id: string) {
        const document = await app.client.send("DOM.getDocument", {});
        if (!record(document) || !record(document.root) || typeof document.root.nodeId !== "number") throw new Error("Missing document node");
        const result = await app.client.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: `[data-workbot-task="${id}"]` });
        if (!record(result) || typeof result.nodeId !== "number") throw new Error("Missing card node");
        if (result.nodeId === 0) return 0;
        // Frontend node ids can be reissued by getDocument; backend ids identify the actual DOM node.
        const description = await app.client.send("DOM.describeNode", { nodeId: result.nodeId });
        if (!record(description) || !record(description.node) || typeof description.node.backendNodeId !== "number") throw new Error("Missing card identity");
        return description.node.backendNodeId;
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
