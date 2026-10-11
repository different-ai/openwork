import { createServer as viteServer } from "vite";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { chrome } from "@openwork/hosts";
import { addInitScript, clickAt, emulateFocus, evaluateOnSurface, setViewport, waitForLocated, type Surface } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

type TaskStatus = "queued" | "working" | "paused" | "done" | "failed" | "stopped";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const blockedAttachLabel = "Attach files. Files aren't set up on this server; your admin can turn them on.";

/** Observe the real browser's native-picker events; the regular CDP probe client doesn't expose events. */
async function observeFilePickers(app: Surface, resources: AsyncDisposableStack) {
  if (!app.client.webSocketDebuggerUrl) throw new Error("File-picker evidence needs the browser's CDP event URL");
  const socket = new WebSocket(app.client.webSocketDebuggerUrl);
  resources.defer(() => socket.close());
  let opened = 0;
  let ready = false;
  let failed = false;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native file-picker observer did not become ready")), 8_000);
    const fail = (message: string) => { failed = true; clearTimeout(timeout); reject(new Error(message)); };
    socket.addEventListener("error", () => fail("Native file-picker observer lost its connection"));
    socket.addEventListener("close", () => { if (!ready) fail("Native file-picker observer closed before setup"); });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Page.enable" })));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const payload: unknown = JSON.parse(event.data);
      if (!record(payload)) return;
      if (payload.method === "Page.fileChooserOpened") opened++;
      if (payload.id !== 1 && payload.id !== 2) return;
      if (record(payload.error)) { fail("Chrome refused native file-picker observation"); return; }
      if (payload.id === 1) {
        // Intercepting makes an unexpected native picker observable without hanging headless Chrome on an OS dialog.
        socket.send(JSON.stringify({ id: 2, method: "Page.setInterceptFileChooserDialog", params: { enabled: true } }));
      } else {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return () => ({ ready: ready && !failed && socket.readyState === WebSocket.OPEN, opened });
}

/** Real Workbot client and styles; local API responses isolate thread rendering from Den and model execution. */
export async function workbotThreadWorld(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("Workbot thread UI proof requires local placement.");
  const resources = new AsyncDisposableStack();
  const streams = new Set<ServerResponse>();
  // Match the standalone host's real contracts: /me reports these features, the thread reports filesEnabled,
  // and /files reports { enabled, files }. Files are deliberately unavailable before any browser act.
  const features = { calendar: false, canSchedule: false, sideChats: false, calendarPolish: false };
  const files = { enabled: false, files: [] };
  const writes: Array<{ method: string; path: string }> = [];
  const requests = { threadReads: 0, fileReads: 0, writes };
  let blockedPointerClicks = 0;
  const now = Date.now();
  const task = (id: string, title: string): { id: string; title: string; status: TaskStatus; startedAt: number; finishedAt: number | null; update: string; updates: string[] } => ({ id, title, status: "working", startedAt: now, finishedAt: null, update: "Drafting", updates: ["Drafting"] });
  const tasks = [task("brief", "Launch brief"), task("notes", "Meeting notes")];
  tasks[1].status = "queued";
  tasks[1].updates = ["Queued", "Drafting"];
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
          const method = request.method ?? "GET";
          if (method !== "GET" && method !== "HEAD") requests.writes.push({ method, path });
          response.setHeader("cache-control", "no-store");
          if (path === "/v1/workbot/events") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("event: ready\ndata: {}\n\n");
            streams.add(response);
            response.on("close", () => streams.delete(response));
            return;
          }
          response.setHeader("content-type", "application/json");
          if (path === "/v1/workbot/me") { response.end(JSON.stringify({ name: "Alex", email: "alex@acme.test", organizationName: "Acme", enabled: true, ...features, denUrl: null })); return; }
          if (path === "/v1/workbot" && request.method === "GET") {
            requests.threadReads++;
            response.end(JSON.stringify({ available: true, name: "Workbot", organizationName: "Acme", status: turns.some((turn) => turn.status === "working") ? "busy" : "idle", turns, hasEarlier: false, filesEnabled: files.enabled })); return;
          }
          if (path === "/v1/workbot/files" || path.startsWith("/v1/workbot/files/")) {
            if (method === "GET" && path === "/v1/workbot/files") {
              requests.fileReads++;
              response.end(JSON.stringify(files));
            } else {
              response.writeHead(409).end(JSON.stringify({ error: "files_not_enabled", message: "Files aren't set up on this server." }));
            }
            return;
          }
          if (path === "/v1/workbot/messages" && request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk.toString();
            const input: unknown = JSON.parse(body);
            if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string" || !("text" in input) || typeof input.text !== "string") { response.writeHead(400).end("{}"); return; }
            turns.push({ id: input.id, text: input.text, sentAt: Date.now(), finishedAt: Date.now(), status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: input.text === 'Try the "Meeting notes" background task again.' ? "I'm drafting the meeting notes again." : "Four." }], modelSteps: 1, error: null, tasks: input.text === 'Try the "Meeting notes" background task again.' ? [task(`notes-retry-${turns.length}`, "Meeting notes")] : [] });
            response.writeHead(201).end("{}"); change(); return;
          }
          const stoppedTask = path.match(/^\/v1\/workbot\/tasks\/([^/]+)\/stop$/);
          if (stoppedTask && method === "POST") {
            const item = turns.flatMap((turn) => turn.tasks).find((entry) => entry.id === stoppedTask[1]);
            if (!item) { response.writeHead(404).end("{}"); return; }
            item.status = "stopped";
            item.finishedAt = Date.now();
            response.end("{}"); change(); return;
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
    // Match Linux CI's persistent scrollbar gutter on macOS too: a 320px window has 305px of usable width.
    resources.use(await addInitScript(app.client, () => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "html { overflow-y: scroll; } ::-webkit-scrollbar { width: 15px; height: 15px; }";
        document.head.append(style);
      });
    }));
    // The member's browser remains active even when another local eval activates a native window.
    // This does not focus a control; keyboard navigation and Escape still use trusted input.
    await emulateFocus(app);
    await setViewport(app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    const nativePickers = await observeFilePickers(app, resources);
    return {
      app, url,
      setCalendarPolish: (enabled: boolean) => { features.calendarPolish = enabled; },
      taskWitness: () => turns.flatMap((turn) => turn.tasks.map((task) => ({ id: task.id, status: task.status, request: turn.text }))),
      fileAccessWitness: () => ({ filesEnabled: files.enabled, threadReads: requests.threadReads,
        fileReads: requests.fileReads, fileWrites: requests.writes.filter((request) => request.path.startsWith("/v1/workbot/files")),
        allWrites: [...requests.writes], blockedPointerClicks, nativePickers: nativePickers() }),
      // This read-only projection is needed because probe.dom intentionally omits ARIA attributes and containment.
      // Base UI's Tooltip is visual-only; the trigger's full accessible name carries the reason to screen readers.
      blockedAttachmentState: () => evaluateOnSurface(app, () => {
        const trigger = document.querySelector('button[aria-label="Attach files. Files aren\'t set up on this server; your admin can turn them on."]');
        const tooltip = document.querySelector('[data-workbot-attachment-hint], [role="tooltip"]');
        const accessibleName = trigger?.getAttribute("aria-label") ?? "";
        return {
          blocked: trigger?.getAttribute("aria-disabled") === "true",
          focused: trigger === document.activeElement,
          reasonInAccessibleName: accessibleName.includes("Files aren't set up on this server") && accessibleName.includes("your admin can turn them on"),
          portaled: Boolean(trigger && tooltip && !trigger.closest(".workbot")?.contains(tooltip)),
          nativeFileInputs: document.querySelectorAll('input[type="file"]').length,
        };
      }),
      /** Read-only: prove the narrow layout uses a classic scrollbar, not a macOS overlay. */
      browserLayout: () => evaluateOnSurface(app, () => {
        const pane = document.querySelector(".workbot-scroll");
        const sendButton = document.querySelector('button[aria-label="Send"]');
        const send = sendButton?.getBoundingClientRect();
        const composer = sendButton?.closest("[data-workbot-composer]")?.getBoundingClientRect();
        return {
          clientWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          scrollbarWidth: pane instanceof HTMLElement ? pane.offsetWidth - pane.clientWidth : 0,
          language: navigator.language,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          sendRight: send?.right ?? 0,
          composerRight: composer?.right ?? 0,
          rootScrollbarWidth: innerWidth - document.documentElement.clientWidth,
        };
      }),
      /** Read-only: elements reaching past the page's client width, so a sideways-scroll failure names its cause. */
      overflowingElements: () => evaluateOnSurface(app, () => {
        const limit = document.documentElement.clientWidth + 0.5;
        const found: string[] = [];
        for (const element of Array.from(document.body.querySelectorAll("*"))) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.right <= limit) continue;
          if (Array.from(element.children).some((child) => child.getBoundingClientRect().right > limit)) continue;
          const chain: string[] = [];
          let node: Element | null = element;
          for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            chain.push(`${node.tagName.toLowerCase()}.${(node.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".")} ${Math.round(rect.left)}–${Math.round(rect.right)}px width=${style.width} min=${style.minWidth} flex=${style.flex} display=${style.display}`);
          }
          found.push(chain.join("; "));
        }
        return found.slice(0, 6);
      }),
      async clickBlockedAttachment(inputKind: "mouse" | "touch" = "mouse") {
        // user.click rejects every aria-disabled control. This one intentionally accepts a click only to show why
        // it is blocked. Keep ARIA intact and use trusted CDP input, limited to this exact, hittable reason button.
        if (inputKind === "touch") await app.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        const target = await waitForLocated(app, { role: "button", label: blockedAttachLabel }, { timeoutMs: 3_000, mustHitTest: true });
        if (target.tag !== "button" || target.disabled !== 'aria-disabled="true"') throw new Error("Expected the focusable, blocked attachment reason button");
        if (inputKind === "touch") {
          await app.client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...target.center, id: 0, radiusX: 1, radiusY: 1, force: 1 }] });
          await app.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await clickAt(app, target.center);
        }
        blockedPointerClicks++;
      },
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
