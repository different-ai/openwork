import { headlessRunnerConfig, type HeadlessRunnerDeps } from "@openwork-ee/headless-protocol"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"

/**
 * Den's wiring for the shared headless runner: its address from the environment, and member-scoped MCP tokens from
 * Den's minter. The client, its schemas and the step labels live in @openwork-ee/headless-protocol.
 */
export * from "@openwork-ee/headless-protocol"

export function defaultHeadlessRunnerDeps(env: Record<string, string | undefined> = process.env): HeadlessRunnerDeps | null {
  const config = headlessRunnerConfig(env)
  // Loaded lazily: the minter pulls in the auth and database modules.
  const mintToken: HeadlessRunnerDeps["mintToken"] = async (input) =>
    (await import("../mcp/headless-run-token-mint.js")).mintHeadlessRunMcpToken(input)
  return config ? { config, fetch, mintToken, maxTokenTtlMs: DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } : null
}
