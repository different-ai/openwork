import { z } from "zod"
import { remoteSessionThreadStatusSchema } from "./automations.js"

/** Only refs from successful persisted create receipts, never model prose or task titles. */
export const workbotRemoteJobSchema = z.object({
  key: z.string(),
  ref: z.union([z.object({ commandId: z.string() }), z.object({ sessionId: z.string() })]),
  title: z.string(),
  target: z.enum(["cloud", "desktop", "registered"]),
  toolCallId: z.string(),
  turnId: z.string().nullable(),
  startedAt: z.number().nullable(),
  watcherTaskIds: z.array(z.string()),
  status: remoteSessionThreadStatusSchema.nullable(),
  stale: z.boolean(),
  checkedAt: z.number().nullable().optional(),
  unreachable: z.string().max(240).nullable().optional(),
})
export type WorkbotRemoteJob = z.infer<typeof workbotRemoteJobSchema>
export const workbotRemoteJobsSchema = z.object({
  jobs: z.array(workbotRemoteJobSchema),
  hasEarlier: z.boolean(),
  statusError: z.enum(["signed_out", "unavailable"]).nullable().optional(),
})
export type WorkbotRemoteJobs = z.infer<typeof workbotRemoteJobsSchema>

/** Bounded plain text only; remote content never becomes HTML, executable controls or approval. */
export const workbotRemoteJobDetailSchema = z.object({
  state: z.enum(["ready", "pending", "unavailable"]),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() })).max(6),
  canStop: z.boolean(),
  messageId: z.string().nullable(),
})
export type WorkbotRemoteJobDetail = z.infer<typeof workbotRemoteJobDetailSchema>
export const workbotRemoteJobStopSchema = z.object({
  state: z.enum(["stopped", "pending", "not_stopped"]),
  reason: z.enum(["different_turn", "not_running", "unconfirmed"]).optional(),
})
export type WorkbotRemoteJobStop = z.infer<typeof workbotRemoteJobStopSchema>
