/** @jsxImportSource react */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    openworkClientToken?: string | null;
    openworkHostToken?: string | null;
    openworkDenBaseUrl?: string | null;
    openworkDenOrgId?: string | null;
    openworkDenWorkerId?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  onOpenAccount: () => void;
};

export function CloudWorkersView({
  connectRemoteWorkspace,
  onOpenAccount,
}: CloudWorkersViewProps) {
  const { activeOrganization: activeOrg, authToken, baseUrl, client, isSignedIn, user } = useCloudSession();
  const { showToast } = useStatusToasts();
  const [workersBusy, setWorkersBusy] = React.useState(false);
  const [openingWorkerId, setOpeningWorkerId] = React.useState<string | null>(null);
  const [attachBusy, setAttachBusy] = React.useState(false);
  const [workers, setWorkers] = React.useState<CloudWorker[]>([]);
  const [workersError, setWorkersError] = React.useState<string | null>(null);
  const [staticWorkerForm, setStaticWorkerForm] = React.useState({
    name: "LAN static worker",
    url: "",
    clientToken: "",
    hostToken: "",
  });
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
        const accessToken = tokens.clientToken?.trim() || tokens.ownerToken?.trim() || "";
        if (!openworkUrl || !accessToken) {
          throw new Error(t("den.error_worker_not_ready"));
        }

        const ok = await connectRemoteWorkspace({
          openworkHostUrl: openworkUrl,
          openworkToken: accessToken,
          openworkClientToken: tokens.clientToken?.trim() || null,
          openworkHostToken: tokens.hostToken?.trim() || null,
          openworkDenBaseUrl: baseUrl,
          openworkDenOrgId: activeOrgId,
          openworkDenWorkerId: workerId,
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
    [activeOrgId, baseUrl, client, connectRemoteWorkspace, showToast],
  );

  const attachStaticWorker = React.useCallback(async () => {
    if (!activeOrgId) {
      setWorkersError(t("den.error_choose_org"));
      return;
    }

    const name = staticWorkerForm.name.trim();
    const url = staticWorkerForm.url.trim();
    const clientToken = staticWorkerForm.clientToken.trim();
    const hostToken = staticWorkerForm.hostToken.trim();
    if (!name || !url || !clientToken || !hostToken) {
      setWorkersError("Name, URL, client token, and host token are required to attach a static worker.");
      return;
    }

    setAttachBusy(true);
    setWorkersError(null);
    try {
      const worker = await client.attachStaticWorker(activeOrgId, {
        name,
        url,
        clientToken,
        hostToken,
      });
      setWorkers((current) => [worker, ...current.filter((entry) => entry.workerId !== worker.workerId)]);
      setStaticWorkerForm((current) => ({ ...current, url: "", clientToken: "", hostToken: "" }));
      showToast({
        title: `Attached ${worker.workerName}`,
        tone: "success",
      });
      void refreshWorkers(true);
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: unknown }).status) : null;
      setWorkersError(status === 403
        ? "Only organization owners and admins can attach static workers. Ask an operator to register this worker."
        : error instanceof Error ? error.message : "Static worker attach failed.");
    } finally {
      setAttachBusy(false);
    }
  }, [activeOrgId, client, refreshWorkers, showToast, staticWorkerForm]);

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
      <SettingsNotice>
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-medium">Admin/operator: attach LAN static worker</div>
            <div className="text-xs text-muted-foreground">
              Organization owners and admins can register a pre-running OpenWork worker without manual database changes. The URL and tokens must match the worker container environment.
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              value={staticWorkerForm.name}
              onChange={(event) => setStaticWorkerForm((current) => ({ ...current, name: event.currentTarget.value }))}
              placeholder="Worker name"
            />
            <Input
              value={staticWorkerForm.url}
              onChange={(event) => setStaticWorkerForm((current) => ({ ...current, url: event.currentTarget.value }))}
              placeholder="http://192.168.1.50:8787"
            />
            <Input
              value={staticWorkerForm.clientToken}
              onChange={(event) => setStaticWorkerForm((current) => ({ ...current, clientToken: event.currentTarget.value }))}
              placeholder="OPENWORK_TOKEN"
              type="password"
            />
            <Input
              value={staticWorkerForm.hostToken}
              onChange={(event) => setStaticWorkerForm((current) => ({ ...current, hostToken: event.currentTarget.value }))}
              placeholder="OPENWORK_HOST_TOKEN"
              type="password"
            />
          </div>
          <div>
            <Button size="sm" onClick={() => void attachStaticWorker()} disabled={attachBusy || workersBusy || !activeOrgId}>
              {attachBusy ? "Attaching..." : "Attach static worker"}
            </Button>
          </div>
        </div>
      </SettingsNotice>
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
