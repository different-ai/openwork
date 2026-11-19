import { expect, test } from "bun:test"
import type { AutomationSharing, SharedAutomation } from "@openwork/types/automations"
import type { DenLibraryOrgDirectory } from "../src/app/lib/den-library"
import {
  automationAudienceDraft,
  automationShareLabel,
  automationSharingInput,
  automationSharingSuccess,
  describeAutomationSharingError,
  filterSharedAutomations,
} from "../src/react-app/domains/automations/automation-sharing"

const directory: DenLibraryOrgDirectory = {
  currentMemberId: "member_owner",
  members: [
    { id: "member_owner", name: "Owner", email: null },
    { id: "member_a", name: "Member A", email: null },
    { id: "member_b", name: "Member B", email: null },
    { id: "member_c", name: "Member C", email: null },
  ],
  teams: [{ id: "team_a", name: "Operations", memberIds: ["member_owner", "member_a", "member_b"] }],
}

const privateSharing: AutomationSharing = { orgWide: false, memberIds: [], teamIds: [] }

test("audience round trip preserves all targets, deduplicates, and excludes the owner", () => {
  const sharing: AutomationSharing = {
    orgWide: true,
    memberIds: ["member_c", "member_a", "member_owner", "member_a"],
    teamIds: ["team_a", "team_a"],
  }
  const draft = automationAudienceDraft(sharing, directory)
  expect(draft.people.map((person) => person.name)).toEqual(["Member C", "Member A"])
  expect(draft.teams).toEqual([{ id: "team_a", name: "Operations" }])
  expect(automationSharingInput(draft)).toEqual({ orgWide: true, memberIds: ["member_a", "member_c"], teamIds: ["team_a"] })
  expect(automationSharingInput(automationAudienceDraft(privateSharing, directory))).toEqual(privateSharing)
})

test("unavailable recipients remain removable rather than disappearing from a saved audience", () => {
  const sharing = { orgWide: false, memberIds: ["member_removed"], teamIds: ["team_removed"] }
  const draft = automationAudienceDraft(sharing, directory)
  expect(draft.people[0]?.name).toBe("Unavailable person")
  expect(draft.teams[0]?.name).toBe("Unavailable team")
  expect(automationSharingInput(draft)).toEqual(sharing)
})

test("Share label reports the saved state for every audience type", () => {
  expect(automationShareLabel(undefined)).toBe("Share")
  expect(automationShareLabel(privateSharing)).toBe("Share")
  expect(automationShareLabel({ ...privateSharing, orgWide: true })).toBe("Shared")
  expect(automationShareLabel({ ...privateSharing, memberIds: ["member_a"] })).toBe("Shared")
  expect(automationShareLabel({ ...privateSharing, teamIds: ["team_a"] })).toBe("Shared")
})

test("success counts distinct people across teams, excluding the owner", () => {
  expect(automationSharingSuccess(privateSharing, directory)).toBe("No longer shared")
  expect(automationSharingSuccess({ ...privateSharing, orgWide: true }, directory)).toBe("Shared with everyone in the organization")
  expect(automationSharingSuccess({ ...privateSharing, memberIds: ["member_a"] }, directory)).toBe("Shared with 1 person")
  expect(automationSharingSuccess({ orgWide: false, memberIds: ["member_a", "member_c"], teamIds: ["team_a"] }, directory)).toBe("Shared with 3 people")
})

function shared(id: string, name: string, executionTarget: "cloud" | "desktop" = "desktop"): SharedAutomation {
  return {
    id, name, executionTarget,
    sharedBy: { memberId: "member_owner", name: "Owner" },
    sharedAt: 100,
    schedule: { kind: "daily", hour: 9, minute: 0, timezone: "UTC" },
    action: { kind: "agent", instructions: "Summarize recent activity", model: { providerId: "test", modelId: "test", variant: null } },
  }
}

test("shared search matches name, sharer, instructions, schedule and computer without changing the source", () => {
  const items = [shared("aut_a", "Morning report"), shared("aut_b", "Evening review", "cloud")]
  expect(filterSharedAutomations(items, " MORNING ").map((item) => item.id)).toEqual(["aut_a"])
  expect(filterSharedAutomations(items, "Owner")).toHaveLength(2)
  expect(filterSharedAutomations(items, "recent activity")).toHaveLength(2)
  expect(filterSharedAutomations(items, "9:00")).toHaveLength(2)
  expect(filterSharedAutomations(items, "cloud").map((item) => item.id)).toEqual(["aut_b"])
  expect(filterSharedAutomations(items, "not found")).toEqual([])
  expect(filterSharedAutomations(items, " ")).toBe(items)
  expect(items).toHaveLength(2)
})

function apiError(code: string, status: number, message = "The model is unavailable.") {
  return Object.assign(new Error(message), { code, status })
}

test("sharing errors explain the next action without exposing API codes", () => {
  expect(describeAutomationSharingError(apiError("automation_share_org_wide_forbidden", 403))).toContain("organization owner or admin")
  expect(describeAutomationSharingError(apiError("automation_share_target_invalid", 400))).toContain("Remove them")
  expect(describeAutomationSharingError(apiError("automation_not_found", 404), "copy")).toContain("Refresh the list")
  expect(describeAutomationSharingError(apiError("feature_disabled", 404))).toBe("Automation sharing is no longer available. Return to your Automations to continue.")
  expect(describeAutomationSharingError(apiError("automation_desktop_disabled", 403), "copy")).toContain("enable them")
  expect(describeAutomationSharingError(apiError("automation_cloud_disabled", 403), "copy")).toContain("enable them")
  expect(describeAutomationSharingError(new Error("internal detail"))).toBe("Sharing could not be updated. Check your connection and try again.")
  expect(describeAutomationSharingError(null, "copy")).toBe("This Automation could not be added. Check your connection and try again.")
})

test("copy model conflicts preserve the server's human message and give direction", () => {
  for (const code of ["model_access_lost", "provider_unavailable"]) {
    expect(describeAutomationSharingError(apiError(code, 409, "Your team cannot use this model."), "copy")).toBe(
      "Your team cannot use this model. Ask an organization owner or admin for model access, then try adding this Automation again.",
    )
  }
})
