import { expect, test } from "bun:test"
import { PUBLISHED_DESKTOP_VERSIONS } from "../src/generated/desktop-versions.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
}

test("static desktop release metadata uses the committed snapshot", async () => {
  seedRequiredEnv()

  const { getDesktopReleaseMetadata } = await import("../src/desktop-releases.js")
  const metadata = await getDesktopReleaseMetadata()
  expect(metadata.latestAppVersion).toBe(PUBLISHED_DESKTOP_VERSIONS[0])
  expect(metadata.publishedDesktopVersions).toEqual([...PUBLISHED_DESKTOP_VERSIONS])
})

test("GET /v1/app-version advertises the deployment web app base URL", async () => {
  seedRequiredEnv()

  const { Hono } = await import("hono")
  const { registerVersionRoutes } = await import("../src/routes/version/index.js")
  const { env } = await import("../src/env.js")

  const app = new Hono()
  registerVersionRoutes(app)

  const response = await app.request("/v1/app-version")
  expect(response.status).toBe(200)

  const payload = await response.json() as Record<string, unknown>
  // Desktop clients configured with only the API URL discover the web app from here.
  expect(payload.webUrl).toBe(env.webUrl)
  expect(payload.latestAppVersion).toBe(PUBLISHED_DESKTOP_VERSIONS[0])
})
