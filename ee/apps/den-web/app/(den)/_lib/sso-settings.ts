import type { OrganizationSsoPolicy } from "@openwork-ee/den-sso";

export type SsoSettings = OrganizationSsoPolicy;

export type SsoSettingsUpdate = Partial<SsoSettings>;

export function ssoSettingsChanges(input: { saved: SsoSettings; draft: SsoSettings }): SsoSettingsUpdate {
  const changes: SsoSettingsUpdate = {};
  if (input.draft.requireSso !== input.saved.requireSso) changes.requireSso = input.draft.requireSso;
  if (input.draft.restrictDomainToSso !== input.saved.restrictDomainToSso) changes.restrictDomainToSso = input.draft.restrictDomainToSso;
  return changes;
}
