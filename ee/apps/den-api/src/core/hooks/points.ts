import type { AuthUserTable, InvitationTable, MemberTable, OrganizationTable, TeamTable } from "@openwork-ee/den-db/schema"
import type { AfterCommit, CoreHookModuleId, CoreHookRejection, CoreTx } from "./types.js"

// The typed point catalogue (W0-05). One map per phase so every handler is
// fully typed by its point name. Points from later PRs (auth contributors,
// org-context contributors, member-add eligibility) are added with their
// dispatchers; delegated rows (module registry, AuditSink, agent capability
// sources, jobs) live in their own plans.

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect
type MemberId = MemberRow["id"]
type TeamId = typeof TeamTable.$inferSelect.id
type UserId = typeof AuthUserTable.$inferSelect.id
type InvitationRow = typeof InvitationTable.$inferSelect

export type CoreMemberAddedSource = "invitation" | "acceptance" | "betterAuthAdapter"

// Invitation and acceptance carry the post-change member count today's
// quantity syncs read. Adapter inserts (SCIM, SSO JIT, raw Better Auth) only
// mint the gateway key today, so they carry what that check needs instead.
export type CoreMemberAddedInput =
  | {
      organizationId: OrgId
      memberId: MemberId
      source: "invitation" | "acceptance"
      memberCount: number
    }
  | {
      organizationId: OrgId
      memberId: MemberId
      source: "betterAuthAdapter"
      userId: string | null
      removedAt: Date | null
    }

export type CoreInvitationGuardInput = {
  tx: CoreTx
  organizationId: OrgId
  invitation: Pick<InvitationRow, "id" | "organizationId" | "teamId">
  // Core's actor-authority check, so a guard can demand a stronger role
  // without knowing about request contexts or session freshness.
  requireSuperAdmin: (message: string) => CoreHookRejection | null
}

export interface CoreGuardPoints {
  // Teams: Admin-team members can only be removed by owners and super-admins.
  "member.removalGuard": {
    tx: CoreTx
    organizationId: OrgId
    memberId: MemberId
    removedByOrgMemberId: MemberId | null
  }
  "invitation.createGuard": CoreInvitationGuardInput
  "invitation.cancelGuard": CoreInvitationGuardInput
  // SCIM-managed teams refuse Den-side mutations.
  "team.mutationGuard": {
    tx: CoreTx
    organizationId: OrgId
    teamId: TeamId
    operation: "delete" | "assignMember"
  }
  // Runs before the deletion transaction. A handler may refuse deletion, and a
  // thrown error aborts it (billing cancels subscriptions here).
  "org.deletion.pre": {
    organizationId: OrgId
  }
}

export interface CoreTxPoints {
  "member.removing": {
    tx: CoreTx
    organizationId: OrgId
    memberIds: MemberId[]
    removedAt: Date
    afterCommit: AfterCommit
  }
  "invitation.accepted": {
    tx: CoreTx
    organizationId: OrgId
    invitation: InvitationRow
    member: MemberRow
  }
  // Better Auth's teamMember delete hook only sees the team id, so the
  // organization can be unknown; the skip rule then uses instance availability.
  "team.membershipChanged": {
    tx: CoreTx
    organizationId: OrgId | null
    teamId: TeamId
  }
  "team.deleting": {
    tx: CoreTx
    organizationId: OrgId
    teamId: TeamId
    removedAt: Date
  }
  // Inside the org-delete transaction, after the org-row lock and before Core
  // deletes invitations, members and the organization row. Every module purges
  // its organization-scoped rows here.
  // `afterCommit` queues remote revocations of grants read before the purge
  // (Google tokens); they run once the deletion has committed.
  "org.deletion.purge": {
    tx: CoreTx
    organizationId: OrgId
    afterCommit: AfterCommit
  }
  // A user spans organizations, so this point is instance-scoped.
  "user.deleting": {
    tx: CoreTx
    userId: UserId
    memberIds: MemberId[]
    afterCommit: AfterCommit
  }
}

export interface CoreParticipantPoints {
  // Wraps every membership mutation inside the org-row lock. W0-P11 moves the
  // gateway usage-entitlement lock here.
  "membership.mutation.participant": {
    tx: CoreTx
    organizationId: OrgId
    memberIds: MemberId[]
  }
}

export interface CorePostCommitPoints {
  "member.added": CoreMemberAddedInput
  "member.removed": {
    organizationId: OrgId
    memberId: MemberId
    memberCount: number
    source: "removal"
  }
  // Defined for module consumers (research/05 hook 11); no registrations yet.
  "member.roleChanged": {
    organizationId: OrgId
    memberId: MemberId
    previousRole: string
    nextRole: string
  }
  // Den path passes the owner member; the Better Auth path cannot.
  "org.created": {
    organizationId: OrgId
    ownerMemberId: MemberId | null
    source: "den" | "betterAuth"
  }
  "org.deletion.post": {
    organizationId: OrgId
  }
  // Point type only; the dispatcher and triggers come with W0-P14.
  "module.enabledForOrg": {
    organizationId: OrgId
    moduleId: CoreHookModuleId
  }
}

export type CoreGuardPointName = keyof CoreGuardPoints
export type CoreTxPointName = keyof CoreTxPoints
export type CoreParticipantPointName = keyof CoreParticipantPoints
export type CorePostCommitPointName = keyof CorePostCommitPoints
export type CoreHookPointName = CoreGuardPointName | CoreTxPointName | CoreParticipantPointName | CorePostCommitPointName
