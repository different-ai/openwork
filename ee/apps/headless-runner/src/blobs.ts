import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { AwsClient } from "aws4fetch"

/**
 * Where saved files' bytes live. The runner keeps each file's name, type and owner in SQLite and only the
 * bytes here, so any backend works: a folder on the runner's disk, any S3-compatible bucket (AWS S3,
 * Cloudflare R2, MinIO, Tigris, Backblaze B2, Google Cloud Storage's XML API), or a private Vercel Blob store.
 * Files are optional: with no store configured, the file routes and tools are simply not offered.
 *
 * Keys are `sessions/<sessionId>/<fileId>` (plus `.preview/...` for page images); the runner only ever reads a
 * key it recorded for that session, so one conversation can never name another's bytes.
 */
export type BlobStore = {
  kind: "disk" | "s3" | "vercel"
  put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>
  /** Null when the object does not exist. */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>
  delete(key: string): Promise<void>
}

/** Keys are runner-generated (`sessions/<id>/<fileId>`); this only guards against a key escaping the folder. */
function safeKey(key: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some((part) => part === ".." || part === "")) throw new Error("invalid_blob_key")
  return key
}

export function diskBlobStore(directory: string): BlobStore {
  const root = resolve(directory)
  const pathOf = (key: string) => {
    const path = resolve(join(root, safeKey(key)))
    if (!path.startsWith(root + sep)) throw new Error("invalid_blob_key")
    return path
  }
  return {
    kind: "disk",
    async put(key, bytes) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)))
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
        throw error
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
  }
}

export type S3Options = {
  /** e.g. https://<account>.r2.cloudflarestorage.com, https://s3.us-east-1.amazonaws.com, http://127.0.0.1:9000 */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. MinIO and most self-hosted stores need it. */
  forcePathStyle: boolean
  fetch?: typeof fetch
}

const S3_TIMEOUT_MS = 120_000

/** Any S3-compatible bucket, signed with SigV4. No provider SDK, so it runs the same on Node and Workers runtimes. */
export function s3BlobStore(options: S3Options): BlobStore {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  })
  const base = new URL(options.endpoint)
  const urlOf = (key: string) => {
    const path = safeKey(key).split("/").map(encodeURIComponent).join("/")
    if (options.forcePathStyle) return `${base.origin}/${encodeURIComponent(options.bucket)}/${path}`
    return `${base.protocol}//${options.bucket}.${base.host}/${path}`
  }
  const send = async (method: string, key: string, init: { body?: Uint8Array<ArrayBuffer>; contentType?: string } = {}) => {
    const request = await client.sign(urlOf(key), {
      method,
      ...(init.body ? { body: init.body } : {}),
      headers: init.contentType ? { "content-type": init.contentType } : {},
    })
    return (options.fetch ?? fetch)(request, { signal: AbortSignal.timeout(S3_TIMEOUT_MS) })
  }
  const fail = async (action: string, response: Response) => {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    return new Error(`s3_${action}_${response.status}${detail ? `: ${detail}` : ""}`)
  }
  return {
    kind: "s3",
    async put(key, bytes, contentType) {
      const response = await send("PUT", key, { body: bytes, contentType })
      if (!response.ok) throw await fail("put", response)
      await response.body?.cancel()
    },
    async get(key) {
      const response = await send("GET", key)
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw await fail("get", response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async delete(key) {
      const response = await send("DELETE", key)
      if (!response.ok && response.status !== 404) throw await fail("delete", response)
      await response.body?.cancel()
    },
  }
}

const VERCEL_BLOB_TIMEOUT_MS = 120_000
/** Larger uploads go in parallel parts, as Vercel recommends for big files. */
const VERCEL_MULTIPART_BYTES = 64 * 1024 * 1024

/**
 * A private Vercel Blob store (`HEADLESS_FILES=vercel`): every read and write needs its read-write token, which is
 * scoped to that one store. The token is always passed explicitly, so the SDK never falls back to whatever
 * BLOB_READ_WRITE_TOKEN or OIDC credentials happen to be in the environment. Reads skip the CDN cache so a file
 * revised in place is never served stale. The SDK is loaded only when this store is configured.
 */
export async function vercelBlobStore(options: { token: string }): Promise<BlobStore> {
  const { del, get, put } = await import("@vercel/blob")
  const { token } = options
  const signal = () => AbortSignal.timeout(VERCEL_BLOB_TIMEOUT_MS)
  return {
    kind: "vercel",
    async put(key, bytes, contentType) {
      await put(safeKey(key), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: "private",
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: bytes.byteLength > VERCEL_MULTIPART_BYTES,
        abortSignal: signal(),
      })
    },
    async get(key) {
      const result = await get(safeKey(key), { access: "private", token, useCache: false, abortSignal: signal() })
      if (!result || result.statusCode !== 200 || !result.stream) return null
      return new Uint8Array(await new Response(result.stream).arrayBuffer())
    },
    async delete(key) {
      // Succeeds when the blob is already gone.
      await del(safeKey(key), { token, abortSignal: signal() })
    },
  }
}
