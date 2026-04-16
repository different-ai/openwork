/** @jsxImportSource react */
import { useMemo } from "react";
import { Boxes, Cloud, Loader2, RefreshCcw, Search } from "lucide-react";

import type { DenOrgSummary, DenWorkerSummary } from "../../../app/lib/den";
import {
  errorBannerClass,
  iconTileClass,
  inputClass,
  modalBodyClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
  sectionBodyClass,
  sectionTitleClass,
  surfaceCardClass,
} from "./modal-styles";

type WorkerStatusMeta = {
  label: string;
  tone: "ready" | "warning" | "neutral" | "error";
  canOpen: boolean;
};

const statusBadgeClass = (tone: WorkerStatusMeta["tone"]): string => {
  switch (tone) {
    case "ready":
      return "border-emerald-7/30 bg-emerald-3/40 text-emerald-11";
    case "warning":
      return "border-amber-7/30 bg-amber-3/40 text-amber-11";
    case "error":
      return "border-red-7/30 bg-red-3/40 text-red-11";
    default:
      return "border-dls-border bg-dls-hover text-dls-secondary";
  }
};

export type CreateWorkspaceSharedPanelProps = {
  signedIn: boolean;
  orgs: DenOrgSummary[];
  activeOrgId: string;
  onActiveOrgChange: (orgId: string) => void;
  orgsBusy: boolean;
  orgsError: string | null;
  workers: DenWorkerSummary[];
  workersBusy: boolean;
  workersError: string | null;
  workerSearch: string;
  onWorkerSearchInput: (value: string) => void;
  filteredWorkers: DenWorkerSummary[];
  openingWorkerId: string | null;
  workerStatusMeta: (status: string) => WorkerStatusMeta;
  workerSecondaryLine: (worker: DenWorkerSummary) => string;
  onOpenWorker: (worker: DenWorkerSummary) => void;
  onOpenCloudSignIn: () => void;
  onRefreshWorkers: () => void;
  onOpenCloudDashboard: () => void;
};

export function CreateWorkspaceSharedPanel(
  props: CreateWorkspaceSharedPanelProps,
) {
  const activeOrg = useMemo(
    () => props.orgs.find((org) => org.id === props.activeOrgId) ?? null,
    [props.activeOrgId, props.orgs],
  );

  if (!props.signedIn) {
    return (
      <div className={modalBodyClass}>
        <div className="flex min-h-[320px] items-center justify-center">
          <div
            className={`${surfaceCardClass} w-full max-w-[420px] p-8 text-center`}
          >
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover text-dls-text">
              <Cloud size={24} />
            </div>
            <div className="mt-5 text-[20px] font-semibold tracking-[-0.3px] text-dls-text">
              Sign in to OpenWork Cloud
            </div>
            <div className="mt-2 text-[14px] leading-6 text-dls-secondary">
              Access remote workers shared with your organization.
            </div>
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                className={pillPrimaryClass}
                onClick={props.onOpenCloudSignIn}
              >
                Continue with Cloud
              </button>
            </div>
            <div className="mt-3 text-[12px] text-dls-secondary">
              You’ll pick a team and connect to an existing workspace next.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={modalBodyClass}>
      <div className="space-y-4">
        <div className={surfaceCardClass}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className={sectionTitleClass}>Shared workspaces</div>
              <div className={sectionBodyClass}>
                Choose your organization, then connect to a cloud worker in one
                step.
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <select
                value={props.activeOrgId}
                onChange={(event) =>
                  props.onActiveOrgChange(event.currentTarget.value)
                }
                disabled={props.orgsBusy || props.orgs.length === 0}
                className={`${inputClass} h-11 min-w-[180px] py-2 font-medium`}
              >
                {props.orgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={pillSecondaryClass}
                onClick={props.onRefreshWorkers}
                disabled={props.workersBusy || !props.activeOrgId.trim()}
                title={activeOrg?.name ?? undefined}
              >
                <RefreshCcw
                  size={13}
                  className={props.workersBusy ? "animate-spin" : ""}
                />
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4">
            <label className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
              <Search size={15} className="shrink-0 text-dls-secondary" />
              <input
                type="text"
                value={props.workerSearch}
                onChange={(event) =>
                  props.onWorkerSearchInput(event.currentTarget.value)
                }
                placeholder="Search shared workspaces"
                className="min-w-0 flex-1 border-none bg-transparent text-[14px] text-dls-text outline-none placeholder:text-dls-secondary"
              />
            </label>
          </div>
        </div>

        {props.orgsError ? (
          <div className={errorBannerClass}>{props.orgsError}</div>
        ) : null}
        {props.workersError ? (
          <div className={errorBannerClass}>{props.workersError}</div>
        ) : null}

        {props.workersBusy && props.workers.length === 0 ? (
          <div className={`${surfaceCardClass} text-[14px] text-dls-secondary`}>
            Loading shared workspaces…
          </div>
        ) : null}

        {!props.workersBusy && props.filteredWorkers.length === 0 ? (
          <div className={`${surfaceCardClass} text-[14px] text-dls-secondary`}>
            {props.workerSearch.trim()
              ? "No shared workspaces match that search."
              : "No shared workspaces available yet."}
          </div>
        ) : null}

        <div className="space-y-3">
          {props.filteredWorkers.map((worker) => {
            const status = props.workerStatusMeta(worker.status);
            const isConnecting = props.openingWorkerId === worker.workerId;
            return (
              <div
                key={worker.workerId}
                className={`${surfaceCardClass} transition-all duration-150 hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]`}
              >
                <div className="flex items-center gap-4">
                  <div className={iconTileClass}>
                    <Boxes size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-[14px] font-medium text-dls-text">
                        {worker.workerName}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusBadgeClass(status.tone)}`.trim()}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                        {status.label}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[12px] text-dls-secondary">
                      {props.workerSecondaryLine(worker)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={pillSecondaryClass}
                    disabled={
                      props.openingWorkerId !== null || !status.canOpen
                    }
                    title={
                      !status.canOpen
                        ? "This workspace is not ready to connect yet."
                        : undefined
                    }
                    onClick={() => props.onOpenWorker(worker)}
                  >
                    {isConnecting ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 size={13} className="animate-spin" />
                        Connecting
                      </span>
                    ) : (
                      "Connect"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {props.workersBusy && props.workers.length > 0 ? (
          <div className="text-[12px] text-dls-secondary">
            Refreshing workspaces…
          </div>
        ) : null}

        <div className="pt-2">
          <button
            type="button"
            className={pillGhostClass}
            onClick={props.onOpenCloudDashboard}
          >
            Open cloud dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
