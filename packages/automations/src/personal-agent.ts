import type { PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"

/**
 * What one run of an agent's routine is told: organization rules, the agent's
 * brief, then the routine's task. Each has its own section.
 */
export function personalAgentRunInstructions(input: { agentName: string; brief: string; instructions: string; organizationRules?: string }): string {
  const rules = input.organizationRules?.trim()
  return [
    ...(rules ? [
      "These rules come from your organization. Follow them first if they conflict with the agent's brief or the task.",
      "<organization_rules>",
      rules,
      "</organization_rules>",
      "",
    ] : []),
    `You are "${input.agentName}", one of this person's own agents. They wrote the brief below. It says who you are and how you work; follow it for everything in this run.`,
    "",
    "<agent_brief>",
    input.brief.trim(),
    "</agent_brief>",
    "",
    "This run's task:",
    input.instructions.trim(),
    "",
    "Your reply is posted in this person's chat with you. Make it at most two short plain sentences, about 40 words: what you found and what you did, naming each thing you created by its id or title only. No headings, tables, lists or explanations of how you decided. If there was nothing to do, say so in one sentence.",
  ].join("\n")
}

export type PersonalAgentToolBlock = { connectionId: string; toolName: string }

/** The connections and single tools a policy withholds from a run. A blocked connection covers its tools. */
export function personalAgentToolPolicyBlocks(policy: PersonalAgentToolPolicy): {
  connections: string[]
  tools: PersonalAgentToolBlock[]
} {
  const connections = Object.entries(policy.connections)
    .filter(([, access]) => access === "block")
    .map(([connectionId]) => connectionId)
    .sort()
  const blockedConnections = new Set(connections)
  const tools: PersonalAgentToolBlock[] = []
  for (const connectionId of Object.keys(policy.tools).sort()) {
    if (blockedConnections.has(connectionId)) continue
    for (const toolName of Object.keys(policy.tools[connectionId]).sort()) {
      if (policy.tools[connectionId][toolName] === "block") tools.push({ connectionId, toolName })
    }
  }
  return { connections, tools }
}
