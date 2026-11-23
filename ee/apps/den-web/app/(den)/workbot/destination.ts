export function workbotBaseUrl(env: { DEN_WORKBOT_URL?: string; DEN_DEPLOYMENT?: string } = process.env): string | null {
  const explicit = env.DEN_WORKBOT_URL?.trim();
  if (explicit) return explicit;
  return env.DEN_DEPLOYMENT?.trim() === "self_hosted" ? null : "https://chat.openworklabs.com";
}

export function workbotDestination(base: string, organizationId: string | string[] | undefined): string {
  if (typeof organizationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) return base;
  const url = new URL(base);
  url.searchParams.set("organization", organizationId);
  return url.toString();
}
