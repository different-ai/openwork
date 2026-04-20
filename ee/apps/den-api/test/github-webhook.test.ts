import { afterEach, beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let envModule: typeof import("../src/env.js")
let githubModule: typeof import("../src/routes/webhooks/github.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  githubModule = await import("../src/routes/webhooks/github.js")
})

afterEach(() => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
})

function createWebhookApp() {
  const app = new Hono()
  githubModule.registerGithubWebhookRoutes(app)
  return app
}

test("webhook route rejects invalid signatures before JSON parsing", async () => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
  const app = createWebhookApp()
  const response = await app.request("http://den.local/api/webhooks/connectors/github", {
    body: "{",
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=wrong",
    },
    method: "POST",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ ok: false, error: "invalid signature" })
})

test("webhook route returns 503 when the GitHub webhook secret is unset", async () => {
  envModule.env.githubConnectorApp.webhookSecret = undefined
  const app = createWebhookApp()
  const response = await app.request("http://den.local/api/webhooks/connectors/github", {
    body: "{}",
    headers: {
      "x-github-delivery": "delivery-2",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=unused",
    },
    method: "POST",
  })

  expect(response.status).toBe(503)
})

test("webhook route accepts a valid signature and ignores unbound deliveries cleanly", async () => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
  const app = createWebhookApp()
  const payload = JSON.stringify({
    after: "abc123",
    ref: "refs/heads/main",
    repository: {
      full_name: "different-ai/openwork",
      id: 42,
    },
  })

  const response = await app.request("http://den.local/api/webhooks/connectors/github", {
    body: payload,
    headers: {
      "x-github-delivery": "delivery-3",
      "x-github-event": "push",
      "x-hub-signature-256": githubModule.signGithubBody(payload, "super-secret"),
    },
    method: "POST",
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    ok: true,
    accepted: false,
    reason: "missing installation id",
  })
})
