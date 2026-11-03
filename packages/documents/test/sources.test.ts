import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentsError, type DocumentItem, type DocumentsProvider, type DocumentsRequest } from "../src/index"
import { combinedDocumentsEditor, combinedDocumentsProvider, documentSourceFileId } from "../src/sources"
import type { DocumentsEditor } from "../src/model"

const file = (id: string, modifiedTime: string): DocumentItem => ({ id, name: `${id}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "file", modifiedTime, size: 1, openUrl: null })
function provider(id: string, list: (request: DocumentsRequest) => Promise<{ items: DocumentItem[]; nextCursor?: string | null }>, extra: Partial<DocumentsProvider> = {}): DocumentsProvider & { calls: DocumentsRequest[] } {
  const calls: DocumentsRequest[] = []
  return { id, label: id === "google-drive" ? "Google Drive" : "OneDrive", rootLabel: id, storage: id === "google-drive" ? "Drive" : "OneDrive", calls, ...extra,
    async list(request) { calls.push(request); const page = await list(request); return { items: page.items, nextCursor: page.nextCursor ?? null, incomplete: false } } }
}

test("one provider stays exactly as it was", () => {
  const google = provider("google-drive", async () => ({ items: [] }))
  assert.equal(combinedDocumentsProvider([google]), google)
})

test("recent files merge every provider newest first, each tagged with where it came from", async () => {
  const google = provider("google-drive", async () => ({ items: [file("g1", "2026-10-10T00:00:00Z")], nextCursor: "g-next" }))
  const microsoft = provider("microsoft-365", async () => ({ items: [file("m1", "2026-10-12T00:00:00Z")] }), { connectionId: "microsoft-365" })
  const combined = combinedDocumentsProvider([google, microsoft])
  const page = await combined.list({ view: "recent", folderId: "root", query: "" })
  assert.deepEqual(page.items.map(item => item.id), ["microsoft-365~m1", "google-drive~g1"])
  assert.equal(page.items[0]?.source?.storage, "OneDrive")
  assert.equal(page.items[0]?.source?.connectionId, "microsoft-365")
  assert.equal(documentSourceFileId(page.items[0]!), "m1")
  // The next page continues only the providers that have more.
  await combined.list({ view: "recent", folderId: "root", query: "", cursor: page.nextCursor ?? undefined })
  assert.equal(google.calls.at(-1)?.cursor, "g-next")
  assert.equal(microsoft.calls.length, 1)
})

test("a service that fails becomes a notice beside the files that loaded; all failing is an error", async () => {
  const google = provider("google-drive", async () => ({ items: [file("g1", "2026-10-10T00:00:00Z")] }))
  const microsoft = provider("microsoft-365", async () => { throw new DocumentsError(409, "needs_connection", "Connect your Microsoft account.") }, { connectionId: "microsoft-365" })
  const page = await combinedDocumentsProvider([google, microsoft]).list({ view: "recent", folderId: "root", query: "" })
  assert.deepEqual(page.items.map(item => item.id), ["google-drive~g1"])
  assert.deepEqual(page.unavailable?.map(entry => [entry.source.id, entry.code, entry.connectionId]), [["microsoft-365", "needs_connection", "microsoft-365"]])
  const down = provider("google-drive", async () => { throw new DocumentsError(409, "needs_connection", "Connect Google Drive.") })
  await assert.rejects(combinedDocumentsProvider([down, microsoft]).list({ view: "recent", folderId: "root", query: "" }), (error: unknown) => error instanceof DocumentsError && error.message === "Connect Google Drive.")
})

test("the top level lists each service's places, and a folder belongs to one service", async () => {
  const google = provider("google-drive", async () => ({ items: [file("g1", "2026-10-10T00:00:00Z")] }))
  const microsoft = provider("microsoft-365", async () => ({ items: [] }), { roots: [{ id: "root", name: "OneDrive" }, { id: "shared", name: "Shared with me" }] })
  const combined = combinedDocumentsProvider([google, microsoft])
  const top = await combined.list({ view: "folder", folderId: "root", query: "" })
  assert.deepEqual(top.items.map(item => [item.id, item.name, item.kind]), [["google-drive~root", "google-drive", "folder"], ["microsoft-365~root", "OneDrive", "folder"], ["microsoft-365~shared", "Shared with me", "folder"]])
  await combined.list({ view: "folder", folderId: "microsoft-365~shared", query: "" })
  assert.equal(microsoft.calls.at(-1)?.folderId, "shared")
  assert.equal(google.calls.length, 0)
})

test("each file opens in its own service's editor, and only Google files get the full Office editor", async () => {
  const opened: string[] = []
  const editor = (name: string, office: boolean): DocumentsEditor => ({
    ...(office ? { office: { open: async id => { opened.push(`${name}-office:${id}`); throw new Error("stop") }, status: async () => { throw new Error("unused") }, save: async () => ({ fileId: "x" }), close: async () => {} } } : {}),
    open: async id => { opened.push(`${name}:${id}`); throw new Error("stop") },
    save: async () => {},
    contentUrl: id => `/${name}/${id}`,
  })
  const combined = combinedDocumentsEditor([{ id: "google-drive", editor: editor("google", true) }, { id: "microsoft-365", editor: editor("microsoft", false) }])
  await assert.rejects(combined.open("microsoft-365~abc"))
  await assert.rejects(combined.open("google-drive~xyz"))
  await assert.rejects(combined.office!.open("google-drive~xyz"))
  assert.deepEqual(opened, ["microsoft:abc", "google:xyz", "google-office:xyz"])
  assert.equal(combined.hasOffice?.("microsoft-365~abc"), false)
  assert.equal(combined.hasOffice?.("google-drive~xyz"), true)
  assert.equal(combined.contentUrl("microsoft-365~abc"), "/microsoft/abc")
})
