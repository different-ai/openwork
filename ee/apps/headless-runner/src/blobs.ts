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
