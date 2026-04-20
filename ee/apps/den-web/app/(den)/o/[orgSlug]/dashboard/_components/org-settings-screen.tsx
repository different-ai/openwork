"use client";

import { Check, Copy, Pencil, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { getAllowedDesktopVersionsFromMetadata } from "../../../../_lib/den-org";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../_components/ui/button";
import { DenCard } from "../../../../_components/ui/card";
import { DenInput } from "../../../../_components/ui/input";
import { DenTextarea } from "../../../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function normalizeAllowedEmailDomainsInput(value: string): string[] | null {
  const domains = [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase().replace(/^@+/, ""))
        .filter(Boolean),
    ),
  ];

  return domains.length > 0 ? domains : null;
}

function normalizeDesktopVersionString(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function getDesktopVersionMetadata(payload: unknown): {
  minAppVersion: string;
  latestAppVersion: string;
} | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;

  const minAppVersion =
    typeof record.minAppVersion === "string"
      ? normalizeDesktopVersionString(record.minAppVersion)
      : null;
  const latestAppVersion =
    typeof record.latestAppVersion === "string"
      ? normalizeDesktopVersionString(record.latestAppVersion)
      : null;

  if (!minAppVersion || !latestAppVersion) {
    return null;
  }

  return { minAppVersion, latestAppVersion };
}

function buildDesktopVersionOptions(
  minVersion: string,
  maxVersion: string,
): string[] {
  const minMatch = minVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const maxMatch = maxVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!minMatch || !maxMatch) {
    return [...new Set([minVersion, maxVersion])];
  }

  const minMajor = Number(minMatch[1]);
  const minMinor = Number(minMatch[2]);
  const minPatch = Number(minMatch[3]);
  const maxMajor = Number(maxMatch[1]);
  const maxMinor = Number(maxMatch[2]);
  const maxPatch = Number(maxMatch[3]);

  if (minMajor !== maxMajor || minMinor !== maxMinor || minPatch > maxPatch) {
    return [...new Set([minVersion, maxVersion])];
  }

  return Array.from(
    { length: maxPatch - minPatch + 1 },
    (_, index) => `${minMajor}.${minMinor}.${minPatch + index}`,
  );
}

function toggleAllowedDesktopVersion(
  current: string[],
  version: string,
  checked: boolean,
) {
  if (checked) {
    return current.includes(version) ? current : [...current, version];
  }

  return current.filter((entry) => entry !== version);
}

function filterAllowedDesktopVersionsToVisibleOptions(
  storedVersions: string[] | null,
  visibleOptions: string[],
) {
  if (storedVersions === null) {
    return null;
  }

  const visibleOptionSet = new Set(visibleOptions);
  return storedVersions.filter((version) => visibleOptionSet.has(version));
}

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

export function OrgSettingsScreen() {
  const {
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    updateOrganizationSettings,
  } = useOrgDashboard();
  const [orgNameDraft, setOrgNameDraft] = useState("");
  const [allowedDomainsDraft, setAllowedDomainsDraft] = useState("");
  const [domainRestrictionsEnabled, setDomainRestrictionsEnabled] =
    useState(false);
  const [allowNonCloudModelsEnabled, setAllowNonCloudModelsEnabled] =
    useState(true);
  const [allowZenModelEnabled, setAllowZenModelEnabled] = useState(true);
  const [allowMultipleWorkspacesEnabled, setAllowMultipleWorkspacesEnabled] =
    useState(true);
  const [domainEditModeEnabled, setDomainEditModeEnabled] = useState(false);
  const [desktopVersionOptions, setDesktopVersionOptions] = useState<string[]>(
    [],
  );
  const [allowedDesktopVersionsDraft, setAllowedDesktopVersionsDraft] =
    useState<string[]>([]);
  const [desktopVersionOptionsBusy, setDesktopVersionOptionsBusy] =
    useState(false);
  const [desktopVersionOptionsError, setDesktopVersionOptionsError] = useState<
    string | null
  >(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState(false);

  const currentAllowedDomains =
    orgContext?.organization.allowedEmailDomains ?? null;
  const currentDesktopAppRestrictions =
    orgContext?.organization.desktopAppRestrictions ?? {};
  const isOwner = orgContext?.currentMember.isOwner ?? false;
  const draftAllowedDomains = useMemo(
    () => normalizeAllowedEmailDomainsInput(allowedDomainsDraft),
    [allowedDomainsDraft],
  );
  const hasDraftDomains = (draftAllowedDomains?.length ?? 0) > 0;
  const visibleAllowedDesktopVersionsDraft = useMemo(
    () =>
      filterAllowedDesktopVersionsToVisibleOptions(
        allowedDesktopVersionsDraft,
        desktopVersionOptions,
      ) ?? [],
    [allowedDesktopVersionsDraft, desktopVersionOptions],
  );
  const selectedDesktopVersions = useMemo(
    () => new Set(visibleAllowedDesktopVersionsDraft),
    [visibleAllowedDesktopVersionsDraft],
  );
  const allDesktopVersionsAllowed =
    desktopVersionOptions.length > 0 &&
    desktopVersionOptions.every((version) =>
      selectedDesktopVersions.has(version),
    );

  useEffect(() => {
    if (!orgContext) {
      return;
    }

    setOrgNameDraft(orgContext.organization.name);
    setAllowedDomainsDraft(
      (orgContext.organization.allowedEmailDomains ?? []).join("\n"),
    );
    setDomainRestrictionsEnabled(
      (orgContext.organization.allowedEmailDomains?.length ?? 0) > 0,
    );
    setAllowNonCloudModelsEnabled(
      orgContext.organization.desktopAppRestrictions.disallowNonCloudModels !==
        true,
    );
    setAllowZenModelEnabled(
      orgContext.organization.desktopAppRestrictions.blockZenModel !== true,
    );
    setAllowMultipleWorkspacesEnabled(
      orgContext.organization.desktopAppRestrictions.blockMultipleWorkspaces !==
        true,
    );
    setDomainEditModeEnabled(false);
  }, [orgContext]);

  useEffect(() => {
    let cancelled = false;

    async function loadDesktopVersionOptions() {
      setDesktopVersionOptionsBusy(true);
      setDesktopVersionOptionsError(null);

      try {
        const { response, payload } = await requestJson(
          "/v1/app-version",
          { method: "GET" },
          12000,
        );

        if (!response.ok) {
          throw new Error(
            getErrorMessage(
              payload,
              `Failed to load desktop version metadata (${response.status}).`,
            ),
          );
        }

        const metadata = getDesktopVersionMetadata(payload);
        if (!metadata) {
          throw new Error("Desktop version metadata was incomplete.");
        }

        if (cancelled) {
          return;
        }

        setDesktopVersionOptions(
          buildDesktopVersionOptions(
            metadata.minAppVersion,
            metadata.latestAppVersion,
          ),
        );
      } catch (error) {
        if (!cancelled) {
          setDesktopVersionOptions([]);
          setDesktopVersionOptionsError(
            error instanceof Error
              ? error.message
              : "Could not load desktop versions.",
          );
        }
      } finally {
        if (!cancelled) {
          setDesktopVersionOptionsBusy(false);
        }
      }
    }

    void loadDesktopVersionOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgContext || desktopVersionOptions.length === 0) {
      return;
    }

    const storedAllowedDesktopVersions =
      filterAllowedDesktopVersionsToVisibleOptions(
        getAllowedDesktopVersionsFromMetadata(orgContext.organization.metadata),
        desktopVersionOptions,
      );

    if (storedAllowedDesktopVersions === null) {
      setAllowedDesktopVersionsDraft(desktopVersionOptions);
      return;
    }

    setAllowedDesktopVersionsDraft(storedAllowedDesktopVersions);
  }, [desktopVersionOptions, orgContext]);

  useEffect(() => {
    if (
      visibleAllowedDesktopVersionsDraft.length ===
      allowedDesktopVersionsDraft.length
    ) {
      return;
    }

    setAllowedDesktopVersionsDraft(visibleAllowedDesktopVersionsDraft);
  }, [allowedDesktopVersionsDraft.length, visibleAllowedDesktopVersionsDraft]);

  useEffect(() => {
    if (!copiedOrgId) {
      return;
    }

    const timeout = window.setTimeout(() => setCopiedOrgId(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copiedOrgId]);

  const createdAtLabel = useMemo(() => {
    if (!orgContext?.organization.createdAt) {
      return "Not available";
    }

    return new Date(orgContext.organization.createdAt).toLocaleDateString();
  }, [orgContext?.organization.createdAt]);

  if (orgBusy && !orgContext) {
    return (
      <div className="mx-auto max-w-[860px] p-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading workspace settings...
        </div>
      </div>
    );
  }

  if (!activeOrg || !orgContext) {
    return (
      <div className="mx-auto max-w-[860px] p-8">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-10 text-[15px] text-red-700">
          {orgError ?? "Workspace settings are not available right now."}
        </div>
      </div>
    );
  }

  const organizationId = orgContext.organization.id;

  async function handleCopyOrgId() {
    await navigator.clipboard.writeText(organizationId);
    setCopiedOrgId(true);
  }

  function handleDomainRestrictionToggle(nextValue: boolean) {
    if (!isOwner) {
      return;
    }

    if (!nextValue && hasDraftDomains) {
      return;
    }

    setPageError(null);
    setPageSuccess(null);
    setDomainRestrictionsEnabled(nextValue);
    setDomainEditModeEnabled(nextValue && !currentAllowedDomains?.length);
  }

  async function handleSaveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError(null);
    setPageSuccess(null);

    try {
      await updateOrganizationSettings({
        name: orgNameDraft,
        allowedEmailDomains: domainRestrictionsEnabled
          ? draftAllowedDomains
          : null,
        desktopAppRestrictions: {
          ...(!allowNonCloudModelsEnabled
            ? { disallowNonCloudModels: true }
            : {}),
          ...(!allowZenModelEnabled ? { blockZenModel: true } : {}),
          ...(!allowMultipleWorkspacesEnabled
            ? { blockMultipleWorkspaces: true }
            : {}),
        },
        ...(desktopVersionOptions.length > 0
          ? {
              allowedDesktopVersions: allDesktopVersionsAllowed
                ? null
                : desktopVersionOptions.filter((version) =>
                    selectedDesktopVersions.has(version),
                  ),
            }
          : {}),
      });
      setDomainEditModeEnabled(false);
      setPageSuccess("Workspace settings updated.");
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : "Could not update workspace settings.",
      );
    }
  }

  return (
    <DashboardPageTemplate
      icon={SlidersHorizontal}
      title="Org settings"
      description="Control your organization's settings."
      colors={["#D9F99D", "#0F172A", "#0F766E", "#FDE68A"]}
    >
      {pageError ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {pageError}
        </div>
      ) : null}
      {pageSuccess ? (
        <div className="mb-6 rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">
          {pageSuccess}
        </div>
      ) : null}

      <form className="grid gap-6" onSubmit={handleSaveSettings}>
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
                value={orgNameDraft}
                onChange={(event) => setOrgNameDraft(event.target.value)}
                minLength={2}
                maxLength={120}
                disabled={!isOwner}
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
                  icon={copiedOrgId ? Check : Copy}
                  onClick={() => void handleCopyOrgId()}
                >
                  {copiedOrgId ? "Copied" : "Copy"}
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
                  !isOwner || (domainRestrictionsEnabled && hasDraftDomains)
                }
                onChange={handleDomainRestrictionToggle}
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
                value={allowedDomainsDraft}
                onChange={(event) => setAllowedDomainsDraft(event.target.value)}
                rows={6}
                disabled={!isOwner}
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
                {isOwner ? (
                  <DenButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon={Pencil}
                    onClick={() => {
                      setPageError(null);
                      setPageSuccess(null);
                      setDomainEditModeEnabled(true);
                    }}
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
              Desktop app
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
              Desktop restrictions
            </h2>
            <p className="text-[14px] text-gray-500">
              Control which desktop-only options remain available after people
              sign in to this workspace.
            </p>
          </div>

          <div className="grid gap-4">
            <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4">
              <div className="grid gap-1 pr-4">
                <p className="text-[15px] font-medium text-gray-900">
                  Allow non-cloud deployed models
                </p>
                <p className="text-[13px] text-gray-500">
                  Let signed-in desktop users access models that are not
                  deployed through OpenWork Cloud.
                </p>
              </div>
              <SettingsToggle
                label="Allow non-cloud deployed models"
                checked={allowNonCloudModelsEnabled}
                disabled={!isOwner}
                onChange={setAllowNonCloudModelsEnabled}
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4">
              <div className="grid gap-1 pr-4">
                <p className="text-[15px] font-medium text-gray-900">
                  Allow usage of OpenCode Zen model
                </p>
                <p className="text-[13px] text-gray-500">
                  Let signed-in desktop users access the OpenCode Zen model in
                  the desktop app.
                </p>
              </div>
              <SettingsToggle
                label="Allow usage of OpenCode Zen model"
                checked={allowZenModelEnabled}
                disabled={!isOwner}
                onChange={setAllowZenModelEnabled}
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4">
              <div className="grid gap-1 pr-4">
                <p className="text-[15px] font-medium text-gray-900">
                  Allow users to configure multiple workspaces
                </p>
                <p className="text-[13px] text-gray-500">
                  Let signed-in desktop users create or manage more than one
                  workspace on their machine.
                </p>
              </div>
              <SettingsToggle
                label="Allow users to configure multiple workspaces"
                checked={allowMultipleWorkspacesEnabled}
                disabled={!isOwner}
                onChange={setAllowMultipleWorkspacesEnabled}
              />
            </div>
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
            {desktopVersionOptions.length > 0 ? (
              <p className="text-[10px] text-gray-400">
                This server currently supports desktop
                {` ${desktopVersionOptions[0]} `}
                to {desktopVersionOptions[desktopVersionOptions.length - 1]}.
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
              <div className="grid gap-3">
                {desktopVersionOptions.map((version) => {
                  const checked = selectedDesktopVersions.has(version);

                  return (
                    <label
                      key={version}
                      className="flex items-center justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4"
                    >
                      <div className="grid gap-1">
                        <p className="text-[15px] font-medium text-gray-900">
                          {version}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!isOwner}
                        aria-label={`Allow desktop version ${version}`}
                        onChange={(event) =>
                          setAllowedDesktopVersionsDraft((current) =>
                            toggleAllowedDesktopVersion(
                              current,
                              version,
                              event.target.checked,
                            ),
                          )
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </DenCard>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-gray-500">
            {!isOwner && "Only workspace owners can change these settings."}
          </p>
          {isOwner ? (
            <DenButton
              type="submit"
              loading={mutationBusy === "update-organization-settings"}
            >
              Save settings
            </DenButton>
          ) : null}
        </div>
      </form>
    </DashboardPageTemplate>
  );
}
