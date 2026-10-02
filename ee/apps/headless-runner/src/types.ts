import { z } from "zod"

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  /** Set when the model sent arguments that were not a JSON object. */
  inputError: z.string().optional(),
})
export type ToolCall = z.infer<typeof toolCallSchema>

/** Engine-neutral transcript entry. Stored as JSON, one row per entry. */
export const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({ role: z.literal("assistant"), text: z.string(), toolCalls: z.array(toolCallSchema) }),
  z.object({
    role: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    output: z.string(),
    isError: z.boolean(),
    /** Images a tool returned (for example a Slack file), passed to the model as image input. */
    images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
  }),
])
export type Message = z.infer<typeof messageSchema>

export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolImage = { mediaType: string; data: string }
export type ToolResult = { output: string; isError: boolean; images?: ToolImage[] }

export const turnStatusSchema = z.enum(["queued", "running", "completed", "failed", "interrupted", "aborted"])
export type TurnStatus = z.infer<typeof turnStatusSchema>

/** Turns in these states can be resumed by re-sending the same messageId. */
export const RESUMABLE: ReadonlySet<TurnStatus> = new Set(["failed", "interrupted"])
export const ACTIVE: ReadonlySet<TurnStatus> = new Set(["queued", "running"])

/**
 * Credentials a trusted caller supplies with each turn. They are held in
 * memory for the life of that turn only and are never written to disk.
 */
export const turnCredentialsSchema = z
  .object({
    modelApiKey: z.string().min(1).max(4096).optional(),
    mcpToken: z.string().min(1).max(16_384).optional(),
  })
  .strict()
export type TurnCredentials = z.infer<typeof turnCredentialsSchema>
