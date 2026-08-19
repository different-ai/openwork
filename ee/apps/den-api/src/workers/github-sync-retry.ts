import { GithubConnectorRequestError } from "../routes/org/plugin-system/github-app.js"

export function isTransientGithubSyncError(error: unknown): boolean {
  if (error instanceof GithubConnectorRequestError) {
    return error.status === 429 || error.status >= 500
  }
  if (error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) return true
  if (error instanceof Error && error.cause !== undefined && error.cause !== error) {
    return isTransientGithubSyncError(error.cause)
  }
  return false
}
