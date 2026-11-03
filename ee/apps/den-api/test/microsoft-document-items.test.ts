import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeMicrosoftDocumentId, encodeMicrosoftDocumentId, microsoftDocumentItem } from "../src/routes/org/microsoft-document-items.js"

test("a OneDrive file id carries its drive and item and fits the opaque Documents id", () => {
  const id = encodeMicrosoftDocumentId("b!Xy_z-1", "01ABC!101")
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeMicrosoftDocumentId(id), { driveId: "b!Xy_z-1", itemId: "01ABC!101" })
  for (const forged of [encodeMicrosoftDocumentId("drive", "item/../other"), encodeMicrosoftDocumentId("a\nb", "c"), "not-base64-of-a-pair", ""]) {
    assert.equal(decodeMicrosoftDocumentId(forged), null, forged)
  }
})

test("shared and recent entries open the real file in its owner's drive", () => {
  const item = microsoftDocumentItem({
    id: "shortcut",
    name: "Quote.docx",
    remoteItem: {
      id: "01REAL",
      name: "Quote.docx",
      size: 2048,
      lastModifiedDateTime: "2026-10-18T09:00:00Z",
      webUrl: "https://contoso.sharepoint.com/sites/sales/Quote.docx",
      file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      parentReference: { driveId: "b!owner" },
    },
  })
  assert.ok(item)
  assert.deepEqual(decodeMicrosoftDocumentId(item.id), { driveId: "b!owner", itemId: "01REAL" })
  assert.equal(item.kind, "file")
  assert.equal(item.size, 2048)
  assert.equal(item.openUrl, "https://contoso.sharepoint.com/sites/sales/Quote.docx")
})

test("folders list, packages without content are skipped, and only Microsoft links are kept", () => {
  const folder = microsoftDocumentItem({ id: "01F", name: "Quotes", folder: {}, parentReference: { driveId: "me" }, webUrl: "https://onedrive.live.com/?id=01F" })
  assert.equal(folder?.kind, "folder")
  assert.equal(folder?.openUrl, "https://onedrive.live.com/?id=01F")
  assert.equal(microsoftDocumentItem({ id: "01N", name: "Notebook", parentReference: { driveId: "me" } }), null)
  assert.equal(microsoftDocumentItem({ id: "01X", name: "a.pdf", file: { mimeType: "application/pdf" } }), null, "no drive id")
  const phishing = microsoftDocumentItem({ id: "01P", name: "a.pdf", file: { mimeType: "application/pdf" }, parentReference: { driveId: "me" }, webUrl: "https://sharepoint.com.evil.example/a.pdf" })
  assert.equal(phishing?.openUrl, null)
})
