import { Agent, fetch as undiciFetch } from "undici";

const approvalDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

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
