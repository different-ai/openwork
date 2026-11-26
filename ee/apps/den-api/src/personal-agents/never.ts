import type { PersonalAgentNever, PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import type { PersonalAgentCaller } from "./access.js"
import { personalAgentConnectionTools, personalAgentUsableConnections } from "./permissions-catalog.js"

type Tool = { name: string; title: string; write: boolean }

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function matchPersonalAgentNeverTools(tools: readonly Tool[], action?: string): string[] {
  const wanted = words(action ?? "")
  const matched = wanted.length ? tools.filter((tool) => [tool.name, tool.title].some((value) => {
    const tokens = words(value)
    return wanted.every((word) => tokens.some((token) => token.includes(word)))
  })) : []
  return (matched.length ? matched : tools.filter((tool) => tool.write)).map((tool) => tool.name)
}

export async function personalAgentNeverBlocks(caller: PersonalAgentCaller, never: readonly PersonalAgentNever[]): Promise<PersonalAgentToolPolicy> {
  const policy: PersonalAgentToolPolicy = { connections: {}, tools: {} }
  if (!never.length) return policy
  const connections = await personalAgentUsableConnections(caller)
  for (const connection of connections) {
    const matches = never.filter(({ app }) => connection.name.toLowerCase().includes(app.toLowerCase()))
    if (!matches.length) continue
    if (matches.some(({ action }) => action === undefined)) {
      policy.connections[connection.id] = "block"
      continue
    }
    const { tools } = await personalAgentConnectionTools(caller, connection)
    const blocked = new Set(matches.flatMap(({ action }) => matchPersonalAgentNeverTools(tools, action)))
    if (blocked.size) policy.tools[connection.id] = Object.fromEntries([...blocked].map((name) => [name, "block"]))
  }
  return policy
}
