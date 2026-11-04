import type { SsoSessionMaxAgeHours } from "./den-org";

/**
 * The organization's SSO settings as saved and as drafted on the settings
 * screen. Only meaningful with ssoPerOrganization on; until then an enabled
 * SSO connection is the only way in, whatever these hold.
 */
export type SsoSettings = {
  requireSso: boolean;
  restrictDomainToSso: boolean;
  ssoSessionMaxAgeHours: SsoSessionMaxAgeHours | null;
};

export type SsoSettingsUpdate = Partial<SsoSettings>;

/**
 * What a settings save sends for SSO: only what the admin changed, and nothing
 * while ssoPerOrganization is off. Saving the name, domains or desktop
 * versions must never rewrite an SSO choice nobody made (the old screen sent
 * `requireSso: false` on every save).
 */
export function ssoSettingsChanges(input: { perOrganization: boolean; saved: SsoSettings; draft: SsoSettings }): SsoSettingsUpdate {
  if (!input.perOrganization) return {};
  const changes: SsoSettingsUpdate = {};
  if (input.draft.requireSso !== input.saved.requireSso) changes.requireSso = input.draft.requireSso;
  if (input.draft.restrictDomainToSso !== input.saved.restrictDomainToSso) changes.restrictDomainToSso = input.draft.restrictDomainToSso;
  if (input.draft.ssoSessionMaxAgeHours !== input.saved.ssoSessionMaxAgeHours) changes.ssoSessionMaxAgeHours = input.draft.ssoSessionMaxAgeHours;
  return changes;
}

/** Label for an "Ask for SSO again after" choice. */
export function ssoSessionMaxAgeLabel(hours: SsoSessionMaxAgeHours | null): string {
  if (hours === null) return "Only when their session ends";
  if (hours < 24) return `After ${hours} hours`;
  const days = hours / 24;
  return days === 1 ? "After 1 day" : `After ${days} days`;
}
