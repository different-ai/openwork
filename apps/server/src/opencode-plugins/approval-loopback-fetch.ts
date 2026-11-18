import { Agent, fetch as undiciFetch } from "undici";

// Approval-capable RPCs send their response only after the person answers.
// Native fetch's default 300 s headers timeout cuts off the desktop's 600 s
// approval wait even when the caller supplied no AbortSignal deadline.
// Scope this dispatcher to these local RPCs, never external website traffic.
const approvalDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * A cancellable loopback RPC that may wait for human approval. The caller's
 * AbortSignal and the approval owner's own deadline bound its lifetime; do not
 * add an unrelated HTTP parser deadline while the person is still deciding.
 */
export async function approvalLoopbackFetch(
  input: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "error"; signal: AbortSignal },
) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Approval requests require a local HTTP endpoint.");
  }
  return undiciFetch(input, { ...init, redirect: "error", dispatcher: approvalDispatcher });
}
