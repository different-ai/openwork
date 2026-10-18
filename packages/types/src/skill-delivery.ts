export type SkillDeliveryState = "selected" | "blocked" | "metadata-only" | "instructions-loaded";
export type SkillDeliveryEvidence = { name: string | null; state: SkillDeliveryState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, depth = 0): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || depth > 3) return null;
  try { const parsed: unknown = JSON.parse(value); return record(parsed, depth + 1); } catch { return null; }
}

/** A small delivery receipt, not a claim the agent applied the instructions. */
export function parseSkillDeliveryEvidence(value: unknown): SkillDeliveryEvidence | null {
  if (!isRecord(value) || !(value.name === null || typeof value.name === "string")) return null;
  const state = value.state;
  return state === "selected" || state === "blocked" || state === "metadata-only" || state === "instructions-loaded"
    ? { name: typeof value.name === "string" ? value.name.slice(0, 128) : null, state } : null;
}

/** Only a skill retrieval proves instruction delivery. A file read, a chip,
 * and a matching phrase do not. Capture this before diagnostic truncation. */
export function skillDeliveryEvidence(call: {
  tool: string; input: unknown; output?: unknown; status: "selected" | "completed" | "error"; isError?: boolean;
}): SkillDeliveryEvidence | null {
  const retrieval = /(?:^|[_.])(?:get_skill|skill)$/.test(call.tool);
  const capability = /(?:^|[_.])execute_capability$/.test(call.tool);
  if (!retrieval && !capability) return null;
  const input = record(call.input);
  const envelope = record(call.output);
  const text = Array.isArray(envelope?.content) ? envelope.content.flatMap(item => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n") : "";
  const output = record(envelope?.structuredContent) ?? record(text) ?? envelope;
  const skillCapability = capability && (output?.kind === "skill"
    || (typeof input?.name === "string" && input.name.startsWith("skill:")));
  if (!retrieval && !skillCapability) return null;
  const asked = typeof input?.name === "string" ? input.name.trim() : "";
  const named = typeof output?.name === "string" ? output.name.trim() : "";
  const content = typeof output?.content === "string" ? output.content : text || (typeof call.output === "string" && !output ? call.output : "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const nameLine = frontmatter?.split(/\r?\n/).find(line => line.startsWith("name:"));
  const slug = nameLine?.slice("name:".length).trim() || undefined;
  const name = (named || (asked && !asked.includes(":") ? asked : slug) || null)?.slice(0, 128) ?? null;
  if (call.status === "error" || envelope?.isError === true || call.isError) return { name, state: "blocked" };
  if (call.status === "selected") return { name, state: "selected" };
  if (/instructions are withheld|organization skill is not ready/i.test(content)) return { name, state: "blocked" };
  const hasInstructions = typeof output?.content === "string" || Boolean(frontmatter && slug) || /<skill_content(?:\s|>)/.test(content);
  if (!content.trim() || !hasInstructions || /discovery metadata, NOT the skill.s instructions|\[Result truncated by OpenWork\]/i.test(content)) return { name, state: "metadata-only" };
  return { name, state: "instructions-loaded" };
}
