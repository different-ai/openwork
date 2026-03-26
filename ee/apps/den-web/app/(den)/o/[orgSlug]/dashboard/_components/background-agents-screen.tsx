"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { getWorkerStatusMeta } from "../../../../_lib/den-flow";
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

function CredentialField({
  label,
  value,
  copyKey,
  copiedField,
  onCopy,
}: {
  label: string;
  value: string | null;
  copyKey: string;
  copiedField: string | null;
  onCopy: (field: string, value: string | null) => Promise<void>;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">{label}</span>
      <div className="flex items-center gap-2 rounded-2xl border border-[var(--dls-border)] bg-white px-3 py-2.5">
        <input
          readOnly
          value={value ?? "Preparing..."}
          className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs text-[var(--dls-text-primary)] outline-none"
          onClick={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="rounded-xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-3 py-1.5 text-xs font-medium text-[var(--dls-text-secondary)] transition hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void onCopy(copyKey, value)}
          disabled={!value}
        >
          {copiedField === copyKey ? "Copied" : value ? "Copy" : "N/A"}
        </button>
      </div>
    </label>
  );
}

function RowConnectActions({
  workerId,
  openworkAppConnectUrl,
  openworkDeepLink,
  activeWorker,
  copiedField,
  copyToClipboard,
  generateWorkerToken,
  actionBusy,
}: {
  workerId: string;
  openworkAppConnectUrl: string | null;
  openworkDeepLink: string | null;
  activeWorker: {
    openworkUrl: string | null;
    instanceUrl: string | null;
    ownerToken: string | null;
    clientToken: string | null;
  };
  copiedField: string | null;
  copyToClipboard: (field: string, value: string | null) => Promise<void>;
  generateWorkerToken: () => Promise<void>;
  actionBusy: "status" | "token" | null;
}) {
  return (
    <div className="mt-4 grid gap-4 border-t border-[var(--dls-border)] pt-4">
      <div className="flex flex-wrap gap-3">
        <a
          href={openworkAppConnectUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
          className={`den-button-primary ${openworkAppConnectUrl ? "" : "pointer-events-none opacity-60"}`}
        >
          Open in web
        </a>
        <button
          type="button"
          className="den-button-secondary"
          onClick={() => {
            if (openworkDeepLink) {
              window.location.href = openworkDeepLink;
            }
          }}
          disabled={!openworkDeepLink}
        >
          Open in desktop
        </button>
        <button
          type="button"
          className="den-button-secondary"
          onClick={() => void generateWorkerToken()}
          disabled={actionBusy === "token"}
        >
          {actionBusy === "token" ? "Refreshing..." : "Refresh tokens"}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <CredentialField
          label="Connection URL"
          value={activeWorker.openworkUrl ?? activeWorker.instanceUrl}
          copyKey={`background-connect-url-${workerId}`}
          copiedField={copiedField}
          onCopy={copyToClipboard}
        />
        <CredentialField
          label="Owner token"
          value={activeWorker.ownerToken}
          copyKey={`background-owner-token-${workerId}`}
          copiedField={copiedField}
          onCopy={copyToClipboard}
        />
        <CredentialField
          label="Collaborator token"
          value={activeWorker.clientToken}
          copyKey={`background-client-token-${workerId}`}
          copiedField={copiedField}
          onCopy={copyToClipboard}
        />
      </div>
    </div>
  );
}

export function BackgroundAgentsScreen() {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const {
    workers,
    workersBusy,
    workersLoadedOnce,
    workersError,
    launchBusy,
    launchWorker,
    selectedWorker,
    activeWorker,
    selectWorker,
    openworkDeepLink,
    openworkAppConnectUrl,
    copiedField,
    copyToClipboard,
    generateWorkerToken,
    renameWorker,
    renameBusyWorkerId,
    actionBusy,
  } = useDenFlow();

  const selectedWorkerId = selectedWorker?.workerId ?? null;

  async function handleAddSandbox() {
    const result = await launchWorker({ source: "manual" });
    if (result === "checkout") {
      router.push("/checkout");
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

      <div className="den-list-shell">
        <div className="px-5 py-5">
          <p className="den-eyebrow">{workers.length > 0 ? "Current sandboxes" : "Example workflows"}</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
            Background workflows
          </h2>
        </div>

        {!workersLoadedOnce || workersBusy ? (
          <div className="den-list-row text-sm text-[var(--dls-text-secondary)]">Loading sandboxes...</div>
        ) : workers.length > 0 ? (
          workers.map((worker) => {
            const meta = getWorkerStatusMeta(worker.status);
            const canConnect = meta.bucket === "ready";
            const isSelected = selectedWorkerId === worker.workerId;
            const showInlineConnect = isSelected && canConnect && activeWorker?.workerId === worker.workerId;
            return (
              <article key={worker.workerId} className="den-list-row flex-col items-stretch gap-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold text-[var(--dls-text-primary)]">{worker.workerName}</h3>
                    <p className="text-sm text-[var(--dls-text-secondary)]">
                      Source: {worker.provider ? `${worker.provider} sandbox` : "Cloud sandbox"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                    {canConnect ? (
                      <button
                        type="button"
                        className="den-button-secondary"
                        onClick={() => {
                          selectWorker(worker);
                          if (!isSelected) {
                            window.setTimeout(() => {
                              void generateWorkerToken();
                            }, 0);
                          }
                        }}
                      >
                        Connect
                      </button>
                    ) : null}
                    <span className={`den-status-pill ${statusClass(meta.bucket)}`}>{meta.label}</span>
                  </div>
                </div>

                {showInlineConnect ? (
                  <RowConnectActions
                    workerId={worker.workerId}
                    openworkAppConnectUrl={openworkAppConnectUrl}
                    openworkDeepLink={openworkDeepLink}
                    activeWorker={activeWorker}
                    copiedField={copiedField}
                    copyToClipboard={copyToClipboard}
                    generateWorkerToken={generateWorkerToken}
                    actionBusy={actionBusy}
                  />
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
