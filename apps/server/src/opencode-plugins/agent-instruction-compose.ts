/**
 * Kent-style instruction primitives for OpenWork system-prompt composition.
 *
 * create  — build one named section
 * combine — merge sections in order, one id wins (first non-empty)
 * delete  — drop a section by id
 * expand  — replace a section body with derived text when present
 *
 * Sections are the unit of overlap control: routing/tools/skills/session each
 * own one id so transforms stop stacking contradictory brochure text.
 */

export type AgentInstructionSection = {
  id: string;
  body: string;
};

export function createInstructionSection(id: string, body: string): AgentInstructionSection {
  return { id, body: body.trim() };
}

export function combineInstructionSections(
  ...groups: Array<AgentInstructionSection | AgentInstructionSection[] | null | undefined>
): AgentInstructionSection[] {
  const seen = new Set<string>();
  const combined: AgentInstructionSection[] = [];
  for (const group of groups) {
    if (!group) continue;
    const sections = Array.isArray(group) ? group : [group];
    for (const section of sections) {
      if (!section.body || seen.has(section.id)) continue;
      seen.add(section.id);
      combined.push(section);
    }
  }
  return combined;
}

export function deleteInstructionSection(
  sections: AgentInstructionSection[],
  id: string,
): AgentInstructionSection[] {
  return sections.filter((section) => section.id !== id);
}

export function expandInstructionSection(
  sections: AgentInstructionSection[],
  id: string,
  expand: (body: string) => string,
): AgentInstructionSection[] {
  return sections.map((section) => (
    section.id === id
      ? { ...section, body: expand(section.body).trim() }
      : section
  )).filter((section) => section.body.length > 0);
}

export function composeAgentInstructions(sections: AgentInstructionSection[]): string[] {
  return combineInstructionSections(sections).map((section) => section.body);
}
