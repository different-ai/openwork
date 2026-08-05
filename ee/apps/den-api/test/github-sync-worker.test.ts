import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
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
  expect(workerModule.isTransientGithubSyncError(new Error("wrapped", {
    cause: new githubModule.GithubConnectorRequestError("rate limited", 429),
  }))).toBe(true)

  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  expect(workerModule.isTransientGithubSyncError(abortError)).toBe(true)
  expect(workerModule.isTransientGithubSyncError(new Error("permanent"))).toBe(false)
})

test("GitHub reconcile selection prioritizes never-probed targets, orders old probes, and respects the batch cap deterministically", () => {
  const input = {
    batchSize: 4,
    lastProbedAtMs: new Map([
      ["probed-new", 3_000],
      ["probed-old-b", 1_000],
      ["probed-old-a", 1_000],
    ]),
    minAgeMs: 0,
    now: new Date(10_000),
    targets: [
      { createdAtMs: 20, targetId: "never-b" },
      { createdAtMs: 30, targetId: "probed-old-b" },
      { createdAtMs: 10, targetId: "never-a" },
      { createdAtMs: 30, targetId: "probed-old-a" },
      { createdAtMs: 5, targetId: "probed-new" },
    ],
  }

  expect(workerModule.selectGithubReconcileCandidates(input)).toEqual([
    "never-a",
    "never-b",
    "probed-old-a",
    "probed-old-b",
  ])
  expect(workerModule.selectGithubReconcileCandidates({
    ...input,
    targets: input.targets.toReversed(),
  })).toEqual([
    "never-a",
    "never-b",
    "probed-old-a",
    "probed-old-b",
  ])
})

test("GitHub reconcile selection excludes probes newer than the minimum age and includes the boundary", () => {
  expect(workerModule.selectGithubReconcileCandidates({
    batchSize: 10,
    lastProbedAtMs: new Map([
      ["at-boundary", 8_000],
      ["too-recent", 8_001],
    ]),
    minAgeMs: 2_000,
    now: new Date(10_000),
    targets: [
      { createdAtMs: 20, targetId: "too-recent" },
      { createdAtMs: 10, targetId: "at-boundary" },
      { createdAtMs: 30, targetId: "never-probed" },
    ],
  })).toEqual(["never-probed", "at-boundary"])
})
