/** @jsxImportSource react */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { useStatusToasts } from "../../shell-feedback/status-toasts";
import { useCloudSession } from "../cloud/cloud-session-provider";
import { CloudWorkersSection, type CloudWorker } from "../cloud/sections";
import { SettingsNotice, SettingsStack } from "../settings-section";

export type CloudWorkersViewProps = {
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  onOpenAccount: () => void;
};

export function CloudWorkersView({
  connectRemoteWorkspace,
  onOpenAccount,
}: CloudWorkersViewProps) {
  const { activeOrganization: activeOrg, authToken, client, isSignedIn, user } = useCloudSession();
  const { showToast } = useStatusToasts();
  const [workersBusy, setWorkersBusy] = React.useState(false);
  const [openingWorkerId, setOpeningWorkerId] = React.useState<string | null>(null);
  const [workers, setWorkers] = React.useState<CloudWorker[]>([]);
  const [workersError, setWorkersError] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";

  const refreshWorkers = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim() || !activeOrgId) {
        setWorkers([]);
        return;
      }

      setWorkersBusy(true);
      if (!quiet) setWorkersError(null);

      try {
        const nextWorkers = await client.listWorkers(activeOrgId, 20);
        setWorkers(nextWorkers);
        if (!quiet) {
          showToast({
            title: nextWorkers.length > 0
              ? t("den.status_loaded_workers", {
                  count: nextWorkers.length,
                  name: activeOrg?.name ?? t("den.active_org_title"),
                })
              : t("den.status_no_workers", {
                  name: activeOrg?.name ?? t("den.active_org_title"),
                }),
            tone: "info",
          });
        }
      } catch (error) {
        setWorkersError(error instanceof Error ? error.message : t("den.error_load_workers"));
      } finally {
        setWorkersBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, client, showToast],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refreshWorkers(true);
  }, [activeOrgId, refreshWorkers, user]);

  const openWorker = React.useCallback(
    async (workerId: string, workerName: string) => {
      if (!activeOrgId) {
        setWorkersError(t("den.error_choose_org"));
        return;
      }

      setOpeningWorkerId(workerId);
      setWorkersError(null);

      try {
        const tokens = await client.getWorkerTokens(workerId, activeOrgId);
        const openworkUrl = tokens.openworkUrl?.trim() ?? "";
        const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
        if (!openworkUrl || !accessToken) {
          throw new Error(t("den.error_worker_not_ready"));
        }

        const ok = await connectRemoteWorkspace({
          openworkHostUrl: openworkUrl,
          openworkToken: accessToken,
          directory: null,
          displayName: workerName,
        });
        if (!ok) {
          throw new Error(t("den.error_open_worker", { name: workerName }));
        }

        showToast({
          title: t("den.status_opened_worker", { name: workerName }),
          tone: "success",
        });
      } catch (error) {
        setWorkersError(
          error instanceof Error
            ? error.message
            : t("den.error_open_worker_fallback", { name: workerName }),
        );
      } finally {
        setOpeningWorkerId(null);
      }
    },
    [activeOrgId, client, connectRemoteWorkspace, showToast],
  );

  if (!isSignedIn) {
    return (
      <SettingsStack>
        <Separator />
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("skills.share_team_sign_in_hint")}</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("skills.share_team_sign_in")}
            </Button>
          </div>
        </SettingsNotice>
      </SettingsStack>
    );
  }

  return (
    <SettingsStack>
      <Separator />
      <CloudWorkersSection
        openingWorkerId={openingWorkerId}
        workers={workers}
        workersBusy={workersBusy}
        workersError={workersError}
        onOpenWorker={openWorker}
        onRefreshWorkers={refreshWorkers}
      />
    </SettingsStack>
  );
}
