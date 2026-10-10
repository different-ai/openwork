import { createServer as viteServer } from "vite";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface, setViewport } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

type Step = { label: string; icon: "app"; status: "running" | "done"; app: string; startedAt: number; finishedAt: number | null; updates: string[] };
/** What the Workbot server sends: one text part per model call (`step`), steps between them. */
export type ReplyPart = { kind: "text"; text: string; step: number } | { kind: "steps"; steps: Step[] };
type Turn = { id: string; text: string; sentAt: number; finishedAt: number | null; status: "working" | "done" | "stopped"; attachments: never[]; outputs: never[]; parts: ReplyPart[]; modelSteps: number; error: null; tasks: never[] };
export type Movement = { down: number; downPx: number; merged: number; bubbles: number };

/** An app step as the page shows it: "Using Gmail" while it runs, "Used Gmail" once done. */
export function gmailStep(status: "running" | "done"): ReplyPart {
  const at = Date.now();
  return { kind: "steps", steps: [{ label: "Searching Gmail", icon: "app", status, app: "Gmail", startedAt: at, finishedAt: status === "done" ? at : null, updates: [] }] };
}

/**
 * Real Workbot client and styles, with Workbot's reply played one model call at a time from the fixture (streamed words,
 * then the stored copy), so a spec can watch how the conversation moves while Workbot answers.
 */
export async function workbotReplyWorld(_seed: Seed, { place }: { place: Place }, options: { natural?: boolean; welcome?: boolean } = {}) {
  if (place.kind !== "local") throw new Error("Workbot reply UI proof requires local placement.");
  const resources = new AsyncDisposableStack();
  const streams = new Set<ServerResponse>();
  const now = Date.now();
  const turns: Turn[] = [{ id: "earlier", text: "What's on today?", sentAt: now - 60_000, finishedAt: now - 55_000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "A design review at 3:30, then nothing after 5.", step: 0 }], modelSteps: 1, error: null, tasks: [] }];
  if (options.welcome) turns.length = 0;
  const send = (event: Record<string, unknown>) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  /** Words streamed for the reply's current model call and not stored yet: what an interrupted answer keeps. */
  let unstored: { step: number; text: string } | null = null;
  const reply = () => {
    const turn = turns.at(-1);
    if (!turn || turn.status !== "working") throw new Error("No reply in progress");
    return turn;
  };
  try {
    const appRoot = fileURLToPath(new URL("../../ee/apps/workbot/", import.meta.url));
    const vite = await viteServer({
      configFile: `${appRoot}vite.config.ts`, cacheDir: fileURLToPath(new URL("../results/workbot-reply-vite", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [{ name: "workbot-reply-api-fixture", configureServer(server) {
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
          if (path === "/v1/workbot/connections") {
            response.end(JSON.stringify({ connections: [
              { id: "slack", name: "Slack", app: "slack", ready: true, connectUrl: null },
              { id: "gmail", name: "Gmail", app: "gmail", ready: true, connectUrl: null },
              { id: "calendar", name: "Google Calendar", app: "googleCalendar", ready: true, connectUrl: null },
            ] })); return;
          }
          if (path === "/v1/workbot/hello") { response.end(JSON.stringify({ started: false })); return; }
          if (path === "/v1/workbot" && request.method === "GET") {
            response.end(JSON.stringify({ available: true, name: "Workbot", organizationName: "Acme", status: turns.some((turn) => turn.status === "working") ? "busy" : "idle", turns, hasEarlier: false, filesEnabled: false })); return;
          }
          if (path === "/v1/workbot/messages" && request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk.toString();
            const input: unknown = JSON.parse(body);
            if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string" || !("text" in input) || typeof input.text !== "string") { response.writeHead(400).end("{}"); return; }
            // Natural replies: as the runner does, the answer in progress wraps up for the follow-up, keeping what it wrote.
            const answering = turns.at(-1);
            if (options.natural && answering?.status === "working") {
              if (unstored?.text) {
                answering.parts = [...answering.parts, { kind: "text", text: unstored.text, step: unstored.step }];
                answering.modelSteps = unstored.step + 1;
              }
              answering.status = "stopped";
              answering.finishedAt = Date.now();
              unstored = null;
            }
            // The reply starts and stays in progress: the spec plays it one model call at a time.
            turns.push({ id: input.id, text: input.text, sentAt: Date.now(), finishedAt: null, status: "working", attachments: [], outputs: [], parts: [], modelSteps: 0, error: null, tasks: [] });
            response.writeHead(202).end("{}");
            send({ type: "changed", messageId: input.id });
            return;
          }
          response.writeHead(404).end("{}");
        });
      } }],
    });
    resources.defer(async () => { for (const stream of streams) stream.end(); await vite.close(); });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Reply fixture did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    const app = resources.use(await chrome({ name: "workbot-reply", host: place.host(), startUrl: "about:blank", headless: true }));
    await setViewport(app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    return {
      app, url,
      /** Workbot writes one model call's words, a few characters at a time, the way a provider streams them. */
      async write(step: number, text: string) {
        const turn = reply();
        unstored = { step, text: "" };
        for (let at = 0; at < text.length; at += 6) {
          unstored.text += text.slice(at, at + 6);
          send({ type: "text", messageId: turn.id, step, delta: text.slice(at, at + 6) });
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      },
      /** The runner stores the reply so far, shaped as the Workbot server sends it; `done` ends the reply. */
      store(parts: ReplyPart[], modelSteps: number, done = false) {
        const turn = reply();
        unstored = null;
        turn.parts = parts;
        turn.modelSteps = modelSteps;
        if (done) {
          turn.status = "done";
          turn.finishedAt = Date.now();
        }
        send({ type: "changed", messageId: turn.id });
      },
      /**
       * Watches the conversation every frame. It sticks to the bottom, so words growing below push it up; moving down
       * means something below shrank or went away. Also counts Workbot's bubbles going down (two becoming one).
       */
      watchMovement: () => evaluateOnSurface(app, () => {
        const state: { down: number; downPx: number; merged: number; bubbles: number; last: number | null; anchor: Element | null } = { down: 0, downPx: 0, merged: 0, bubbles: -1, last: null, anchor: null };
        Reflect.set(window, "__workbotMovement", state);
        const frame = () => {
          const top = document.querySelector(".workbot-scroll > div > div > :first-child");
          if (top) {
            const y = top.getBoundingClientRect().top;
            if (top === state.anchor && state.last !== null && y > state.last + 1) {
              state.down += 1;
              state.downPx += y - state.last;
            }
            state.anchor = top;
            state.last = y;
          }
          const bubbles = document.querySelectorAll("ol[aria-label='Conversation'] div.overflow-x-auto.rounded-bl-md").length;
          if (state.bubbles >= 0 && bubbles < state.bubbles) state.merged += state.bubbles - bubbles;
          state.bubbles = bubbles;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        return true;
      }),
      movement: () => evaluateOnSurface(app, (): Movement | null => {
        const state: unknown = Reflect.get(window, "__workbotMovement");
        if (typeof state !== "object" || state === null) return null;
        const read = (key: string) => {
          const value: unknown = Reflect.get(state, key);
          return typeof value === "number" ? value : 0;
        };
        return { down: read("down"), downPx: Math.round(read("downPx")), merged: read("merged"), bubbles: read("bubbles") };
      }),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}

/** The same, with natural replies on: a message sent while Workbot answers interrupts that answer. */
export function workbotNaturalReplyWorld(seed: Seed, context: { place: Place }) {
  return workbotReplyWorld(seed, context, { natural: true });
}

/** A first visit with all three everyday demo apps connected. */
export function workbotWelcomeWorld(seed: Seed, context: { place: Place }) {
  return workbotReplyWorld(seed, context, { natural: true, welcome: true });
}
