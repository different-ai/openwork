/**
 * Where the re-authentication dialog sends someone to confirm through SSO.
 *
 * Signed in: the person's organizations from `/v1/me/sso-sign-in`, falling
 * back to the active organization's context on an older Den API. Not signed
 * in (desktop page, email typed): `/v1/orgs/sso/resolve`, which returns the
 * email domain's SSO as a sign-in option, or as the only one when SSO is
 * forced for the domain. Older APIs return the link only when forced.
 */
export type ReauthSsoTarget = {
  /** Path or URL of the organization's SSO sign-in page. */
  signInUrl: string;
  /** Only SSO may confirm: other methods would create a session the organization refuses. */
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

/** Parses `GET /v1/me/sso-sign-in`; null when the response is not that shape. */
export function parseMemberSsoSignIns(payload: unknown): MemberSsoSignIn[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.organizations)) return null;
  return payload.organizations.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { organizationId, signInUrl, ssoOnly } = entry;
    if (typeof organizationId !== "string" || !organizationId || typeof signInUrl !== "string" || !signInUrl) return [];
    return [{ organizationId, signInUrl, ssoOnly: ssoOnly === true }];
  });
}

/** The SSO option `/v1/orgs/sso/resolve` returns for the email's domain. */
export type ResolvedDomainSso = {
  signInUrl: string;
  /** `requireSso`: SSO is forced for the whole domain, so it is the only way to sign in. */
  domainForced: boolean;
  /** `ssoRequired`: the domain's organization only opens from an SSO session. */
  organizationRequired: boolean;
};

/** Parses `/v1/orgs/sso/resolve`; null when it offers no SSO for the email. */
export function parseResolvedDomainSso(payload: unknown): ResolvedDomainSso | null {
  if (!isRecord(payload) || typeof payload.signInUrl !== "string" || !payload.signInUrl) return null;
  return {
    signInUrl: payload.signInUrl,
    domainForced: payload.requireSso === true,
    // Before ssoRequired existed, the route returned a link only when SSO was forced.
    organizationRequired: payload.ssoRequired === true || (payload.ssoRequired === undefined && payload.requireSso === true),
  };
}

export function resolveReauthSsoTarget(input: {
  /** The email domain's SSO from `/v1/orgs/sso/resolve`. */
  resolvedDomainSso: ResolvedDomainSso | null;
  /** The organization the change is for, when known (dashboard context or the desktop's active organization). */
  organizationId: string | null;
  /** `/v1/me/sso-sign-in`, or null when it could not be read. */
  memberSsoSignIns: MemberSsoSignIn[] | null;
  /** The active organization's context, used only when `/v1/me/sso-sign-in` could not be read. */
  organization: {
    slug: string;
    hasSso: boolean;
    requireSso: boolean;
    restrictDomainToSso: boolean;
  } | null;
}): ReauthSsoTarget | null {
  const domainSso = input.resolvedDomainSso;
  // SSO forced for the whole domain: no other sign-in works at all.
  if (domainSso?.domainForced) {
    return { signInUrl: domainSso.signInUrl, ssoOnly: true };
  }

  if (input.memberSsoSignIns) {
    // A known organization must match exactly: another organization's SSO
    // does not confirm a change here. Without one, a single SSO organization is unambiguous.
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

  // No session and no organization context (the desktop page after typing an
  // email): the email domain's SSO is one of the sign-in options, or the only
  // one when that organization requires SSO.
  return domainSso ? { signInUrl: domainSso.signInUrl, ssoOnly: domainSso.organizationRequired } : null;
}
