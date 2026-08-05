import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/micx_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let workerModule: typeof import("../src/workers/github-sync.js")
let githubModule: typeof import("../src/routes/org/plugin-system/github-app.js")

beforeAll(async () => {
  seedRequiredEnv()
  workerModule = await import("../src/workers/github-sync.js")
  githubModule = await import("../src/routes/org/plugin-system/github-app.js")
})

test("GitHub sync backoff applies exponential jitter bounds and the 15 minute cap", () => {
  expect(workerModule.computeGithubSyncBackoffMs(1, 30_000, () => 0)).toBe(24_000)
  expect(workerModule.computeGithubSyncBackoffMs(1, 30_000, () => 1)).toBe(36_000)
  expect(workerModule.computeGithubSyncBackoffMs(2, 30_000, () => 0)).toBe(48_000)
  expect(workerModule.computeGithubSyncBackoffMs(11, 30_000, () => 1)).toBe(900_000)
})

test("GitHub sync transient error classification covers rate limits, server failures, and network errors", () => {
  expect(workerModule.isTransientGithubSyncError(new githubModule.GithubConnectorRequestError("rate limited", 429))).toBe(true)
  expect(workerModule.isTransientGithubSyncError(new githubModule.GithubConnectorRequestError("unavailable", 503))).toBe(true)
  expect(workerModule.isTransientGithubSyncError(new githubModule.GithubConnectorRequestError("bad request", 400))).toBe(false)
  expect(workerModule.isTransientGithubSyncError(new TypeError("fetch failed"))).toBe(true)

  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  expect(workerModule.isTransientGithubSyncError(abortError)).toBe(true)
  expect(workerModule.isTransientGithubSyncError(new Error("permanent"))).toBe(false)
})
