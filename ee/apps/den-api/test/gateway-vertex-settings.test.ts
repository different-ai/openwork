import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-vertex-settings-test-key-00000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-vertex-settings-test-secret-00000"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const { GatewayWriteError, validateGatewaySettings } = await import("../src/llm/gateway-matrix.js")

for (const npm of ["@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic"]) {
  test(`${npm} accepts multi-region, global and regional destinations`, () => {
    for (const location of ["eu", "us", "global", "europe-west4"]) {
      for (const project of ["example-project", "123456789012"]) {
        assert.doesNotThrow(() => validateGatewaySettings({ npm }, { project, location }))
      }
    }
  })

  test(`${npm} still rejects invalid destinations`, () => {
    for (const settings of [
      { project: "example-project", location: "europe" },
      { project: "example-project", location: "eu.example.com" },
      { project: "example-project", location: "eu/locations/global" },
      { project: "bad/project", location: "eu" },
      { project: "short", location: "eu" },
      { project: "example-project" },
    ]) {
      assert.throws(() => validateGatewaySettings({ npm }, settings), (error: unknown) =>
        error instanceof GatewayWriteError && error.code === "invalid_settings" && error.status === 400)
    }
  })
}
