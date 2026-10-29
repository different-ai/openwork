import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/**
 * The real Workbot page (Vite, the same client people load) with synthetic Workbot API answers: a member with side
 * chats and one conversation that started two background tasks. The command palette is available by default,
 * including when older API responses omit the compatibility field. Den and the runner are not involved.
 */
export async function workbotCommandPalette(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const stopped: string[] = [];
  const chatReads: string[] = [];
  let holdChats = false;
  const releaseChats: (() => void)[] = [];
  const release = () => { holdChats = false; for (const resolve of releaseChats.splice(0)) resolve(); };
  const now = Date.now();
  const tasks = [
    { id: "task_research", title: "Research venue options", status: "working", startedAt: now - 4 * 60_000, finishedAt: null, update: "Comparing three venues", updates: ["Comparing three venues"] },
    { id: "task_summary", title: "Summarize last quarter's notes", status: "done", startedAt: now - 3 * 3_600_000, finishedAt: now - 3 * 3_500_000, update: null, updates: [] },
  ];
  const turn = (id: string, text: string, answer: string, at: number, extra: Record<string, unknown> = {}) => ({ id, text, sentAt: at, finishedAt: at + 2_000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: answer }], modelSteps: 1, error: null, ...extra });
  const turns = [
    turn("turn_one", "What should I prepare for the offsite?", "A venue shortlist and an agenda. I started both in the background.", now - 3 * 3_600_000, { tasks }),
    turn("turn_two", "Thanks, keep going", "On it. The venue research is still running.", now - 5 * 60_000),
  ];
  const sideChats = [
    { id: "sidechatbudget00001", title: "Budget review", createdAt: now - 86_400_000, updatedAt: now - 2 * 3_600_000 },
    { id: "sidechatlaunch00001", title: "Launch plan", createdAt: now - 2 * 86_400_000, updatedAt: now - 26 * 3_600_000 },
    { id: "sidechattravel00001", title: "Travel notes", createdAt: now - 5 * 86_400_000, updatedAt: now - 4 * 86_400_000 },
  ];
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-command-palette-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") {
            return json({ name: "Alex Example", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: true, canSchedule: false, sideChats: true, denUrl: "https://workspace.example.test" });
          }
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: url.searchParams.has("chat") ? [] : turns, hasEarlier: false, filesEnabled: false });
          if (url.pathname === "/v1/workbot/chats") {
            chatReads.push(url.pathname);
            if (holdChats) await new Promise<void>((resolve) => releaseChats.push(resolve));
            return json({ main: { updatedAt: now - 5 * 60_000 }, side: sideChats });
          }
          const stop = /^\/v1\/workbot\/tasks\/([^/]+)\/stop$/.exec(url.pathname);
          if (stop && req.method === "POST") { stopped.push(decodeURIComponent(stop[1] ?? "")); return json({ ok: true }); }
          if (url.pathname === "/v1/workbot/connections") return json({ connections: [] });
          if (url.pathname === "/v1/workbot/events") { res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (url.pathname.endsWith("/calendar/v1/automations")) return json({ items: [], nextCursor: null });
          if (url.pathname.endsWith("/calendar/v1/automation-runs")) return json({ runs: [], nextCursor: null });
          if (url.pathname.includes("/calendar-events")) return json({ error: "needs_connection" }, 409);
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    resources.defer(release);
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-command-palette", startUrl: url, headless: true }));
    return {
      web,
      url,
      stopped: () => [...stopped],
      chatReads: () => chatReads.length,
      holdChats: () => { holdChats = true; },
      releaseChats: release,
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
