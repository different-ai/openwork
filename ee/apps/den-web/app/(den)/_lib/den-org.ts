export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
  role: string;
  orgMemberId: string;
  membershipId: string;
  memberCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  isActive: boolean;
};

export type DenOrgMember = {
  id: string;
  userId: string | null;
  inviteId: string | null;
  role: string;
  createdAt: string | null;
  joinedAt: string | null;
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
  inviteToken: string | null;
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
    allowedEmailDomains: string[] | null;
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

export type DenOrgScimConnection = {
  id: string;
  providerId: string;
  organizationId: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenOrgScimHealth = {
  unresolvedFailureCount: number;
  lastFailureAt: string | null;
  lastFailureAction: string | null;
  lastFailureMessage: string | null;
  nextRetryAt: string | null;
  lastSuccessfulSyncAt: string | null;
};

export type DenOrgSsoConnection = {
  id: string;
  providerId: string;
  kind: "oidc" | "saml";
  issuer: string;
  domain: string;
  status: string;
  signInPath: string;
  signInUrl: string;
  redirectUrl: string;
  acsUrl: string | null;
  metadataUrl: string | null;
  domainVerified: boolean;
  oidc: {
    clientId: string | null;
    scopes: string[];
    skipDiscovery: boolean;
    authorizationEndpoint: string | null;
    tokenEndpoint: string | null;
    jwksEndpoint: string | null;
    userInfoEndpoint: string | null;
    tokenEndpointAuthentication: "client_secret_basic" | "client_secret_post" | null;
  } | null;
  saml: {
    entryPoint: string | null;
    audience: string | null;
    wantAssertionsSigned: boolean;
  } | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenOrgContext = {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    allowedEmailDomains: string[] | null;
    metadata: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    owner: {
      memberId: string;
      userId: string;
      name: string | null;
      email: string | null;
      image: string | null;
    } | null;
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
  entitlements: DenOrgEntitlements;
  authMethods: DenOrgAuthMethods;
};

export type DenOrgAuthMethods = {
  sso: boolean;
  scim: boolean;
};

export type DenOrgEntitlements = {
  sso: boolean;
  desktopPolicies: boolean;
  orgControls: boolean;
  analytics: boolean;
};

export type DenOrganizationMetadata = {
  allowedDesktopVersions?: string[];
  requireSso?: boolean;
} & Record<string, unknown>;

export const DEN_ROLE_PERMISSION_OPTIONS = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
  security_configuration: ["manage"],
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

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeDesktopVersionString(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : null;
}

export function parseOrganizationMetadata(metadata: string | null): DenOrganizationMetadata | null {
  if (!metadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? (parsed as DenOrganizationMetadata) : null;
  } catch {
    return null;
  }
}

export function getAllowedDesktopVersionsFromMetadata(metadata: string | null): string[] | null {
  const parsed = parseOrganizationMetadata(metadata);
  const values = asStringArray(parsed?.allowedDesktopVersions);

  if (!values) {
    return null;
  }

  return [...new Set(values.map((entry) => normalizeDesktopVersionString(entry)).filter((entry): entry is string => Boolean(entry)))];
}

export function getRequireSsoFromMetadata(metadata: string | null): boolean {
  const parsed = parseOrganizationMetadata(metadata);
  return parsed?.requireSso === true;
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

function roleHasSecurityConfigurationPermission(roleValue: string, roles: readonly DenOrgRole[]) {
  const roleNames = new Set(splitRoleString(roleValue));
  return roles.some((role) => (
    roleNames.has(role.role)
    && (role.permission.security_configuration?.includes("manage") ?? false)
  ));
}

export function getOrgAccessFlags(roleValue: string, isOwner: boolean, roleDefinitions: readonly DenOrgRole[] = []) {
  const roleNames = new Set(splitRoleString(roleValue));
  const isAdmin = isOwner || roleNames.has("admin");
  const canManageSecurityConfiguration = isOwner || roleHasSecurityConfigurationPermission(roleValue, roleDefinitions);

  return {
    isOwner,
    isAdmin,
    canManageSecurityConfiguration,
    canInviteMembers: isAdmin,
    canCancelInvitations: isAdmin,
    canManageMembers: isOwner,
    canRemoveMembers: isAdmin,
    canManageRoles: isOwner,
    canManageTeams: isAdmin,
    canManageApiKeys: canManageSecurityConfiguration,
    canManageScim: canManageSecurityConfiguration,
    canManageSso: canManageSecurityConfiguration,
  };
}

export function formatRoleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function getOrgDashboardRoute(_orgSlug?: string | null): string {
  return "/dashboard";
}

export function getMarketplaceOnboardingRoute(_orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(_orgSlug)}/onboarding`;
}

export function getJoinOrgRoute(invitationId: string): string {
  return `/join-org?invite=${encodeURIComponent(invitationId)}`;
}

export function getAnalyticsRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/analytics`;
}

export function getManageMembersRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/manage-members`;
}

export function getMembersRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/members`;
}

export function getBackgroundAgentsRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/background-agents`;
}

export function getCustomLlmProvidersRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/custom-llm-providers`;
}

export function getInferenceRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/inference`;
}

export function getLlmProvidersRoute(orgSlug?: string | null): string {
  return getCustomLlmProvidersRoute(orgSlug);
}

export function getDesktopPoliciesRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/desktop-policies`;
}

export function getNewDesktopPolicyRoute(orgSlug?: string | null): string {
  return `${getDesktopPoliciesRoute(orgSlug)}/new`;
}

export function getDesktopPolicyRoute(orgSlug: string | null | undefined, desktopPolicyId: string): string {
  return `${getDesktopPoliciesRoute(orgSlug)}/${encodeURIComponent(desktopPolicyId)}`;
}

export function getLlmProviderRoute(orgSlug: string | null | undefined, llmProviderId: string): string {
  return `${getLlmProvidersRoute(orgSlug)}/${encodeURIComponent(llmProviderId)}`;
}

export function getEditLlmProviderRoute(orgSlug: string | null | undefined, llmProviderId: string): string {
  return `${getLlmProviderRoute(orgSlug, llmProviderId)}/edit`;
}

export function getNewLlmProviderRoute(orgSlug?: string | null): string {
  return `${getLlmProvidersRoute(orgSlug)}/new`;
}

export function getBillingRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/billing`;
}

export function getOrgSettingsRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/org-settings`;
}

export function getApiKeysRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/api-keys`;
}

export function getScimRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/scim`;
}

export function getSsoRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/sso`;
}

export function getPluginsRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/plugins`;
}

export function getPluginRoute(orgSlug: string | null | undefined, pluginId: string): string {
  return `${getPluginsRoute(orgSlug)}/${encodeURIComponent(pluginId)}`;
}

export function getNewPluginRoute(orgSlug?: string | null): string {
  return `${getPluginsRoute(orgSlug)}/new`;
}

export function getMarketplacesRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/marketplaces`;
}

export function getMarketplaceRoute(orgSlug: string | null | undefined, marketplaceId: string): string {
  return `${getMarketplacesRoute(orgSlug)}/${encodeURIComponent(marketplaceId)}`;
}

export function getIntegrationsRoute(orgSlug?: string | null): string {
  return `${getOrgDashboardRoute(orgSlug)}/integrations`;
}

export function getGithubIntegrationRoute(orgSlug?: string | null): string {
  return `${getIntegrationsRoute(orgSlug)}/github`;
}

export function getGithubIntegrationSetupRoute(orgSlug: string | null | undefined, connectorInstanceId: string): string {
  return `${getGithubIntegrationRoute(orgSlug)}?connectorInstanceId=${encodeURIComponent(connectorInstanceId)}`;
}

export function getGithubIntegrationAccountRoute(orgSlug: string | null | undefined, connectorAccountId: string): string {
  return `${getGithubIntegrationRoute(orgSlug)}?connectorAccountId=${encodeURIComponent(connectorAccountId)}`;
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
        memberCount: typeof entry.memberCount === "number" ? entry.memberCount : 0,
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
  const organizationOwner = isRecord(organization.owner) ? organization.owner : null;
  const organizationOwnerMemberId = organizationOwner ? asString(organizationOwner.memberId) : null;
  const organizationOwnerUserId = organizationOwner ? asString(organizationOwner.userId) : null;
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
          if (!id || !role || !userEmail || !userName || !userIdentity) {
            return null;
          }

          return {
            id,
            userId,
            inviteId: asString(entry.inviteId),
            role,
            createdAt: asIsoString(entry.createdAt),
            joinedAt: asIsoString(entry.joinedAt),
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
            inviteToken: asString(entry.inviteToken),
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
      allowedEmailDomains: asStringArray(organization.allowedEmailDomains),
      metadata: asString(organization.metadata),
      createdAt: asIsoString(organization.createdAt),
      updatedAt: asIsoString(organization.updatedAt),
      owner: organizationOwner && organizationOwnerMemberId && organizationOwnerUserId
        ? {
          memberId: organizationOwnerMemberId,
          userId: organizationOwnerUserId,
          name: asString(organizationOwner.name),
          email: asString(organizationOwner.email),
          image: asString(organizationOwner.image),
        }
        : null,
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
    entitlements: parseOrgEntitlements(payload.entitlements),
    authMethods: parseOrgAuthMethods(payload.authMethods),
  };
}

function parseOrgAuthMethods(value: unknown): DenOrgAuthMethods {
  if (!isRecord(value)) {
    return { sso: false, scim: false };
  }

  return {
    sso: value.sso === true,
    scim: value.scim === true,
  };
}

function parseOrgEntitlements(value: unknown): DenOrgEntitlements {
  // Older servers do not return entitlements; treat everything as available
  // so gating only applies when the API explicitly reports it.
  if (!isRecord(value)) {
    return { sso: true, desktopPolicies: true, orgControls: true, analytics: true };
  }

  return {
    sso: value.sso !== false,
    desktopPolicies: value.desktopPolicies !== false,
    orgControls: value.orgControls !== false,
    analytics: value.analytics !== false,
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
      allowedEmailDomains: asStringArray(organization.allowedEmailDomains),
    },
  };
}

export function isEmailAllowedForOrganization(allowedEmailDomains: readonly string[] | null | undefined, email: string): boolean {
  if (!allowedEmailDomains || allowedEmailDomains.length === 0) {
    return true;
  }

  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex === -1 || atIndex + 1 >= normalized.length) {
    return false;
  }

  return allowedEmailDomains.includes(normalized.slice(atIndex + 1));
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

export function parseOrgScimPayload(payload: unknown): {
  baseUrl: string | null;
  connection: DenOrgScimConnection | null;
  health: DenOrgScimHealth;
  scimToken: string | null;
} {
  if (!isRecord(payload)) {
    return {
      baseUrl: null,
      connection: null,
      health: {
        unresolvedFailureCount: 0,
        lastFailureAt: null,
        lastFailureAction: null,
        lastFailureMessage: null,
        nextRetryAt: null,
        lastSuccessfulSyncAt: null,
      },
      scimToken: null,
    };
  }

  const rawConnection = isRecord(payload.connection) ? payload.connection : null;
  const connection = rawConnection
    ? (() => {
        const id = asString(rawConnection.id);
        const providerId = asString(rawConnection.providerId);
        const organizationId = asString(rawConnection.organizationId);

        if (!id || !providerId || !organizationId) {
          return null;
        }

        return {
          id,
          providerId,
          organizationId,
          createdAt: asIsoString(rawConnection.createdAt),
          updatedAt: asIsoString(rawConnection.updatedAt),
        } satisfies DenOrgScimConnection;
      })()
    : null;

  const rawHealth = isRecord(payload.health) ? payload.health : null;
  const health = {
    unresolvedFailureCount: typeof rawHealth?.unresolvedFailureCount === "number"
      ? rawHealth.unresolvedFailureCount
      : 0,
    lastFailureAt: asIsoString(rawHealth?.lastFailureAt),
    lastFailureAction: asString(rawHealth?.lastFailureAction),
    lastFailureMessage: asString(rawHealth?.lastFailureMessage),
    nextRetryAt: asIsoString(rawHealth?.nextRetryAt),
    lastSuccessfulSyncAt: asIsoString(rawHealth?.lastSuccessfulSyncAt),
  } satisfies DenOrgScimHealth;

  return {
    baseUrl: asString(payload.baseUrl),
    connection,
    health,
    scimToken: asString(payload.scimToken),
  };
}

export function parseOrgSsoPayload(payload: unknown): {
  connection: DenOrgSsoConnection | null;
  domainVerificationToken: string | null;
} {
  if (!isRecord(payload)) {
    return { connection: null, domainVerificationToken: null };
  }

  const rawConnection = isRecord(payload.connection) ? payload.connection : null;
  const connection = rawConnection
    ? (() => {
        const id = asString(rawConnection.id);
        const providerId = asString(rawConnection.providerId);
        const kind = asString(rawConnection.kind);
        const issuer = asString(rawConnection.issuer);
        const domain = asString(rawConnection.domain);
        const status = asString(rawConnection.status);
        const signInPath = asString(rawConnection.signInPath);
        const signInUrl = asString(rawConnection.signInUrl);
        const redirectUrl = asString(rawConnection.redirectUrl);
        const rawOidc = isRecord(rawConnection.oidc) ? rawConnection.oidc : null;
        const rawSaml = isRecord(rawConnection.saml) ? rawConnection.saml : null;
        const tokenEndpointAuthentication = asString(rawOidc?.tokenEndpointAuthentication);

        if (!id || !providerId || !issuer || !domain || !status || !signInPath || !signInUrl || !redirectUrl || (kind !== "oidc" && kind !== "saml")) {
          return null;
        }

        return {
          id,
          providerId,
          kind,
          issuer,
          domain,
          status,
          signInPath,
          signInUrl,
          redirectUrl,
          acsUrl: asString(rawConnection.acsUrl),
          metadataUrl: asString(rawConnection.metadataUrl),
          domainVerified: asBoolean(rawConnection.domainVerified),
          oidc: rawOidc
            ? {
                clientId: asString(rawOidc.clientId),
                scopes: asStringArray(rawOidc.scopes) ?? [],
                skipDiscovery: asBoolean(rawOidc.skipDiscovery),
                authorizationEndpoint: asString(rawOidc.authorizationEndpoint),
                tokenEndpoint: asString(rawOidc.tokenEndpoint),
                jwksEndpoint: asString(rawOidc.jwksEndpoint),
                userInfoEndpoint: asString(rawOidc.userInfoEndpoint),
                tokenEndpointAuthentication: tokenEndpointAuthentication === "client_secret_basic" || tokenEndpointAuthentication === "client_secret_post"
                  ? tokenEndpointAuthentication
                  : null,
              }
            : null,
          saml: rawSaml
            ? {
                entryPoint: asString(rawSaml.entryPoint),
                audience: asString(rawSaml.audience),
                wantAssertionsSigned: asBoolean(rawSaml.wantAssertionsSigned),
              }
            : null,
          lastTestedAt: asIsoString(rawConnection.lastTestedAt),
          lastError: asString(rawConnection.lastError),
          createdAt: asIsoString(rawConnection.createdAt),
          updatedAt: asIsoString(rawConnection.updatedAt),
        } satisfies DenOrgSsoConnection;
      })()
    : null;

  return { connection, domainVerificationToken: asString(payload.domainVerificationToken) };
}
