/**
 * Slack event statuses the worker picks up. `watching`: the answer is delivered and the thread released, and the
 * message's background tasks still report back.
 */
export const CLAIMABLE_STATUSES = ["pending", "running", "watching"]

/**
 * Statuses that hold a thread: a newer message waits for an older one in these, and Slack's Stop ends them. A
 * watching event is in neither, so the person can keep talking while its tasks run.
 */
export const THREAD_ACTIVE_STATUSES = ["pending", "running"]
