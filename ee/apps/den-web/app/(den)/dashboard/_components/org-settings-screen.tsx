"use client";

import { Check, Copy, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getAllowedDesktopVersionsFromMetadata } from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { EgressDiagnosticsCard } from "./egress-diagnostics-card";
import { OrganizationAdmissionPolicyCard } from "./organization-admission-policy-card";
import {
  allPublishedDesktopVersionsAllowed,
  compareDesktopVersions,
  getDesktopVersionMetadata,
  initialAllowedDesktopVersions,
} from "./desktop-version-options";

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

export function OrgSettingsScreen() {
  const {
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    orgSettingsCompletion,
    clearOrgSettingsCompletion,
    updateOrganizationSettings,
  } = useOrgDashboard();
  const [orgNameDraft, setOrgNameDraft] = useState("");
  const [desktopVersionOptions, setDesktopVersionOptions] = useState<string[]>(
    [],
  );
  const [desktopVersionRange, setDesktopVersionRange] = useState<{
    minVersion: string;
    maxVersion: string;
  } | null>(null);
  const [allowedDesktopVersionsDraft, setAllowedDesktopVersionsDraft] =
    useState<string[]>([]);
  const [desktopVersionOptionsBusy, setDesktopVersionOptionsBusy] =
    useState(false);
  const [desktopVersionOptionsError, setDesktopVersionOptionsError] = useState<
    string | null
  >(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState(false);

  const isOwner = orgContext?.currentMember.isOwner ?? false;
  const canRunEgressDiagnostics = isOwner || (orgContext?.currentMember.role ?? "")
    .split(",")
    .map((role) => role.trim())
    .includes("admin");
  const supportedDesktopVersionOptions = useMemo(
    () =>
      desktopVersionRange
        ? desktopVersionOptions.filter(
            (version) =>
              compareDesktopVersions(version, desktopVersionRange.maxVersion) <= 0,
          )
        : [],
    [desktopVersionOptions, desktopVersionRange],
  );
  const selectedDesktopVersions = useMemo(
    () => new Set(allowedDesktopVersionsDraft),
    [allowedDesktopVersionsDraft],
  );
  const allDesktopVersionsAllowed = allPublishedDesktopVersionsAllowed({
    draftVersions: allowedDesktopVersionsDraft,
    publishedVersions: supportedDesktopVersionOptions,
  });
  const pageSuccess = orgSettingsCompletion?.message ?? null;

  useEffect(() => {
    if (!orgContext) {
      return;
    }

    setOrgNameDraft(orgContext.organization.name);
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

        setDesktopVersionOptions(metadata.publishedDesktopVersions);
        setDesktopVersionRange({
          minVersion: metadata.minAppVersion,
          maxVersion: metadata.latestAppVersion,
        });
      } catch (error) {
        if (!cancelled) {
          setDesktopVersionOptions([]);
          setDesktopVersionRange(null);
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
    if (!orgContext || supportedDesktopVersionOptions.length === 0) {
      return;
    }

    setAllowedDesktopVersionsDraft(initialAllowedDesktopVersions(
      getAllowedDesktopVersionsFromMetadata(orgContext.organization.metadata),
      supportedDesktopVersionOptions,
    ).filter((version) => supportedDesktopVersionOptions.includes(version)));
  }, [orgContext, supportedDesktopVersionOptions]);

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

  async function handleSaveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError(null);
    clearOrgSettingsCompletion();

    try {
      await updateOrganizationSettings({
        name: orgNameDraft,
        ...(supportedDesktopVersionOptions.length > 0
          ? {
              allowedDesktopVersions: allDesktopVersionsAllowed
                ? null
                : supportedDesktopVersionOptions.filter((version) =>
                    selectedDesktopVersions.has(version),
                  ),
            }
          : {}),
      });
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
        <DenNotice message={pageError} className="mb-6" />
      ) : null}
      {pageSuccess ? (
        <div className="mb-6 rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">
          {pageSuccess}
        </div>
      ) : null}

      <form className="grid min-w-0 grid-cols-1 gap-6" onSubmit={handleSaveSettings}>
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

        <OrganizationAdmissionPolicyCard
          organizationId={organizationId}
          isOwner={isOwner}
          hasOrgControls={orgContext.entitlements.orgControls}
          hasSso={orgContext.authMethods.ssoVerified}
          hasScim={orgContext.authMethods.scim}
        />

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
                        disabled={!isOwner || requiresServerUpgrade}
                        aria-label={`Allow desktop version v${version}`}
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

        <EgressDiagnosticsCard canRun={canRunEgressDiagnostics} />

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
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
