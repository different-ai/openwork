export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
  role: string;
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

export function getBillingRoute(orgSlug: string): string {
  return `${getOrgDashboardRoute(orgSlug)}/billing`;
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
      const membershipId = asString(entry.membershipId);
      if (!id || !name || !slug || !role || !membershipId) {
        return null;
      }

      return {
        id,
        name,
        slug,
        logo: asString(entry.logo),
        metadata: asString(entry.metadata),
        role,
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
