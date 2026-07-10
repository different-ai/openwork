"use client";

import { Check, Copy, Pencil, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getAllowedDesktopVersionsFromMetadata, getRequireSsoFromMetadata, parseOrganizationMetadata } from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

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
  const [requireSsoEnabled, setRequireSsoEnabled] = useState(false);
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
  const [brandAppNameDraft, setBrandAppNameDraft] = useState("");
  const [brandLogoUrlDraft, setBrandLogoUrlDraft] = useState("");
  const [brandIconUrlDraft, setBrandIconUrlDraft] = useState("");
  const [brandAccentColorDraft, setBrandAccentColorDraft] = useState("");
  const [copiedOrgId, setCopiedOrgId] = useState(false);

  const currentAllowedDomains =
    orgContext?.organization.allowedEmailDomains ?? null;
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
    setRequireSsoEnabled(getRequireSsoFromMetadata(orgContext.organization.metadata));
    const meta = parseOrganizationMetadata(orgContext.organization.metadata);
    setBrandAppNameDraft(typeof meta?.brandAppName === "string" ? meta.brandAppName : "");
    setBrandLogoUrlDraft(typeof meta?.brandLogoUrl === "string" ? meta.brandLogoUrl : "");
    setBrandIconUrlDraft(typeof meta?.brandIconUrl === "string" ? meta.brandIconUrl : "");
    setBrandAccentColorDraft(typeof meta?.brandAccentColor === "string" ? meta.brandAccentColor : "");
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
        ...(desktopVersionOptions.length > 0
          ? {
              allowedDesktopVersions: allDesktopVersionsAllowed
                ? null
                : desktopVersionOptions.filter((version) =>
                    selectedDesktopVersions.has(version),
                  ),
            }
          : {}),
        requireSso: requireSsoEnabled,
        brandAppName: brandAppNameDraft.trim() || null,
        brandLogoUrl: brandLogoUrlDraft.trim() || null,
        brandIconUrl: brandIconUrlDraft.trim() || null,
        brandAccentColor: brandAccentColorDraft.trim() || null,
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
      {orgContext && !orgContext.entitlements.orgControls ? (
        <EnterprisePlanNotice feature="Enforced SSO and desktop version control" />
      ) : null}
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
              disabled={!isOwner}
              onChange={setRequireSsoEnabled}
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

        <DenCard size="spacious" className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              White-label
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">
              Brand Appearance
            </h2>
            <p className="text-[14px] text-gray-500">
              Customize the desktop app with your organization's branding. Changes apply to all members in real-time.
            </p>
          </div>

          {orgContext && !orgContext.entitlements.desktopPolicies ? (
            <EnterprisePlanNotice feature="White-label brand appearance" />
          ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-5">
              <label className="grid gap-3">
                <span className="text-[14px] font-medium text-gray-700">
                  Application name
                </span>
                <DenInput
                  type="text"
                  value={brandAppNameDraft}
                  onChange={(event) => setBrandAppNameDraft(event.target.value)}
                  placeholder="OpenWork"
                  maxLength={64}
                  disabled={!isOwner}
                />
                <span className="text-[11px] text-gray-400">
                  Displayed on download, setup, and desktop screens. The signed application identity stays OpenWork.
                </span>
              </label>

              <label className="grid gap-3">
                <span className="text-[14px] font-medium text-gray-700">
                  Logo URL
                </span>
                <DenInput
                  type="url"
                  value={brandLogoUrlDraft}
                  onChange={(event) => setBrandLogoUrlDraft(event.target.value)}
                  placeholder="https://example.com/logo.svg"
                  maxLength={2048}
                  disabled={!isOwner}
                />
                <span className="text-[11px] text-gray-400">
                  Displayed in the sidebar top-left. Use an SVG or PNG with a transparent background.
                </span>
              </label>

              <label className="grid gap-3">
                <span className="text-[14px] font-medium text-gray-700">
                  Icon URL
                </span>
                <DenInput
                  type="url"
                  value={brandIconUrlDraft}
                  onChange={(event) => setBrandIconUrlDraft(event.target.value)}
                  placeholder="https://example.com/icon.png"
                  maxLength={2048}
                  disabled={!isOwner}
                />
                <span className="text-[11px] text-gray-400">
                  Square PNG, 256×256 or larger. Changes the app icon in the taskbar and dock for all members.
                </span>
              </label>
            </div>

            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">
                Accent color
              </span>
              <select
                value={brandAccentColorDraft}
                onChange={(event) => setBrandAccentColorDraft(event.target.value)}
                disabled={!isOwner}
                className="h-11 rounded-2xl border border-gray-200 bg-white px-4 text-[14px] text-gray-900 outline-none"
              >
                <option value="">Default (OpenWork)</option>
                <option value="blue">Blue</option>
                <option value="violet">Violet</option>
                <option value="purple">Purple</option>
                <option value="indigo">Indigo</option>
                <option value="iris">Iris</option>
                <option value="crimson">Crimson</option>
                <option value="red">Red</option>
                <option value="ruby">Ruby</option>
                <option value="pink">Pink</option>
                <option value="plum">Plum</option>
                <option value="orange">Orange</option>
                <option value="tomato">Tomato</option>
                <option value="gold">Gold</option>
                <option value="green">Green</option>
                <option value="grass">Grass</option>
                <option value="jade">Jade</option>
                <option value="teal">Teal</option>
                <option value="cyan">Cyan</option>
                <option value="sky">Sky</option>
              </select>
              <span className="text-[11px] text-gray-400">
                Overrides buttons and accent highlights across the desktop app.
              </span>
            </label>
          </div>
          )}
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
