"use client";

import {
  Bot,
  Box,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Monitor,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { DenInput } from "../../_components/ui/input";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import {
  OPENWORK_APP_CONNECT_BASE_URL,
  buildOpenworkAppConnectUrl,
  buildOpenworkDeepLink,
  getErrorMessage,
  getWorkerStatusMeta,
  getWorkerTokens,
  requestJson,
  type WorkerListItem,
} from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type ConnectionDetails = {
  openworkUrl: string | null;
  ownerToken: string | null;
  clientToken: string | null;
  openworkAppConnectUrl: string | null;
  openworkDeepLink: string | null;
};

function getStatusBadgeClass(bucket: ReturnType<typeof getWorkerStatusMeta>["bucket"]) {
  switch (bucket) {
    case "ready":
      return "border-emerald-100 bg-emerald-50 text-emerald-600";
    case "starting":
      return "border-amber-100 bg-amber-50 text-amber-600";
    case "attention":
      return "border-rose-100 bg-rose-50 text-rose-600";
    default:
      return "border-gray-100 bg-gray-50 text-gray-500";
  }
}

function SandboxCard({
  sandbox,
  expanded,
  details,
  renameBusy,
  onToggle,
  onRename,
}: {
  sandbox: WorkerListItem;
  expanded: boolean;
  details: ConnectionDetails | null;
  renameBusy: boolean;
  onToggle: () => void;
  onRename: () => void;
}) {
  const meta = getWorkerStatusMeta(sandbox.status);
  const canConnect = meta.bucket === "ready";
  const connectionUrl = details?.openworkUrl ?? sandbox.instanceUrl ?? null;
  const openWebUrl = details?.openworkAppConnectUrl ?? null;
  const openDesktopUrl = details?.openworkDeepLink ?? null;

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 transition-all hover:border-gray-200 hover:shadow-[0_2px_8px_-4px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
            <Box size={18} className="text-gray-400" />
          </div>
          <div>
            <h3 className="mb-0.5 flex items-center gap-2 text-[14px] font-medium text-gray-900">
              {sandbox.workerName}
              <span
                className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.5px] ${getStatusBadgeClass(meta.bucket)}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {meta.label}
              </span>
            </h3>
            <p className="text-[12px] text-gray-400">
              Source: {sandbox.provider ? `${sandbox.provider} sandbox` : "cloud sandbox"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            disabled={!canConnect}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              expanded
                ? "bg-gray-100 text-gray-900 hover:bg-gray-200"
                : "bg-gray-50 text-gray-700 hover:bg-gray-100 hover:text-gray-900"
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {expanded ? "Hide details" : "Connect"}
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            type="button"
            onClick={onRename}
            disabled={renameBusy}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`Rename ${sandbox.workerName}`}
          >
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-5 border-t border-gray-100 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                if (openDesktopUrl) {
                  window.location.href = openDesktopUrl;
                }
              }}
              disabled={!openDesktopUrl}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gray-900 py-2.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Monitor size={15} /> Open in desktop
            </button>

            {openWebUrl ? (
              <a
                href={openWebUrl}
                target="_blank"
                rel="noreferrer"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white py-2.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
              >
                <ExternalLink size={15} /> Open in web
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white py-2.5 text-[13px] font-medium text-gray-700 shadow-sm opacity-60"
              >
                <ExternalLink size={15} /> Open in web
              </button>
            )}
          </div>

          {canConnect ? (
            <p className="mt-4 text-[12px] text-gray-500">
              {connectionUrl ? "Connection is ready. Use the buttons above to open this worker." : "Connection details are still preparing."}
            </p>
          ) : (
            <p className="mt-4 text-[12px] text-gray-500">
              Connection details will appear once this workspace is ready.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function BackgroundAgentsScreen() {
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);
  const [connectBusyWorkerId, setConnectBusyWorkerId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectionDetailsByWorkerId, setConnectionDetailsByWorkerId] = useState<
    Record<string, ConnectionDetails>
  >({});
  const {
    filteredWorkers,
    workerQuery,
    setWorkerQuery,
    workersBusy,
    workersLoadedOnce,
    workersError,
    renameWorker,
    renameBusyWorkerId,
  } = useDenFlow();
  const { orgId } = useOrgDashboard();

  async function loadConnectionDetails(workerId: string, workerName: string) {
    setConnectBusyWorkerId(workerId);
    setConnectError(null);

    try {
      const { response, payload } = await requestJson(
        `/v1/workers/${encodeURIComponent(workerId)}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(
          getErrorMessage(payload, `Failed to load connection details (${response.status}).`),
        );
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        throw new Error("Connection details were missing from the worker response.");
      }

      const nextDetails: ConnectionDetails = {
        openworkUrl: tokens.openworkUrl,
        ownerToken: tokens.ownerToken,
        clientToken: tokens.clientToken,
        openworkAppConnectUrl: buildOpenworkAppConnectUrl(
          OPENWORK_APP_CONNECT_BASE_URL,
          tokens.openworkUrl,
          tokens.clientToken,
          workerId,
          workerName,
          {
            autoConnect: true,
            clientToken: tokens.clientToken,
            denBaseUrl: window.location.origin,
            denApiBaseUrl: `${window.location.origin}/api/den`,
            denOrgId: orgId,
          },
        ),
        openworkDeepLink: buildOpenworkDeepLink(
          tokens.openworkUrl,
          tokens.clientToken,
          workerId,
          workerName,
          {
            clientToken: tokens.clientToken,
            denBaseUrl: window.location.origin,
            denApiBaseUrl: `${window.location.origin}/api/den`,
            denOrgId: orgId,
          },
        ),
      };

      setConnectionDetailsByWorkerId((current) => ({
        ...current,
        [workerId]: nextDetails,
      }));
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : "Failed to load connection details.",
      );
    } finally {
      setConnectBusyWorkerId(null);
    }
  }

  async function toggleSandbox(worker: WorkerListItem) {
    const meta = getWorkerStatusMeta(worker.status);
    if (meta.bucket !== "ready") {
      return;
    }

    if (expandedWorkerId === worker.workerId) {
      setExpandedWorkerId(null);
      return;
    }

    setExpandedWorkerId(worker.workerId);
    if (!connectionDetailsByWorkerId[worker.workerId]) {
      await loadConnectionDetails(worker.workerId, worker.workerName);
    }
  }

  return (
    <DashboardPageTemplate
      icon={Bot}
      badgeLabel="Alpha"
      title="Background Tasks"
      description="Run selected workflows in the background without asking each teammate to run them locally. Coming soon."
      colors={["#E9FFE0", "#3E9A1D", "#B3F750", "#51F0A3"]}
    >
      <div className="mb-10 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-[13px] leading-6 text-amber-800">
        New cloud workspaces are no longer available from this page. Existing workspaces remain available below.
      </div>

      {workersError ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {workersError}
        </div>
      ) : null}
      {connectError ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {connectError}
        </div>
      ) : null}

      <div>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-[15px] font-medium tracking-[-0.2px] text-gray-900">
            Current workspaces
          </h2>
          <div className="w-full max-w-[240px]">
            <DenInput
              type="text"
              icon={Search}
              value={workerQuery}
              onChange={(event) => setWorkerQuery(event.target.value)}
              placeholder="Search workspaces..."
            />
          </div>
        </div>

        <div className="space-y-3">
          {!workersLoadedOnce ? (
            <div className="rounded-2xl border border-gray-100 bg-white p-5 text-[13px] text-gray-500">
              Loading workspaces...
            </div>
          ) : filteredWorkers.length === 0 ? (
            <div className="rounded-2xl border border-gray-100 bg-white p-5 text-[13px] text-gray-500">
              {workerQuery.trim()
                ? "No workspaces match that search yet."
                : "No workspaces launched yet."}
            </div>
          ) : (
            filteredWorkers.map((sandbox) => (
              <SandboxCard
                key={sandbox.workerId}
                sandbox={sandbox}
                expanded={expandedWorkerId === sandbox.workerId}
                details={connectionDetailsByWorkerId[sandbox.workerId] ?? null}
                renameBusy={renameBusyWorkerId === sandbox.workerId}
                onToggle={() => void toggleSandbox(sandbox)}
                onRename={() => {
                  const nextName = window.prompt("Rename workspace", sandbox.workerName)?.trim();
                  if (!nextName || nextName === sandbox.workerName) {
                    return;
                  }
                  void renameWorker(sandbox.workerId, nextName);
                }}
              />
            ))
          )}
        </div>
      </div>

      {workersLoadedOnce && workersBusy ? (
        <p className="mt-4 text-[12px] text-gray-400">Refreshing workspaces…</p>
      ) : null}
    </DashboardPageTemplate>
  );
}
import { useState } from "react";
