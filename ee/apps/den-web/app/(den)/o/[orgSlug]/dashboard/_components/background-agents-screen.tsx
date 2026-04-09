"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { DenInput } from "../../../../_components/ui/input";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import { OrgLimitDialog } from "../../../../_components/org-limit-dialog";
import {
  OPENWORK_APP_CONNECT_BASE_URL,
  buildOpenworkAppConnectUrl,
  buildOpenworkDeepLink,
  getErrorMessage,
  getWorkerStatusMeta,
  getWorkerTokens,
  requestJson,
  type WorkerListItem,
} from "../../../../_lib/den-flow";
import { buildDenFeedbackUrl } from "../../../../_lib/feedback";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { getSharedSetupsRoute } from "../../../../_lib/den-org";
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

function CredentialField({
  id,
  label,
  value,
  onCopy,
  copied,
}: {
  id: string;
  label: string;
  value: string;
  onCopy: (field: string, text: string) => void;
  copied: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] text-gray-500">{label}</label>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] font-mono text-gray-600 outline-none shadow-sm transition-colors focus:border-gray-300"
          onClick={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          onClick={() => onCopy(id, value)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 shadow-sm transition-colors hover:border-gray-300 hover:text-gray-700"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

function SandboxCard({
  sandbox,
  expanded,
  details,
  connectBusy,
  renameBusy,
  onToggle,
  onRefresh,
  onRename,
}: {
  sandbox: WorkerListItem;
  expanded: boolean;
  details: ConnectionDetails | null;
  connectBusy: boolean;
  renameBusy: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onRename: () => void;
}) {
  const [showTokens, setShowTokens] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const meta = getWorkerStatusMeta(sandbox.status);
  const canConnect = meta.bucket === "ready";
  const connectionUrl = details?.openworkUrl ?? sandbox.instanceUrl ?? null;
  const ownerToken = details?.ownerToken ?? null;
  const clientToken = details?.clientToken ?? null;
  const openWebUrl = details?.openworkAppConnectUrl ?? null;
  const openDesktopUrl = details?.openworkDeepLink ?? null;

  async function handleCopy(field: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    window.setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 2000);
  }

  const credentialFields = [
    connectionUrl ? { id: "url", label: "Connection URL", value: connectionUrl } : null,
    ownerToken ? { id: "owner", label: "Owner token", value: ownerToken } : null,
    clientToken ? { id: "client", label: "Client token", value: clientToken } : null,
  ].filter((field): field is { id: string; label: string; value: string } => Boolean(field));

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
            onClick={() => {
              if (expanded) {
                setShowTokens(false);
              }
              onToggle();
            }}
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
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowTokens((current) => !current)}
                className="flex w-full items-center justify-between rounded-xl border border-gray-100 bg-gray-50/50 px-4 py-2.5 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                <span className="flex items-center gap-2">
                  <KeyRound size={14} className="text-gray-400" />
                  Connection credentials
                </span>
                {showTokens ? (
                  <ChevronUp size={14} className="text-gray-400" />
                ) : (
                  <ChevronDown size={14} className="text-gray-400" />
                )}
              </button>

              {showTokens ? (
                <div className="mt-2 space-y-4 rounded-xl border border-gray-100 bg-gray-50/50 p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-[1px] text-gray-500">
                      Access Tokens
                    </span>
                    <button
                      type="button"
                      onClick={onRefresh}
                      disabled={connectBusy}
                      className="flex items-center gap-1.5 text-[12px] font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RefreshCw size={13} className={connectBusy ? "animate-spin" : ""} />
                      {connectBusy ? "Refreshing..." : "Refresh tokens"}
                    </button>
                  </div>

                  {credentialFields.length > 0 ? (
                    credentialFields.map((field) => (
                      <CredentialField
                        key={field.id}
                        id={field.id}
                        label={field.label}
                        value={field.value}
                        onCopy={handleCopy}
                        copied={copiedField === field.id}
                      />
                    ))
                  ) : (
                    <p className="text-[12px] text-gray-500">
                      {connectBusy
                        ? "Loading connection credentials..."
                        : "Connection credentials will appear here once the workspace is ready."}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
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
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
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
    launchBusy,
    launchWorker,
    orgLimitError,
    clearOrgLimitError,
    renameWorker,
    renameBusyWorkerId,
  } = useDenFlow();
  const feedbackHref = buildDenFeedbackUrl({
    pathname: `/o/${orgSlug}/dashboard/background-agents`,
    orgSlug,
    topic: "workspace-limits",
  });

  async function handleAddWorkspace() {
    const result = await launchWorker({ source: "manual" });
    if (result === "checkout") {
      router.push("/checkout");
    }
  }

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
          { autoConnect: true },
        ),
        openworkDeepLink: buildOpenworkDeepLink(
          tokens.openworkUrl,
          tokens.clientToken,
          workerId,
          workerName,
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
      title="Shared Workspaces"
      description="Keep selected workflows running in the background without asking each teammate to run them locally."
      colors={["#E9FFE0", "#3E9A1D", "#B3F750", "#51F0A3"]}
    >
      <OrgLimitDialog
        open={Boolean(orgLimitError)}
        title={orgLimitError?.limitType === "workers" ? "Worker limit reached" : "Member limit reached"}
        message={orgLimitError?.message ?? "This workspace reached its current plan limit."}
        detail={
          orgLimitError
            ? `${orgLimitError.currentCount} of ${orgLimitError.limit} ${orgLimitError.limitType} are already in use.`
            : null
        }
        feedbackHref={feedbackHref}
        onClose={clearOrgLimitError}
      />

      <div className="mb-10 flex items-center gap-3">
        <DenButton
          icon={Plus}
          loading={launchBusy}
          onClick={() => void handleAddWorkspace()}
        >
          Add workspace
        </DenButton>
        <Link
          href={getSharedSetupsRoute(orgSlug)}
          className={buttonVariants({ variant: "secondary" })}
        >
          Open shared setups
        </Link>
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
                : "No workspaces launched yet. Add one to start connecting cloud workflows."}
            </div>
          ) : (
            filteredWorkers.map((sandbox) => (
              <SandboxCard
                key={sandbox.workerId}
                sandbox={sandbox}
                expanded={expandedWorkerId === sandbox.workerId}
                details={connectionDetailsByWorkerId[sandbox.workerId] ?? null}
                connectBusy={connectBusyWorkerId === sandbox.workerId}
                renameBusy={renameBusyWorkerId === sandbox.workerId}
                onToggle={() => void toggleSandbox(sandbox)}
                onRefresh={() => void loadConnectionDetails(sandbox.workerId, sandbox.workerName)}
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
