const BETTER_AUTH_SECURE_SESSION_COOKIES = [
  "__Secure-openwork-den.session_token",
  "__Secure-better-auth.session_token",
];

function normalizeCookieDomain(value: string | null | undefined): string | null {
  const domain = value?.trim().replace(/^\.+/u, "").toLowerCase() ?? "";
  if (!domain || domain.includes(":")) return null;
  return domain;
}

function parentCookieDomain(hostname: string): string | null {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 3) return null;
  return labels.slice(-2).join(".");
}

function domainCandidates(requestUrl: string, configuredDomain?: string): string[] {
  const candidates = new Set<string>();
  const configured = normalizeCookieDomain(configuredDomain);
  if (configured) candidates.add(configured);

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return Array.from(candidates);
  }

  const hostname = normalizeCookieDomain(url.hostname);
  if (hostname) {
    candidates.add(hostname);
    const parent = parentCookieDomain(hostname);
    if (parent) candidates.add(parent);
  }

  return Array.from(candidates);
}

export function buildAuthSessionCookieClearHeaders(requestUrl: string, configuredDomain = process.env.DEN_BETTER_AUTH_COOKIE_DOMAIN): string[] {
  return BETTER_AUTH_SECURE_SESSION_COOKIES.flatMap((cookieName) => {
    const expiredCookie = `${cookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
    return [
      expiredCookie,
      ...domainCandidates(requestUrl, configuredDomain).map((domain) => `${expiredCookie}; Domain=${domain}`),
    ];
  });
}
