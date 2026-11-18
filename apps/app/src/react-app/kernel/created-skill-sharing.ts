import type { ReactNode } from "react"
import type { UIMessage } from "ai"

export type CreatedSkillSharingProviderProps = { messages: UIMessage[]; active: boolean; children: ReactNode }

export function NoCreatedSkillSharing({ children }: CreatedSkillSharingProviderProps) {
  return children
}
