import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { diskBlobStore, s3BlobStore, type BlobStore } from "../src/blobs.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { DEFAULT_STORAGE_SETTINGS, SessionStorage } from "../src/storage/index.js"
import { Store } from "../src/store.js"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    "files-dir": { type: "string" },
    out: { type: "string" },
    target: { type: "string" },
    vacuum: { type: "boolean", default: false },
  },
})
const [command, sessionId] = positionals
const env = process.env
const dbPath = values.db ?? env.HEADLESS_DB_PATH ?? "./data/headless.sqlite"

function blobStore(): BlobStore | null {
  if (values["files-dir"]) return diskBlobStore(values["files-dir"])
  if (env.HEADLESS_FILES === "disk") return diskBlobStore(env.HEADLESS_FILES_DIR ?? join(dirname(dbPath), "files"))
  if (env.HEADLESS_FILES === "s3") {
    const s3 = z
      .object({ HEADLESS_S3_ENDPOINT: z.url(), HEADLESS_S3_BUCKET: z.string().min(1), HEADLESS_S3_ACCESS_KEY_ID: z.string().min(1), HEADLESS_S3_SECRET_ACCESS_KEY: z.string().min(1) })
      .parse(env)
    return s3BlobStore({
      endpoint: s3.HEADLESS_S3_ENDPOINT,
      region: env.HEADLESS_S3_REGION ?? "auto",
      bucket: s3.HEADLESS_S3_BUCKET,
      accessKeyId: s3.HEADLESS_S3_ACCESS_KEY_ID,
      secretAccessKey: s3.HEADLESS_S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.HEADLESS_S3_FORCE_PATH_STYLE === "true",
    })
  }
  return null
}

function usage(): never {
  console.error("usage: pnpm session <list|inspect|verify|seal|reseal|export|delete> [sessionId] [--db <path>] [--files-dir <dir>] [--out <file>] [--vacuum]")
  process.exit(2)
}

const store = new Store(nodeSqlite(dbPath))
if (store.migrationError) throw store.migrationError
const target = values.target ? Number(values.target) : Number(env.HEADLESS_SEGMENT_TARGET_BYTES ?? DEFAULT_STORAGE_SETTINGS.segmentTargetBytes)
const storage = new SessionStorage(store, blobStore(), {
  ...DEFAULT_STORAGE_SETTINGS,
  segments: true,
  segmentTargetBytes: target,
  contextCharBudget: Number(env.HEADLESS_CONTEXT_CHAR_BUDGET ?? DEFAULT_STORAGE_SETTINGS.contextCharBudget),
})
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
const needSession = () => {
  if (!sessionId) usage()
  if (!store.getSession(sessionId)) {
    console.error(`unknown session ${sessionId}`)
    process.exit(1)
  }
  return sessionId
}

try {
  switch (command) {
    case "list": {
      const rows = store.db.prepare("SELECT id, title, hot_bytes, (SELECT COUNT(*) FROM segments WHERE segments.session_id = sessions.id) AS segments FROM sessions ORDER BY updated_at DESC").all()
      print(rows.map((row) => z.object({ id: z.string(), title: z.string(), hot_bytes: z.number().nullable(), segments: z.number() }).parse(row)))
      break
    }
    case "inspect":
      print(storage.inspect(needSession()))
      break
    case "verify": {
      const results = await storage.verify(needSession())
      print(results)
      if (results.some((result) => !result.ok)) process.exitCode = 1
      break
    }
    case "seal":
      print({ sealed: await storage.sealAll(needSession()) })
      break
    case "reseal":
      print({ resealed: await storage.reseal(needSession()) })
      break
    case "export": {
      const conversation = await storage.exportConversation(needSession())
      const json = JSON.stringify({ format: "openwork-headless-conversation", version: 1, ...conversation })
      if (values.out) writeFileSync(values.out, json)
      else console.log(json)
      break
    }
    case "delete": {
      const id = needSession()
      if (store.activeTurn(id)) {
        console.error("a turn is still running in this session; stop it first")
        process.exit(1)
      }
      print({ deleted: await storage.deleteSession(id) })
      if (values.vacuum) store.db.exec("VACUUM")
      break
    }
    default:
      usage()
  }
} finally {
  store.close()
}
