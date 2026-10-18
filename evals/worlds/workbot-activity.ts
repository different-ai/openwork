import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { allocateFreePorts } from "@openwork/cdp";
import { buildWorkbotTurns } from "../../ee/packages/workbot-server/src/thread.ts";
import type { RunnerSnapshot } from "../../ee/packages/headless-protocol/src/client.ts";
import { workbotActivityFaultResponses } from "../../ee/apps/workbot/scripts/activity-api-fixture.ts";

/** The shipped Workbot app and transcript adapter, with deterministic runner/file responses and a transport fault. */
export async function workbotActivity(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const boundary = await workbotActivityFaultResponses();
  const reads: Array<{ status: number; payload: unknown }> = [];
  const attachmentText = "Conversation attachment: quarterly figures.";
  const attachment = { id: `fl_${"a".repeat(32)}`, name: "Report notes.txt", mediaType: "text/plain", size: new TextEncoder().encode(attachmentText).byteLength };
  const at = Date.now() - 5000;
  let unavailable = false;
  let revoked = false;
  let transportFailed = false;
  let disabled = false;
  let stopAttempts = 0;
  let taskStopAttempts = 0;
  let sends = 0;
  let progressStage = 0;
  let progressUpdatedAt = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  resources.defer(() => { for (const timer of timers) clearTimeout(timer); });
  const streams = new Set<ServerResponse>();
  const snapshot: RunnerSnapshot = {
    turns: [{ messageId: "wb_example", status: "running", error: null, createdAt: at, updatedAt: at + 3000 }, { messageId: "wb_example.t1", kind: "task", parent: "wb_example", title: "Review charts", status: "running", error: null, createdAt: at, updatedAt: at + 3000 }],
    messages: [
      { role: "user", messageId: "wb_example", text: "Prepare the report", createdAt: at, attachments: [attachment] },
      { role: "assistant", messageId: "wb_example", text: "The report has three sections.", createdAt: at + 100, toolCalls: [
        { id: "skill", name: "execute_capability", input: { name: "skill:slack-calendar-report" } },
        { id: "command", name: "bash", input: { description: "Checking the report" } },
      ] },
      { role: "tool", messageId: "wb_example", name: "bash", callId: "command", isError: true, createdAt: at + 3000 },
    ], finalAssistantText: "", status: "busy",
  };
  const changed = () => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "changed", messageId: "example" })}\n\n`); };
  try {
    const [port] = await allocateFreePorts(1);
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port, strictPort: true },
      plugins: [{ name: "workbot-activity-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: false, documents: false, workspaceAssistant: new URL(req.headers.referer ?? "http://fixture").searchParams.get("workspace") === "on", sideChats: false, denUrl: "https://example.test" });
          if (url.pathname === "/v1/workbot/events") {
            if (unavailable) return json({ error: "unavailable" }, 503);
            res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.write("event: ready\ndata: {}\n\n");
            res.write(`data: ${JSON.stringify({ type: "text", messageId: "example", step: 1, delta: "The figures still need verification.", reset: true })}\n\n`);
            streams.add(res); res.on("close", () => streams.delete(res)); return;
          }
          if (url.pathname === "/v1/workbot") {
            const reply = (payload: unknown, status = 200) => { reads.push({ status, payload }); return json(payload, status); };
            if (revoked) return reply({ error: "forbidden" }, 403);
            if (transportFailed) return reply({ error: "unavailable" }, 503);
            if (unavailable) return reply(boundary.unavailable.payload, boundary.unavailable.status);
            if (disabled) return reply({ available: false, reason: "workbot_not_enabled" });
            const turns = buildWorkbotTurns(snapshot);
            return reply({ available: true, name: "Workbot", organizationName: "Example", status: snapshot.status, turns, hasEarlier: false, filesEnabled: false });
          }
          if (url.pathname === `/v1/workbot/files/${attachment.id}`) { res.setHeader("content-type", "text/plain"); res.end(attachmentText); return; }
          if (url.pathname === "/v1/workbot/stop" && req.method === "POST") {
            stopAttempts += 1;
            if (stopAttempts === 1) return json(boundary.stop.payload, boundary.stop.status);
            if (snapshot.turns[0]) { snapshot.turns[0].status = "aborted"; snapshot.turns[0].updatedAt = Date.now(); }
            snapshot.status = "idle"; changed(); return json({ stopped: true });
          }
          if (url.pathname === "/v1/workbot/tasks/example.t1/stop" && req.method === "POST") {
            taskStopAttempts += 1;
            if (taskStopAttempts === 1) return json(boundary.taskStop.payload, boundary.taskStop.status);
            if (snapshot.turns[1]) { snapshot.turns[1].status = "aborted"; snapshot.turns[1].updatedAt = Date.now(); }
            changed(); return json({ stopped: true });
          }
          if (url.pathname === "/v1/workbot/messages" && req.method === "POST") {
            sends += 1;
            let body = ""; for await (const chunk of req) body += chunk;
            const input: unknown = JSON.parse(body);
            if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string") return json({ error: "invalid_request" }, 400);
            const messageId = `wb_${input.id}`;
            const turn = { messageId, status: "running", error: null, createdAt: Date.now(), updatedAt: Date.now() };
            snapshot.turns.push(turn); snapshot.status = "busy";
            snapshot.messages.push({ role: "user", messageId, text: "Check progress" });
            const command = (index: number) => { progressStage = index * 2 - 1; progressUpdatedAt = Date.now(); snapshot.messages.push({ role: "assistant", messageId, text: "", createdAt: Date.now(), toolCalls: [{ id: `progress-${index}`, name: "bash", input: { description: `Checking section ${index}` } }] }); changed(); };
            const result = (index: number) => { progressStage = index * 2; progressUpdatedAt = Date.now(); snapshot.messages.push({ role: "tool", messageId, name: "bash", callId: `progress-${index}`, isError: index === 3, createdAt: Date.now() }); changed(); };
            command(1);
            for (const [delay, act] of [[500, () => result(1)], [1000, () => command(2)], [1500, () => result(2)], [2000, () => command(3)], [2500, () => result(3)]] satisfies Array<[number, () => void]>) timers.add(setTimeout(act, delay));
            timers.add(setTimeout(() => { turn.status = "completed"; turn.updatedAt = Date.now(); snapshot.status = "idle"; snapshot.messages.push({ role: "assistant", messageId, text: "I couldn't verify every section.", toolCalls: [] }); changed(); }, 3500));
            return json({ accepted: true }, 202);
          }
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(async () => { for (const stream of streams) stream.end(); await vite.close(); });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot proof did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-activity", startUrl: url, headless: true }));
    console.error(`[workbot-activity] web=${url} chromePid=${web.handle.pid ?? "remote"} cdp=${web.handle.cdpUrl}`);
    return {
      web, url,
      stopAttempts: () => stopAttempts, taskStopAttempts: () => taskStopAttempts, sends: () => sends, progressStage: () => progressStage, progressUpdatedAt: () => progressUpdatedAt,
      disconnect() { unavailable = true; for (const stream of streams) stream.end(); streams.clear(); },
      restore() { unavailable = false; transportFailed = false; disabled = false; },
      revokeAccess() { revoked = true; changed(); },
      failAfterRevocation() { revoked = false; transportFailed = true; unavailable = false; disabled = false; changed(); },
      unavailableAfterRevocation() { revoked = false; transportFailed = false; unavailable = true; disabled = false; changed(); },
      disabledAfterRevocation() { revoked = false; transportFailed = false; unavailable = false; disabled = true; changed(); },
      authorize() { revoked = false; transportFailed = false; unavailable = false; disabled = false; },
      reads: () => [...reads], boundary: () => boundary,
      interruptAnswer() { if (snapshot.turns[0]) snapshot.turns[0].status = "interrupted"; snapshot.status = "idle"; changed(); },

      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
