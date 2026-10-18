import type { DynamicToolUIPart } from "ai";
import { parseSkillDeliveryEvidence, skillDeliveryEvidence, type SkillDeliveryEvidence } from "@openwork/types/skill-delivery";

/** Use the server's bounded receipt when the inspectable result was truncated.
 * Otherwise only the actual retrieval result can attest delivered instructions. */
export function skillEvidence(part: DynamicToolUIPart): SkillDeliveryEvidence | null {
  if (!/(?:^|[_.])(?:get_skill|skill|execute_capability)$/.test(part.toolName)) return null;
  const receipt = parseSkillDeliveryEvidence(part.callProviderMetadata?.openwork?.skillDelivery);
  if (receipt) return part.state === "output-error" || part.state === "output-denied" ? { ...receipt, state: "blocked" } : receipt;
  const mcp = part.callProviderMetadata?.openwork?.mcpResult;
  return skillDeliveryEvidence({ tool: part.toolName, input: part.input, output: "output" in part ? part.output : undefined,
    status: part.state === "output-available" ? "completed" : part.state === "output-error" || part.state === "output-denied" ? "error" : "selected",
    isError: mcp !== null && typeof mcp === "object" && Reflect.get(mcp, "isError") === true,
  });
}

export function skillEvidenceSentence(evidence: SkillDeliveryEvidence) {
  const target = evidence.name ? `“${evidence.name}”` : "skill";
  return {
    service: null,
    present: `Loading ${target} instructions`,
    past: evidence.state === "instructions-loaded" ? `Loaded ${target} instructions`
      : evidence.state === "blocked" ? `${target} instructions unavailable`
      : evidence.state === "metadata-only" ? `Found ${target} skill details` : `Selected ${target} skill`,
    failure: `Couldn’t load ${target} instructions`,
  };
}
