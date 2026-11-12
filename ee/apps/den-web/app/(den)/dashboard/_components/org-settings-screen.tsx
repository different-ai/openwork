"use client";

import { Check, ChevronRight, Copy, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { markFeatureUsed } from "../../_lib/feature-usage";
import { normalizeAllowedEmailDomainsInput, refreshedDraft, sameStringSet, settingsDraftChanged } from "./page-consistency-state";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import {
  getAllowedDesktopVersionsFromMetadata,
  getOrgAccessFlags,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { OrgWebOriginsSection } from "./org-web-origins-section";
import { OrgDefaultModelSection } from "./default-model-section";
import { OrgAutomationSettingsSection } from "./org-automation-settings-section";
import { DenSwitch } from "../../_components/ui/switch";
import { ItemSection } from "./item-list";
import { COMPACT_INPUT_CLASS, DASHBOARD_PAGE_CLASS, SETTINGS_MEASURE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenCheckbox } from "../../_components/ui/checkbox";
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

  const pageConsistency = orgFeatureEnabled(orgContext, "denPageConsistency");
  const currentAllowedDomains =
    orgContext?.organization.allowedEmailDomains ?? null;
  const previousSettings = useRef<{ orgId: string; name: string; domains: string; restricted: boolean } | null>(null);
  const previousVersions = useRef<{ orgId: string; versions: string[] } | null>(null);
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const canManageSettings = access.canManageSettings;
  // admins choose the model new desktop chats start with.

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
  const savedDomains = orgContext?.organization.allowedEmailDomains ?? [];
  const savedDesktopVersions = useMemo(() => orgContext && supportedDesktopVersionOptions.length > 0
    ? initialAllowedDesktopVersions(getAllowedDesktopVersionsFromMetadata(orgContext.organization.metadata), supportedDesktopVersionOptions).filter((version) => supportedDesktopVersionOptions.includes(version))
    : [], [orgContext, supportedDesktopVersionOptions]);
  // Compare effective values, not formatting or set order. Unavailable/hidden fields are not submitted.
  const dirty = Boolean(orgContext) && settingsDraftChanged({
    name: orgContext?.organization.name ?? "", domains: savedDomains, domainRestrictionsEnabled: savedDomains.length > 0,
    desktopVersions: savedDesktopVersions,
  }, {
    name: orgNameDraft, domains: draftAllowedDomains ?? [], domainRestrictionsEnabled,
    desktopVersions: allowedDesktopVersionsDraft,
  }, {
    compareVersions: supportedDesktopVersionOptions.length > 0,
  });
  function discardChanges() {
    if (!orgContext || !canManageSettings || !dirty || mutationBusy === "update-organization-settings") return;
    if (pageConsistency) markFeatureUsed("denPageConsistency");
    clearOrgSettingsCompletion();
    setOrgNameDraft(orgContext.organization.name);
    setAllowedDomainsDraft(savedDomains.join("\n"));
    setDomainRestrictionsEnabled(savedDomains.length > 0);
    setAllowedDesktopVersionsDraft(savedDesktopVersions);
    setDomainEditModeEnabled(false);
    setPageError(null);
  }

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

    const next = {
      orgId: orgContext.organization.id,
      name: orgContext.organization.name,
      domains: (orgContext.organization.allowedEmailDomains ?? []).join("\n"),
      restricted: (orgContext.organization.allowedEmailDomains?.length ?? 0) > 0,
    };
    const previous = previousSettings.current;
    // A rollout change is not an organization switch: never erase an unsaved draft when the flag is killed.
    const sameOrganization = previous?.orgId === next.orgId;
    setOrgNameDraft((current) => refreshedDraft(current, previous?.name, next.name, sameOrganization));
    setAllowedDomainsDraft((current) => refreshedDraft(current, previous?.domains, next.domains, sameOrganization,
      (left, right) => sameStringSet(normalizeAllowedEmailDomainsInput(left) ?? [], normalizeAllowedEmailDomainsInput(right) ?? [])));
    setDomainRestrictionsEnabled((current) => refreshedDraft(current, previous?.restricted, next.restricted, sameOrganization));
    if (!sameOrganization) {
      setDomainEditModeEnabled(false);
      setPageError(null);
    }
    previousSettings.current = next;
  }, [orgContext, pageConsistency]);

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

    const orgId = orgContext.organization.id;
    const previous = previousVersions.current;
    setAllowedDesktopVersionsDraft((current) => refreshedDraft(current, previous?.versions, savedDesktopVersions,
      previous?.orgId === orgId, sameStringSet));
    previousVersions.current = { orgId, versions: savedDesktopVersions };
  }, [orgContext, supportedDesktopVersionOptions, savedDesktopVersions, pageConsistency]);

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
      <div className={DASHBOARD_PAGE_CLASS}>
        <DenSkeleton className="mb-6 h-6 w-32" />
        <div className="grid gap-4"><DenSkeleton className="h-10 w-full" /><DenSkeleton className="h-10 w-full" /><DenSkeleton className="h-10 w-full" /></div>
      </div>
    );
  }

  if (!activeOrg || !orgContext) {
    return (
      <div className={DASHBOARD_PAGE_CLASS}>
        <div role="alert" className="text-[13px] text-[var(--ow-danger)]">
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
      setPageError("You don't have permission to change settings.");
      return;
    }

    if (mutationBusy === "update-organization-settings" || (pageConsistency && !dirty)) return;
    if (pageConsistency && domainRestrictionsEnabled && !hasDraftDomains) {
      setPageError("Enter at least one email domain, or turn off domain restrictions.");
      return;
    }
    if (pageConsistency) markFeatureUsed("denPageConsistency");
    try {
      await updateOrganizationSettings({
        name: orgNameDraft,
        allowedEmailDomains: domainRestrictionsEnabled
          ? draftAllowedDomains
          : null,
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
      description={null}
      measure
    >
      {/* Settings read as label and control side by side, so they keep a narrower measure than the lists. */}
      <div className={SETTINGS_MEASURE_CLASS}>
      {orgContext && !orgContext.entitlements.orgControls ? (
        <EnterprisePlanNotice feature="Desktop version control" />
      ) : null}
      {pageError ? (
        <DenNotice
          message={pageError}
          className="mb-6"
          tone="error"
        />
      ) : null}
      {pageSuccess ? (
        <div role="status" className="mb-6 text-[13px] text-[var(--dls-text-secondary)]">
          {pageSuccess}
        </div>
      ) : null}

      <form className="grid min-w-0 grid-cols-1 gap-6 text-[13px]" onSubmit={handleSaveSettings}>
        <ItemSection variant="rule" title="Organization identity">
          <label className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--den-list-line)] py-2">
            <span className="font-medium text-[var(--dls-text-primary)]">Name</span>
            <DenInput
              type="text"
              value={orgNameDraft}
              onChange={(event) => setOrgNameDraft(event.target.value)}
              minLength={2}
              maxLength={120}
              disabled={!canManageSettings}
              required
              className={`${COMPACT_INPUT_CLASS} w-full sm:w-80`}
            />
          </label>
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--den-list-line)] py-2">
            <span className="font-medium text-[var(--dls-text-primary)]">ID</span>
            <div className="flex w-full items-center gap-2 sm:w-80">
              <DenInput value={organizationId} readOnly aria-label="Organization ID" className={`${COMPACT_INPUT_CLASS} font-mono text-[12px]!`} />
              <DenButton variant="secondary" size="sm" type="button" icon={copiedOrgId ? Check : Copy} onClick={() => void handleCopyOrgId()}>
                {copiedOrgId ? "Copied" : "Copy"}
              </DenButton>
            </div>
          </div>
        </ItemSection>

        <section id="allowed-email-domains" aria-label="Allowed email domains" className="scroll-mt-6">
          <ItemSection variant="rule" title="Allowed email domains">
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--den-list-line)] py-2">
            <span className="font-medium text-[var(--dls-text-primary)]">Only people with these email domains can join</span>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-[var(--dls-text-secondary)]">
                {domainRestrictionsEnabled ? "On" : "Off"}
              </span>
              <DenSwitch
                aria-label="Restrict allowed email domains"
                checked={domainRestrictionsEnabled}
                disabled={
                  !canManageSettings || (domainRestrictionsEnabled && hasDraftDomains)
                }
                onChange={handleDomainRestrictionToggle}
              />
            </div>
          </div>

          {domainRestrictionsEnabled && domainEditModeEnabled ? (
            <label className="grid gap-2 border-b border-[var(--den-list-line)] py-3 sm:pl-0">
              <span className="text-[13px] font-medium text-[var(--dls-text-primary)]">Domain allowlist</span>
              <span className="text-[12px] text-[var(--dls-text-secondary)]">One domain per line, or separated by commas.</span>
              <DenTextarea
                value={allowedDomainsDraft}
                onChange={(event) => setAllowedDomainsDraft(event.target.value)}
                rows={6}
                disabled={!canManageSettings}
                placeholder={"company.com\npartner.org"}
              />
            </label>
          ) : null}

          {domainRestrictionsEnabled && !domainEditModeEnabled ? (
            <div className="border-b border-[var(--den-list-line)] py-2">
              <div className="flex min-h-8 items-center justify-between gap-3">
                {currentAllowedDomains && currentAllowedDomains.length > 0 ? (
                  <div className="flex flex-wrap w-full gap-2">
                    {currentAllowedDomains.map((domain) => (
                      <span
                        key={domain}
                        className="text-[13px] text-[var(--dls-text-secondary)]"
                      >
                        {domain}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-[var(--dls-text-secondary)]">
                    No email domains are configured yet.
                  </p>
                )}
                {canManageSettings ? (
                  <DenButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon={Pencil}
                    onClick={() => {
                      setPageError(null);
                      clearOrgSettingsCompletion();
                      setDomainEditModeEnabled(true);
                    }}
                  >
                    Edit
                  </DenButton>
                ) : null}
              </div>
            </div>
          ) : null}
          </ItemSection>
        </section>

                  <OrgAutomationSettingsSection canManage={canManageSettings} />

        <section aria-label="Allowed desktop versions">
          <ItemSection variant="rule" title="Desktop app">
          {desktopVersionOptionsError ? <p role="alert" className="border-b border-[var(--den-list-line)] py-3 text-[13px] text-[var(--ow-danger)]">{desktopVersionOptionsError}</p> : null}
          {/* The list is long and rarely changed: the row says what is allowed, and opens to change it (DESIGN.md P3, S3). */}
          <details className="group border-b border-[var(--den-list-line)]" data-testid="desktop-version-disclosure">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-secondary)] [&::-webkit-details-marker]:hidden">
              <span className="font-medium text-[var(--dls-text-primary)]">Allowed versions</span>
              <span className="flex items-center gap-2 text-[13px] text-[var(--dls-text-secondary)]">
                {desktopVersionOptionsBusy ? <DenSkeleton className="h-3 w-24" />
                  : supportedDesktopVersionOptions.length === 0 ? "Not available"
                  : allDesktopVersionsAllowed ? `All ${supportedDesktopVersionOptions.length} versions`
                  : `${allowedDesktopVersionsDraft.length} of ${supportedDesktopVersionOptions.length} versions`}
                <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
              </span>
            </summary>
            {!desktopVersionOptionsBusy && !desktopVersionOptionsError && desktopVersionOptions.length > 0 ? (
              <div data-testid="desktop-version-list" className="grid max-h-[320px] overflow-y-auto border-t border-[var(--den-list-line)] pb-1">
                {desktopVersionRange ? <p className="py-2 text-[12px] text-[var(--dls-text-secondary)]">This server supports v{desktopVersionRange.minVersion} to v{desktopVersionRange.maxVersion}.</p> : null}
                {desktopVersionOptions.map((version) => {
                  const checked = selectedDesktopVersions.has(version);
                  const requiresServerUpgrade = desktopVersionRange !== null && compareDesktopVersions(version, desktopVersionRange.maxVersion) > 0;
                  return (
                    <label key={version} data-desktop-version={version} data-supported={!requiresServerUpgrade}
                      className={`flex min-h-9 items-center gap-3 py-1 text-[13px] ${requiresServerUpgrade ? "cursor-not-allowed text-[var(--dls-text-secondary)]" : "text-[var(--dls-text-primary)]"}`}>
                      <DenCheckbox
                        checked={checked}
                        disabled={!canManageDesktopVersions || requiresServerUpgrade}
                        aria-label={`Allow desktop version v${version}`}
                        onCheckedChange={(next) => setAllowedDesktopVersionsDraft((current) => toggleAllowedDesktopVersion(current, version, next))}
                      />
                      <span className="tabular-nums">v{version}</span>
                      {requiresServerUpgrade ? <span className="text-[12px] text-[var(--dls-text-secondary)]">Upgrade the server to allow this version</span> : null}
                    </label>
                  );
                })}
              </div>
            ) : null}
          </details>
          </ItemSection>
        </section>

        {!canManageSettings ? <p className="text-[12px] text-[var(--dls-text-secondary)]">{`Read only. ${permissionLockReason("organization.update")}`}</p> : null}
        {pageConsistency ? dirty && canManageSettings ? (
          <DenStickyActionBar summary="Unsaved changes" testId="org-settings-save-bar">
            <DenButton type="button" size="sm" variant="ghost" disabled={mutationBusy === "update-organization-settings"} onClick={discardChanges}>Discard</DenButton>
            <DenButton type="submit" size="sm" loading={mutationBusy === "update-organization-settings"}>Save changes</DenButton>
          </DenStickyActionBar>
        ) : null : <div className="flex justify-end"><DenButton type="submit" loading={mutationBusy === "update-organization-settings"} disabled={!canManageSettings}>Save settings</DenButton></div>}
      </form>

      {access.canViewModelsSettings ? (
        <div className="mt-6">
          <ItemSection variant="rule" title="Models">
            <OrgDefaultModelSection embedded canManage={access.canManageModelsSettings} />
          </ItemSection>
        </div>
      ) : null}

      {access.canViewWebOrigins ? (
        <div className="mt-6">
          <OrgWebOriginsSection orgId={organizationId} canManage={access.canManageWebOrigins} />
        </div>
      ) : null}

      {canDeleteOrganization ? (
        <section aria-label="Owner controls" className="mt-6">
          <ItemSection variant="rule" title="Owner controls">
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--den-list-line)] py-2">
              <span className="text-[13px] font-medium text-[var(--dls-text-primary)]" title="Permanently delete this organization, including members, teams, workers, plugins, and connections. This cannot be undone.">Delete organization</span>
              <DenButton type="button" size="sm" variant="destructive" icon={Trash2} onClick={openDeleteDialog}>Delete organization</DenButton>
            </div>
          </ItemSection>
        </section>
      ) : null}

      {denVersion ? <p className="mt-8 text-[12px] tabular-nums text-[var(--dls-text-secondary)]" data-den-runtime-version={denVersion} title={`Den API version ${denVersion}`}>Den {denVersion}</p> : null}
      </div>

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
