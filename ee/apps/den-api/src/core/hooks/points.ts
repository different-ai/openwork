import type { AuthUserTable, InvitationTable, MemberTable, OrganizationTable, TeamTable } from "@openwork-ee/den-db/schema"
import type { OAuthOptions, Scope } from "@better-auth/oauth-provider"
import type { BetterAuthPlugin } from "better-auth"
import type { createAuthMiddleware } from "better-auth/api"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import type { OrganizationOptions } from "better-auth/plugins"
import type { MemberAddPath } from "../../member-add-eligibility-config.js"
import type { AfterCommit, CoreHookModuleId, CoreHookRejection, CoreTx } from "./types.js"

// The typed point catalogue (W0-05). One map per phase so every handler is
// fully typed by its point name. Points from later PRs (org-context
// contributors, member-add eligibility) are added with their dispatchers;
// delegated rows (module registry, AuditSink, agent capability sources, jobs)
// live in their own plans.

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

// The context Better Auth passes to `hooks.before` / `hooks.after`.
export type CoreAuthMiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

type CoreOrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>
type CoreTeamOrganizationHookName =
  | "beforeCreateTeam"
  | "beforeUpdateTeam"
  | "beforeDeleteTeam"
  | "beforeAddTeamMember"
  | "beforeRemoveTeamMember"

export type CoreRawMutationDenial = {
  // Better Auth endpoint path, for example "/organization/create-team".
  path: string
  message: string
}

// Platform-owned organization metadata. A create request carrying any listed
// key is refused; dropped capability keys are silently removed instead.
export type CoreReservedMetadataKeys = {
  keys?: readonly string[]
  capabilityKeys?: readonly string[]
  droppedCapabilityKeys?: readonly string[]
}

// The organization a sign-in must go through SSO for.
export type CoreSsoSignInRequirement = {
  organizationId: string
  organizationSlug: string
  signInPath: string
  ssoProviderId: string | null
  hasSso: boolean
}

export type CoreSignInMethodLookup =
  // Login options and SSO resolve: verified email domain, not membership.
  | { lookup: "emailDomain"; email: string }
  // Single-org instances: the singleton organization's own connection.
  | { lookup: "organization"; organizationId: OrgId; organizationSlug: string }

export interface CoreGuardPoints {
  // Whether an organization may gain `netNewSeats` people on `path`. Callers
  // go through member-add-eligibility.ts, which decides observe vs enforce.
  // Binding an invitation placeholder adds no seat and is never checked.
  "member.addEligibility": {
    organizationId: OrgId
    path: MemberAddPath
    netNewSeats: number
  }
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
  // Refuses a sign-in method the account's organization does not allow.
  // credentialSignIn: email/password and email sign-up (Better Auth before
  // hook; rejection → 403 with its message). socialCallback: the OAuth social
  // callback (after hook; Core deletes the new session and redirects to
  // `details.signInPath`).
  "auth.signInEnforcement":
    | { stage: "credentialSignIn"; email: string }
    | { stage: "socialCallback"; userId: string }
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
  "org.deletion.purge": {
    tx: CoreTx
    organizationId: OrgId
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

export interface CoreMiddlewarePoints {
  // Runs in Better Auth's `hooks.before`, after Core's device-code staging and
  // before Core's raw-mutation denials. Handlers match on `ctx.path`.
  // `isRequest` is false for server-side `auth.api.*` calls.
  "auth.beforePath": {
    ctx: CoreAuthMiddlewareContext
    isRequest: boolean
  }
  // Runs in Better Auth's `hooks.after` for paths Core does not own.
  "auth.afterPath": {
    ctx: CoreAuthMiddlewareContext
  }
  // `/oauth2/authorize` for a client id: a first-party client provisions its
  // OAuth client row on first use. Handlers match on `clientId`.
  "oauth.firstPartyClients": {
    clientId: string
    adapter: CoreAuthMiddlewareContext["context"]["adapter"]
  }
}

// Collected once at boot; never per organization (Better Auth plugins and
// options are process-wide).
export interface CoreBootContributorPoints {
  // Inserted after the OAuth provider plugin, in contribution order. Plugins
  // whose endpoints Den calls through `auth.api.*` or passes `auth` to
  // (oauthProvider, sso, scim) stay in auth.ts so their endpoint types survive.
  "betterAuth.plugins": readonly BetterAuthPlugin[]
  // Options merged into auth.ts's oauthProvider() call, after Core's login and
  // consent pages. A key set by two contributors fails the boot.
  "oauth.providerConfig": Partial<OAuthOptions<Scope[]>>
  "betterAuth.orgHooks": Partial<Pick<CoreOrganizationHooks, CoreTeamOrganizationHookName>>
  // Raw Better Auth endpoints refused over HTTP. Always contributed: turning a
  // module off must not reopen them.
  "auth.rawMutationDenials": readonly CoreRawMutationDenial[]
  // Better Auth model name → id generator.
  "auth.modelIds": Readonly<Record<string, () => string>>
  "org.reservedMetadataKeys": CoreReservedMetadataKeys
  // Conditions a member row must also meet to count as a person (seat counts,
  // member lists, seat eligibility), and'ed with Core's "not removed".
  "member.visibilityFilter": SQL
}

export type CoreMemberTeam = {
  id: TeamId
  name: string
  organizationId: OrgId
  createdAt: Date
  updatedAt: Date
}

export interface CoreResolverPoints {
  "auth.signInMethodResolver": {
    input: CoreSignInMethodLookup
    output: CoreSsoSignInRequirement | null
  }
  // The teams a member belongs to, for audience matching. Core's default is
  // today's team membership; M-teams moves it and makes the default "no
  // teams" (D29).
  "audience.resolver": {
    input: { organizationId: OrgId; memberId: MemberId }
    output: CoreMemberTeam[]
  }
}

// Stored organization metadata as Core hands it around (a JSON column, or a
// serialized string on older paths).
export type CoreOrganizationMetadata = string | Readonly<Record<string, unknown>> | null

// A JSON response fragment. Values are serialized by the route (Dates become
// ISO strings), exactly as before they were contributed.
export type CoreResponseFragment = Readonly<Record<string, unknown>>

export type CoreOrgContextFragment = {
  // Top-level fields of GET /v1/org, merged after Core's organization field.
  fields?: CoreResponseFragment
  // `capabilities.*` and `authMethods.*` flags.
  capabilities?: Readonly<Record<string, boolean>>
  authMethods?: Readonly<Record<string, boolean>>
}

// Async contributors. Fragments are collected concurrently and merged in
// order; a key written twice fails the request (a registration bug).
export interface CoreContributorPoints {
  // GET /v1/org. `metadata` is the context's metadata, `storedMetadata` the
  // row re-read by the route.
  "org.context": {
    input: {
      organizationId: OrgId
      memberId: MemberId
      metadata: CoreOrganizationMetadata
      storedMetadata: CoreOrganizationMetadata
      memberTeams: CoreMemberTeam[]
    }
    fragment: CoreOrgContextFragment
  }
  // GET /v1/me/desktop-config, merged in order.
  "me.desktopConfig": {
    input: {
      organizationId: OrgId
      memberId: MemberId
      metadata: CoreOrganizationMetadata
      normalizedMetadata: Readonly<Record<string, unknown>>
    }
    fragment: CoreResponseFragment
  }
  // The desktop handoff exchange response, after token, user and organization.
  "auth.handoffPayload": {
    input: {
      organizationId: string | null
      metadata: CoreOrganizationMetadata
    }
    fragment: CoreResponseFragment
  }
}

export type CoreInvitationPreviewBranding = {
  appName: string
  logoUrl: string | null
  iconUrl: string | null
}

// Decorators transform a value in order.
export interface CoreDecoratorPoints {
  // Organization metadata shown to members (GET /v1/org, the org list).
  "org.memberFacingMetadata": {
    input: { organizationId: OrgId }
    value: Readonly<Record<string, unknown>>
  }
  // The branding block of the public invitation preview.
  "invitation.preview": {
    input: { organizationId: OrgId; normalizedMetadata: Readonly<Record<string, unknown>> }
    value: CoreInvitationPreviewBranding
  }
}

export type CoreGuardPointName = keyof CoreGuardPoints
export type CoreTxPointName = keyof CoreTxPoints
export type CoreParticipantPointName = keyof CoreParticipantPoints
export type CorePostCommitPointName = keyof CorePostCommitPoints
export type CoreMiddlewarePointName = keyof CoreMiddlewarePoints
export type CoreBootContributorPointName = keyof CoreBootContributorPoints
export type CoreResolverPointName = keyof CoreResolverPoints
export type CoreContributorPointName = keyof CoreContributorPoints
export type CoreDecoratorPointName = keyof CoreDecoratorPoints
export type CoreHookPointName =
  | CoreGuardPointName
  | CoreTxPointName
  | CoreParticipantPointName
  | CorePostCommitPointName
  | CoreMiddlewarePointName
  | CoreBootContributorPointName
  | CoreResolverPointName
  | CoreContributorPointName
  | CoreDecoratorPointName
