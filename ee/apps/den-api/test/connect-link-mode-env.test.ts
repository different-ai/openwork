import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeConnectLinkEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify(env.connectLink))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...overrides,
    },
  })
}

test("connect links default to keyless exchange even when legacy key values exist", () => {
  const noKey = probeConnectLinkEnv({})
  const legacyKey = probeConnectLinkEnv({
    DEN_CONNECT_LINK_KEY_ID: "legacy-key",
    DEN_CONNECT_LINK_PRIVATE_KEY: "legacy-private-key",
  })

  assert.equal(noKey.status, 0)
  assert.equal(noKey.stdout.trim(), "null")
  assert.equal(legacyKey.status, 0)
  assert.equal(legacyKey.stdout.trim(), "null")
})

test("signed mode is explicit and fails closed unless both key values exist", () => {
  const incomplete = probeConnectLinkEnv({
    DEN_CONNECT_LINK_MODE: "signed",
    DEN_CONNECT_LINK_KEY_ID: "owc-test",
  })
  const complete = probeConnectLinkEnv({
    DEN_CONNECT_LINK_MODE: "signed",
    DEN_CONNECT_LINK_KEY_ID: "owc-test",
    DEN_CONNECT_LINK_PRIVATE_KEY: "test-private-key",
  })

  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /DEN_CONNECT_LINK_MODE=signed requires/)
  assert.equal(complete.status, 0)
  assert.match(complete.stdout, /"kid":"owc-test"/)
})

test("numeric environment values are coerced and bounded", () => {
  const valid = probeConnectLinkEnv({
    DAYTONA_SANDBOX_CPU: "2.5",
    PORT: "8790",
    WORKER_PROVISIONING_RECONCILE_BATCH_SIZE: "25",
  })
  const invalidPort = probeConnectLinkEnv({ PORT: "70000" })
  const invalidBatch = probeConnectLinkEnv({ WORKER_PROVISIONING_RECONCILE_BATCH_SIZE: "0" })

  assert.equal(valid.status, 0)
  assert.notEqual(invalidPort.status, 0)
  assert.match(invalidPort.stderr, /PORT/)
  assert.notEqual(invalidBatch.status, 0)
  assert.match(invalidBatch.stderr, /WORKER_PROVISIONING_RECONCILE_BATCH_SIZE/)
})
