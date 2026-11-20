import type { OrganizationSsoPolicy } from "@openwork-ee/sso";

/**
 * The organization's SSO settings as saved and as drafted on the settings
 * screen: the policy Den API enforces (@openwork-ee/sso).
 */
export type SsoSettings = OrganizationSsoPolicy;

export type SsoSettingsUpdate = Partial<SsoSettings>;

/**
 * What a settings save sends for SSO: only what the admin changed. Saving the name, domains or desktop
 * versions must never rewrite an SSO choice nobody made (the old screen sent
 * `requireSso: false` on every save).
 */
export function ssoSettingsChanges(input: { saved: SsoSettings; draft: SsoSettings }): SsoSettingsUpdate {
  const changes: SsoSettingsUpdate = {};
  if (input.draft.requireSso !== input.saved.requireSso) changes.requireSso = input.draft.requireSso;
  if (input.draft.restrictDomainToSso !== input.saved.restrictDomainToSso) changes.restrictDomainToSso = input.draft.restrictDomainToSso;
  return changes;
}
