import assert from "node:assert/strict"
import { test } from "node:test"
import { QueryClient } from "@tanstack/react-query"
import type { DocumentItem } from "../src/index"
import type { DocumentsEditor, EditorDocument } from "../src/model"
import { documentEditorKey, documentEditorPrefix, documentsListKey, prefetchDocumentEditor } from "../src/queries"

const scope = ["https://den.example.test/dashboard", "org_example", "user_example"] as const
const file: DocumentItem = { id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", kind: "file", modifiedTime: null, size: 42, openUrl: null }
const text: EditorDocument = { kind: "text", fileId: "file_brief", connectionId: "google-workspace", name: "Project brief.txt", revision: "v1", canEdit: true, text: "Project overview" }

function editor(reads: string[]): DocumentsEditor {
  return { open: async (id) => { reads.push(id); return text }, save: async () => {}, contentUrl: id => `/content/${id}` }
}

test("every cache key starts with the identity scope, so no entry is shared across people", () => {
  assert.deepEqual(documentsListKey(scope, "google-drive", "recent", "").slice(0, 4), ["documents", ...scope])
  assert.deepEqual(documentEditorKey(scope, "file_brief", undefined, 1, true).slice(0, 6), [...documentEditorPrefix(scope, "file_brief")])
  assert.notDeepEqual(documentEditorPrefix(scope, "file_brief"), documentEditorPrefix([scope[0], scope[1], "user_other"], "file_brief"))
})

test("a file read on hover lands in the entry its tab reads first; folders are never read", async () => {
  const client = new QueryClient()
  const reads: string[] = []
  await prefetchDocumentEditor(client, { editor: editor(reads), scope, item: { ...file, id: "folder_team", kind: "folder" }, editingEnabled: true })
  assert.deepEqual(reads, [])
  await prefetchDocumentEditor(client, { editor: editor(reads), scope, item: file, editingEnabled: true })
  assert.deepEqual(reads, ["file_brief"])
  assert.deepEqual(client.getQueryData(documentEditorKey(scope, "file_brief", undefined, 1, true)), text)
  // Closing the tab releases every window of that file.
  client.removeQueries({ queryKey: documentEditorPrefix(scope, "file_brief") })
  assert.equal(client.getQueryData(documentEditorKey(scope, "file_brief", undefined, 1, true)), undefined)
  client.clear()
})

test("a failed read ahead of the click is not an error: the tab reads again", async () => {
  const client = new QueryClient()
  await prefetchDocumentEditor(client, { editor: { ...editor([]), open: async () => { throw new Error("offline") } }, scope, item: file, editingEnabled: false })
  assert.equal(client.getQueryData(documentEditorKey(scope, "file_brief", undefined, 1, false)), undefined)
  client.clear()
})
