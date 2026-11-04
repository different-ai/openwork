"use client";

import { isSsoSessionMaxAgeHours, SSO_SESSION_MAX_AGE_HOURS } from "../../_lib/den-org";
import { ssoSessionMaxAgeLabel, type SsoSettings } from "../../_lib/sso-settings";
import { DenSelect } from "../../_components/ui/select";
import { SettingsToggle } from "./settings-toggle";

const ROW_CLASS = "flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4";

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
      <div className="rounded-[24px] border border-gray-200 bg-white px-5 py-4" data-testid="sso-legacy-status">
        <p className="text-[15px] font-medium text-gray-900">
          Required: with SSO on, everyone on your verified domain signs in with it
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={ROW_CLASS} data-testid="require-sso-row">
        <div className="grid gap-1 pr-4">
          <p className="text-[15px] font-medium text-gray-900">Require SSO</p>
          <p className="text-[13px] text-gray-500">
            Members open this organization only after signing in with its SSO. They can still use their password or Google for other organizations.
          </p>
        </div>
        <SettingsToggle
          label="Require SSO for this organization"
          checked={draft.requireSso}
          disabled={disabled}
          onChange={(requireSso) => onChange({ ...draft, requireSso })}
        />
      </div>
      <div className={ROW_CLASS} data-testid="restrict-domain-sso-row">
        <div className="grid gap-1 pr-4">
          <p className="text-[15px] font-medium text-gray-900">Restrict this domain to our SSO</p>
          <p className="text-[13px] text-gray-500">
            Everyone with an email on your verified SSO domain must sign in with this organization&apos;s SSO, including people invited to other organizations.
          </p>
        </div>
        <SettingsToggle
          label="Restrict this domain to our SSO"
          checked={draft.restrictDomainToSso}
          disabled={disabled}
          onChange={(restrictDomainToSso) => onChange({ ...draft, restrictDomainToSso })}
        />
      </div>
      <div className={ROW_CLASS} data-testid="sso-max-age-row">
        <div className="grid gap-1 pr-4">
          <p className="text-[15px] font-medium text-gray-900">Ask for SSO again</p>
          <p className="text-[13px] text-gray-500">
            When SSO is required, how long a sign-in with it keeps this organization open before members sign in with SSO again.
          </p>
        </div>
        <div className="w-[220px] shrink-0">
          <DenSelect
            aria-label="Ask for SSO again"
            value={draft.ssoSessionMaxAgeHours === null ? "" : String(draft.ssoSessionMaxAgeHours)}
            disabled={disabled}
            onChange={(event) => {
              const hours = Number(event.target.value);
              onChange({ ...draft, ssoSessionMaxAgeHours: event.target.value && isSsoSessionMaxAgeHours(hours) ? hours : null });
            }}
            menuWidth="trigger"
          >
            <option value="">{ssoSessionMaxAgeLabel(null)}</option>
            {SSO_SESSION_MAX_AGE_HOURS.map((hours) => (
              <option key={hours} value={String(hours)}>{ssoSessionMaxAgeLabel(hours)}</option>
            ))}
          </DenSelect>
        </div>
      </div>
    </>
  );
}
