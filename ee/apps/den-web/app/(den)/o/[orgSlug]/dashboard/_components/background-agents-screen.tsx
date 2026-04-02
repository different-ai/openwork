"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
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
} from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";
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
    renameWorker,
    renameBusyWorkerId,
  } = useDenFlow();

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
    <div className="mx-auto max-w-[860px] p-8">
      <div className="relative mb-8 flex min-h-[180px] items-center overflow-hidden rounded-3xl border border-gray-100 px-10">
        <div className="absolute inset-0 z-0">
          <Dithering
            speed={0}
            shape="warp"
            type="4x4"
            size={2.5}
            scale={1}
            frame={5213.4}
            colorBack="#00000000"
            colorFront="#FEFEFE"
            style={{ backgroundColor: "#23301C", width: "100%", height: "100%" }}
          >
            <PaperMeshGradient
              speed={0}
              distortion={0.8}
              swirl={0.1}
              grainMixer={0}
              grainOverlay={0}
              frame={176868.9}
              colors={["#E9FFE0", "#3E9A1D", "#B3F750", "#51F0A3"]}
              style={{ width: "100%", height: "100%" }}
            />
          </Dithering>
        </div>
        <div className="relative z-10 flex flex-col items-start gap-3">
          <div>
            <span className="mb-2 inline-block rounded-full border border-white/20 bg-white/20 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[1px] text-white backdrop-blur-md">
              Alpha
            </span>
            <h1 className="mb-1.5 text-[26px] font-medium tracking-[-0.5px] text-white">
              Shared Workspaces
            </h1>
            <p className="max-w-[500px] text-[14px] text-white/80">
              Keep selected workflows running in the background without asking each teammate to run them locally. Available for selected workflows while the product continues to evolve.
            </p>
          </div>
        </div>
      </div>

      <div className="mb-10 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleAddWorkspace()}
          disabled={launchBusy}
          className="flex items-center gap-2 rounded-full bg-gray-900 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={15} />
          {launchBusy ? "Adding workspace..." : "Add workspace"}
        </button>
        <Link
          href={getSharedSetupsRoute(orgSlug)}
          className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-5 py-2.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
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
          <div className="relative w-full max-w-[240px]">
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-400"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <input
              type="text"
              value={workerQuery}
              onChange={(event) => setWorkerQuery(event.target.value)}
              placeholder="Search workspaces..."
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-[13px] text-gray-900 outline-none transition-all placeholder:text-gray-400 focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5"
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
    </div>
  );
}
