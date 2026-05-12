/** @jsxImportSource react */
import { Building2, Check, LogOut, Loader2 } from "lucide-react";

import type { DenOrgSummary } from "../../../../app/lib/den";
import { Button } from "@/components/ui/button";
import {
  SettingsNotice,
  SettingsSectionHeaderDescription,
} from "../settings-section";
import { t } from "@/i18n";
import { useCloudSession } from "./cloud-session-provider";

export interface CloudAccountSectionProps {
  activeOrgId: string;
  authBusy: boolean;
  needsOrgSelection?: boolean;
  orgs: DenOrgSummary[];
  orgsBusy: boolean;
  orgsError: string | null;
  sessionBusy: boolean;
  onActiveOrgChange: (orgId: string) => void | Promise<void>;
  onRefreshOrgs: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}

export function CloudAccountSection({
  activeOrgId,
  authBusy,
  needsOrgSelection,
  orgs,
  orgsBusy,
  orgsError,
  sessionBusy,
  onActiveOrgChange,
  onRefreshOrgs,
  onSignOut,
}: CloudAccountSectionProps) {
  const { user } = useCloudSession();
  const activeOrg = orgs.find((org) => org.id === activeOrgId) ?? null;
  const controlsDisabled = authBusy || sessionBusy;

  return (
    <section className="flex flex-col gap-y-6">
      {/* User identity */}
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-dls-hover text-sm font-semibold text-dls-text">
            {(user?.name ?? user?.email ?? "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-dls-text">
              {user?.name || user?.email}
            </div>
            {user?.name && user.email ? (
              <div className="truncate text-xs text-dls-secondary">{user.email}</div>
            ) : null}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void onSignOut()}
          disabled={controlsDisabled}
        >
          <LogOut className="size-3.5" />
          {authBusy ? t("den.signing_out") : t("den.sign_out")}
        </Button>
      </div>

      {/* Org picker (stepper-style) or connected org display */}
      {needsOrgSelection ? (
        <OrgPicker
          orgs={orgs}
          orgsBusy={orgsBusy}
          disabled={controlsDisabled}
          onSelect={onActiveOrgChange}
          onRefresh={onRefreshOrgs}
        />
      ) : activeOrg ? (
        <ConnectedOrg org={activeOrg} />
      ) : orgsBusy ? (
        <div className="flex items-center gap-2 text-sm text-dls-secondary">
          <Loader2 size={14} className="animate-spin" />
          Loading organizations...
        </div>
      ) : null}

      {orgsError ? <SettingsNotice tone="error">{orgsError}</SettingsNotice> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Connected org: read-only display                                   */
/* ------------------------------------------------------------------ */

function ConnectedOrg({ org }: { org: DenOrgSummary }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-green-3 text-green-11">
        <Building2 size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-dls-text">{org.name}</div>
        <div className="text-xs text-dls-secondary">
          {org.role === "owner" ? "Owner" : "Member"} &middot; Connected
        </div>
      </div>
      <Check size={16} className="shrink-0 text-green-11" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Org picker: card-per-org selection                                 */
/* ------------------------------------------------------------------ */

function OrgPicker({
  orgs,
  orgsBusy,
  disabled,
  onSelect,
  onRefresh,
}: {
  orgs: DenOrgSummary[];
  orgsBusy: boolean;
  disabled: boolean;
  onSelect: (orgId: string) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  if (orgsBusy) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-sm text-dls-secondary">
        <Loader2 size={20} className="animate-spin" />
        Loading your organizations...
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="rounded-xl border border-dls-border bg-dls-surface px-4 py-6 text-center text-sm text-dls-secondary">
        No organizations found.{" "}
        <button
          type="button"
          className="font-medium text-dls-text underline underline-offset-2"
          onClick={() => void onRefresh()}
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium text-dls-text">
        Select an organization
      </div>
      <div className="text-xs text-dls-secondary">
        Choose the organization to use with this workspace. Sign out to switch later.
      </div>
      <div className="flex flex-col gap-2">
        {orgs.map((org) => (
          <button
            key={org.id}
            type="button"
            disabled={disabled}
            className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-left transition-colors hover:border-dls-text/20 hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void onSelect(org.id)}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-dls-hover text-dls-secondary">
              <Building2 size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-dls-text">{org.name}</div>
              <div className="text-xs text-dls-secondary">
                {org.role === "owner" ? "Owner" : "Member"}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
