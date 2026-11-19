import { withDeadlockRetry } from "../utils/deadlock-retry.js"

/** Retry only a complete, rolled-back database transaction, never provider calls or ambiguous commits. */
export const withExternalMcpCreationRetry = withDeadlockRetry
