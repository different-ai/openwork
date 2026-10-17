import type { ObserverSnapshot, ObservedServiceCall, JsonRecord } from "./workshop-narrative-contract.ts";
export { workflowWitness, sharingWitness, observedNativeWorkflowCalls } from "./workshop-workflow-witness.ts";
export type { NativeWorkflowObservation, NativeWorkflowRead, WorkflowWitnessContext, WorkflowActorEvidence, VerifiedWorkflowWitness, VerifiedSharingWitness } from "./workshop-workflow-witness.ts";
const obj = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === "string" ? value : "";

/** Bind only actual server-side MCP observations to a unique completed Code Mode tool's real time window. */
export function observedServiceCalls(before: ObserverSnapshot, after: ObserverSnapshot): ObservedServiceCall[] {
  const tools = arr(after.messages).flatMap((message) => arr(obj(message).parts).map(obj)).filter((part) => part.type === "tool" && obj(part.state).status === "completed");
  const result: ObservedServiceCall[] = [];
  for (const [key, service] of [["atlassian", "atlassian"], ["microsoft", "microsoft"], ["news", "news"]] as const) {
    const old = arr(obj(before[key]).audit).map(obj);
    for (const entry of arr(obj(after[key]).audit).map(obj)) {
      if (old.some((value) => value.sequence === entry.sequence)) continue;
      const candidates = tools.filter((tool) => {
        const state = obj(tool.state), time = obj(state.time), input = obj(state.input);
        return (typeof input.code === "string" || /execute_capability_script/.test(str(tool.tool))) && typeof time.start === "number" && typeof time.end === "number" && typeof entry.at === "number" && entry.at >= time.start && entry.at <= time.end;
      });
      if (candidates.length !== 1 || !str(candidates[0].callID)) continue;
      result.push({ callId: str(candidates[0].callID), name: str(entry.name), input: entry.input, output: entry.output, status: entry.status === "completed" ? "completed" : "error", service });
    }
  }
  return result;
}
