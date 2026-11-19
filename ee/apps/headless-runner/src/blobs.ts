import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { AwsClient } from "aws4fetch"

/**
 * Where saved files' bytes live. The runner keeps each file's name, type and owner in SQLite and only the
 * bytes here: a folder on the runner's disk (development and single-disk installs), or any S3-compatible bucket
 * (AWS S3, Cloudflare R2, MinIO, Tigris, Backblaze B2, Google Cloud Storage's XML API), which every host can share.
 * Files are optional: with no store configured, the file routes and tools are simply not offered.
 *
 * Keys are `sessions/<sessionId>/<fileId>` (plus `.preview/...` for page images); the runner only ever reads a
 * key it recorded for that session, so one conversation can never name another's bytes.
 */
export type BlobStore = {
  kind: "disk" | "s3"
  put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>
  /** Null when the object does not exist. */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>
  delete(key: string): Promise<void>
  /**
   * Every object under a prefix, with when it was last written (epoch ms): for orphan cleanup of sealed segments and
   * large bodies (storage/), which deletes only old objects nothing references. Optional for test stores.
   */
  list?(prefix: string): Promise<Array<{ key: string; lastModified: number }>>
  /**
   * Moving bytes without holding them (S3 only; a disk store has none of these). `link` is an address for one object
   * and one method that stops working after `expiresSeconds`: it carries a signature, never the store's credentials,
   * so it can be handed to a conversation's computer. `size` and `copy` let the runner check and keep what arrived.
   */
  link?(method: "GET" | "PUT", key: string, expiresSeconds: number): Promise<string>
  /** An object's size in bytes; null when it does not exist. */
  size?(key: string): Promise<number | null>
  /** Copies an object inside the store, giving the copy this content type. */
  copy?(from: string, to: string, contentType: string): Promise<void>
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
    async list(prefix) {
      const folder = prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix)
      const found: Array<{ key: string; lastModified: number }> = []
      let entries: string[]
      try {
        entries = await readdir(pathOf(folder), { recursive: true })
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
        throw error
      }
      for (const entry of entries) {
        const key = `${folder}/${entry.split(sep).join("/")}`
        if (!key.startsWith(prefix)) continue
        const info = await stat(pathOf(key)).catch(() => null)
        if (info?.isFile()) found.push({ key, lastModified: info.mtimeMs })
      }
      return found
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
  const send = async (method: string, key: string, init: { body?: Uint8Array<ArrayBuffer>; contentType?: string; headers?: Record<string, string> } = {}) => {
    const request = await client.sign(urlOf(key), {
      method,
      ...(init.body ? { body: init.body } : {}),
      headers: { ...init.headers, ...(init.contentType ? { "content-type": init.contentType } : {}) },
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
    // A presigned URL: the signature is in the query, bound to this object, this method and the expiry.
    async link(method, key, expiresSeconds) {
      const url = new URL(urlOf(key))
      url.searchParams.set("X-Amz-Expires", String(Math.max(1, Math.round(expiresSeconds))))
      return (await client.sign(url.toString(), { method, aws: { signQuery: true } })).url
    },
    async size(key) {
      const response = await send("HEAD", key)
      await response.body?.cancel()
      if (response.status === 404) return null
      const length = response.headers.get("content-length")
      if (!response.ok || length === null || !/^\d+$/.test(length)) throw new Error(`s3_head_${response.status}`)
      return Number(length)
    },
    // CopyObject; the copy's metadata is replaced so it gets this content type, whatever the source was sent with.
    async copy(from, to, contentType) {
      const source = `/${encodeURIComponent(options.bucket)}/${safeKey(from).split("/").map(encodeURIComponent).join("/")}`
      const response = await send("PUT", to, { contentType, headers: { "x-amz-copy-source": source, "x-amz-metadata-directive": "REPLACE" } })
      if (!response.ok) throw await fail("copy", response)
      // A copy can fail after the 200 was sent: the error is then in the body.
      const body = await response.text()
      if (/<Error>/.test(body)) throw new Error(`s3_copy_failed: ${body.slice(0, 300)}`)
    },
    // ListObjectsV2, page by page.
    async list(prefix) {
      safeKey(prefix.replace(/\/$/, ""))
      const bucketUrl = options.forcePathStyle ? `${base.origin}/${encodeURIComponent(options.bucket)}` : `${base.protocol}//${options.bucket}.${base.host}/`
      const found: Array<{ key: string; lastModified: number }> = []
      let token: string | null = null
      for (let page = 0; page < 1_000; page += 1) {
        const url = new URL(bucketUrl)
        url.searchParams.set("list-type", "2")
        url.searchParams.set("prefix", prefix)
        if (token) url.searchParams.set("continuation-token", token)
        const request = await client.sign(url.toString(), { method: "GET" })
        const response = await (options.fetch ?? fetch)(request, { signal: AbortSignal.timeout(S3_TIMEOUT_MS) })
        if (!response.ok) throw await fail("list", response)
        const xml = await response.text()
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlText(/<Key>([\s\S]*?)<\/Key>/.exec(match[1] ?? "")?.[1])
          const modified = Date.parse(xmlText(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(match[1] ?? "")?.[1]))
          if (key) found.push({ key, lastModified: Number.isFinite(modified) ? modified : 0 })
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]) || null : null
        if (!token) break
      }
      return found
    },
  }
}

function xmlText(value: string | undefined) {
  return (value ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&")
}
