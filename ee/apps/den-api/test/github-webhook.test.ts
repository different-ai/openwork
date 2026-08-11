import assert from "node:assert/strict"
import { afterEach, before, test } from "node:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let envModule: typeof import("../src/env.js")
let githubModule: typeof import("../src/routes/webhooks/github.js")

before(async () => {
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

function assertInvalidRequestBody(body: unknown) {
  assert.ok(typeof body === "object" && body !== null && "error" in body)
  assert.equal(body.error, "invalid_request")
}

test("webhook route rejects invalid signatures before JSON parsing", async () => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
  const app = createWebhookApp()
  const response = await app.request("http://den.local/v1/webhooks/connectors/github", {
    body: "{",
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=wrong",
    },
    method: "POST",
  })

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { ok: false, error: "invalid signature" })
})

test("webhook route returns 503 when the GitHub webhook secret is unset", async () => {
  envModule.env.githubConnectorApp.webhookSecret = undefined
  const app = createWebhookApp()
  const response = await app.request("http://den.local/v1/webhooks/connectors/github", {
    body: "{}",
    headers: {
      "x-github-delivery": "delivery-2",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=unused",
    },
    method: "POST",
  })

  assert.equal(response.status, 503)
})

test("webhook route rejects signed malformed JSON payloads", async () => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
  const app = createWebhookApp()
  const payload = "{"
  const response = await app.request("http://den.local/v1/webhooks/connectors/github", {
    body: payload,
    headers: {
      "x-github-delivery": "delivery-malformed-json",
      "x-github-event": "push",
      "x-hub-signature-256": githubModule.signGithubBody(payload, "super-secret"),
    },
    method: "POST",
  })

  assert.equal(response.status, 400)
  assertInvalidRequestBody(await response.json())
})

test("webhook route rejects signed payloads with invalid GitHub metadata", async () => {
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
  const app = createWebhookApp()
  const payload = JSON.stringify({ installation: { id: "not-a-number" } })
  const response = await app.request("http://den.local/v1/webhooks/connectors/github", {
    body: payload,
    headers: {
      "x-github-delivery": "delivery-invalid-metadata",
      "x-github-event": "installation",
      "x-hub-signature-256": githubModule.signGithubBody(payload, "super-secret"),
    },
    method: "POST",
  })

  assert.equal(response.status, 400)
  assertInvalidRequestBody(await response.json())
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

  const response = await app.request("http://den.local/v1/webhooks/connectors/github", {
    body: payload,
    headers: {
      "x-github-delivery": "delivery-3",
      "x-github-event": "push",
      "x-hub-signature-256": githubModule.signGithubBody(payload, "super-secret"),
    },
    method: "POST",
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "missing installation id",
  })
})
