import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_temp_files"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

seedRequiredEnv()

const config = {
  bucket: "openwork-temp-files",
  region: "eu-west-1",
  prefix: "temp-files/",
  forcePathStyle: false,
}

type SentCommand = { name: string; input: Record<string, unknown> }

function fakeClient(responses: { get?: unknown; error?: unknown } = {}) {
  const sent: SentCommand[] = []
  return {
    sent,
    client: {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: command.constructor.name, input: command.input })
        if (responses.error) throw responses.error
        if (command.constructor.name === "GetObjectCommand") return responses.get
        return {}
      },
    },
  }
}

let s3TempFileStorage: typeof import("../src/temp-file-storage-s3.js").s3TempFileStorage

beforeAll(async () => {
  s3TempFileStorage = (await import("../src/temp-file-storage-s3.js")).s3TempFileStorage
})

describe("s3 storage backend", () => {
  test("keys are prefixed and the tier is reported", () => {
    const { client } = fakeClient()
    const storage = s3TempFileStorage(config, client as never)
    expect(storage.tier).toBe("s3")
    expect(storage.keyFor("tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")).toBe("temp-files/tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")
  })

  test("uploads put the bytes into the configured bucket", async () => {
    const { client, sent } = fakeClient()
    const storage = s3TempFileStorage(config, client as never)
    await storage.put("temp-files/abc", new Uint8Array([1, 2, 3]).buffer)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.name).toBe("PutObjectCommand")
    expect(sent[0]?.input.Bucket).toBe("openwork-temp-files")
    expect(sent[0]?.input.Key).toBe("temp-files/abc")
    expect(new Uint8Array(sent[0]?.input.Body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("downloads return the stored bytes", async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const { client } = fakeClient({ get: { Body: { transformToByteArray: async () => bytes } } })
    const storage = s3TempFileStorage(config, client as never)

    const read = await storage.read("temp-files/abc")
    expect(new Uint8Array(read as ArrayBuffer)).toEqual(bytes)
  })

  // A bucket lifecycle rule can delete an object before the sweeper reaches
  // it, so a missing key is an expected state, not a failure.
  test("a missing key reads as null and deleting it is not an error", async () => {
    const missing = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" })
    const { client } = fakeClient({ error: missing })
    const storage = s3TempFileStorage(config, client as never)

    expect(await storage.read("temp-files/gone")).toBeNull()
    await storage.delete("temp-files/gone")
  })

  test("an unexpected storage error is not swallowed", async () => {
    const denied = Object.assign(new Error("AccessDenied"), { name: "AccessDenied" })
    const { client } = fakeClient({ error: denied })
    const storage = s3TempFileStorage(config, client as never)

    await expect(storage.read("temp-files/abc")).rejects.toThrow("AccessDenied")
    await expect(storage.delete("temp-files/abc")).rejects.toThrow("AccessDenied")
  })

  test("path-style addressing is available for S3-compatible services", async () => {
    const { client, sent } = fakeClient()
    const storage = s3TempFileStorage({ ...config, forcePathStyle: true, endpoint: "http://127.0.0.1:9000" }, client as never)
    await storage.put(storage.keyFor("tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3"), new Uint8Array([1]).buffer)
    expect(sent[0]?.input.Key).toBe("temp-files/tmpf_01k2p3q4r5s6t7u8v9w0x1y2z3")
  })
})
