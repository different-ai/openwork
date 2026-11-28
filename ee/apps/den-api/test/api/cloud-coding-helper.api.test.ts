import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { OPENWORK_CODE_HELPER_SOURCE } from "../../src/cloud-coding/helper/openwork-code-source.js"
import { bootDen } from "./harness.js"

test("Den serves the exact helper source without authentication or caching", async (t) => {
  const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", GITHUB_CLOUD_CODING_APP_ID: "" } })
  t.after(() => den.close())
  const response = await den.request(null, "GET", "/v1/cloud-coding/gateway/helper.mjs")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8")
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.text, OPENWORK_CODE_HELPER_SOURCE)
  const { auth } = await import("../../src/auth.js")
  await auth.$context
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: response.text })
})
