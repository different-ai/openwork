import assert from "node:assert/strict"
import { test } from "node:test"
import { createComposerState } from "../../../packages/workbot-ui/src/composer-state.js"
import { isHeic, isImage, uploadableFiles } from "../../../packages/workbot-ui/src/images.js"

const saved = (file: File) => ({ id: `f_${file.name}`, name: file.name, mediaType: file.type, size: file.size, createdAt: 0, source: "user" as const })

test("HEIC photos are recognized by type or by name, and are not images the page or model can show", () => {
  assert.equal(isHeic(new File(["x"], "IMG_1.HEIC", { type: "" })), true)
  assert.equal(isHeic(new File(["x"], "photo", { type: "image/heif" })), true)
  assert.equal(isHeic(new File(["x"], "photo.jpg", { type: "image/jpeg" })), false)
  assert.equal(isImage("image/heic"), false)
  assert.equal(isImage("image/jpeg"), true)
})

test("a HEIC this browser can't decode is sent as it is, without a broken preview", async () => {
  // Node has no image decoder, like a browser without HEIC support.
  const heic = new File(["heic bytes"], "Workbot.heic", { type: "image/heic" })
  const [same] = await uploadableFiles([heic])
  assert.equal(same, heic)

  const uploaded: string[] = []
  const composer = createComposerState(async (file) => { uploaded.push(file.name); return saved(file) })
  composer.add([heic, new File(["png"], "shot.png", { type: "image/png" })])
  await new Promise((resolve) => setTimeout(resolve, 0))
  const uploads = composer.getSnapshot().uploads
  assert.deepEqual(uploads.map((upload) => [upload.file.name, upload.previewUrl === null]), [["Workbot.heic", true], ["shot.png", false]])
  assert.deepEqual(uploaded, ["Workbot.heic", "shot.png"])
  composer.dispose()
})

test("typing and one file's upload progress leave the other messages being sent as they are", async () => {
  const progress = new Map<string, (loaded: number) => void>()
  const composer = createComposerState((file, onProgress) => { progress.set(file.name, onProgress); return new Promise(() => {}) })
  composer.enqueue({ id: "message_sending", text: "Still on its way" })
  composer.add([new File(["notes"], "notes.txt", { type: "text/plain" })])
  const before = composer.getSnapshot()

  // The conversation reads only `pending`: the same list means nothing in it re-renders.
  composer.setText("A half-typed reply")
  progress.get("notes.txt")?.(3)
  const typed = composer.getSnapshot()
  assert.equal(typed.pending, before.pending)
  assert.equal(typed.uploads[0]?.loaded, 3)

  // Once the file's message is sending too, its progress changes that message and no other.
  composer.enqueue({ id: "message_with_file", text: "With the notes" })
  const sending = composer.getSnapshot()
  progress.get("notes.txt")?.(5)
  const ticked = composer.getSnapshot()
  assert.equal(ticked.pending[0], sending.pending[0])
  assert.notEqual(ticked.pending[1], sending.pending[1])
  assert.equal(ticked.pending[1]?.uploads[0]?.loaded, 5)
  composer.dispose()
})
