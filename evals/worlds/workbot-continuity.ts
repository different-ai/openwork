import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shipped Workbot client in headless Chrome. Only the signed-in API/provider is a deterministic fixture. */
export async function workbotContinuity(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const attempts: Record<string, unknown>[] = [];
  const accepted = new Map<string, Record<string, unknown>[]>();
  const requests: number[] = [];
  const historyPages: Array<{ records: number; messages: number }> = [];
  let uploadCount = 0;
  // Holds conversation reads, so a check can look at the page before its first read answers.
  let holdThread = false;
  const releaseThreads: (() => void)[] = [];
  const releaseThread = () => { holdThread = false; for (const resolve of releaseThreads.splice(0)) resolve(); };
  // Holds the app's script, so a check can see what the page does before it arrives.
  let holdScript = false;
  const releaseScripts: (() => void)[] = [];
  const releaseScript = () => { holdScript = false; for (const resolve of releaseScripts.splice(0)) resolve(); };
  // Who each conversation read named, in the order they arrived.
  const threadReads: Array<{ turns: number; chat: string; user: string | null }> = [];
  const turn = (id: string, text: string, index: number) => ({ id, text, sentAt: 1_790_000_000_000 + index * 1000, finishedAt: 1_790_000_000_100 + index * 1000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: `Reply ${index + 1}` }], modelSteps: 1, error: null });
  try {
    const fixtureDir = await mkdtemp(join(tmpdir(), "workbot-continuity-"));
    resources.defer(() => rm(fixtureDir, { recursive: true, force: true }));
    const notesPath = join(fixtureDir, "notes.txt");
    await writeFile(notesPath, "notes");
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-continuity-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/fixture-file-inputs") {
            res.setHeader("content-type", "text/html");
            res.end(`<!doctype html><html><body><h1>File input boundaries</h1>
              <label>Disabled input<input id="disabled-direct" type="file" disabled></label>
              <fieldset disabled><legend>Disabled group</legend><input id="disabled-fieldset" type="file"></fieldset>
              <div hidden><input id="unavailable-parent" type="file"></div>
              <div inert><input id="inert-parent" type="file"></div>
              <input id="hidden-enabled" type="file" hidden><output>No file selected</output>
              <script>document.addEventListener('change', event => { if (event.target instanceof HTMLInputElement && event.target.files?.length) document.querySelector('output').textContent = 'Selected ' + event.target.files[0].name; });</script>
              </body></html>`);
            return;
          }
          if (url.pathname === "/main.tsx" && holdScript) { await new Promise<void>(resolve => releaseScripts.push(resolve)); return next(); }
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const referring = new URL(req.headers.referer ?? "http://fixture");
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          const chat = url.searchParams.get("chat") ?? "main";
          const history = referring.searchParams.get("history") === "long";
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: true, documents: true, documentEditing: true, nativeDictation: referring.searchParams.get("dictation") === "on", workspaceAssistant: referring.searchParams.get("assistant") !== "off", canSchedule: false, sideChats: true, denUrl: "https://workspace.example.test" });
          if (url.pathname === "/v1/workbot") {
            const count = Math.min(200, Number(url.searchParams.get("turns") ?? 30));
            // Recorded when they arrive, so a held read counts as made.
            const user = req.headers["x-openwork-client-user"];
            threadReads.push({ turns: count, chat, user: typeof user === "string" ? user : null });
            if (holdThread) await new Promise<void>(resolve => releaseThreads.push(resolve));
            requests.push(count);
            const prior = Array.from({ length: history ? 230 : 2 }, (_, index) => turn(`message${String(index).padStart(4, "0")}`, index === 0 ? "Use Monday" : `Earlier question ${index + 1}`, index));
            const all = [...prior, ...(accepted.get(chat) ?? [])];
            // The runner's bound counts background records too; only caller messages render as chat rows.
            const page = all.slice(-count);
            const visible = history ? page.filter((_entry, index) => index % 2 === 0) : page;
            if (history) historyPages.push({ records: page.length, messages: visible.length });
            return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: visible, hasEarlier: all.length > count, filesEnabled: true });
          }
          if (url.pathname === "/v1/workbot/chats") return json({ main: { updatedAt: Date.now() }, side: [{ id: "sidechat000000001", title: "Planning", updatedAt: Date.now() }] });
          if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if ((url.pathname === "/v1/workbot/messages" || url.pathname.endsWith("/edit")) && req.method === "POST") {
            let body = ""; for await (const chunk of req) body += chunk;
            const input: unknown = JSON.parse(body);
            if (!isRecord(input)) return json({ error: "invalid_request" }, 400);
            attempts.push({ ...input, chat });
            const correction = url.pathname.endsWith("/edit");
            const id = correction ? input.newId : input.id;
            // Witness a real refusal after upload success / correction send, once per message identity.
            if ((correction || input.text === "Read my notes") && attempts.filter(entry => (correction ? entry.newId : entry.id) === id).length === 1) return json({ error: "too_many_queued" }, 429);
            const entries = accepted.get(chat) ?? [];
            const originalId = url.pathname.split("/").at(-2) ?? "";
            const originalIndex = Number(originalId.replace("message", ""));
            const original = turn(originalId, originalIndex === 0 ? "Use Monday" : `Earlier question ${originalIndex + 1}`, originalIndex);
            const reference = { messageId: `wb_${originalId}`, quote: original.text, sentAt: original.sentAt };
            const text = correction ? `[OpenWork correction reference v1]\n${JSON.stringify(reference)}\n[End OpenWork correction reference]\n\n${input.text}` : String(input.text);
            if (!entries.some(entry => entry.id === id)) entries.push({ ...turn(String(id), text, entries.length + 230), attachments: Array.isArray(input.attachments) ? input.attachments.map(id => ({ id, name: "notes.txt", mediaType: "text/plain", size: 5 })) : [] });
            accepted.set(chat, entries);
            return json({ ok: true }, 202);
          }
          if (url.pathname === "/v1/workbot/files" && req.method === "POST") {
            for await (const _chunk of req) { /* consume the selected file */ }
            uploadCount++;
            // Stay in flight long enough for the person to send before upload completion.
            await new Promise(resolve => setTimeout(resolve, 2000));
            return json({ id: "file_notes", name: "notes.txt", mediaType: "text/plain", size: 5, createdAt: 1, source: "user" }, 201);
          }
          if (url.pathname === "/v1/workbot/files") return json({ enabled: true, files: [] });
          if (url.pathname.endsWith("/drive-files")) return json({ ok: true, files: [{ id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", modifiedTime: "2026-10-12T09:00:00Z", size: "42", webViewLink: "https://drive.google.com/file/d/file_brief/view" }] });
          if (url.pathname.endsWith("/metadata")) return json({ id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", modifiedTime: "2026-10-12T09:00:00Z", size: 42, openUrl: "https://drive.google.com/file/d/file_brief/view" });
          if (url.pathname.endsWith("/editor")) return json({ kind: "text", fileId: "file_brief", connectionId: "google-workspace", name: "Project brief.txt", revision: "v1", canEdit: true, text: "Project overview" });
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    resources.defer(releaseThread);
    resources.defer(releaseScript);
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-continuity", startUrl: `${url}?chat=sidechat000000001`, headless: true }));
    return { web, url, notesPath, attempts: () => [...attempts], uploads: () => uploadCount, windows: () => [...requests], historyPages: () => [...historyPages], holdThread: () => { holdThread = true; }, pendingThreads: () => releaseThreads.length, releaseThread, holdScript: () => { holdScript = true; }, pendingScripts: () => releaseScripts.length, releaseScript, threadReads: () => [...threadReads], async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
