import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeConnectLinkEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
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

  expect(noKey.status).toBe(0)
  expect(noKey.stdout.trim()).toBe("null")
  expect(legacyKey.status).toBe(0)
  expect(legacyKey.stdout.trim()).toBe("null")
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

  expect(incomplete.status).not.toBe(0)
  expect(incomplete.stderr).toContain("DEN_CONNECT_LINK_MODE=signed requires")
  expect(complete.status).toBe(0)
  expect(complete.stdout).toContain('"kid":"owc-test"')
})
