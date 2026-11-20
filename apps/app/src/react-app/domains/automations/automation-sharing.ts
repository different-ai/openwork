import type { AutomationSharing, SharedAutomation, UpdateAutomationSharing } from "@openwork/types/automations"
import type { DenLibraryOrgDirectory } from "@/app/lib/den-library"
import { formatAutomationSchedule } from "./automation-format"

export type AutomationAudienceDraft = {
  orgWide: boolean
  people: Array<{ id: string; name: string }>
  teams: Array<{ id: string; name: string }>
}

export function automationAudienceDraft(sharing: AutomationSharing, directory: DenLibraryOrgDirectory): AutomationAudienceDraft {
  return {
    orgWide: sharing.orgWide,
    people: [...new Set(sharing.memberIds)].filter((id) => id !== directory.currentMemberId).map((id) => ({
      id, name: directory.members.find((member) => member.id === id)?.name ?? "Unavailable person",
    })),
    teams: [...new Set(sharing.teamIds)].map((id) => ({
      id, name: directory.teams.find((team) => team.id === id)?.name ?? "Unavailable team",
    })),
  }
}

export function automationSharingInput(draft: AutomationAudienceDraft): UpdateAutomationSharing {
  return {
    orgWide: draft.orgWide,
    memberIds: [...new Set(draft.people.map((person) => person.id))].sort(),
    teamIds: [...new Set(draft.teams.map((team) => team.id))].sort(),
  }
}

export function automationShareLabel(sharing: AutomationSharing | undefined) {
  return sharing && (sharing.orgWide || sharing.memberIds.length > 0 || sharing.teamIds.length > 0) ? "Shared" : "Share"
}

export function automationSharingSuccess(sharing: AutomationSharing, directory: DenLibraryOrgDirectory) {
  if (sharing.orgWide) return "Shared with everyone in the organization"
  if (!sharing.memberIds.length && !sharing.teamIds.length) return "No longer shared"
  const people = new Set(sharing.memberIds)
  for (const team of directory.teams) {
    if (sharing.teamIds.includes(team.id)) for (const id of team.memberIds) people.add(id)
  }
  if (directory.currentMemberId) people.delete(directory.currentMemberId)
  return people.size === 1 ? "Shared with 1 person" : `Shared with ${people.size} people`
}

export function filterSharedAutomations(items: SharedAutomation[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items
  return items.filter((item) => [
    item.name,
    item.sharedBy.name,
    formatAutomationSchedule(item.schedule),
    item.executionTarget === "cloud" ? "Cloud computer" : "Desktop computer",
    item.action.kind === "agent" ? item.action.instructions : "",
  ].some((value) => value.toLowerCase().includes(normalized)))
}

export function describeAutomationSharingError(error: unknown, action: "share" | "copy" = "share") {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null
  if (code === "automation_share_org_wide_forbidden") return "You cannot share with everyone in the organization. Ask an organization owner or admin to change your sharing permissions."
  if (code === "automation_share_target_invalid") return "A selected person or team is no longer available. Remove them and try saving again."
  if (code === "automation_not_found") return "This Automation is no longer shared with you. Refresh the list to see what is available."
  if (code === "feature_disabled") return "Automation sharing is no longer available. Return to your Automations to continue."
  if (code === "automation_desktop_disabled") return "Desktop Automations are disabled. Ask an organization owner or admin to enable them."
  if (code === "automation_cloud_disabled") return "Cloud Automations are disabled. Ask an organization owner or admin to enable them."
  if (status === 409 && (code === "model_access_lost" || code === "provider_unavailable")) {
    const message = error instanceof Error ? error.message.trim() : "The model is not available to you."
    return `${message} Ask an organization owner or admin for model access, then try adding this Automation again.`
  }
  return action === "copy"
    ? "This Automation could not be added. Check your connection and try again."
    : "Sharing could not be updated. Check your connection and try again."
}
