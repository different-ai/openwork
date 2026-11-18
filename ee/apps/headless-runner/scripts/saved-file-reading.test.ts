/** Kept files the model can't read (src/saved-files.ts, src/tool-files.ts): the note comes from the row, the bytes stay in the bucket. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { MAX_COMPRESSED_BYTES } from "@openwork/workbook"
import { nodeSqlite } from "../src/node-sqlite.js"
import { SavedFiles, mediaTypeFor, runSavedFileTool } from "../src/saved-files.js"
import { Store } from "../src/store.js"
import { MAX_IMAGE_BASE64, MAX_PDF_BASE64, readToolFile, unreadableNote } from "../src/tool-files.js"
import { memoryBlobs } from "./storage-fixture.js"

const MB = 1024 * 1024
const limits = { maxFileBytes: 200 * MB, maxSessionBytes: 1024 * MB }
/** The most bytes an image and a PDF may have and still go to the model. */
const IMAGE_BYTES = (MAX_IMAGE_BASE64 / 4) * 3
const PDF_BYTES = (MAX_PDF_BASE64 / 4) * 3

/** What reading the whole file says: the wording the row-only answer has to match. */
async function fromBytes(name: string, size: number, declared?: string) {
  const data = Buffer.alloc(size, 0x20).toString("base64")
  return readToolFile({ name, mimeType: mediaTypeFor(name, declared), data }, { images: 0, documents: 0 })
}

const fromRow = (name: string, size: number, declared?: string) => unreadableNote({ name, mimeType: mediaTypeFor(name, declared), size })

test("a file that can't be read gets the same note from its name, type and size as from its bytes", async () => {
  const cases: Array<{ name: string; size: number; declared?: string; note: RegExp }> = [
    { name: "demo.mp4", size: 300_000, declared: "video/mp4", note: /^\[Can't open demo\.mp4 \(video, 293 KB\) here\. Audio and video can't be read/ },
    { name: "call.m4a", size: 2 * MB, declared: "audio/mp4", note: /^\[Can't open call\.m4a \(audio, 2\.0 MB\) here\./ },
    { name: "scan.tiff", size: 4_096, declared: "image/tiff", note: /^\[Can't open scan\.tiff \(image\/tiff, 4 KB\) here\. Ask for a PNG or JPEG version\.\]$/ },
    { name: "export.zip", size: 900, declared: "application/zip", note: /^\[Can't open export\.zip \(archive, 900 bytes\) here\./ },
    { name: "letter.doc", size: 70_000, declared: "application/msword", note: /^\[Can't open letter\.doc \(application\/msword, 68 KB\) here\./ },
    { name: "model.bin", size: 5_000, note: /^\[Can't open model\.bin \(application\/octet-stream, 5 KB\) here\. Ask for a PDF, text, or image version\.\]$/ },
    { name: "photo.png", size: IMAGE_BYTES + 1, note: /^\[image\/png image too large to view\]$/ },
    { name: "report.pdf", size: PDF_BYTES + 1, note: /^\[Can't open report\.pdf \(PDF, 10\.0 MB\) here: it is larger than 10 MB\./ },
    { name: "deck.pptx", size: MAX_COMPRESSED_BYTES + 1, note: /^\[Can't open deck\.pptx \(PowerPoint deck, 12\.0 MB\) here: it is larger than 12\.0 MB\.\]$/ },
  ]
  for (const { name, size, declared, note } of cases) {
    const read = await fromBytes(name, size, declared)
    assert.match(read.text, note, name)
    assert.equal(read.image ?? read.document, undefined, name)
    assert.equal(fromRow(name, size, declared), read.text, name)
  }
})

test("a file that can be read is not answered from its row", async () => {
  // The largest image and PDF that still go to the model, and types whose content decides.
  assert.equal(fromRow("photo.png", IMAGE_BYTES), null)
  assert.ok((await fromBytes("photo.png", IMAGE_BYTES)).image)
  assert.equal(fromRow("report.pdf", PDF_BYTES), null)
  assert.ok((await fromBytes("report.pdf", PDF_BYTES)).document)
  assert.equal(fromRow("deck.pptx", MAX_COMPRESSED_BYTES), null)
  assert.equal(fromRow("notes.md", 50 * MB), null)
  assert.equal(fromRow("data.csv", 10, "application/octet-stream"), null)
})

test("opening a kept file that can't be read never fetches its bytes", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  try {
    const session = store.createSession({ owner: "test-owner", files: true }).id
    const blobs = memoryBlobs()
    const fetched: string[] = []
    blobs.hooks.failGet = (key) => {
      fetched.push(key)
      return false
    }
    const files = new SavedFiles(store, blobs.store, limits)

    const notes = await files.add(session, { name: "notes.md", bytes: new Uint8Array(Buffer.from("# Plan\nShip it.")), source: "user" })
    // Rows as an upload leaves them; the sizes alone say these can't be read, so no object is needed behind them.
    const row = (id: string, name: string, mediaType: string, size: number) => {
      store.addSavedFile({ id, sessionId: session, name, mediaType, size, source: "user", createdAt: 1, updatedAt: 1, storageKey: `sessions/${session}/${id}` })
      return id
    }
    const video = row("fl_video", "walkthrough.mp4", "video/mp4", 100 * MB)
    const image = row("fl_image", "poster.png", "image/png", 9 * MB)
    const pdf = row("fl_pdf", "handbook.pdf", "application/pdf", 40 * MB)

    assert.deepEqual((await files.reading(session, video))?.reading, {
      text: "[Can't open walkthrough.mp4 (video, 100.0 MB) here. Audio and video can't be read; ask for a transcript or screenshots.]",
    })
    assert.deepEqual((await files.reading(session, image))?.reading, { text: "[image/png image too large to view]" })
    assert.match((await files.reading(session, pdf))?.reading.text ?? "", /^\[Can't open handbook\.pdf \(PDF, 40\.0 MB\) here: it is larger than 10 MB\./)
    const opened = await runSavedFileTool(files, store, session, "open_file", { id: video })
    assert.match(opened.output, /^walkthrough\.mp4 \(sent by the person 1970-01-01\)\n\[Can't open walkthrough\.mp4 \(video, 100\.0 MB\) here\./)
    assert.deepEqual(fetched, [])

    // A readable file is still fetched and read, and a file with no row is still unknown.
    assert.equal((await files.reading(session, notes.id))?.reading.text, "[notes.md]\n# Plan\nShip it.")
    assert.deepEqual(fetched, [`sessions/${session}/${notes.id}`])
    assert.equal(await files.reading(session, "fl_missing"), null)
  } finally {
    store.close()
  }
})
