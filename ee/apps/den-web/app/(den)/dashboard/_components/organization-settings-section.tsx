"use client";

import { Check, Copy, Pencil } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenTextarea } from "../../_components/ui/textarea";
import { compareDesktopVersions } from "./desktop-version-options";

type DesktopVersionRange = {
  minVersion: string;
  maxVersion: string;
};

type OrganizationSettingsSectionProps = {
  error: string | null;
  success: string | null;
  canManageSettings: boolean;
  canManageDesktopVersions: boolean;
  saving: boolean;
  organizationId: string;
  organizationName: string;
  copiedOrganizationId: boolean;
  currentAllowedDomains: string[] | null;
  allowedDomains: string;
  domainRestrictionsEnabled: boolean;
  domainEditModeEnabled: boolean;
  hasDraftDomains: boolean;
  requireSsoEnabled: boolean;
  desktopVersionOptions: string[];
  desktopVersionRange: DesktopVersionRange | null;
  selectedDesktopVersions: ReadonlySet<string>;
  desktopVersionOptionsBusy: boolean;
  desktopVersionOptionsError: string | null;
  onOrganizationNameChange: (value: string) => void;
  onCopyOrganizationId: () => void;
  onDomainRestrictionToggle: (value: boolean) => void;
  onDomainEdit: () => void;
  onAllowedDomainsChange: (value: string) => void;
  onRequireSsoChange: (value: boolean) => void;
  onDesktopVersionChange: (version: string, checked: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
};

function SettingsToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (nextValue: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-7 w-12 items-center rounded-full border transition-colors",
        checked
          ? "border-[#0f172a] bg-[#0f172a]"
          : "border-gray-200 bg-gray-200",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "inline-block h-5 w-5 rounded-full bg-white transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
}

export function OrganizationSettingsSection({
  error,
  success,
  canManageSettings,
  canManageDesktopVersions,
  saving,
  organizationId,
  organizationName,
  copiedOrganizationId,
  currentAllowedDomains,
  allowedDomains,
  domainRestrictionsEnabled,
  domainEditModeEnabled,
  hasDraftDomains,
  requireSsoEnabled,
  desktopVersionOptions,
  desktopVersionRange,
  selectedDesktopVersions,
  desktopVersionOptionsBusy,
  desktopVersionOptionsError,
  onOrganizationNameChange,
  onCopyOrganizationId,
  onDomainRestrictionToggle,
  onDomainEdit,
  onAllowedDomainsChange,
  onRequireSsoChange,
  onDesktopVersionChange,
  onSubmit,
}: OrganizationSettingsSectionProps) {
  return (
    <section
      aria-labelledby="organization-settings-section-title"
      className="grid min-w-0 gap-6"
      data-testid="organization-settings-section"
    >
      <div className="grid gap-1">
        <h2
          id="organization-settings-section-title"
          className="text-[20px] font-semibold tracking-[-0.03em] text-gray-950"
        >
          Organization settings
        </h2>
        <p className="text-[13px] leading-6 text-gray-500">
          Manage your organization identity and access requirements.
        </p>
      </div>

      {error ? <DenNotice message={error} /> : null}
      {success ? (
        <div className="rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">
          {success}
        </div>
      ) : null}

      <form className="grid min-w-0 grid-cols-1 gap-6" onSubmit={onSubmit}>
        <DenCard size="spacious" className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Core
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
              Organization Identity
            </h2>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">
                Name
              </span>
              <DenInput
                type="text"
                value={organizationName}
                onChange={(event) => onOrganizationNameChange(event.target.value)}
                minLength={2}
                maxLength={120}
                disabled={!canManageSettings}
                required
              />
            </label>

            <div className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">ID</span>
              <div className="flex gap-2">
                <DenInput
                  value={organizationId}
                  readOnly
                  aria-label="Organization ID"
                  className="font-mono text-[13px]"
                />
                <DenButton
                  variant="secondary"
                  type="button"
                  icon={copiedOrganizationId ? Check : Copy}
                  onClick={onCopyOrganizationId}
                >
                  {copiedOrganizationId ? "Copied" : "Copy"}
                </DenButton>
              </div>
            </div>
          </div>
        </DenCard>

        <DenCard size="spacious" className="grid gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-2">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                Access rules
              </p>
              <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
                Allowed email domains
              </h2>
              <p className="text-[14px] text-gray-500">
                Only allow people with specific email domains to join this
                Organization.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <span className="text-[13px] font-medium text-gray-500">
                {domainRestrictionsEnabled ? "On" : "Off"}
              </span>
              <SettingsToggle
                label="Restrict allowed email domains"
                checked={domainRestrictionsEnabled}
                disabled={
                  !canManageSettings || (domainRestrictionsEnabled && hasDraftDomains)
                }
                onChange={onDomainRestrictionToggle}
              />
            </div>
          </div>

          {domainRestrictionsEnabled && domainEditModeEnabled ? (
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">
                Domain allowlist
              </span>
              <span className="text-[10px] text-gray-500">
                Enter domains one per line or with comma as separator
              </span>
              <DenTextarea
                value={allowedDomains}
                onChange={(event) => onAllowedDomainsChange(event.target.value)}
                rows={6}
                disabled={!canManageSettings}
                placeholder={"company.com\npartner.org"}
              />
            </label>
          ) : null}

          {domainRestrictionsEnabled && !domainEditModeEnabled ? (
            <div className="grid gap-3 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                {currentAllowedDomains && currentAllowedDomains.length > 0 ? (
                  <div className="flex flex-wrap w-full gap-2">
                    {currentAllowedDomains.map((domain) => (
                      <span
                        key={domain}
                        className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[13px] text-gray-700"
                      >
                        {domain}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[14px] text-gray-600">
                    No email domains are configured yet.
                  </p>
                )}
                {canManageSettings ? (
                  <DenButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon={Pencil}
                    onClick={onDomainEdit}
                  >
                    Edit
                  </DenButton>
                ) : null}
              </div>
            </div>
          ) : null}
        </DenCard>

        <DenCard size="spacious" className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Authentication
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
              Single sign-on requirement
            </h2>
            <p className="text-[14px] text-gray-500">
              Require members to use the workspace SSO entrypoint when their email domain matches this organization.
            </p>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4">
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
              onChange={onRequireSsoChange}
            />
          </div>
        </DenCard>

        <DenCard size="spacious" className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Desktop app
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
              Allowed Desktop Versions
            </h2>
            <p className="text-[14px] text-gray-500">
              Choose which supported desktop versions can sign in to this
              workspace.
            </p>
            {desktopVersionRange ? (
              <p className="text-[10px] text-gray-400">
                This server currently supports desktop v
                {desktopVersionRange.minVersion} to v
                {desktopVersionRange.maxVersion}.
              </p>
            ) : null}
          </div>

          {desktopVersionOptionsBusy ? (
            <div className="rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-4 text-[14px] text-gray-500">
              Loading desktop versions...
            </div>
          ) : null}

          {desktopVersionOptionsError ? (
            <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-[14px] text-amber-800">
              {desktopVersionOptionsError}
            </div>
          ) : null}

          {!desktopVersionOptionsBusy &&
          !desktopVersionOptionsError &&
          desktopVersionOptions.length > 0 ? (
            <div className="grid gap-4">
              <div
                data-testid="desktop-version-list"
                className="grid max-h-[400px] gap-3 overflow-y-auto pr-2"
              >
                {desktopVersionOptions.map((version) => {
                  const checked = selectedDesktopVersions.has(version);
                  const requiresServerUpgrade =
                    desktopVersionRange !== null &&
                    compareDesktopVersions(
                      version,
                      desktopVersionRange.maxVersion,
                    ) > 0;

                  return (
                    <label
                      key={version}
                      data-desktop-version={version}
                      data-supported={!requiresServerUpgrade}
                      className={[
                        "flex items-center justify-between gap-4 rounded-[24px] border px-5 py-4",
                        requiresServerUpgrade
                          ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400"
                          : "border-gray-200 bg-white",
                      ].join(" ")}
                    >
                      <div className="grid gap-1">
                        <p
                          className={[
                            "text-[15px] font-medium",
                            requiresServerUpgrade
                              ? "text-gray-400"
                              : "text-gray-900",
                          ].join(" ")}
                        >
                          v{version}
                        </p>
                        {requiresServerUpgrade ? (
                          <p className="text-[12px] text-gray-400">
                            Upgrade server to allow this version
                          </p>
                        ) : null}
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManageDesktopVersions || requiresServerUpgrade}
                        aria-label={`Allow desktop version v${version}`}
                        onChange={(event) =>
                          onDesktopVersionChange(version, event.target.checked)
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </DenCard>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-gray-500">
            {!canManageSettings ? "Admins can view settings here. Owners and super-admins can change them." : null}
          </p>
          <DenButton
            type="submit"
            loading={saving}
            disabled={!canManageSettings}
          >
            Save settings
          </DenButton>
        </div>
      </form>
    </section>
  );
}
