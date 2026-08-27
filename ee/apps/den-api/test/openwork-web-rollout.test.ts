import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeOpenWorkWeb(value?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({ enabled: env.openworkWebEnabled }))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      DEN_ORG_MODE: "single_org",
      STRIPE_SECRET_KEY: "sk_test_configured",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_web_configured",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(value === undefined ? {} : { DEN_OPENWORK_WEB_ENABLED: value }),
    },
  })
}

test("OpenWork Web availability fails closed unless the deployment flag is true", () => {
  const unset = probeOpenWorkWeb()
  const disabled = probeOpenWorkWeb("false")
  const enabled = probeOpenWorkWeb("true")
  const malformed = probeOpenWorkWeb("enabled")

  expect(unset.status, unset.stderr).toBe(0)
  expect(unset.stdout.trim()).toBe('{"enabled":false}')
  expect(disabled.status, disabled.stderr).toBe(0)
  expect(disabled.stdout.trim()).toBe('{"enabled":false}')
  expect(enabled.status, enabled.stderr).toBe(0)
  expect(enabled.stdout.trim()).toBe('{"enabled":true}')
  expect(malformed.status, malformed.stderr).toBe(0)
  expect(malformed.stdout.trim()).toBe('{"enabled":false}')
})
