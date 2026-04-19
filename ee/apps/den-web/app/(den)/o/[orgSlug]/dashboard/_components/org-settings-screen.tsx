"use client";

import { Check, Copy, Pencil, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

function SettingsToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (nextValue: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Restrict allowed email domains"
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
  const [domainEditModeEnabled, setDomainEditModeEnabled] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState(false);

  const currentAllowedDomains =
    orgContext?.organization.allowedEmailDomains ?? null;
  const isOwner = orgContext?.currentMember.isOwner ?? false;
  const draftAllowedDomains = useMemo(
    () => normalizeAllowedEmailDomainsInput(allowedDomainsDraft),
    [allowedDomainsDraft],
  );
  const hasDraftDomains = (draftAllowedDomains?.length ?? 0) > 0;

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
    setDomainEditModeEnabled(false);
  }, [orgContext]);

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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-gray-500">
            {!isOwner && "Only workspace owners can change these settings."}
          </p>
          {isOwner ? (
            <DenButton
              type="submit"
              loading={mutationBusy === "update-organization-name"}
            >
              Save settings
            </DenButton>
          ) : null}
        </div>
      </form>
    </DashboardPageTemplate>
  );
}
