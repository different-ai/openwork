import { createHash } from "node:crypto"
import { z } from "zod"
import { canonicalArguments } from "../mcp-events/protocol.js"

export const EXTENSION = "io.modelcontextprotocol/events"
export const SESSION_EVENT = "openwork.remote_session.status_changed"
export const COMPUTER_EVENT = "openwork.computer.state_changed"
export const nativeNameSchema = z.enum([SESSION_EVENT, COMPUTER_EVENT])
export const sessionArguments = z.object({
  commandId: z.string().min(1).max(160).optional(), sessionId: z.string().min(1).max(160).optional(),
  states: z.array(z.enum(["starting", "running", "waiting", "idle", "error"])).min(1).max(5).optional(),
}).strict().refine(value => Boolean(value.commandId) !== Boolean(value.sessionId), "Name exactly one commandId or sessionId")
export const computerArguments = z.object({ deviceId: z.string().min(1).max(64) }).strict()
export const CATALOG = [
  { name: SESSION_EVENT, description: "Observed status changes in one of your remote sessions. Defaults to waiting, idle or error. Read the session for its current result; an event never authorizes answering a permission request.", delivery: ["webhook"], inputSchema: { type: "object", properties: { commandId: { type: "string" }, sessionId: { type: "string" }, states: { type: "array", items: { enum: ["starting", "running", "waiting", "idle", "error"] } } }, oneOf: [{ required: ["commandId"] }, { required: ["sessionId"] }], additionalProperties: false }, payloadSchema: { type: "object", properties: { state: { type: "string" }, sessionId: { type: ["string", "null"] }, commandId: { type: ["string", "null"] }, waitingFor: { type: ["string", "null"] }, requestId: { type: ["string", "null"] } } } },
  { name: COMPUTER_EVENT, description: "Observed lifecycle changes in one of your computers, including a hosted cloud computer. Does not stream screen frames or input. Read the computer for its current state.", delivery: ["webhook"], inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"], additionalProperties: false }, payloadSchema: { type: "object", properties: { deviceId: { type: "string" }, state: { type: "string" }, activityId: { type: ["string", "null"] }, activity: { type: ["string", "null"] } } } },
]
export const fingerprint = (value: unknown) => createHash("sha256").update(canonicalArguments(value)).digest("hex")
export class NativeEventError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) { super(message) }
}
export const denied = () => new NativeEventError(-32024, "This event source is not available to you.")
