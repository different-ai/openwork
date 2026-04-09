export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
  role: string;
  orgMemberId: string;
  membershipId: string;
  createdAt: string | null;
  updatedAt: string | null;
  isActive: boolean;
};

export type DenOrgMember = {
  id: string;
  userId: string;
  role: string;
  createdAt: string | null;
  isOwner: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    image: string | null;
  };
};

export type DenOrgInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
};

export type DenOrgTeam = {
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  memberIds: string[];
};

export type DenCurrentMemberTeam = {
  id: string;
  name: string;
  organizationId: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenInvitationPreview = {
  invitation: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string | null;
    createdAt: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

export type DenOrgRole = {
  id: string;
  role: string;
  permission: Record<string, string[]>;
  builtIn: boolean;
  protected: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenOrgApiKey = {
  id: string;
  configId: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitMax: number | null;
  rateLimitTimeWindow: number | null;
  lastRequest: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  owner: {
    userId: string;
    memberId: string;
    name: string;
    email: string;
    image: string | null;
  };
};

export type DenOrgContext = {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    metadata: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  currentMember: {
    id: string;
    userId: string;
    role: string;
    createdAt: string | null;
    isOwner: boolean;
  };
  members: DenOrgMember[];
  invitations: DenOrgInvitation[];
  roles: DenOrgRole[];
  teams: DenOrgTeam[];
  currentMemberTeams: DenCurrentMemberTeam[];
};

export const DEN_ROLE_PERMISSION_OPTIONS = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
} as const;

export const PENDING_ORG_INVITATION_STORAGE_KEY = "openwork:web:pending-org-invitation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asIsoString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePermissionRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([resource, actions]) => [
        resource,
        actions.filter((entry: unknown): entry is string => typeof entry === "string"),
      ])
  );
}

export function splitRoleString(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getOrgAccessFlags(roleValue: string, isOwner: boolean) {
  const roles = new Set(splitRoleString(roleValue));
  const isAdmin = isOwner || roles.has("admin");

  return {
    isOwner,
    isAdmin,
    canInviteMembers: isAdmin,
    canCancelInvitations: isAdmin,
    canManageMembers: isOwner,
    canManageRoles: isOwner,
    canManageTeams: isAdmin,
    canManageApiKeys: isAdmin,
  };
}

export function formatRoleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function getOrgDashboardRoute(orgSlug: string): string {
  return `/o/${encodeURIComponent(orgSlug)}/dashboard`;
}

export function getJoinOrgRoute(invitationId: string): string {
  return `/join-org?invite=${encodeURIComponent(invitationId)}`;
}

export function getManageMembersRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/manage-members`;
}

export function getMembersRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/members`;
}

export function getSharedSetupsRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/shared-setups`;
}

export function getBackgroundAgentsRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/background-agents`;
}

export function getCustomLlmProvidersRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/custom-llm-providers`;
}

export function getLlmProvidersRoute(orgSlug: string): string {
  return getCustomLlmProvidersRoute(orgSlug);
}

export function getLlmProviderRoute(orgSlug: string, llmProviderId: string): string {
  return `${getLlmProvidersRoute(orgSlug)}/${encodeURIComponent(llmProviderId)}`;
}

export function getEditLlmProviderRoute(orgSlug: string, llmProviderId: string): string {
  return `${getLlmProviderRoute(orgSlug, llmProviderId)}/edit`;
}

export function getNewLlmProviderRoute(orgSlug: string): string {
  return `${getLlmProvidersRoute(orgSlug)}/new`;
}

export function getBillingRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/billing`;
}

export function getApiKeysRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/api-keys`;
}

export function getSkillHubsRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/skill-hubs`;
}

export function getSkillHubRoute(orgSlug: string, skillHubId: string): string {
  return `${getSkillHubsRoute(orgSlug)}/${encodeURIComponent(skillHubId)}`;
}

export function getEditSkillHubRoute(orgSlug: string, skillHubId: string): string {
  return `${getSkillHubRoute(orgSlug, skillHubId)}/edit`;
}

export function getNewSkillHubRoute(orgSlug: string): string {
  return `${getSkillHubsRoute(orgSlug)}/new`;
}

export function getSkillDetailRoute(orgSlug: string, skillId: string): string {
  return `${getSkillHubsRoute(orgSlug)}/skills/${encodeURIComponent(skillId)}`;
}

export function getEditSkillRoute(orgSlug: string, skillId: string): string {
  return `${getSkillDetailRoute(orgSlug, skillId)}/edit`;
}

export function getNewSkillRoute(orgSlug: string): string {
  return `${getSkillHubsRoute(orgSlug)}/skills/new`;
}

export function parseOrgListPayload(payload: unknown): {
  orgs: DenOrgSummary[];
  activeOrgId: string | null;
  activeOrgSlug: string | null;
} {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) {
    return { orgs: [], activeOrgId: null, activeOrgSlug: null };
  }

  const orgs = payload.orgs
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }

      const id = asString(entry.id);
      const name = asString(entry.name);
      const slug = asString(entry.slug);
      const role = asString(entry.role);
      const orgMemberId = asString(entry.orgMemberId);
      const membershipId = asString(entry.membershipId);
      if (!id || !name || !slug || !role || !orgMemberId || !membershipId) {
        return null;
      }

      return {
        id,
        name,
        slug,
        logo: asString(entry.logo),
        metadata: asString(entry.metadata),
        role,
        orgMemberId,
        membershipId,
        createdAt: asIsoString(entry.createdAt),
        updatedAt: asIsoString(entry.updatedAt),
        isActive: asBoolean(entry.isActive),
      } satisfies DenOrgSummary;
    })
    .filter((entry): entry is DenOrgSummary => entry !== null);

  return {
    orgs,
    activeOrgId: asString(payload.activeOrgId),
    activeOrgSlug: asString(payload.activeOrgSlug),
  };
}

export function parseOrgContextPayload(payload: unknown): DenOrgContext | null {
  if (!isRecord(payload) || !isRecord(payload.organization) || !isRecord(payload.currentMember)) {
    return null;
  }

  const organization = payload.organization;
  const currentMember = payload.currentMember;
  const organizationId = asString(organization.id);
  const organizationName = asString(organization.name);
  const organizationSlug = asString(organization.slug);
  const currentMemberId = asString(currentMember.id);
  const currentMemberUserId = asString(currentMember.userId);
  const currentMemberRole = asString(currentMember.role);

  if (!organizationId || !organizationName || !organizationSlug || !currentMemberId || !currentMemberUserId || !currentMemberRole) {
    return null;
  }

  const members = Array.isArray(payload.members)
    ? payload.members
        .map((entry) => {
          if (!isRecord(entry) || !isRecord(entry.user)) {
            return null;
          }

          const id = asString(entry.id);
          const userId = asString(entry.userId);
          const role = asString(entry.role);
          const user = entry.user;
          const userEmail = asString(user.email);
          const userName = asString(user.name);
          const userIdentity = asString(user.id);
          if (!id || !userId || !role || !userEmail || !userName || !userIdentity) {
            return null;
          }

          return {
            id,
            userId,
            role,
            createdAt: asIsoString(entry.createdAt),
            isOwner: asBoolean(entry.isOwner),
            user: {
              id: userIdentity,
              email: userEmail,
              name: userName,
              image: asString(user.image),
            },
          } satisfies DenOrgMember;
        })
        .filter((entry): entry is DenOrgMember => entry !== null)
    : [];

  const invitations = Array.isArray(payload.invitations)
    ? payload.invitations
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }

          const id = asString(entry.id);
          const email = asString(entry.email);
          const role = asString(entry.role);
          const status = asString(entry.status);
          if (!id || !email || !role || !status) {
            return null;
          }

          return {
            id,
            email,
            role,
            status,
            expiresAt: asIsoString(entry.expiresAt),
            createdAt: asIsoString(entry.createdAt),
          } satisfies DenOrgInvitation;
        })
        .filter((entry): entry is DenOrgInvitation => entry !== null)
    : [];

  const roles = Array.isArray(payload.roles)
    ? payload.roles
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }

          const id = asString(entry.id);
          const role = asString(entry.role);
          if (!id || !role) {
            return null;
          }

          return {
            id,
            role,
            permission: parsePermissionRecord(entry.permission),
            builtIn: asBoolean(entry.builtIn),
            protected: asBoolean(entry.protected),
            createdAt: asIsoString(entry.createdAt),
            updatedAt: asIsoString(entry.updatedAt),
          } satisfies DenOrgRole;
        })
        .filter((entry): entry is DenOrgRole => entry !== null)
    : [];

  const teams = Array.isArray(payload.teams)
    ? payload.teams
        .map((entry) => {
          if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
            return null;
          }

          const memberIds = Array.isArray(entry.memberIds)
            ? entry.memberIds.filter((value): value is string => typeof value === "string")
            : [];

          return {
            id: entry.id,
            name: entry.name,
            createdAt: asIsoString(entry.createdAt),
            updatedAt: asIsoString(entry.updatedAt),
            memberIds,
          } satisfies DenOrgTeam;
        })
        .filter((entry): entry is DenOrgTeam => entry !== null)
    : [];

  const currentMemberTeams = Array.isArray(payload.currentMemberTeams)
    ? payload.currentMemberTeams
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }

          const id = asString(entry.id);
          const name = asString(entry.name);
          const organizationId = asString(entry.organizationId);
          if (!id || !name || !organizationId) {
            return null;
          }

          return {
            id,
            name,
            organizationId,
            createdAt: asIsoString(entry.createdAt),
            updatedAt: asIsoString(entry.updatedAt),
          } satisfies DenCurrentMemberTeam;
        })
        .filter((entry): entry is DenCurrentMemberTeam => entry !== null)
    : [];

  return {
    organization: {
      id: organizationId,
      name: organizationName,
      slug: organizationSlug,
      logo: asString(organization.logo),
      metadata: asString(organization.metadata),
      createdAt: asIsoString(organization.createdAt),
      updatedAt: asIsoString(organization.updatedAt),
    },
    currentMember: {
      id: currentMemberId,
      userId: currentMemberUserId,
      role: currentMemberRole,
      createdAt: asIsoString(currentMember.createdAt),
      isOwner: asBoolean(currentMember.isOwner),
    },
    members,
    invitations,
    roles,
    teams,
    currentMemberTeams,
  };
}

export function parseInvitationPreviewPayload(payload: unknown): DenInvitationPreview | null {
  if (!isRecord(payload) || !isRecord(payload.invitation) || !isRecord(payload.organization)) {
    return null;
  }

  const invitation = payload.invitation;
  const organization = payload.organization;
  const invitationId = asString(invitation.id);
  const invitationEmail = asString(invitation.email);
  const invitationRole = asString(invitation.role);
  const invitationStatus = asString(invitation.status);
  const organizationId = asString(organization.id);
  const organizationName = asString(organization.name);
  const organizationSlug = asString(organization.slug);

  if (!invitationId || !invitationEmail || !invitationRole || !invitationStatus || !organizationId || !organizationName || !organizationSlug) {
    return null;
  }

  return {
    invitation: {
      id: invitationId,
      email: invitationEmail,
      role: invitationRole,
      status: invitationStatus,
      expiresAt: asIsoString(invitation.expiresAt),
      createdAt: asIsoString(invitation.createdAt),
    },
    organization: {
      id: organizationId,
      name: organizationName,
      slug: organizationSlug,
    },
  };
}

export function parseOrgApiKeysPayload(payload: unknown): DenOrgApiKey[] {
  if (!isRecord(payload) || !Array.isArray(payload.apiKeys)) {
    return [];
  }

  return payload.apiKeys
    .map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.owner)) {
        return null;
      }

      const id = asString(entry.id);
      const configId = asString(entry.configId);
      const owner = entry.owner;
      const ownerUserId = asString(owner.userId);
      const ownerMemberId = asString(owner.memberId);
      const ownerName = asString(owner.name);
      const ownerEmail = asString(owner.email);

      if (!id || !configId || !ownerUserId || !ownerMemberId || !ownerName || !ownerEmail) {
        return null;
      }

      return {
        id,
        configId,
        name: asString(entry.name),
        start: asString(entry.start),
        prefix: asString(entry.prefix),
        enabled: asBoolean(entry.enabled),
        rateLimitEnabled: asBoolean(entry.rateLimitEnabled),
        rateLimitMax: typeof entry.rateLimitMax === "number" ? entry.rateLimitMax : null,
        rateLimitTimeWindow: typeof entry.rateLimitTimeWindow === "number" ? entry.rateLimitTimeWindow : null,
        lastRequest: asIsoString(entry.lastRequest),
        expiresAt: asIsoString(entry.expiresAt),
        createdAt: asIsoString(entry.createdAt),
        updatedAt: asIsoString(entry.updatedAt),
        owner: {
          userId: ownerUserId,
          memberId: ownerMemberId,
          name: ownerName,
          email: ownerEmail,
          image: asString(owner.image),
        },
      } satisfies DenOrgApiKey;
    })
    .filter((entry): entry is DenOrgApiKey => entry !== null);
}
