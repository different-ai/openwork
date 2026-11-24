/** Links for moving kept files without holding them (src/blobs.ts, src/saved-files.ts): what a link is, and what is kept of what arrives. */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { diskBlobStore, s3BlobStore } from "../src/blobs.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { SavedFileLimitError, SavedFiles } from "../src/saved-files.js"
import { Store } from "../src/store.js"

const SECRET = "secret-key-never-leaves-the-runner"
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text))

/** An S3-compatible bucket in memory, reached through `fetch`: enough of GET, PUT, HEAD, DELETE and CopyObject. */
function bucket() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>()
  const keyOf = (path: string) => decodeURIComponent(path).replace(/^\/files\//, "")
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const key = keyOf(new URL(request.url).pathname)
    const found = objects.get(key)
    if (request.method === "PUT") {
      const source = request.headers.get("x-amz-copy-source")
      const from = source ? objects.get(keyOf(source)) : null
      if (source && !from) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      objects.set(key, { bytes: from ? from.bytes : new Uint8Array(await request.arrayBuffer()), type: request.headers.get("content-type") ?? "" })
      return new Response(from ? "<CopyObjectResult/>" : null, { status: 200 })
    }
    if (request.method === "DELETE") {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    if (!found) return new Response(null, { status: 404 })
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(found.bytes.byteLength) } })
    return new Response(found.bytes, { status: 200 })
  }
  const blobs = s3BlobStore({ endpoint: "https://store.example", region: "auto", bucket: "files", accessKeyId: "key-id", secretAccessKey: SECRET, forcePathStyle: true, fetch: fetcher })
  /** What the computer does with a link: one plain request, no credentials of its own. */
  const send = (url: string, body: string) => fetcher(url, { method: "PUT", body })
  return { objects, blobs, send, fetcher }
}

function conversation(limits = { maxFileBytes: 1_000, maxSessionBytes: 5_000 }) {
  const store = new Store(nodeSqlite(":memory:"))
  const session = store.createSession({ owner: "test-owner", files: true }).id
  const remote = bucket()
  return { store, session, files: new SavedFiles(store, remote.blobs, limits), ...remote }
}

test("a link reaches one object with one method for a limited time, and carries no secret", async () => {
  const { blobs } = bucket()
  assert.ok(blobs.link)
  const get = new URL(await blobs.link("GET", "sessions/s1/fl_a", 240))
  assert.equal(`${get.origin}${get.pathname}`, "https://store.example/files/sessions/s1/fl_a")
  assert.equal(get.searchParams.get("X-Amz-Expires"), "240")
  assert.equal(get.searchParams.get("X-Amz-SignedHeaders"), "host")
  assert.match(get.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/)
  assert.ok(!get.href.includes(SECRET))
  // Another method, object or lifetime needs another signature: one link can't be turned into another.
  const signatures = new Set(await Promise.all([
    blobs.link("PUT", "sessions/s1/fl_a", 240),
    blobs.link("GET", "sessions/s1/fl_b", 240),
    blobs.link("GET", "sessions/s1/fl_a", 241),
  ].map(async (link) => new URL(await link).searchParams.get("X-Amz-Signature"))))
  assert.equal(signatures.size, 3)
  assert.ok(!signatures.has(get.searchParams.get("X-Amz-Signature")))
})

test("a file sent to its link is measured, then kept under its own key with its type", async () => {
  const { store, session, files, objects, send, fetcher } = conversation()
  try {
    const place = await files.receive(session, { name: "chart.png", size: 5, source: "agent", expiresSeconds: 120 })
    assert.ok(place)
    // The link writes a holding object, never a kept file.
    const holding = decodeURIComponent(new URL(place.url).pathname).replace("/files/", "")
    assert.match(holding, new RegExp(`^sessions/${session}/incoming-[0-9a-f]{32}$`))
    assert.equal((await send(place.url, "12345")).status, 200)
    assert.deepEqual(files.list(session), [])

    const file = await place.finish()
    assert.ok(file)
    assert.deepEqual({ name: file.name, size: file.size, mediaType: file.mediaType, source: file.source }, { name: "chart.png", size: 5, mediaType: "image/png", source: "agent" })
    assert.deepEqual([...objects.keys()], [`sessions/${session}/${file.id}`])
    assert.equal(objects.get(`sessions/${session}/${file.id}`)?.type, "image/png")
    assert.equal(Buffer.from((await files.read(session, file.id))?.bytes ?? []).toString(), "12345")

    // The person's own file is fetched through a link to that one object.
    const link = await files.downloadUrl(session, file.id, 120)
    assert.equal(new URL(link ?? "").pathname, `/files/sessions/${session}/${file.id}`)
    assert.equal(await (await fetcher(link ?? "")).text(), "12345")
    assert.equal(await files.downloadUrl(session, "fl_missing", 120), null)
  } finally {
    store.close()
  }
})

test("what arrives is held to the limits, whatever size was announced", async () => {
  const { store, session, files, objects, send } = conversation({ maxFileBytes: 10, maxSessionBytes: 12 })
  try {
    // Too large as announced: no link at all.
    await assert.rejects(files.receive(session, { name: "big.bin", size: 20, source: "agent", expiresSeconds: 120 }), (error) => error instanceof SavedFileLimitError && error.code === "file_too_large")

    // Announced small, sent large: measured after it arrived, and not kept.
    const sly = await files.receive(session, { name: "sly.bin", size: 4, source: "agent", expiresSeconds: 120 })
    assert.ok(sly)
    await send(sly.url, "x".repeat(11))
    await assert.rejects(sly.finish(), (error) => error instanceof SavedFileLimitError && error.code === "file_too_large")
    assert.deepEqual(files.list(session), [])
    assert.equal(objects.size, 0)

    // The conversation's total counts what arrived too.
    const kept = await files.add(session, { name: "notes.txt", bytes: bytesOf("12345678"), source: "agent" })
    const extra = await files.receive(session, { name: "extra.txt", size: 3, source: "agent", expiresSeconds: 120 })
    assert.ok(extra)
    await send(extra.url, "12345")
    await assert.rejects(extra.finish(), (error) => error instanceof SavedFileLimitError && error.code === "files_full")

    // A new version that doesn't fit leaves the kept version as it was.
    const next = await files.receive(session, { name: "notes.txt", size: 8, source: "agent", replaces: kept.id, expiresSeconds: 120 })
    assert.ok(next)
    await send(next.url, "x".repeat(11))
    await assert.rejects(next.finish(), SavedFileLimitError)
    assert.deepEqual(files.list(session).map((file) => [file.id, file.size]), [[kept.id, 8]])
    assert.equal(Buffer.from((await files.read(session, kept.id))?.bytes ?? []).toString(), "12345678")
    assert.deepEqual([...objects.keys()], [`sessions/${session}/${kept.id}`])
  } finally {
    store.close()
  }
})

test("a new version sent to a link replaces the file in place; when nothing arrives, nothing changes", async () => {
  const { store, session, files, objects, send } = conversation()
  try {
    const first = await files.add(session, { name: "deck.pptx", bytes: bytesOf("version one"), source: "agent" })
    await files.putPreview(session, first.id, [bytesOf("page")], { width: 10, height: 10 })

    const nothing = await files.receive(session, { name: "deck.pptx", size: 11, source: "agent", replaces: first.id, expiresSeconds: 120 })
    assert.equal(await nothing?.finish(), null)
    assert.equal(Buffer.from((await files.read(session, first.id))?.bytes ?? []).toString(), "version one")
    assert.ok(await files.readPreview(session, first.id))

    const place = await files.receive(session, { name: "deck.pptx", size: 11, source: "agent", replaces: first.id, expiresSeconds: 120 })
    assert.ok(place)
    await send(place.url, "the second version")
    const second = await place.finish()
    // Same file, new bytes and size, and its old preview is gone with the old bytes.
    assert.deepEqual([second?.id, second?.size], [first.id, 18])
    assert.deepEqual(files.list(session).map((file) => [file.id, file.size]), [[first.id, 18]])
    assert.equal(Buffer.from((await files.read(session, first.id))?.bytes ?? []).toString(), "the second version")
    assert.equal(await files.readPreview(session, first.id), null)
    assert.deepEqual([...objects.keys()], [`sessions/${session}/${first.id}`])

    // The file it was to replace is gone by the time it arrives: kept as a new file, like `replace` then `add`.
    const late = await files.receive(session, { name: "deck.pptx", size: 5, source: "agent", replaces: first.id, expiresSeconds: 120 })
    assert.ok(late)
    await files.delete(session, first.id)
    await send(late.url, "third")
    const third = await late.finish()
    assert.ok(third && third.id !== first.id)
    assert.deepEqual(files.list(session).map((file) => [file.id, file.size]), [[third.id, 5]])
  } finally {
    store.close()
  }
})

test("a disk store gives no links, so files keep going through the runner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saved-file-links-"))
  const store = new Store(nodeSqlite(":memory:"))
  try {
    const session = store.createSession({ owner: "test-owner", files: true }).id
    const files = new SavedFiles(store, diskBlobStore(directory), { maxFileBytes: 1_000, maxSessionBytes: 5_000 })
    const file = await files.add(session, { name: "notes.txt", bytes: bytesOf("on disk"), source: "user" })
    assert.equal(await files.downloadUrl(session, file.id, 120), null)
    assert.equal(await files.receive(session, { name: "out.txt", size: 3, source: "agent", expiresSeconds: 120 }), null)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
