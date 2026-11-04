"use client";

import { useEffect, useState } from "react";
import {
  getOrgAccessFlags,
  getRequireSsoFromMetadata,
  getRestrictDomainToSsoFromMetadata,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { SettingsToggle } from "./settings-toggle";

/** SSO › Authentication: whether members must sign in with this organization's SSO. */
export function SsoRequirementSection() {
  const { orgContext, mutationBusy, updateOrganizationSettings } = useOrgDashboard();
  const [requireSsoEnabled, setRequireSsoEnabled] = useState(false);
  const [restrictDomainToSsoEnabled, setRestrictDomainToSsoEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!orgContext) {
      return;
    }

    setRequireSsoEnabled(getRequireSsoFromMetadata(orgContext.organization.metadata));
    setRestrictDomainToSsoEnabled(getRestrictDomainToSsoFromMetadata(orgContext.organization.metadata));
  }, [orgContext]);

  if (!orgContext) {
    return null;
  }

  const canManageSettings = getOrgAccessFlags(
    orgContext.currentMember.role,
    orgContext.currentMember.isOwner,
    orgContext.currentMember.permissions,
  ).canManageSettings;
  const ssoPerOrganization = orgFeatureEnabled(orgContext, "ssoPerOrganization");
  const storedRequireSso = getRequireSsoFromMetadata(orgContext.organization.metadata);
  const storedRestrictDomainToSso = getRestrictDomainToSsoFromMetadata(orgContext.organization.metadata);
  const dirty =
    requireSsoEnabled !== storedRequireSso ||
    (ssoPerOrganization && restrictDomainToSsoEnabled !== storedRestrictDomainToSso);

  function updateDraft(update: () => void) {
    setError(null);
    setSaved(false);
    update();
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    if (!canManageSettings) {
      setError("You don't have permission to change settings.");
      return;
    }

    try {
      await updateOrganizationSettings({
        requireSso: requireSsoEnabled,
        ...(ssoPerOrganization ? { restrictDomainToSso: restrictDomainToSsoEnabled } : {}),
      });
      setSaved(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update SSO settings.");
    }
  }

  return (
    <form className="mb-6" onSubmit={handleSave} data-testid="sso-requirement-section">
      <DenCard size="spacious" className="grid gap-6">
        <div className="grid gap-2">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            Authentication
          </p>
          <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
            Single sign-on requirement
          </h2>
          <p className="text-[14px] text-gray-500">
            {ssoPerOrganization
              ? "SSO is offered first at sign-in. Choose whether this organization, or your whole email domain, requires it."
              : "Require members to use the workspace SSO entrypoint when their email domain matches this organization."}
          </p>
        </div>

        {!orgContext.entitlements.orgControls ? <EnterprisePlanNotice feature="Enforced SSO" /> : null}
        {error ? <DenNotice message={error} /> : null}

        {ssoPerOrganization ? (
          <>
            <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4" data-testid="require-sso-row">
              <div className="grid gap-1 pr-4">
                <p className="text-[15px] font-medium text-gray-900">Require SSO</p>
                <p className="text-[13px] text-gray-500">
                  Members open this organization only after signing in with its SSO. They can still use their password or Google for other organizations.
                </p>
              </div>
              <SettingsToggle
                label="Require SSO for this organization"
                checked={requireSsoEnabled}
                disabled={!canManageSettings}
                onChange={(next) => updateDraft(() => setRequireSsoEnabled(next))}
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4" data-testid="restrict-domain-sso-row">
              <div className="grid gap-1 pr-4">
                <p className="text-[15px] font-medium text-gray-900">Restrict this domain to our SSO</p>
                <p className="text-[13px] text-gray-500">
                  Everyone with an email on your verified SSO domain must sign in with this organization&apos;s SSO, including people invited to other organizations.
                </p>
              </div>
              <SettingsToggle
                label="Restrict this domain to our SSO"
                checked={restrictDomainToSsoEnabled}
                disabled={!canManageSettings}
                onChange={(next) => updateDraft(() => setRestrictDomainToSsoEnabled(next))}
              />
            </div>
          </>
        ) : (
          <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4" data-testid="require-sso-row">
            <div className="grid gap-1 pr-4">
              <p className="text-[15px] font-medium text-gray-900">Require SSO for matching domains</p>
              <p className="text-[13px] text-gray-500">
                Email/password sign-in will redirect users to the org SSO flow when their email domain matches the configured SSO connection.
              </p>
            </div>
            <SettingsToggle
              label="Require SSO for this organization"
              checked={requireSsoEnabled}
              disabled={!canManageSettings}
              onChange={(next) => updateDraft(() => setRequireSsoEnabled(next))}
            />
          </div>
        )}

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-gray-500" role="status">
            {!canManageSettings
              ? `Read only. ${permissionLockReason("organization.update")}`
              : saved && !dirty
                ? "SSO settings saved."
                : null}
          </p>
          <DenButton
            type="submit"
            loading={mutationBusy === "update-organization-settings"}
            disabled={!canManageSettings || !dirty}
          >
            Save
          </DenButton>
        </div>
      </DenCard>
    </form>
  );
}
