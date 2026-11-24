import { z } from "zod"
import { headlessModelAccessSchema } from "@openwork-ee/headless-protocol"
export { headlessModelAccessSchema, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"

export const attachmentSchema = z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number() })
export type Attachment = z.infer<typeof attachmentSchema>

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  inputError: z.string().optional(),
})
export type ToolCall = z.infer<typeof toolCallSchema>

export const toolAppSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200),
})
export type ToolApp = z.infer<typeof toolAppSchema>

export const messageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    text: z.string(),
    attachments: z.array(z.lazy(() => attachmentSchema)).optional(),
    images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
    documents: z.array(z.object({ mediaType: z.literal("application/pdf"), data: z.string(), name: z.string() })).optional(),
  }),
  z.object({ role: z.literal("assistant"), text: z.string(), toolCalls: z.array(toolCallSchema) }),
  z.object({
    role: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    output: z.string(),
    isError: z.boolean(),
    images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
    documents: z.array(z.object({ mediaType: z.literal("application/pdf"), data: z.string(), name: z.string() })).optional(),
    app: toolAppSchema.optional(),
  }),
])
export type Message = z.infer<typeof messageSchema>
export type ToolMessage = Extract<Message, { role: "tool" }>

export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly?: boolean
}

export type ToolImage = { mediaType: string; data: string }
export type ToolDocument = { mediaType: "application/pdf"; data: string; name: string }
export type ToolResult = { output: string; isError: boolean; images?: ToolImage[]; documents?: ToolDocument[]; app?: ToolApp }

export const repeatLimitsSchema = z
  .object({
    maxWaitingMs: z.number().int().min(10_000).max(24 * 3_600_000).optional(),
    maxIdenticalFailures: z.number().int().min(2).max(100).optional(),
  })
  .strict()
export type RepeatLimits = z.infer<typeof repeatLimitsSchema>

export const turnStatusSchema = z.enum(["queued", "running", "completed", "failed", "interrupted", "aborted"])
export type TurnStatus = z.infer<typeof turnStatusSchema>

export const RESUMABLE: ReadonlySet<TurnStatus> = new Set(["failed", "interrupted"])
export const ACTIVE: ReadonlySet<TurnStatus> = new Set(["queued", "running"])

export const executionSchema = z.enum(["steps"])
export type Execution = z.infer<typeof executionSchema>

export const INDEX_CAPABILITY = /^[A-Za-z0-9_.-]{1,2048}$/

export const RESUME_GRANT = /^hrg_[A-Za-z0-9_-]{43}$/

export const turnCredentialsSchema = z
  .object({
    modelApiKey: z.string().min(1).max(4096).optional(),
    modelAccess: headlessModelAccessSchema.optional(),
    mcpToken: z.string().min(1).max(16_384).optional(),
    readOnly: z.boolean().optional(),
    resumeGrant: z.string().regex(RESUME_GRANT).optional(),
    indexCapability: z.string().regex(INDEX_CAPABILITY).optional(),
  })
  .strict()
export type TurnCredentials = z.infer<typeof turnCredentialsSchema>

export const DESKTOP_VIEWS = ["browser", "computer"] as const
export const desktopViewSchema = z.enum(DESKTOP_VIEWS)
export type DesktopView = z.infer<typeof desktopViewSchema>

export type SessionComputer = {
  prompt: string
  tools: ToolSpec[]
  toolNames: ReadonlySet<string>
  image: string
  desktopTools?: ToolSpec[]
  desktopRun?(sessionId: string, input: Record<string, unknown>, signal?: AbortSignal, policy?: { browserRecovery: boolean }): Promise<ToolResult>
  desktopViewer?(sessionId: string, input: { view: "browser" | "computer"; control: boolean; origin: string }): Promise<{ state: "paused" } | { state: "connected"; url: string; expiresAt: number; paused: boolean }>
  browserDemonstration?(sessionId: string, command: import("@openwork/types/browser-demonstration").DemonstrationCommand): Promise<import("@openwork/types/browser-demonstration").DemonstrationReply>
  desktopAction?(sessionId: string, action: "continue" | "pause" | "resume" | "rebuild"): Promise<{ ok: boolean }>
  run(sessionId: string, name: string, input: Record<string, unknown>, callKey?: string): Promise<ToolResult>
  pickUp?(sessionId: string, name: string, input: Record<string, unknown>, callKey: string): Promise<ToolResult | null>
  available?(sessionId: string): boolean
  known(sessionId: string): boolean
  prewarm(sessionId: string): void
  release(sessionId: string): void
  delete(sessionId: string): Promise<void>
  previewSavedFile(sessionId: string, fileId: string): Promise<void>
}
