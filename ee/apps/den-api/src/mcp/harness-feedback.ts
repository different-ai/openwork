import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { HARNESS_FEEDBACK_SURFACES } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { isHarnessFeedbackOrganization } from "../harness-feedback/access.js"
import { captureHarnessFeedback, findHarnessFeedbackMember, type HarnessFeedbackIdentity } from "../harness-feedback/repository.js"
import { isFirstPartyMcpPrincipal, type McpPrincipal } from "./auth.js"
import { DEN_MCP_HEADLESS_RUN_CLIENT_ID } from "./headless-run-token.js"

export const HARNESS_FEEDBACK_TOOL_NAME = "harness_feedback"
export const HARNESS_FEEDBACK_INSTRUCTIONS = "After a concrete OpenWork harness problem (a tool that misbehaved or was confusing, a wrong or missing instruction, or a missing capability), call harness_feedback once, then carry on with your task. Describe the problem without user content, secrets, file contents, logs, tool arguments, or raw output. Do not report ordinary provider errors or task-level failures."

const identifier = (limit: number) => z.string().min(1).max(limit).regex(/^[a-zA-Z0-9_.:-]+$/)
const shortDescription = z.string().max(400).trim().min(1)
const inputSchema = z.strictObject({
  surface: z.enum(HARNESS_FEEDBACK_SURFACES),
  tool: identifier(80).optional().describe("Tool name, when relevant."),
  errorCode: identifier(64).optional().describe("Error code only, not an error message."),
  symptom: shortDescription.describe("What went wrong, in your own words and without user data."),
  workaround: shortDescription.optional().describe("How you continued, without user data."),
})

async function eligibleIdentity(principal: McpPrincipal, fresh = false): Promise<HarnessFeedbackIdentity | null> {
  if (!isFirstPartyMcpPrincipal(principal) || !(await isHarnessFeedbackOrganization(principal.organizationId, { fresh }))) return null
  return {
    organizationId: normalizeDenTypeId("organization", principal.organizationId),
    userId: normalizeDenTypeId("user", principal.userId),
    clientKind: principal.payload.client_id === DEN_MCP_HEADLESS_RUN_CLIENT_ID ? "headless" : "app",
  }
}

export async function harnessFeedbackAvailable(principal: McpPrincipal): Promise<boolean> {
  try {
    const identity = await eligibleIdentity(principal)
    return identity !== null && (await findHarnessFeedbackMember(identity)) !== null
  } catch {
    return false
  }
}

function receipt(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) }
}

export function registerHarnessFeedbackTool(server: McpServer, principal: McpPrincipal) {
  server.registerTool(HARNESS_FEEDBACK_TOOL_NAME, {
    title: "Report an OpenWork harness problem",
    description: HARNESS_FEEDBACK_INSTRUCTIONS,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema,
  }, async (args) => {
    const forbidden = () => receipt("Harness feedback is not available. Continue your task.", true)
    try {
      const identity = await eligibleIdentity(principal, true)
      if (!identity) return forbidden()
      const result = await captureHarnessFeedback(identity, args)
      switch (result.kind) {
        case "stored": return receipt("Feedback recorded. Continue your task.")
        case "duplicate": return receipt("This feedback was already recorded. Continue your task.")
        case "limited": return receipt("Feedback limit reached. Continue your task without reporting again now.", true)
        case "forbidden": return forbidden()
      }
    } catch {
      return receipt("Feedback could not be recorded. Continue your task.", true)
    }
  })
}
