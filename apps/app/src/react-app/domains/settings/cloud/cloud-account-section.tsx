/** @jsxImportSource react */
import { LogOut } from "lucide-react";

import type { DenOrgSummary } from "../../../../app/lib/den";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshButton,
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
  const activeOrgOptions = orgs.map((org) => ({
    value: org.id,
    label: `${org.name} ${org.role === "owner" ? t("den.org_owner_suffix") : t("den.org_member_suffix")}`,
  }));
  const handleActiveOrgChange = (orgId: string | null) => {
    if (orgId === null) {
      return;
    }

    onActiveOrgChange(orgId);
  };

  return (
    <section className="flex flex-col gap-y-8">
      <div>
        <div className="text-sm font-medium text-dls-text">{t("den.cloud_account_title")}</div>
        <SettingsSectionHeaderDescription>{t("den.cloud_account_hint")}</SettingsSectionHeaderDescription>
      </div>

      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex flex-col gap-y-1">
            <div className="truncate text-sm font-medium text-dls-text">
              {user?.name ? user.name : user?.email}
            </div>
            <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void onSignOut()}
            disabled={[authBusy, sessionBusy].some(Boolean)}
          >
            <LogOut className="size-4" />
            {authBusy ? t("den.signing_out") : t("den.sign_out")}
          </Button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex flex-col gap-y-1">
            <div className="text-sm font-medium text-dls-text">{t("den.active_org_title")}</div>
            <div className="text-xs text-muted-foreground">
              {activeOrgId
                ? t("den.active_org_hint")
                : orgs.length > 1
                  ? "Select the organization to use. Sign out to switch later."
                  : t("den.active_org_hint")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="w-[260px] max-w-full">
              <Select
                value={activeOrgId}
                items={activeOrgOptions}
                onValueChange={handleActiveOrgChange}
                disabled={orgsBusy || orgs.length === 0}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("den.active_org_title")}
                >
                  <SelectValue placeholder={t("den.no_org_selected")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {activeOrgOptions.map((org) => (
                      <SelectItem key={org.value} value={org.value}>
                        {org.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <RefreshButton
              busy={orgsBusy}
              disabled={orgsBusy}
              onRefresh={onRefreshOrgs}
            >
              {t("den.refresh")}
            </RefreshButton>
          </div>
        </div>
      </div>

      {needsOrgSelection ? (
        <div className="rounded-xl border border-amber-6/40 bg-amber-2/50 px-4 py-3 text-sm text-amber-11">
          Select an organization to continue. Cloud providers and settings will be loaded for the selected org.
        </div>
      ) : null}

      {orgsError ? <SettingsNotice tone="error">{orgsError}</SettingsNotice> : null}
    </section>
  );
}
