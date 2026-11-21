import { agentSendCheckRequest, decideSendCheck, type AgentSendCheckVerdict } from "@openwork/automations/proactive-brief"
import type { EvaluationModel } from "./evaluation-model.js"

export type AgentSendCheckInput = { brief: string; message: string; update: boolean; toldToday: readonly string[]; holdAt?: number }
export type AgentSendCheckResult = {
  verdict: AgentSendCheckVerdict
  status: "answered" | "unavailable"
  durationMs: number
  inputTokens: number | null
}
export type AgentSendCheck = (input: AgentSendCheckInput) => Promise<AgentSendCheckResult>

export function createAgentSendCheck(model: EvaluationModel): AgentSendCheck {
  return async (input) => {
    const answer = await model(agentSendCheckRequest(input))
    return {
      verdict: answer.answers ? decideSendCheck(answer.answers, input, input.holdAt) : { kind: "send" },
      status: answer.answers ? "answered" : "unavailable",
      durationMs: answer.durationMs,
      inputTokens: answer.inputTokens,
    }
  }
}
