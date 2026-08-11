import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const workerProxyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({ port: env.port, openworkPort: env.daytona.openworkPort, previewTtl: env.daytona.signedPreviewExpiresSeconds }))
  `], {
    cwd: workerProxyRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      ...overrides,
    },
  })
}

test("worker proxy numeric environment values are coerced and bounded", () => {
  const valid = probeEnv({
    DAYTONA_OPENWORK_PORT: "8787",
    DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: "86400",
    PORT: "8789",
  })
  const invalidPort = probeEnv({ PORT: "0" })
  const invalidTtl = probeEnv({ DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: "0" })

  assert.equal(valid.status, 0)
  assert.match(valid.stdout, /"port":8789/)
  assert.notEqual(invalidPort.status, 0)
  assert.match(invalidPort.stderr, /PORT/)
  assert.notEqual(invalidTtl.status, 0)
  assert.match(invalidTtl.stderr, /DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS/)
})
