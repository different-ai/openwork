/**
 * Where the re-authentication dialog sends someone to confirm through SSO.
 *
 * `/v1/orgs/sso/resolve` is the sign-in page's preflight: it only returns a
 * `signInUrl` when SSO is the sole way in for the email's domain (legacy SSO
 * or "Restrict this domain to our SSO"). With `ssoPerOrganization` on and the
 * domain not restricted it returns no link, even though the organization has
 * SSO set up. So the dialog reads the person's organization SSO from
 * `/v1/me/sso-sign-in`, falling back to the active organization's context
 * when that route is unavailable (an older Den API).
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

export function resolveReauthSsoTarget(input: {
  /** `signInUrl` from `/v1/orgs/sso/resolve`, set only when the domain must use SSO. */
  resolvedSignInUrl: string | null;
  /** The organization the change is for, when known (dashboard context or the desktop's active organization). */
  organizationId: string | null;
  /** `/v1/me/sso-sign-in`, or null when it could not be read. */
  memberSsoSignIns: MemberSsoSignIn[] | null;
  /** The active organization's context, used only when `/v1/me/sso-sign-in` could not be read. */
  organization: {
    slug: string;
    hasSso: boolean;
    perOrganization: boolean;
    requireSso: boolean;
    restrictDomainToSso: boolean;
  } | null;
}): ReauthSsoTarget | null {
  if (input.resolvedSignInUrl) {
    return { signInUrl: input.resolvedSignInUrl, ssoOnly: true };
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
  if (!organization?.hasSso || !organization.slug) {
    return null;
  }
  return {
    signInUrl: `/sso/${encodeURIComponent(organization.slug)}`,
    ssoOnly: !organization.perOrganization || organization.requireSso || organization.restrictDomainToSso,
  };
}
