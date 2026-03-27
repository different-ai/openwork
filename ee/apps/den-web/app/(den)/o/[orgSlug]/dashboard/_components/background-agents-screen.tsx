"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  OPENWORK_APP_CONNECT_BASE_URL,
  buildOpenworkAppConnectUrl,
  buildOpenworkDeepLink,
  getErrorMessage,
  getWorkerStatusMeta,
  getWorkerTokens,
  requestJson,
} from "../../../../_lib/den-flow";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { getSharedSetupsRoute } from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const EXAMPLE_AGENTS = [
  {
    name: "Sales follow-up agent",
    status: "Active",
    detail: "Source: SDR outreach setup",
  },
  {
    name: "Renewal reminder agent",
    status: "Active",
    detail: "Source: Customer success setup",
  },
];

function statusClass(bucket: ReturnType<typeof getWorkerStatusMeta>["bucket"]) {
  switch (bucket) {
    case "ready":
      return "is-success";
    case "starting":
      return "is-neutral";
    case "attention":
      return "is-warning";
    default:
      return "is-neutral";
  }
}

type ConnectionDetails = {
  openworkUrl: string | null;
  ownerToken: string | null;
  clientToken: string | null;
  openworkAppConnectUrl: string | null;
  openworkDeepLink: string | null;
};

export function BackgroundAgentsScreen() {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);
  const [connectBusyWorkerId, setConnectBusyWorkerId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [connectionDetailsByWorkerId, setConnectionDetailsByWorkerId] = useState<Record<string, ConnectionDetails>>({});
  const {
    workers,
    workersBusy,
    workersLoadedOnce,
    workersError,
    launchBusy,
    launchWorker,
    renameWorker,
    renameBusyWorkerId,
  } = useDenFlow();

  async function handleAddSandbox() {
    const result = await launchWorker({ source: "manual" });
    if (result === "checkout") {
      router.push("/checkout");
    }
  }

  async function copyValue(field: string, value: string | null) {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    window.setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1500);
  }

  async function loadConnectionDetails(workerId: string, workerName: string) {
    setConnectBusyWorkerId(workerId);
    setConnectError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(workerId)}/tokens`, {
        method: "POST",
        body: JSON.stringify({}),
      }, 12000);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load connection details (${response.status}).`));
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
        openworkDeepLink: buildOpenworkDeepLink(tokens.openworkUrl, tokens.clientToken, workerId, workerName),
      };

      setConnectionDetailsByWorkerId((current) => ({
        ...current,
        [workerId]: nextDetails,
      }));
      return nextDetails;
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Failed to load connection details.");
      return null;
    } finally {
      setConnectBusyWorkerId(null);
    }
  }

  async function toggleConnect(workerId: string, workerName: string) {
    if (expandedWorkerId === workerId) {
      setExpandedWorkerId(null);
      return;
    }

    setExpandedWorkerId(workerId);
    if (!connectionDetailsByWorkerId[workerId]) {
      await loadConnectionDetails(workerId, workerName);
    }
  }

  return (
    <section className="den-page flex max-w-6xl flex-col gap-6 py-4 md:py-8">
      <div className="den-frame grid gap-6 p-6 md:p-8 lg:p-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3">
            <div className="flex items-center gap-3">
              <p className="den-eyebrow">OpenWork Cloud</p>
              <span className="den-status-pill is-neutral">Alpha</span>
            </div>
            <h1 className="den-title-xl max-w-[12ch]">Background agents</h1>
            <p className="den-copy max-w-2xl">
              Keep selected workflows running in the background.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="den-button-primary"
              onClick={() => void handleAddSandbox()}
              disabled={launchBusy}
            >
              {launchBusy ? "Adding..." : "+ Add sandbox"}
            </button>
            <Link href={getSharedSetupsRoute(orgSlug)} className="den-button-secondary">
              Open shared setups
            </Link>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="den-stat-card md:col-span-2">
            <p className="den-stat-label">How this fits</p>
            <p className="den-stat-copy mt-3">
              Use shared setups as the source of truth, then keep selected workflows available without asking each teammate to run them locally.
            </p>
          </div>
          <div className="den-stat-card">
            <p className="den-stat-label">Status</p>
            <p className="den-stat-value text-[1.5rem] md:text-[1.7rem]">Alpha</p>
            <p className="den-stat-copy">Available for selected workflows while the product continues to evolve.</p>
          </div>
        </div>
      </div>

      {workersError ? <div className="den-notice is-error">{workersError}</div> : null}
      {connectError ? <div className="den-notice is-error">{connectError}</div> : null}

      <div className="den-list-shell">
        <div className="px-5 py-5">
          <div className="flex items-center gap-3">
            <p className="den-eyebrow">{workers.length > 0 ? "Current sandboxes" : "Example workflows"}</p>
            {workersLoadedOnce && workersBusy ? <span className="text-xs text-[var(--dls-text-secondary)]">Refreshing...</span> : null}
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
            Background workflows
          </h2>
        </div>

        {!workersLoadedOnce ? (
          <div className="den-list-row text-sm text-[var(--dls-text-secondary)]">Loading sandboxes...</div>
        ) : workers.length > 0 ? (
          workers.map((worker) => {
            const meta = getWorkerStatusMeta(worker.status);
            const canConnect = meta.bucket === "ready";
            const isExpanded = expandedWorkerId === worker.workerId;
            const details = connectionDetailsByWorkerId[worker.workerId] ?? null;
            const showExpandedConnect = isExpanded && canConnect;
            return (
              <article key={worker.workerId} className="den-list-row flex-col items-stretch gap-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h3 className="text-base font-semibold text-[var(--dls-text-primary)]">{worker.workerName}</h3>
                    <p className="text-sm text-[var(--dls-text-secondary)]">
                      Source: {worker.provider ? `${worker.provider} sandbox` : "Cloud sandbox"}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {worker.isMine ? (
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => {
                          const nextName = window.prompt("Rename sandbox", worker.workerName)?.trim();
                          if (!nextName || nextName === worker.workerName) {
                            return;
                          }
                          void renameWorker(worker.workerId, nextName);
                        }}
                        disabled={renameBusyWorkerId === worker.workerId}
                      >
                        {renameBusyWorkerId === worker.workerId ? "Renaming..." : "Rename"}
                      </button>
                    ) : null}
                    {canConnect && !isExpanded ? (
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => void toggleConnect(worker.workerId, worker.workerName)}
                      >
                        Connect
                      </button>
                    ) : null}
                    {canConnect && isExpanded ? (
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => setExpandedWorkerId(null)}
                      >
                        Hide details
                      </button>
                    ) : null}
                    <span className={`den-status-pill ${statusClass(meta.bucket)}`}>{meta.label}</span>
                  </div>
                </div>

                {showExpandedConnect ? (
                  <div className="grid gap-4 border-t border-[var(--dls-border)] pt-4">
                    <div className="flex flex-wrap gap-3">
                      <a
                        href={details?.openworkAppConnectUrl ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className={`den-button-primary ${details?.openworkAppConnectUrl ? "" : "pointer-events-none opacity-60"}`}
                      >
                        Open in web
                      </a>
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => {
                          if (details?.openworkDeepLink) {
                            window.location.href = details.openworkDeepLink;
                          }
                        }}
                        disabled={!details?.openworkDeepLink}
                      >
                        Open in desktop
                      </button>
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => void loadConnectionDetails(worker.workerId, worker.workerName)}
                        disabled={connectBusyWorkerId === worker.workerId}
                      >
                        {connectBusyWorkerId === worker.workerId ? "Refreshing..." : "Refresh tokens"}
                      </button>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-3">
                      <div className="grid gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">Connection URL</span>
                        <div className="flex items-center gap-2 rounded-2xl border border-[var(--dls-border)] bg-white px-3 py-2.5">
                          <input
                            readOnly
                            value={details?.openworkUrl ?? worker.instanceUrl ?? "Preparing..."}
                            className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs text-[var(--dls-text-primary)] outline-none"
                            onClick={(event) => event.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="den-button-secondary"
                            onClick={() => void copyValue(`background-connect-url-${worker.workerId}`, details?.openworkUrl ?? worker.instanceUrl)}
                            disabled={!details?.openworkUrl && !worker.instanceUrl}
                          >
                            {copiedField === `background-connect-url-${worker.workerId}` ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>

                      <div className="grid gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">Owner token</span>
                        <div className="flex items-center gap-2 rounded-2xl border border-[var(--dls-border)] bg-white px-3 py-2.5">
                          <input
                            readOnly
                            value={details?.ownerToken ?? "Preparing..."}
                            className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs text-[var(--dls-text-primary)] outline-none"
                            onClick={(event) => event.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="den-button-secondary"
                            onClick={() => void copyValue(`background-owner-token-${worker.workerId}`, details?.ownerToken ?? null)}
                            disabled={!details?.ownerToken}
                          >
                            {copiedField === `background-owner-token-${worker.workerId}` ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>

                      <div className="grid gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">Client token</span>
                        <div className="flex items-center gap-2 rounded-2xl border border-[var(--dls-border)] bg-white px-3 py-2.5">
                          <input
                            readOnly
                            value={details?.clientToken ?? "Preparing..."}
                            className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs text-[var(--dls-text-primary)] outline-none"
                            onClick={(event) => event.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="den-button-secondary"
                            onClick={() => void copyValue(`background-client-token-${worker.workerId}`, details?.clientToken ?? null)}
                            disabled={!details?.clientToken}
                          >
                            {copiedField === `background-client-token-${worker.workerId}` ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })
        ) : (
          EXAMPLE_AGENTS.map((agent) => (
            <article key={agent.name} className="den-list-row">
              <div className="grid gap-1">
                <h3 className="text-base font-semibold text-[var(--dls-text-primary)]">{agent.name}</h3>
                <p className="text-sm text-[var(--dls-text-secondary)]">{agent.detail}</p>
              </div>
              <span className="den-status-pill is-neutral">{agent.status}</span>
            </article>
          ))
        )}
      </div>

    </section>
  );
}
