import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

type Session = { id: string; fileId: string; expiresAt: string; recoveryExpiresAt: string; saveRequestId?: string; uncertain: boolean };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Real Workbot and Office client; synthetic Drive and postMessage peer. This
 * proves tab/resource identity and recovery controls, not Collabora fidelity. */
export async function officeLifecycle(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const sessions = new Map<string, Session>();
  const launches: string[] = [];
  const saves: string[] = [];
  const messages: Record<string, unknown>[] = [];
  let copied = false;
  const files = [
    { id: "original", name: "Planning", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "uncertain", name: "Unconfirmed workbook", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "expiring", name: "Expiring workbook", mimeType: "application/vnd.google-apps.spreadsheet" },
  ];
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "office-lifecycle-provider-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
          if (url.pathname.startsWith("/office-frame/")) {
            const id = url.pathname.split("/").pop();
            if (id) launches.push(id);
            res.setHeader("content-type", "text/html");
            return void res.end(`<!doctype html><html><body><p>Office protocol fixture — not a document engine</p><script>
              const send = (MessageId, Values) => parent.postMessage(JSON.stringify({MessageId, Values}), location.origin);
              send('App_LoadingStatus', {Status:'Document_Loaded'});
              addEventListener('message', async event => {
                if (event.source !== parent || event.origin !== location.origin) return;
                const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                if (message.MessageId === 'Action_Save') {
                  await fetch('/office-snapshot/${id}', {method:'POST', body:JSON.stringify({saveRequestId:message.Values.ExtendedData})});
                  send('Action_Save_Resp', {success:true});
                }
              });
            </script></body></html>`);
          }
          if (url.pathname.startsWith("/office-snapshot/")) {
            let body = ""; for await (const chunk of req) body += chunk;
            const id = url.pathname.split("/").pop(); const session = id ? sessions.get(id) : undefined;
            const parsed: unknown = JSON.parse(body);
            if (session && typeof parsed === "object" && parsed && "saveRequestId" in parsed && typeof parsed.saveRequestId === "string") session.saveRequestId = parsed.saveRequestId;
            return json({ ok: true });
          }
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, documents: true, workspaceAssistant: true, canSchedule: false, sideChats: false, denUrl: "https://workspace.example.test" });
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: [], hasEarlier: false, filesEnabled: false });
          if (url.pathname === "/v1/workbot/chats") return json({ main: null, side: [] });
          if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); return void res.end(": fixture\n\n"); }
          if (url.pathname === "/v1/workbot/messages") {
            let body = ""; for await (const chunk of req) body += chunk;
            const parsed: unknown = JSON.parse(body);
            if (isRecord(parsed)) messages.push(parsed);
            return json({ ok: true }, 202);
          }
          if (url.pathname.endsWith("/drive-files")) return json({ ok: true, files: [...files, ...(copied ? [{ id: "saved_copy", name: "Planning.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }] : [])].map(file => ({ ...file, modifiedTime: "2026-10-18T12:00:00Z", webViewLink: `https://drive.google.com/file/d/${file.id}/view`, size: "256" })) });
          const route = /\/files\/([^/]+)\/office(?:\/([^/]+)(?:\/(save|close|download))?)?$/.exec(url.pathname);
          if (!route) return json({ error: "not_found" }, 404);
          const fileId = route[1]!; const id = route[2];
          if (!id) {
            const expiresAt = new Date(Date.now() + (fileId === "expiring" ? 3000 : 3_600_000)).toISOString();
            const session: Session = { id: randomUUID(), fileId, expiresAt, recoveryExpiresAt: new Date(Date.parse(expiresAt) + 900_000).toISOString(), uncertain: false };
            sessions.set(session.id, session);
            return json({ ...session, serverUrl: url.origin, editorUrl: `${url.origin}/office-frame/${session.id}`, accessToken: "fixture_capability", canEdit: fileId !== "expiring", saveAsCopy: true, fileType: "xlsx" });
          }
          const session = sessions.get(id);
          if (!session || session.fileId !== fileId) return json({ error: "not_found" }, 409);
          if (route[3] === "save") {
            saves.push(fileId);
            if (fileId === "uncertain") { session.uncertain = true; return json({ error: "google_api_error", message: "Google did not confirm the operation." }, 502); }
            copied = true; return json({ fileId: "saved_copy" });
          }
          if (route[3] === "close") { sessions.delete(id); return json({ ok: true }); }
          if (route[3] === "download") { res.setHeader("content-type", "application/octet-stream"); res.setHeader("content-disposition", "attachment; filename=snapshot.xlsx"); return void res.end("last received fixture snapshot"); }
          return json({ ...session, draftVersion: 1 });
        });
      } }],
    });
    resources.defer(() => vite.close()); await vite.listen();
    const url = vite.resolvedUrls?.local[0]; if (!url) throw new Error("Office fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "office-lifecycle", startUrl: `${url}documents`, headless: true }));
    return { web, url, saves: () => [...saves], messages: () => [...messages], sessions: () => [...sessions.values()], launchedSessions: () => [...new Set(launches)].flatMap(id => { const session = sessions.get(id); return session ? [session] : []; }), async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
