import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { officeEditor, officeSessionSchema, officeStatusSchema, savedOfficeDocument } from "../src/office-engine"
import { createCollaboraService, officeTicketMatches, officeBytes, OFFICE_MAX_BYTES, officeSessionActive, officeRecoveryUntil, OFFICE_RECOVERY_SECONDS, type OfficeDraft } from "../src/office-server"

const draft: OfficeDraft = { id: randomUUID(), organizationId: "example-org", memberId: "example-member", userId: "example-user", connectionId: "google-workspace", fileId: "example-file", revision: "1", name: "Example.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileType: "xlsx", canEdit: true, saveAsCopy: false, expiresAt: Date.now() + 60_000, ticket: randomUUID(), source: "", draftVersion: 0 }
const service = (fetcher: typeof fetch) => createCollaboraService({ serverUrl: "https://office.example.com", callbackBaseUrl: "https://api.example.com", hostOrigin: "https://workbot.example.com", fetch: fetcher })
const xml = (url: string) => `<wopi-discovery><net-zone><app><action name="edit" ext="xlsx" urlsrc="${url}"/></app></net-zone></wopi-discovery>`

test("WOPI capabilities match one file session and reject missing, wrong and oversized tokens", () => {
  assert.equal(officeTicketMatches(draft, draft.ticket), true)
  assert.equal(officeTicketMatches(draft, undefined), false)
  assert.equal(officeTicketMatches(draft, randomUUID()), false)
  assert.equal(officeTicketMatches({ ...draft, ticket: randomUUID() }, draft.ticket), false)
  assert.equal(officeTicketMatches(draft, "a".repeat(1000)), false)
})

test("editor discovery cannot point the browser at an arbitrary host, protocol or path", async () => {
  for (const url of ["http://169.254.169.254/browser/edit", "https://other.example.com/browser/edit", "https://office.example.com:444/browser/edit", "https://office.example.com/admin", "https://name:password@office.example.com/browser/edit"]) {
    await assert.rejects(service(async () => new Response(xml(url))).session(draft))
  }
})

test("free WOPI launch omits credentials from URLs, exposes no vendor config and binds the host origin", async () => {
  const engine = service(async (_url, init) => { assert.equal(init?.redirect, "error"); return new Response(xml("https://office.example.com/browser/build/cool.html?")) })
  const session = await engine.session(draft)
  assert.equal(officeSessionSchema.parse(session).expiresAt, new Date(draft.expiresAt).toISOString())
  assert.equal(officeStatusSchema.parse({ expiresAt: session.expiresAt, recoveryExpiresAt: session.recoveryExpiresAt, uncertain: false, draftVersion: 0 }).draftVersion, 0)
  const url = new URL(session.editorUrl)
  assert.equal(url.searchParams.get("WOPISrc"), `https://api.example.com/v1/documents/wopi/files/${draft.id}`)
  assert.equal(session.editorUrl.includes(draft.ticket), false)
  assert.equal(session.accessToken, draft.ticket)
  assert.equal("config" in session, false)
  const info = engine.fileInfo(draft, 120)
  assert.equal(info.PostMessageOrigin, "https://workbot.example.com")
  assert.equal(info.Size, 120)
  assert.equal(info.UserCanNotWriteRelative, true)
  assert.equal(info.HideSaveOption, true)
  assert.equal(engine.fileInfo({ ...draft, canEdit: false }, 120).ReadOnly, true)
})

test("chunked and declared oversized editor output is rejected before buffering unbounded bytes", async () => {
  let cancelled = false
  await assert.rejects(officeBytes(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(OFFICE_MAX_BYTES + 1)) }, cancel() { cancelled = true } }))))
  assert.equal(cancelled, true)
  await assert.rejects(officeBytes(new Response("small", { headers: { "content-length": String(OFFICE_MAX_BYTES + 1) } })))
})

test("the authenticated host download path is file/session bound and does not prepare or replay a write", async () => {
  const calls: string[] = []
  const editor = officeEditor(async path => { calls.push(path); throw new Error("Lost reply") }, id => `/files/${encodeURIComponent(id)}/office`, path => `/authenticated${path}`)
  assert.equal(editor.downloadUrl?.("source_file", draft.id), `/authenticated/files/source_file/office/${draft.id}/download`)
  assert.equal(calls.length, 0)
  await assert.rejects(editor.save("source_file", draft.id, 1), /Lost reply/)
  assert.deepEqual(calls, [`/files/source_file/office/${draft.id}/save`])
})

test("recovery expiry never extends editing and uncertain state survives the status contract", () => {
  assert.equal(officeSessionActive(draft, draft.expiresAt - 1), true)
  assert.equal(officeSessionActive(draft, draft.expiresAt), false)
  assert.equal(officeRecoveryUntil(draft), draft.expiresAt + OFFICE_RECOVERY_SECONDS * 1000)
  assert.equal(officeStatusSchema.parse({ expiresAt: new Date(draft.expiresAt).toISOString(), recoveryExpiresAt: new Date(officeRecoveryUntil(draft)).toISOString(), draftVersion: 1, uncertain: true }).uncertain, true)
})

test("context follows the confirmed Office copy while the original tab identity can stay stable", () => {
  const original = { id: "google_original", name: "Project brief", mimeType: "application/vnd.google-apps.document", kind: "file" as const, modifiedTime: null, size: null, openUrl: "https://docs.google.com/document/d/google_original/edit" }
  const saved = savedOfficeDocument(original, "docx", true, "saved_copy")
  assert.equal(saved.id, "saved_copy")
  assert.equal(saved.name, "Project brief.docx")
  assert.equal(saved.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  const slides = savedOfficeDocument({ ...original, mimeType: "application/vnd.google-apps.presentation" }, "pptx", true, "saved_slides")
  assert.equal(slides.name, "Project brief.pptx")
  assert.equal(slides.mimeType, "application/vnd.openxmlformats-officedocument.presentationml.presentation")
  assert.equal(original.id, "google_original")
  assert.equal(saved.openUrl, "https://drive.google.com/file/d/saved_copy/view")
  assert.equal(savedOfficeDocument({ ...original, name: "Budget.xlsx" }, "xlsx", false, "existing_file").name, "Budget.xlsx")
})
