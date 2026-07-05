import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let resolveInstallerArtifact: typeof import("../src/utils/installer-artifacts.js")["resolveInstallerArtifact"]

beforeAll(async () => {
  seedRequiredEnv()
  ;({ resolveInstallerArtifact } = await import("../src/utils/installer-artifacts.js"))
})

const FILE_NAME = "openwork-installer-mac-arm64.zip"

function tempDir(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fetcherReturning(status: number, body: string | null, calls: string[]) {
  return (url: string) => {
    calls.push(url)
    return Promise.resolve(new Response(body, { status }))
  }
}

describe("resolveInstallerArtifact", () => {
  test("prefers the local artifacts dir over cache and network", async () => {
    const artifactsDir = tempDir("ow-installer-artifacts-dir-")
    const cacheDir = tempDir("ow-installer-cache-")
    writeFileSync(path.join(artifactsDir, FILE_NAME), "from-artifacts-dir")
    mkdirSync(path.join(cacheDir, "v9.9.9"), { recursive: true })
    writeFileSync(path.join(cacheDir, "v9.9.9", FILE_NAME), "from-cache")
    const calls: string[] = []

    const resolved = await resolveInstallerArtifact(FILE_NAME, {
      artifactsDir,
      cacheDir,
      releaseTag: "v9.9.9",
      releaseRepo: "different-ai/openwork",
      fetcher: fetcherReturning(200, "from-network", calls),
    })

    expect(resolved?.toString("utf8")).toBe("from-artifacts-dir")
    expect(calls).toEqual([])
  })

  test("serves the disk cache without touching the network", async () => {
    const cacheDir = tempDir("ow-installer-cache-")
    mkdirSync(path.join(cacheDir, "v9.9.9"), { recursive: true })
    writeFileSync(path.join(cacheDir, "v9.9.9", FILE_NAME), "from-cache")
    const calls: string[] = []

    const resolved = await resolveInstallerArtifact(FILE_NAME, {
      cacheDir,
      releaseTag: "v9.9.9",
      releaseRepo: "different-ai/openwork",
      fetcher: fetcherReturning(200, "from-network", calls),
    })

    expect(resolved?.toString("utf8")).toBe("from-cache")
    expect(calls).toEqual([])
  })

  test("downloads the release asset once and fills the cache", async () => {
    const cacheDir = tempDir("ow-installer-cache-")
    const calls: string[] = []
    const options = {
      cacheDir,
      releaseTag: "v9.9.9",
      releaseRepo: "different-ai/openwork",
      fetcher: fetcherReturning(200, "from-network", calls),
    }

    const [first, second] = await Promise.all([
      resolveInstallerArtifact(FILE_NAME, options),
      resolveInstallerArtifact(FILE_NAME, options),
    ])
    expect(first?.toString("utf8")).toBe("from-network")
    expect(second?.toString("utf8")).toBe("from-network")
    // Concurrent callers share one in-flight download.
    expect(calls).toEqual([`https://github.com/different-ai/openwork/releases/download/v9.9.9/${FILE_NAME}`])
    expect(readFileSync(path.join(cacheDir, "v9.9.9", FILE_NAME), "utf8")).toBe("from-network")

    // The follow-up request is a cache hit, still no extra network call.
    const third = await resolveInstallerArtifact(FILE_NAME, options)
    expect(third?.toString("utf8")).toBe("from-network")
    expect(calls.length).toBe(1)
  })

  test("resolves null when the release asset is missing (404)", async () => {
    const cacheDir = tempDir("ow-installer-cache-")
    const calls: string[] = []

    const resolved = await resolveInstallerArtifact(FILE_NAME, {
      cacheDir,
      releaseTag: "v0.0.0-missing",
      releaseRepo: "different-ai/openwork",
      fetcher: fetcherReturning(404, null, calls),
    })

    expect(resolved).toBeNull()
    expect(calls.length).toBe(1)
  })
})
