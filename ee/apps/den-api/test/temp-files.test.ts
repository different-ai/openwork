import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createTempFileToken,
  createTempFileTokenPair,
  hashTempFileToken,
  resolveTempFileContentType,
  sanitizeTempFilename,
  TEMP_FILE_DIGEST_PATTERN,
  tempFileContentUrl,
  tempFileDigest,
  tempFileExpiresAt,
  tempFileUri,
  verifyTempFileToken,
} from "../src/temp-files.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_temp_files"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

seedRequiredEnv()

let directory = ""
let volumeTempFileStorage: typeof import("../src/temp-file-storage.js").volumeTempFileStorage

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "openwork-temp-file-test-"))
  volumeTempFileStorage = (await import("../src/temp-file-storage.js")).volumeTempFileStorage
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("temporary file tokens", () => {
  test("tokens are unguessable and distinct per slot", () => {
    const pair = createTempFileTokenPair()
    expect(pair.uploadToken).not.toBe(pair.downloadToken)
    expect(pair.uploadTokenHash).not.toBe(pair.downloadTokenHash)
    // 32 random bytes render as 43 base64url characters.
    expect(pair.uploadToken).toHaveLength(43)
    expect(pair.uploadTokenHash).toBe(hashTempFileToken(pair.uploadToken))
    expect(pair.downloadTokenHash).toBe(hashTempFileToken(pair.downloadToken))
  })

  test("verification accepts the matching token and rejects everything else", () => {
    const token = createTempFileToken()
    const hash = hashTempFileToken(token)
    expect(verifyTempFileToken(token, hash)).toBe(true)
    expect(verifyTempFileToken(createTempFileToken(), hash)).toBe(false)
    expect(verifyTempFileToken(undefined, hash)).toBe(false)
    expect(verifyTempFileToken("", hash)).toBe(false)
    // A truncated stored hash must not be accepted by a length-tolerant compare.
    expect(verifyTempFileToken(token, hash.slice(0, 32))).toBe(false)
  })

  test("the upload token does not open the download URL", () => {
    const pair = createTempFileTokenPair()
    expect(verifyTempFileToken(pair.uploadToken, pair.downloadTokenHash)).toBe(false)
    expect(verifyTempFileToken(pair.downloadToken, pair.uploadTokenHash)).toBe(false)
  })
})

describe("temporary file expiry and naming", () => {
  test("expiry is the mint time plus the configured lifetime", () => {
    const now = new Date("2026-08-13T10:00:00.000Z")
    expect(tempFileExpiresAt(now, 86_400).toISOString()).toBe("2026-08-14T10:00:00.000Z")
  })

  test("filenames cannot traverse directories or break the content-disposition header", () => {
    expect(sanitizeTempFilename("../../etc/passwd")).toBe("passwd")
    expect(sanitizeTempFilename("report.pdf")).toBe("report.pdf")
    expect(sanitizeTempFilename('quarterly"report.pdf')).toBe("quarterlyreport.pdf")
    expect(sanitizeTempFilename("bad\r\nname.txt")).toBe("badname.txt")
    expect(sanitizeTempFilename("/")).toBe("download")
    expect(sanitizeTempFilename("   ")).toBe("download")
  })

  test("content URLs carry the token as a query parameter", () => {
    const url = new URL(tempFileContentUrl({
      baseUrl: "https://den.example.com",
      fileId: "tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3",
      token: "token-value",
    }))
    expect(url.pathname).toBe("/v1/temporary-files/tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3/content")
    expect(url.searchParams.get("token")).toBe("token-value")
  })
})

describe("content type resolution", () => {
  test("a declared type wins", () => {
    expect(resolveTempFileContentType({ declared: "application/pdf", filename: "r.bin" })).toBe("application/pdf")
  })

  test("the filename extension is used when nothing specific was declared", () => {
    expect(resolveTempFileContentType({ filename: "report.pdf" })).toBe("application/pdf")
    expect(resolveTempFileContentType({ declared: "application/octet-stream", filename: "sheet.xlsx" }))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  })

  // curl sends application/x-www-form-urlencoded by default for --data-binary,
  // so adopting it would hand every plain-curl upload a wrong type.
  test("curl's default form content type never wins", () => {
    expect(resolveTempFileContentType({
      declared: "application/octet-stream",
      filename: "report.pdf",
      uploaded: "application/x-www-form-urlencoded",
    })).toBe("application/pdf")
    expect(resolveTempFileContentType({
      filename: "payload",
      uploaded: "application/x-www-form-urlencoded",
    })).toBe("application/octet-stream")
  })

  test("a specific type on the upload is used when nothing better is known", () => {
    expect(resolveTempFileContentType({ filename: "payload", uploaded: "image/heic; charset=binary" })).toBe("image/heic")
  })

  test("an unknown extension falls back to the opaque default", () => {
    expect(resolveTempFileContentType({ filename: "archive.zzz" })).toBe("application/octet-stream")
  })
})

describe("volume storage backend", () => {
  test("round-trips bytes, reports a missing key, and tolerates repeat deletes", async () => {
    const storage = volumeTempFileStorage(path.join(directory, "nested"))
    const key = storage.keyFor("tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]).buffer

    expect(await storage.read(key)).toBeNull()
    await storage.put(key, bytes)

    const stored = await storage.read(key)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(stored as ArrayBuffer)).toEqual(new Uint8Array(bytes))
    // Bytes land on disk, never in a database column.
    expect(await readFile(path.join(directory, "nested", key))).toHaveLength(6)

    await storage.delete(key)
    expect(await storage.read(key)).toBeNull()
    await storage.delete(key)
  })

  test("the tier is reported so a mint response can name it", () => {
    expect(volumeTempFileStorage(directory).tier).toBe("volume")
  })
})

describe("file digest and handle", () => {
  // Base64url without padding is what the MCP file-transfer proposal specifies,
  // and it survives a URL or a header unescaped.
  test("the digest is unpadded base64url sha-256", () => {
    const digest = tempFileDigest(new Uint8Array([1, 2, 3]).buffer)
    expect(digest).toBe(createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("base64url"))
    expect(digest).toMatch(TEMP_FILE_DIGEST_PATTERN)
    expect(digest).not.toContain("=")
    expect(digest).not.toContain("+")
    expect(digest).not.toContain("/")
  })

  test("different bytes produce different digests", () => {
    expect(tempFileDigest(new Uint8Array([1]).buffer)).not.toBe(tempFileDigest(new Uint8Array([2]).buffer))
  })

  // A file handle is not a resource URI: keeping its own scheme stops a client
  // from trying to read it through resources/read.
  test("the file handle uses a scheme of its own", () => {
    expect(tempFileUri("tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")).toBe("mcp-file://openwork/tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")
    expect(new URL(tempFileUri("tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")).protocol).toBe("mcp-file:")
  })
})
