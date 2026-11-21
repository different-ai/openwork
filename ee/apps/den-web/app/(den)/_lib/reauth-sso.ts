export type ReauthSsoTarget = {
  signInUrl: string;
  ssoOnly: boolean;
};

export type MemberSsoSignIn = {
  organizationId: string;
  signInUrl: string;
  ssoOnly: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMemberSsoSignIns(payload: unknown): MemberSsoSignIn[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.organizations)) return null;
  return payload.organizations.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { organizationId, signInUrl, ssoOnly } = entry;
    if (typeof organizationId !== "string" || !organizationId || typeof signInUrl !== "string" || !signInUrl) return [];
    return [{ organizationId, signInUrl, ssoOnly: ssoOnly === true }];
  });
}

export type ResolvedDomainSso = {
  signInUrl: string;
  domainForced: boolean;
  organizationRequired: boolean;
};

export function parseResolvedDomainSso(payload: unknown): ResolvedDomainSso | null {
  if (!isRecord(payload) || typeof payload.signInUrl !== "string" || !payload.signInUrl) return null;
  return {
    signInUrl: payload.signInUrl,
    domainForced: payload.requireSso === true,
    organizationRequired: payload.ssoRequired === true || (payload.ssoRequired === undefined && payload.requireSso === true),
  };
}

export function resolveReauthSsoTarget(input: {
  resolvedDomainSso: ResolvedDomainSso | null;
  organizationId: string | null;
  memberSsoSignIns: MemberSsoSignIn[] | null;
  organization: {
    slug: string;
    hasSso: boolean;
    requireSso: boolean;
    restrictDomainToSso: boolean;
  } | null;
}): ReauthSsoTarget | null {
  const domainSso = input.resolvedDomainSso;
  if (domainSso?.domainForced) {
    return { signInUrl: domainSso.signInUrl, ssoOnly: true };
  }

  if (input.memberSsoSignIns) {
    const match = input.organizationId
      ? input.memberSsoSignIns.find((entry) => entry.organizationId === input.organizationId)
      : input.memberSsoSignIns.length === 1 ? input.memberSsoSignIns[0] : undefined;
    return match ? { signInUrl: match.signInUrl, ssoOnly: match.ssoOnly } : null;
  }

  const organization = input.organization;
  if (organization) {
    if (!organization.hasSso || !organization.slug) {
      return null;
    }
    return {
      signInUrl: `/sso/${encodeURIComponent(organization.slug)}`,
      ssoOnly: organization.requireSso || organization.restrictDomainToSso,
    };
  }

  return domainSso ? { signInUrl: domainSso.signInUrl, ssoOnly: domainSso.organizationRequired } : null;
}
