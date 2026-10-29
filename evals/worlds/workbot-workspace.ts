import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real Workbot client and Documents components; only Den/provider responses are
 * synthetic. The Office peer proves owner/session lifecycle, NOT engine fidelity
 * or survival of changes buffered inside Collabora. Snapshot bytes are proved
 * separately against real Den/Redis in the Office API test. */
export async function workbotWorkspace(seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const messages: Record<string, unknown>[] = [];
  const opened: string[] = [];
  const editorReads: string[] = [];
  const editorConnections: (string | null)[] = [];
  const documentWrites: string[] = [];
  const contentReads: string[] = [];
  let holdContent = false;
  let holdMetadata = false;
  const releaseMetadatas: (() => void)[] = [];
  const releaseMetadata = () => { holdMetadata = false; for (const release of releaseMetadatas.splice(0)) release(); };
  const releaseContents: (() => void)[] = [];
  const releaseContent = () => { holdContent = false; for (const release of releaseContents.splice(0)) release(); };
  const identityReads: number[] = [];
  const identityScopes: { principalId: string; organizationId: string; status: number }[] = [];
  const listingReads: { view: string; folder: string; status: number }[] = [];
  const officeOpens: string[] = [];
  const officeRequests: string[] = [];
  const officeCloses: string[] = [];
  const officeLaunches: string[] = [];
  const officeSessions = new Map<string, { expiresAt: string; recoveryExpiresAt: string }>();
  let driveDenied = false;
  let sessionExpired = false;
  let principalId = "user_example";
  let organizationId = "org_example";
  let identityStatus = 200;
  let holdIdentity = false;
  let pendingIdentities = 0;
  const releaseIdentities: (() => void)[] = [];
  let listingFailure = false;
  let recentStatus = 200;
  let folderStatus = 200;
  let holdFolder = false;
  let pendingFolders = 0;
  const releaseFolders: (() => void)[] = [];
  let fileDenied = false;
  const deniedFiles = new Set<string>();
  let officeError: number | null = 503;
  let documentsOff = false;
  let editingOff = false;
  let officeStarting = false;
  const files = [
    { id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", modifiedTime: "2026-10-12T09:00:00Z", size: "42", webViewLink: "https://drive.google.com/file/d/file_brief/view" },
    { id: "file_budget", name: "Budget notes.txt", mimeType: "text/plain", modifiedTime: "2026-10-11T09:00:00Z", size: "36", webViewLink: "https://drive.google.com/file/d/file_budget/view" },
    { id: "file_sheet", name: "Trigger phrases", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-11T09:00:00Z", size: null, webViewLink: "https://docs.google.com/spreadsheets/d/file_sheet/edit" },
    { id: "file_office", name: "Analysis.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", modifiedTime: "2026-10-11T09:00:00Z", size: "256", webViewLink: "https://drive.google.com/file/d/file_office/view" },
  ];
  const previewFiles = [
    { id: "file_docx", name: "Project plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { id: "file_doc", name: "Project plan", mimeType: "application/vnd.google-apps.document" },
    { id: "file_pdf", name: "Project plan.pdf", mimeType: "application/pdf" },
    { id: "file_slides", name: "Project slides", mimeType: "application/vnd.google-apps.presentation" },
    { id: "file_image", name: "Project image.png", mimeType: "image/png" },
  ].map(file => ({ ...file, modifiedTime: "2026-10-11T09:00:00Z", size: "256", webViewLink: `https://drive.google.com/file/d/${file.id}/view` }));
  const folder = { id: "folder_private", name: "Team folder", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-11T09:00:00Z", size: null, webViewLink: "https://drive.google.com/drive/folders/folder_private" };
  const secret = { ...files[0]!, id: "file_secret", name: "Folder secret.txt" };
  const conversations = new Map<string, Record<string, unknown>[]>();
  const threadRequests: { actor: string; expectedUser: string | null }[] = [];
  let holdOtherThread = false;
  let pendingOtherThreads = 0;
  const releaseOtherThreads: (() => void)[] = [];
  const thread = (actor: string) => { const value = conversations.get(actor) ?? []; conversations.set(actor, value); return value; };
  thread("user_other").push({ id: "other_account_turn", text: "Other account question", sentAt: Date.now(), finishedAt: Date.now(), status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "Other account answer" }], modelSteps: 1, error: null });
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-workspace-provider-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (url.pathname === "/auth/login") { res.setHeader("content-type", "text/html"); return void res.end("<!doctype html><html><body>Workspace sign-in fixture</body></html>"); }
          if (url.pathname.startsWith("/office-fixture/")) {
            const id = url.pathname.split("/").pop() ?? "";
            officeLaunches.push(id);
            res.setHeader("content-type", "text/html");
            return void res.end(`<!doctype html><html><body>Received-snapshot protocol fixture, not a document engine<script>parent.postMessage(JSON.stringify({MessageId:'App_LoadingStatus',Values:{Status:'Document_Loaded'}}),location.origin)</script></body></html>`);
          }
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const referring = new URL(req.headers.referer ?? "http://fixture");
          const enabled = referring.searchParams.get("assistant") !== "off";
          const documentEditing = !editingOff && referring.searchParams.get("editing") !== "off";
          const documents = !documentsOff && referring.searchParams.get("documents") !== "off";
          const denied = driveDenied || referring.searchParams.get("access") === "denied";
          const json = (body: unknown, status = 200) => { if (res.destroyed) return; res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") {
            if (holdIdentity) { pendingIdentities++; await new Promise<void>(resolve => releaseIdentities.push(resolve)); pendingIdentities--; }
            identityReads.push(identityStatus);
            identityScopes.push({ principalId, organizationId, status: identityStatus });
            if (identityStatus !== 200) return json({ error: identityStatus === 401 ? "unauthorized" : "identity_unavailable" }, identityStatus);
            return json({ name: "Alex", email: "alex@example.test", userId: principalId, organizationId, organizationName: "Example", enabled: true, calendar: true, documents, documentEditing, computer: referring.searchParams.get("computer") === "on", workspaceAssistant: enabled, guidedNavigation: referring.searchParams.get("guided") === "on", canSchedule: false, sideChats: referring.searchParams.get("sideChats") === "on", denUrl: "https://workspace.example.test" });
          }
          const expectedUser = req.headers["x-openwork-client-user"];
          const expectedOrganization = req.headers["x-openwork-client-organization"];
          if ((expectedUser !== undefined || expectedOrganization !== undefined) && (expectedUser !== principalId || expectedOrganization !== organizationId)) return json({ error: "identity_changed" }, 401);
          const actor = principalId;
          if (url.pathname === "/v1/workbot") {
            threadRequests.push({ actor, expectedUser: typeof expectedUser === "string" ? expectedUser : null });
            if (actor === "user_other" && holdOtherThread) { pendingOtherThreads++; await new Promise<void>(resolve => releaseOtherThreads.push(resolve)); pendingOtherThreads--; }
            return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: thread(actor), hasEarlier: false, filesEnabled: false });
          }
          if (url.pathname === "/v1/workbot/connections") return json({ connections: [{ id: "google-workspace", name: "Google Workspace", app: "gmail", nativeProviderKey: "google-workspace", ready: !denied, connectMode: "external", connectUrl: "https://workspace.example.test/dashboard/your-connections?connectionId=google-workspace" }] });
          if (url.pathname === "/v1/workbot/chats") return json({ main: null, side: [{ id: "sidechat000000001", title: "Document questions", createdAt: Date.now(), updatedAt: Date.now() }] });
          if (url.pathname === "/v1/workbot/events") { res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (url.pathname === "/v1/workbot/messages" && req.method === "POST") {
            let body = ""; for await (const chunk of req) body += chunk;
            const input: unknown = JSON.parse(body);
            if (!isRecord(input)) return json({ error: "invalid_request" }, 400);
            messages.push(input);
            const now = Date.now();
            // "Open the … for me" is answered with an accepted open_document request, as the runner records it.
            const targets: Record<string, string> = { "project brief": "file_brief", "trigger phrases": "file_sheet", "restricted document": "file_private" };
            const requested = typeof input.text === "string" ? targets[/^Open the (.+) for me$/.exec(input.text)?.[1] ?? ""] : undefined;
            if (requested) {
              thread(actor).push({ ...input, navigation: [{ id: `open_${String(input.id)}`, fileId: requested }], sentAt: now, finishedAt: now, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "Opening it beside our chat." }], modelSteps: 1, error: null });
              return json({ ok: true }, 202);
            }
            // A question about the computer gets a reply that used it; everything else links documents.
            const parts = typeof input.text === "string" && /computer/i.test(input.text)
              ? [{ kind: "steps", steps: [{ label: "Checked the budget site", icon: "computer", status: "done", app: null, startedAt: now, finishedAt: now, updates: [] }] }, { kind: "text", text: "I checked the budget site on my computer." }]
              : [{ kind: "text", text: "I can read the saved version. [Budget notes](https://drive.google.com/file/d/file_budget/view) · [Restricted document](https://docs.google.com/document/d/file_private/edit)" }];
            thread(actor).push({ ...input, sentAt: now, finishedAt: now, status: "done", attachments: [], outputs: [], parts, modelSteps: 1, error: null });
            return json({ ok: true }, 202);
          }
          if (url.pathname.startsWith("/v1/workbot/documents")) {
            const write = /\/files\/([^/]+)\/editor$/.exec(url.pathname);
            if (req.method === "POST" && write) documentWrites.push(write[1]!);
            if (/\/files\/[^/]+\/office(?:\/|$)/.test(url.pathname)) officeRequests.push(url.pathname);
            const office = /\/files\/file_office\/office(?:\/([^/]+)(?:\/(close|save))?)?$/.exec(url.pathname);
            if (office?.[2] === "close") officeCloses.push(office[1]!);
            if (!documents) return json({ error: "workbot_documents_not_enabled" }, 403);
            if (sessionExpired) return json({ error: "unauthorized" }, 401);
            if (denied) return json({ error: "needs_connection" }, 409);
            if (url.pathname.endsWith("/drive-files")) {
              const recent = url.searchParams.get("filesOnly") === "true";
              const folderId = url.searchParams.get("folderId") ?? "root";
              if (!recent && folderId === folder.id && holdFolder) { pendingFolders++; await new Promise<void>(resolve => releaseFolders.push(resolve)); pendingFolders--; }
              const status = listingFailure ? 503 : recent ? recentStatus : folderStatus;
              listingReads.push({ view: recent ? "recent" : "folder", folder: folderId, status });
              if (status !== 200) return json({ error: status === 403 ? "permission_denied" : "upstream_unavailable" }, status);
              return json({ ok: true, files: folderId === folder.id && !recent ? [secret] : [...(recent ? [] : [folder]), ...files, ...(referring.searchParams.get("previews") === "on" ? previewFiles : [])] });
            }
            if (office) {
              const id = office[1];
              if (!id) {
                officeOpens.push("open");
                if (officeStarting) return json({ error: "office_starting", message: "Starting the document editor in your OpenWork Cloud workspace…" }, 503);
                if (officeError !== null) return json({ error: "office_unavailable", message: "The document service isn't available." }, officeError);
                const id = randomUUID(); const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
                const session = { expiresAt, recoveryExpiresAt: new Date(Date.parse(expiresAt) + 900_000).toISOString() };
                officeSessions.set(id, session);
                return json({ ...session, id, serverUrl: url.origin, editorUrl: `${url.origin}/office-fixture/${id}`, accessToken: "fixture_capability", canEdit: false, saveAsCopy: false, fileType: "xlsx" });
              }
              const session = officeSessions.get(id); if (!session) return json({ error: "office_unavailable" }, 409);
              if (office[2] === "close") { officeSessions.delete(id); return json({ ok: true }); }
              return json({ ...session, draftVersion: 0, uncertain: false });
            }
            const match = /\/files\/([^/]+)\/(metadata|editor|content)$/.exec(url.pathname);
            if (match) {
              const file = [...files, ...previewFiles, secret].find(file => file.id === match[1]);
              if (match[2] === "editor") { editorReads.push(match[1]!); editorConnections.push(url.searchParams.get("connectionId")); }
              if (!file || fileDenied || deniedFiles.has(file.id)) return json({ error: "permission_denied" }, 403);
              if (match[2] === "content") {
                contentReads.push(file.id);
                if (holdContent) await new Promise<void>(resolve => releaseContents.push(resolve));
                res.setHeader("content-type", file.mimeType === "image/png" ? "image/png" : "application/pdf");
                return void res.end(file.mimeType === "image/png" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/aQAAAAASUVORK5CYII=", "base64") : fixturePdf());
              }
              if (["file_pdf", "file_slides", "file_image"].includes(file.id) && match[2] === "editor") return json({ kind: "preview", fileId: file.id, connectionId: "google-workspace", name: file.name, revision: "v1", canEdit: false, mimeType: file.mimeType });
              if (["file_doc", "file_docx"].includes(file.id) && match[2] === "editor") return json({ kind: "document", source: file.id === "file_docx" ? "docx" : "google", fileId: file.id, connectionId: "google-workspace", name: file.name, revision: "v1", canEdit: true, sections: [{ id: "body", name: "Body", paragraphs: [{ id: "p1", runs: [{ id: "r1", text: "A readable project plan", bold: true }] }] }] });
              if (match[2] === "metadata") { if (holdMetadata) await new Promise<void>(resolve => releaseMetadatas.push(resolve)); opened.push(file.id); return json({ id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, size: file.size === null ? null : Number(file.size), openUrl: file.webViewLink }); }
              if (req.method === "POST") return json({ ok: true });
              if (file.id === "file_sheet" || file.id === "file_office") {
                return json({ kind: "spreadsheet", source: file.id === "file_office" ? "xlsx" : "google", fileId: file.id, connectionId: "google-workspace", name: file.name, revision: "v1", canEdit: true, sheets: [{ id: "0", name: "Phrases", rows: 3, columns: 2 }], activeSheetId: "0", startRow: 1, endRow: 3, cells: [{ row: 1, column: 1, text: "Trigger phrase" }, { row: 2, column: 1, text: "book a demo" }] });
              }
              return json({ kind: "text", fileId: file.id, connectionId: "google-workspace", name: file.name, revision: "v1", canEdit: true, ...(referring.searchParams.get("notice") === "on" ? { notice: "Text editing. Original document layout and other content are retained when you save." } : {}), text: file.id === "file_brief" ? "Project overview" : "Budget overview" });
            }
          }
          if (url.pathname.endsWith("/calendar/v1/automations")) return json({ items: [], nextCursor: null });
          if (url.pathname.endsWith("/calendar/v1/automation-runs")) return json({ runs: [], nextCursor: null });
          if (url.pathname.endsWith("/google-workspace/calendar-events")) {
            const from = Date.parse(url.searchParams.get("timeMin") ?? "");
            const date = new Date(from + 2 * 86400000).toISOString().slice(0, 10);
            return json({ ok: true, events: [{ id: "event_review", summary: "Team review", description: "Review the project", location: "", start: `${date}T17:00:00Z`, end: `${date}T18:00:00Z`, status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: [], meetLink: null }] });
          }
          if (url.pathname.includes("microsoft-365/calendar-events")) return json({ error: "needs_connection" }, 409);
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-workspace", startUrl: `${url}documents?assistant=off`, headless: true }));
    const release = () => { holdFolder = false; for (const resolve of releaseFolders.splice(0)) resolve(); };
    resources.defer(release);
    const releaseOther = () => { holdOtherThread = false; for (const resolve of releaseOtherThreads.splice(0)) resolve(); };
    resources.defer(releaseOther);
    const releaseIdentity = () => { holdIdentity = false; for (const resolve of releaseIdentities.splice(0)) resolve(); };
    resources.defer(releaseIdentity);
    resources.defer(releaseContent);
    resources.defer(releaseMetadata);
    return {
      web, url, messages: () => [...messages], opened: () => [...opened], editorReads: () => [...editorReads], editorConnections: () => [...editorConnections], documentWrites: () => [...documentWrites],
      holdDocumentMetadata: () => { holdMetadata = true; }, releaseDocumentMetadata: releaseMetadata,
      holdPreviewContent: () => { holdContent = true; }, releasePreviewContent: releaseContent, contentReads: () => [...contentReads],
      identityReads: () => [...identityReads], identityScopes: () => [...identityScopes], listingReads: () => [...listingReads], pendingFolders: () => pendingFolders,
      holdIdentity: () => { holdIdentity = true; }, pendingIdentities: () => pendingIdentities, releaseIdentity,
      threadRequests: () => [...threadRequests], pendingOtherThreads: () => pendingOtherThreads,
      holdOtherThread: () => { holdOtherThread = true; }, releaseOtherThread: releaseOther,
      seedOwnerConversation: (text: string) => { thread("user_example").push({ id: "owner_account_turn", text, sentAt: Date.now(), finishedAt: Date.now(), status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "Original account answer" }], modelSteps: 1, error: null }); },
      async documentReadStatus() { const response = await fetch(`${url}v1/workbot/documents/v1/documents/google-drive/files/file_brief/editor`); await response.arrayBuffer(); return response.status; },
      officeOpens: () => [...officeOpens], officeRequests: () => [...officeRequests], officeCloses: () => [...officeCloses], officeLaunches: () => [...officeLaunches],
      revokeDrive: () => { driveDenied = true; }, restoreDrive: () => { driveDenied = false; },
      expireSession: () => { sessionExpired = true; }, restoreSession: () => { sessionExpired = false; },
      expireIdentity: () => { identityStatus = 401; }, failIdentity: () => { identityStatus = 503; }, restoreIdentityService: () => { identityStatus = 200; },
      useOtherIdentity: () => { principalId = "user_other"; }, restoreIdentity: () => { principalId = "user_example"; },
      useOtherOrganization: () => { organizationId = "org_other"; }, restoreOrganization: () => { organizationId = "org_example"; },
      failListing: () => { listingFailure = true; }, restoreListing: () => { listingFailure = false; },
      denyRecent: () => { recentStatus = 403; }, failRecent: () => { recentStatus = 503; }, restoreRecent: () => { recentStatus = 200; },
      holdFolder: () => { holdFolder = true; }, releaseFailedFolder: () => { folderStatus = 503; release(); }, restoreFolder: () => { folderStatus = 200; release(); },
      denyFile: () => { fileDenied = true; }, allowFile: () => { fileDenied = false; }, denyBudget: () => { deniedFiles.add("file_budget"); },
      makeOfficeAvailable: () => { officeError = null; officeStarting = false; },
      startOfficeSlowly: () => { officeStarting = true; },
      makeOfficeUnavailable: () => { officeError = 503; officeStarting = false; },
      disableEditing: () => { editingOff = true; }, enableEditing: () => { editingOff = false; },
      disableDocuments: () => { documentsOff = true; }, enableDocuments: () => { documentsOff = false; },
      // Test-owned wall-clock + OS connectivity fault, not a query/cache setter.
      // Both base and head cross the real 60-second parent stale boundary, then
      // exercise its ordinary reconnect revalidation without a minute of sleep.
      reconnectAfterStaleMinute: () => seed.evalIn(web, browserScript(() => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 61_000;
        window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online"));
      }, [])),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}

/** A valid one-page PDF keeps the browser viewer path real without provider access. */
function fixturePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
