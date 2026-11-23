import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveReleaseSecret } from "@openwork/free-auto/node"
import { createDesktopFreeSigner } from "../../../../../apps/desktop/electron/desktop-free-signer.mjs"
import type { TestContext } from "node:test"

export async function fixtureDesktopSigner(t: TestContext, releaseKey: string) {
  const dir = await mkdtemp(join(tmpdir(), "ow-desktop-grant-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const version = "1.2.3"
  return createDesktopFreeSigner({ filePath: join(dir, "identity"), platform: "darwin", arch: "arm64", appVersion: version,
    readMachineId: async () => "a".repeat(64), releaseSecret: async () => deriveReleaseSecret(releaseKey, version),
    isEligible: () => true, loadSafeStorage: () => ({ isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value: string) => Buffer.from(value), decryptStringAsync: async (value: Buffer) => ({ result: value.toString() }) }) })
}
