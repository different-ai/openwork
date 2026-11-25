import { headlessRunnerConfig, type HeadlessRunnerDeps } from "@openwork-ee/headless-protocol"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import type { HeadlessIndexKind } from "./session-index.js"

export * from "@openwork-ee/headless-protocol"

export function defaultHeadlessRunnerDeps(
  env: Record<string, string | undefined> = process.env,
  options: { indexKind?: HeadlessIndexKind; memberId?: string } = {},
): HeadlessRunnerDeps | null {
  const config = headlessRunnerConfig(env)
  const mintToken: HeadlessRunnerDeps["mintToken"] = async (input) => {
    const { token, resumeGrant, modelAccess, indexCapability } = await (await import("./resume-grants.js")).mintHeadlessTurnCredentials({
      ...input,
      ...(options.indexKind ? { indexKind: options.indexKind } : {}),
      ...(options.memberId ? { memberId: options.memberId } : {}),
    })
    return { token, ...(resumeGrant ? { resumeGrant } : {}), ...(modelAccess ? { modelAccess } : {}), ...(indexCapability ? { indexCapability } : {}) }
  }
  const modelAccessRequired: HeadlessRunnerDeps["modelAccessRequired"] = () => true
  return config ? { config, fetch, mintToken, modelAccessRequired, maxTokenTtlMs: DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } : null
}
