import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH, rememberForPersonalAgentSchema } from "@openwork/types/den/personal-agents"
import { personalAgentAccess } from "../personal-agents/access.js"
import { PERSONAL_AGENT_MEMORY_ERRORS, rememberPersonalAgentRunNote, savePersonalAgentRoutineState } from "../personal-agents/memory.js"
import { personalAgentDispatchContext } from "../personal-agents/permissions-dispatch.js"
import { createPersonalAgentChangeRequest } from "../personal-agents/requests.js"

export const AGENT_REMEMBER_TOOL_NAME = "agent_remember"
export const AGENT_NOTE_PROGRESS_TOOL_NAME = "agent_note_progress"

const notLive = "This run is no longer active or no longer has access to this agent."
const paused = "An admin paused this agent."
const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

function result(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) }
}

export function registerAgentMemoryTools(server: McpServer, input: { organizationId: string; runId: string; memberId: string }) {
  async function runAccess() {
    const context = await personalAgentDispatchContext(input.runId, input.organizationId, input.memberId)
    if (!context) return { error: notLive } as const
    if (context.paused) return { error: paused } as const
    const caller = { organizationId: input.organizationId, memberId: context.memberId }
    const access = await personalAgentAccess(caller, context.agentId, true)
    if (access?.state !== "active") return { error: notLive } as const
    if (access.pausedAt !== null) return { error: paused } as const
    return { access, caller }
  }

  server.registerTool(AGENT_REMEMBER_TOOL_NAME, {
    title: "Remember a note",
    description: "Keep one short preference, decision, or fact for future runs. Never save secrets or passwords. If this run is not for the owner, the note waits for their approval.",
    annotations,
    inputSchema: rememberForPersonalAgentSchema,
  }, async ({ note }) => {
    const context = await runAccess()
    if (!context.access) return result(context.error, true)
    const { access, caller } = context
    if (access.role !== "owner") {
      await createPersonalAgentChangeRequest(access, caller, { summary: `Remember: ${note.slice(0, 120)}`, change: { memoryNote: note } })
      return result("The note is waiting for the owner's approval. It has not been saved yet.")
    }
    try {
      const saved = await rememberPersonalAgentRunNote({ ...caller, agentId: access.agentId, runId: input.runId, note })
      return saved ? result("Saved the note for future runs.") : result(notLive, true)
    } catch (error) {
      if (error instanceof Error && error.message === "personal_agent_memory_full") return result(PERSONAL_AGENT_MEMORY_ERRORS[error.message], true)
      throw error
    }
  })

  server.registerTool(AGENT_NOTE_PROGRESS_TOOL_NAME, {
    title: "Save routine progress",
    description: "Before you finish, record what you did and what the next run should not do again. Use IDs or titles. Progress is saved only when this run is for the owner.",
    annotations: { ...annotations, idempotentHint: true },
    inputSchema: z.object({ state: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH) }).strict(),
  }, async ({ state }) => {
    const context = await runAccess()
    if (!context.access) return result(context.error, true)
    const { access, caller } = context
    if (access.role !== "owner") return result("Progress was not saved. Only a run for the owner can save progress.")
    const saved = await savePersonalAgentRoutineState({ ...caller, agentId: access.agentId, runId: input.runId, state, writtenByAgent: true })
    return saved ? result("Saved the progress for this routine's next run.") : result(notLive, true)
  })
}
