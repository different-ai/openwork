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
  /** Pure status-watcher tasks proved to follow these exact refs. Safe to hide their duplicate rows. */
  watcherTaskIds: z.array(z.string()),
  status: remoteSessionThreadStatusSchema.nullable(),
  /** Not checked or couldn't verify now. Never infer done from a finished local watcher. */
  stale: z.boolean(),
  /** When Workbot last read a verified status for this task (ms); a stale row shows its last state from then. */
  checkedAt: z.number().nullable().optional(),
  /** Plain reason this task can't be reached at all (not a passing refresh failure); older servers omit it. */
  unreachable: z.string().max(240).nullable().optional(),
})
export type WorkbotRemoteJob = z.infer<typeof workbotRemoteJobSchema>
export const workbotRemoteJobsSchema = z.object({
  jobs: z.array(workbotRemoteJobSchema),
  /** The bounded transcript window may omit older remote jobs. */
  hasEarlier: z.boolean(),
  /**
   * Why this read could not refresh any status: `signed_out` needs the person to sign in again; `unavailable` is a
   * passing failure, so rows keep their last known state. Absent when the refresh worked or from older servers.
   */
  statusError: z.enum(["signed_out", "unavailable"]).nullable().optional(),
})
export type WorkbotRemoteJobs = z.infer<typeof workbotRemoteJobsSchema>

/** Bounded plain text only; remote content never becomes HTML, executable controls or approval. */
export const workbotRemoteJobDetailSchema = z.object({
  state: z.enum(["ready", "pending", "unavailable"]),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() })).max(6),
  canStop: z.boolean(),
  /** Guard for the latest remote user turn actually shown in this read. */
  messageId: z.string().nullable(),
})
export type WorkbotRemoteJobDetail = z.infer<typeof workbotRemoteJobDetailSchema>
export const workbotRemoteJobStopSchema = z.object({
  state: z.enum(["stopped", "pending", "not_stopped"]),
  reason: z.enum(["different_turn", "not_running", "unconfirmed"]).optional(),
})
export type WorkbotRemoteJobStop = z.infer<typeof workbotRemoteJobStopSchema>
