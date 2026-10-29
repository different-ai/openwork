import { z } from "zod"
import { turnStatusSchema } from "../src/types.js"

export const smokeView = z.object({
  status: z.enum(["busy", "idle"]),
  turns: z.array(z.object({ status: turnStatusSchema, error: z.string().nullable().optional() })),
  finalAssistantText: z.string(),
})

// Never echo provider details, arbitrary error strings, or conversation content into deployment logs.
const safeErrors = new Set([
  "model_credentials_missing", "mcp_unavailable", "credentials_refresh", "stuck_repeating", "output_limit",
  "max_steps_exceeded", "runner_shutdown", "turn_timeout", "runner_error", "superseded",
  "model_unreachable", "model_failed", "model_bad_response", "model_stream_interrupted",
])
export function smokeResult(read: z.infer<typeof smokeView>) {
  const turn = read.turns.at(-1)
  const code = turn?.error
  const error = code ? (safeErrors.has(code) || /^model_http_[1-5]\d{2}$/.test(code) ? code : "unrecognized_error") : "none"
  const answered = /pong/i.test(read.finalAssistantText)
  return { completed: turn?.status === "completed" && answered, summary: `turn: ${turn?.status ?? "none"}, error: ${error}, expected answer: ${answered}` }
}
