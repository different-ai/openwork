import { agentSendCheckRequest, decideSendCheck, type AgentSendCheckVerdict } from "@openwork/automations/proactive-brief"
import type { EvaluationModel } from "./evaluation-model.js"

/**
 * The send check (`workbotAgentSendCheck`): each message Your agent wrote is read once more by the evaluation model
 * before Den sends it, with two yes-or-no questions (does the brief say to leave it out; does it only repeat what was
 * told today). Den's rule (`decideSendCheck`) turns the answers into send or hold; no usable answer sends the message,
 * exactly as without the check.
 */

/** `holdAt`: the policy's own threshold; left out, the default. */
export type AgentSendCheckInput = { brief: string; message: string; update: boolean; toldToday: readonly string[]; holdAt?: number }
export type AgentSendCheckResult = {
  verdict: AgentSendCheckVerdict
  /** `unavailable`: the model gave no usable answer, so the message is sent. */
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
