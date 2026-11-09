"use client";

import { useEffect, useState } from "react";
import { SsoSessionRequiredError } from "../../_lib/den-flow";
import {
  getOrgAccessFlags,
  getSsoSettingsFromMetadata,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { ssoSettingsChanges, type SsoSettings } from "../../_lib/sso-settings";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { SsoRequirementFields, ssoRequirementDescription } from "./sso-requirement-fields";

/** SSO › Authentication: whether members must sign in with this organization's SSO. */
export function SsoRequirementSection() {
  const { orgContext, mutationBusy, updateOrganizationSettings } = useOrgDashboard();
  const [draft, setDraft] = useState<SsoSettings>({ requireSso: false, restrictDomainToSso: false });
  const [error, setError] = useState<string | null>(null);
  const [ssoRecoveryPath, setSsoRecoveryPath] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!orgContext) {
      return;
    }

    setDraft(getSsoSettingsFromMetadata(orgContext.organization.metadata));
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
  const changes = ssoSettingsChanges({
    perOrganization: ssoPerOrganization,
    saved: getSsoSettingsFromMetadata(orgContext.organization.metadata),
    draft,
  });
  const dirty = Object.keys(changes).length > 0;

  function updateDraft(next: SsoSettings) {
    setError(null);
    setSsoRecoveryPath(null);
    setSaved(false);
    setDraft(next);
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSsoRecoveryPath(null);
    setSaved(false);

    if (!canManageSettings) {
      setError("You don't have permission to change settings.");
      return;
    }

    try {
      await updateOrganizationSettings(changes);
      setSaved(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update SSO settings.");
      if (nextError instanceof SsoSessionRequiredError) {
        setSsoRecoveryPath(`${nextError.signInPath}?callbackURL=${encodeURIComponent(window.location.href)}`);
      }
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
          <p className="text-[14px] text-gray-500">{ssoRequirementDescription(ssoPerOrganization)}</p>
        </div>

        {!orgContext.entitlements.orgControls ? <EnterprisePlanNotice feature="Enforced SSO" /> : null}
        {error ? (
          <DenNotice
            message={error}
            tone={ssoRecoveryPath ? "neutral" : "error"}
            action={ssoRecoveryPath ? (
              <DenButton href={ssoRecoveryPath} variant="secondary" size="sm">
                Sign in with SSO
              </DenButton>
            ) : undefined}
          />
        ) : null}

        <SsoRequirementFields
          perOrganization={ssoPerOrganization}
          draft={draft}
          disabled={!canManageSettings}
          onChange={updateDraft}
        />

        {ssoPerOrganization ? (
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
        ) : null}
      </DenCard>
    </form>
  );
}
