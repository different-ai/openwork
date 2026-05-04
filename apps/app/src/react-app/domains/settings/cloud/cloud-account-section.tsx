/** @jsxImportSource react */
import { LogOut } from "lucide-react";

import type { DenOrgSummary, DenUser } from "../../../../app/lib/den";
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
import { useTranslate } from "@/hooks/use-translate";

export interface CloudAccountSectionProps {
  activeOrgId: string;
  authBusy: boolean;
  orgs: DenOrgSummary[];
  orgsBusy: boolean;
  orgsError: string | null;
  sessionBusy: boolean;
  user: DenUser | null;
  onActiveOrgChange: (orgId: string) => void;
  onRefreshOrgs: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}

export function CloudAccountSection({
  activeOrgId,
  authBusy,
  orgs,
  orgsBusy,
  orgsError,
  sessionBusy,
  user,
  onActiveOrgChange,
  onRefreshOrgs,
  onSignOut,
}: CloudAccountSectionProps) {
  const { tr } = useTranslate();
  const activeOrgOptions = orgs.map((org) => ({
    value: org.id,
    label: `${org.name} ${org.role === "owner" ? tr("den.org_owner_suffix") : tr("den.org_member_suffix")}`,
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
        <div className="text-sm font-medium text-dls-text">{tr("den.cloud_account_title")}</div>
        <SettingsSectionHeaderDescription>{tr("den.cloud_account_hint")}</SettingsSectionHeaderDescription>
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
            {authBusy ? tr("den.signing_out") : tr("den.sign_out")}
          </Button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex flex-col gap-y-1">
            <div className="text-sm font-medium text-dls-text">{tr("den.active_org_title")}</div>
            <div className=" text-xs text-muted-foreground">{tr("den.active_org_hint")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="w-[260px] max-w-full">
              <Select
                value={activeOrgId}
                items={activeOrgOptions}
                onValueChange={handleActiveOrgChange}
                disabled={[orgsBusy, orgs.length === 0].some(Boolean)}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={tr("den.active_org_title")}
                >
                  <SelectValue placeholder={tr("den.no_org_selected")} />
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
              {tr("den.refresh")}
            </RefreshButton>
          </div>
        </div>
      </div>

      {orgsError ? <SettingsNotice tone="error">{orgsError}</SettingsNotice> : null}
    </section>
  );
}
