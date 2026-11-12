"use client";

import type { SsoSettings } from "../../_lib/sso-settings";
import { DenSwitch } from "../../_components/ui/switch";

const ROW_CLASS = "flex min-h-12 items-start justify-between gap-4 border-b border-[var(--den-list-line)] py-3";

export function ssoRequirementDescription(perOrganization: boolean) {
  return perOrganization
    ? "SSO is offered first at sign-in. Choose whether this organization, or your whole email domain, requires it."
    : "How sign-in works for people on your SSO domain.";
}

/**
 * The SSO requirement rows, on Org settings or the SSO page. With
 * ssoPerOrganization off an enabled SSO connection is the only way in, so the
 * rows state that instead of offering a switch that changes nothing.
 */
export function SsoRequirementFields(props: {
  perOrganization: boolean;
  draft: SsoSettings;
  disabled: boolean;
  onChange: (next: SsoSettings) => void;
}) {
  const { perOrganization, draft, disabled, onChange } = props;

  if (!perOrganization) {
    return (
      <div className={ROW_CLASS} data-testid="sso-legacy-status">
        <p className="text-[13px] font-medium text-[var(--dls-text-primary)]">
          Required: with SSO on, everyone on your verified domain signs in with it
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={ROW_CLASS} data-testid="require-sso-row">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-[13px] font-medium text-[var(--dls-text-primary)]">Require SSO</p>
          <p className="text-[12px] text-[var(--dls-text-secondary)]">
            Members open this organization only after signing in with its SSO. They can still use their password or Google for other organizations.
          </p>
        </div>
        <DenSwitch
          aria-label="Require SSO for this organization"
          checked={draft.requireSso}
          disabled={disabled}
          onChange={(requireSso) => onChange({ ...draft, requireSso })}
        />
      </div>
      <div className={ROW_CLASS} data-testid="restrict-domain-sso-row">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-[13px] font-medium text-[var(--dls-text-primary)]">Restrict this domain to our SSO</p>
          <p className="text-[12px] text-[var(--dls-text-secondary)]">
            Everyone with an email on your verified SSO domain must sign in with this organization&apos;s SSO, including people invited to other organizations.
          </p>
        </div>
        <DenSwitch
          aria-label="Restrict this domain to our SSO"
          checked={draft.restrictDomainToSso}
          disabled={disabled}
          onChange={(restrictDomainToSso) => onChange({ ...draft, restrictDomainToSso })}
        />
      </div>
    </>
  );
}
