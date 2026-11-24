import { count, field, items, optionalText, requiredText, strings, text } from "./json.ts"

export type User = { id: string; email: string; name: string | null }
export type OrgSummary = { id: string; name: string; slug: string; role: string; planTier: string; memberCount: number }
export type MyOrgs = { orgs: OrgSummary[]; activeOrgId: string | null; activeOrgSlug: string | null }
export type Member = { id: string; email: string; name: string; role: string; isOwner: boolean; joinedAt: string | null }
export type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string }
export type Team = { id: string; name: string; memberIds: string[]; managedByScim: boolean; grantsOrganizationAdmin: boolean }
export type ApiKey = { id: string; name: string; type: string; scopes: string[]; areas: string[] | null; owner: string; lastUsedAt: string | null; expiresAt: string | null; createdAt: string }
export type CreatedApiKey = { id: string; name: string; type: string; scopes: string[]; areas: string[] | null; expiresAt: string | null; key: string }
export type AuditOperation = { id: string; action: string; outcome: string; origin: string; actorId: string | null; events: number; startedAt: string }
export type AuditPage = { operations: AuditOperation[]; nextCursor: string | null; snapshotAt: string }
export type OrgDetails = {
  id: string
  name: string
  slug: string
  ownerEmail: string | null
  yourRole: string
  yourPermissions: string[]
  members: Member[]
  invitations: Invitation[]
  teams: Team[]
}
export type CreatedInvitation = { invitationId: string; email: string; role: string; expiresAt: string }
export type InvitationLink = { invitationId: string; inviteLink: string; expiresAt: string }

export function parseUser(body: unknown): User {
  const user = field(body, "user")
  return { id: requiredText(user, "id"), email: requiredText(user, "email"), name: optionalText(user, "name") }
}

export function parseMyOrgs(body: unknown): MyOrgs {
  return {
    orgs: items(body, "orgs").map((org) => ({
      id: requiredText(org, "id"),
      name: text(org, "name"),
      slug: text(org, "slug"),
      role: text(org, "role"),
      planTier: text(org, "planTier"),
      memberCount: count(org, "memberCount"),
    })),
    activeOrgId: optionalText(body, "activeOrgId"),
    activeOrgSlug: optionalText(body, "activeOrgSlug"),
  }
}

export function parseOrgDetails(body: unknown): OrgDetails {
  const organization = field(body, "organization")
  const currentMember = field(body, "currentMember")
  return {
    id: requiredText(organization, "id"),
    name: text(organization, "name"),
    slug: text(organization, "slug"),
    ownerEmail: optionalText(field(organization, "owner"), "email"),
    yourRole: text(currentMember, "role"),
    yourPermissions: items(currentMember, "permissions").filter((key) => typeof key === "string"),
    members: items(body, "members").map((member) => ({
      id: requiredText(member, "id"),
      email: text(field(member, "user"), "email"),
      name: text(field(member, "user"), "name"),
      role: text(member, "effectiveRole") || text(member, "role"),
      isOwner: field(member, "isOwner") === true,
      joinedAt: optionalText(member, "joinedAt"),
    })),
    invitations: items(body, "invitations").map((invitation) => ({
      id: requiredText(invitation, "id"),
      email: text(invitation, "email"),
      role: text(invitation, "role"),
      status: text(invitation, "status"),
      expiresAt: text(invitation, "expiresAt"),
    })),
    teams: items(body, "teams").map((team) => ({
      id: requiredText(team, "id"),
      name: text(team, "name"),
      memberIds: strings(team, "memberIds"),
      managedByScim: field(team, "managedByScim") === true,
      grantsOrganizationAdmin: field(team, "grantsOrganizationAdmin") === true,
    })),
  }
}

export function parseCreatedInvitation(body: unknown): CreatedInvitation {
  return { invitationId: requiredText(body, "invitationId"), email: text(body, "email"), role: text(body, "role"), expiresAt: text(body, "expiresAt") }
}

export function parseInvitationLink(body: unknown): InvitationLink {
  return { invitationId: requiredText(body, "invitationId"), inviteLink: requiredText(body, "inviteLink"), expiresAt: text(body, "expiresAt") }
}

function areasOrNull(value: unknown): string[] | null {
  return Array.isArray(field(value, "areas")) ? strings(value, "areas") : null
}

export function parseApiKeys(body: unknown): ApiKey[] {
  return items(body, "apiKeys").map((apiKey) => ({
    id: requiredText(apiKey, "id"),
    name: text(apiKey, "name"),
    type: text(apiKey, "type"),
    scopes: strings(apiKey, "scopes"),
    areas: areasOrNull(apiKey),
    owner: text(field(apiKey, "owner"), "email"),
    lastUsedAt: optionalText(apiKey, "lastRequest"),
    expiresAt: optionalText(apiKey, "expiresAt"),
    createdAt: text(apiKey, "createdAt"),
  }))
}

export function parseCreatedApiKey(body: unknown): CreatedApiKey {
  const apiKey = field(body, "apiKey")
  return {
    id: requiredText(apiKey, "id"),
    name: text(apiKey, "name"),
    type: text(apiKey, "type"),
    scopes: strings(apiKey, "scopes"),
    areas: areasOrNull(apiKey),
    expiresAt: optionalText(apiKey, "expiresAt"),
    key: requiredText(body, "key"),
  }
}

export function parseTeamId(body: unknown): string {
  return requiredText(field(body, "team"), "id")
}

export function parseAuditPage(body: unknown): AuditPage {
  return {
    operations: items(body, "operations").map((operation) => ({
      id: requiredText(operation, "id"),
      action: text(operation, "action"),
      outcome: text(operation, "outcome"),
      origin: text(operation, "origin"),
      actorId: optionalText(field(operation, "initiatingActor"), "id"),
      events: count(operation, "eventCount"),
      startedAt: text(operation, "startedAt"),
    })),
    nextCursor: optionalText(body, "nextCursor"),
    snapshotAt: text(body, "snapshotAt"),
  }
}
