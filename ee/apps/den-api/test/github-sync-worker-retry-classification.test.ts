import { expect, test } from "bun:test"
import { GithubConnectorRequestError } from "../src/routes/org/plugin-system/github-app.js"
import { isTransientGithubSyncError } from "../src/workers/github-sync-retry.js"

test("GitHub sync treats 502 and TimeoutError as transient", () => {
  expect(isTransientGithubSyncError(
    new GithubConnectorRequestError("bad gateway", 502),
  )).toBe(true)
  const timeoutError = new Error("timed out")
  timeoutError.name = "TimeoutError"
  expect(isTransientGithubSyncError(timeoutError)).toBe(true)
})
