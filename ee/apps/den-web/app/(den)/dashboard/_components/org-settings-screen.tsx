"use client";

import { SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import {
  getAllowedDesktopVersionsFromMetadata,
  getOrgAccessFlags,
  getRequireSsoFromMetadata,
} from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { OrganizationSettingsSection } from "./organization-settings-section";
import {
  allPublishedDesktopVersionsAllowed,
  compareDesktopVersions,
  getDesktopVersionMetadata,
  initialAllowedDesktopVersions,
} from "./desktop-version-options";

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

function DeleteOrganizationDialog({
  open,
  organizationName,
  confirmationName,
  busy,
  error,
  onConfirmationNameChange,
  onClose,
  onConfirm,
}: {
  open: boolean;
  organizationName: string;
  confirmationName: string;
  busy: boolean;
  error: string | null;
  onConfirmationNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  const confirmed = confirmationName === organizationName;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || busy) {
      return;
    }

    onConfirm();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
      onClick={busy ? undefined : onClose}
    >
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-organization-title"
        aria-describedby="delete-organization-description"
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <Trash2 className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="delete-organization-title" className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
              Delete {organizationName}?
            </h2>
            <p id="delete-organization-description" className="mt-1 text-[13px] leading-6 text-gray-600">
              Type the organization name to permanently delete it.
            </p>
          </div>
        </div>

        <label className="mt-5 grid gap-2">
          <span className="text-[12px] font-medium text-gray-700">
            Organization name
          </span>
          <DenInput
            value={confirmationName}
            onChange={(event) => onConfirmationNameChange(event.target.value)}
            placeholder={organizationName}
            disabled={busy}
            autoFocus
          />
        </label>

        {error ? (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </DenButton>
          <DenButton
            type="submit"
            variant="destructive"
            icon={Trash2}
            loading={busy}
            disabled={!confirmed}
          >
            {busy ? "Deleting..." : "Delete organization"}
          </DenButton>
        </div>
      </form>
    </div>
  );
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
    deleteOrganization,
    refreshOrgData,
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
  const [denVersion, setDenVersion] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmationName, setDeleteConfirmationName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const currentAllowedDomains =
    orgContext?.organization.allowedEmailDomains ?? null;
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const canManageSettings = access.canManageSettings;
  const canManageDesktopVersions = access.canManageSettings;
  const canDeleteOrganization = access.canDeleteOrganization;
  const draftAllowedDomains = useMemo(
    () => normalizeAllowedEmailDomainsInput(allowedDomainsDraft),
    [allowedDomainsDraft],
  );
  const hasDraftDomains = (draftAllowedDomains?.length ?? 0) > 0;
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
    let cancelled = false;

    void requestJson("/health", { method: "GET" }, 5000)
      .then(({ response, payload }) => {
        const version = Object.getOwnPropertyDescriptor(payload ?? {}, "version")?.value;
        if (!cancelled && response.ok && typeof version === "string" && version.trim()) {
          setDenVersion(version.trim());
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

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
  const organizationName = orgContext.organization.name;

  async function handleCopyOrgId() {
    await navigator.clipboard.writeText(organizationId);
    setCopiedOrgId(true);
  }

  function handleDomainRestrictionToggle(nextValue: boolean) {
    if (!canManageSettings) {
      return;
    }

    if (!nextValue && hasDraftDomains) {
      return;
    }

    setPageError(null);
    clearOrgSettingsCompletion();
    setDomainRestrictionsEnabled(nextValue);
    setDomainEditModeEnabled(nextValue && !currentAllowedDomains?.length);
  }

  async function handleSaveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError(null);
    clearOrgSettingsCompletion();

    if (!canManageSettings) {
      setPageError("Only workspace owners and super-admins can change settings.");
      return;
    }

    try {
      await updateOrganizationSettings({
        name: orgNameDraft,
        allowedEmailDomains: domainRestrictionsEnabled
          ? draftAllowedDomains
          : null,
        requireSso: requireSsoEnabled,
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
      setDomainEditModeEnabled(false);
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : "Could not update workspace settings.",
      );
    }
  }

  function openDeleteDialog() {
    setPageError(null);
    clearOrgSettingsCompletion();
    setDeleteConfirmationName("");
    setDeleteError(null);
    setDeleteDialogOpen(true);
  }

  function closeDeleteDialog() {
    setDeleteDialogOpen(false);
    setDeleteConfirmationName("");
    setDeleteError(null);
  }

  async function handleDeleteOrganization() {
    if (deleteConfirmationName !== organizationName) {
      return;
    }

    setPageError(null);
    clearOrgSettingsCompletion();
    setDeleteError(null);

    try {
      await deleteOrganization();
      closeDeleteDialog();
      await refreshOrgData();
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Could not delete organization.",
      );
    }
  }

  return (
    <DashboardPageTemplate
      icon={SlidersHorizontal}
      title="Org settings"
      description={(
        <span className="flex w-full items-baseline justify-between gap-4">
          <span>Control your organization&apos;s settings.</span>
          {denVersion ? (
            <span
              className="font-normal tabular-nums text-gray-300"
              data-den-runtime-version={denVersion}
              title={`Den API version ${denVersion}`}
            >
              Den {denVersion}
            </span>
          ) : null}
        </span>
      )}
      colors={["#D9F99D", "#0F172A", "#0F766E", "#FDE68A"]}
    >
      {orgContext && !orgContext.entitlements.orgControls ? (
        <EnterprisePlanNotice feature="Enforced SSO and desktop version control" />
      ) : null}
      <OrganizationSettingsSection
        error={pageError}
        success={pageSuccess}
        canManageSettings={canManageSettings}
        canManageDesktopVersions={canManageDesktopVersions}
        saving={mutationBusy === "update-organization-settings"}
        organizationId={organizationId}
        organizationName={orgNameDraft}
        copiedOrganizationId={copiedOrgId}
        currentAllowedDomains={currentAllowedDomains}
        allowedDomains={allowedDomainsDraft}
        domainRestrictionsEnabled={domainRestrictionsEnabled}
        domainEditModeEnabled={domainEditModeEnabled}
        hasDraftDomains={hasDraftDomains}
        requireSsoEnabled={requireSsoEnabled}
        desktopVersionOptions={desktopVersionOptions}
        desktopVersionRange={desktopVersionRange}
        selectedDesktopVersions={selectedDesktopVersions}
        desktopVersionOptionsBusy={desktopVersionOptionsBusy}
        desktopVersionOptionsError={desktopVersionOptionsError}
        onOrganizationNameChange={setOrgNameDraft}
        onCopyOrganizationId={() => void handleCopyOrgId()}
        onDomainRestrictionToggle={handleDomainRestrictionToggle}
        onDomainEdit={() => {
          setPageError(null);
          clearOrgSettingsCompletion();
          setDomainEditModeEnabled(true);
        }}
        onAllowedDomainsChange={setAllowedDomainsDraft}
        onRequireSsoChange={setRequireSsoEnabled}
        onDesktopVersionChange={(version, checked) =>
          setAllowedDesktopVersionsDraft((current) =>
            toggleAllowedDesktopVersion(current, version, checked),
          )
        }
        onSubmit={handleSaveSettings}
      />

      {canDeleteOrganization ? (
        <DenCard size="spacious" className="mt-6 grid gap-5 !border-red-200 bg-red-50/30">
          <div className="grid gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-red-400">
              Owner controls
            </p>
            <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-red-950">
              Danger zone
            </h2>
            <p className="max-w-2xl text-[14px] leading-6 text-red-700">
              Permanently delete this organization, including members, teams, workers, plugins, and connections. This cannot be undone.
            </p>
          </div>
          <div>
            <DenButton
              type="button"
              variant="destructive"
              icon={Trash2}
              onClick={openDeleteDialog}
            >
              Delete organization
            </DenButton>
          </div>
        </DenCard>
      ) : null}

      <DeleteOrganizationDialog
        open={deleteDialogOpen}
        organizationName={organizationName}
        confirmationName={deleteConfirmationName}
        busy={mutationBusy === "delete-organization"}
        error={deleteError}
        onConfirmationNameChange={setDeleteConfirmationName}
        onClose={closeDeleteDialog}
        onConfirm={() => void handleDeleteOrganization()}
      />
    </DashboardPageTemplate>
  );
}
