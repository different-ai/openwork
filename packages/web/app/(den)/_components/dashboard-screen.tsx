"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getWorkerStatusCopy, getWorkerStatusMeta } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

function CredentialRow({
  label,
  value,
  placeholder,
  hint,
  canCopy,
  copied,
  onCopy
}: {
  label: string;
  value: string | null;
  placeholder: string;
  hint?: string;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="px-0.5 text-[0.67rem] font-bold uppercase tracking-[0.11em] text-slate-500">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
        <input
          readOnly
          value={value ?? placeholder}
          className="min-w-0 flex-1 border-none bg-transparent px-2 py-1.5 font-mono text-xs text-slate-700 outline-none"
          onClick={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canCopy}
          onClick={onCopy}
        >
          {copied ? "Copied" : canCopy ? "Copy" : "N/A"}
        </button>
      </div>
      {hint ? <span className="px-0.5 text-[0.7rem] text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function DashboardScreen() {
  const router = useRouter();
  const {
    user,
    sessionHydrated,
    onboardingPending,
    onboardingDecisionBusy,
    resolveUserLandingRoute,
    signOut,
    workers,
    filteredWorkers,
    workersBusy,
    workersError,
    workerQuery,
    setWorkerQuery,
    workerStatusFilter,
    setWorkerStatusFilter,
    selectedWorker,
    activeWorker,
    selectWorker,
    workerName,
    setWorkerName,
    launchBusy,
    launchStatus,
    launchError,
    actionBusy,
    deleteBusyWorkerId,
    redeployBusyWorkerId,
    runtimeSnapshot,
    runtimeBusy,
    runtimeError,
    runtimeUpgradeBusy,
    copiedField,
    events,
    openworkDeepLink,
    openworkAppConnectUrl,
    hasWorkspaceScopedUrl,
    additionalWorkerNeedsPlan,
    selectedStatusMeta,
    isSelectedWorkerFailed,
    ownedWorkerCount,
    effectiveCheckoutUrl,
    billingSummary,
    refreshWorkers,
    launchWorker,
    checkWorkerStatus,
    generateWorkerToken,
    deleteWorker,
    redeployWorker,
    refreshRuntime,
    upgradeRuntime,
    copyToClipboard,
    getRuntimeServiceLabel
  } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }
    if (!user) {
      router.replace("/");
      return;
    }
    if (!onboardingPending) {
      return;
    }

    void resolveUserLandingRoute().then((target) => {
      if (target === "/checkout") {
        router.replace(target);
      }
    });
  }, [onboardingPending, resolveUserLandingRoute, router, sessionHydrated, user]);

  if (!sessionHydrated || !user || onboardingDecisionBusy) {
    return (
      <section className="mx-auto grid w-full max-w-[52rem] gap-4 rounded-[32px] border border-white/70 bg-white/92 p-6 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)]">
        <p className="text-sm text-slate-500">Preparing your dashboard...</p>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col gap-3 rounded-[32px] bg-white/92 shadow-[0_20px_60px_rgba(15,23,42,0.08)] ring-1 ring-black/5 lg:flex-row">
      <aside className="w-full shrink-0 border-b border-[var(--dls-border)] p-5 lg:w-[330px] lg:border-b-0 lg:border-r lg:p-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Dashboard</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Workers</h2>
          </div>
          <button
            type="button"
            className="rounded-[14px] border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            onClick={() => void signOut()}
          >
            Log out
          </button>
        </div>

        <div className="rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-hover)] p-4">
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Worker name</span>
            <input
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
              value={workerName}
              onChange={(event) => setWorkerName(event.target.value)}
              maxLength={80}
            />
          </label>

          <button
            type="button"
            className="w-full rounded-2xl bg-slate-900 px-3 py-3 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
            onClick={async () => {
              const outcome = await launchWorker({ source: "manual" });
              if (outcome === "checkout") {
                router.push("/checkout");
              }
            }}
            disabled={!user || launchBusy || activeWorker?.status === "provisioning"}
          >
            {launchBusy
              ? "Starting worker..."
              : activeWorker?.status === "provisioning"
                ? "Worker is starting..."
                : `Launch \"${workerName || "My Worker"}\"`}
          </button>

          {(launchStatus || launchError) ? (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
              <p className="text-xs text-slate-600">{launchStatus}</p>
              {launchError ? <p className="mt-1 text-xs font-medium text-rose-600">{launchError}</p> : null}
            </div>
          ) : null}

          {additionalWorkerNeedsPlan ? (
            <div className="mt-3 rounded-[16px] border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              Your first worker is live. Additional workers require an active Den Cloud plan.
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/checkout"
              className="inline-flex flex-1 items-center justify-center rounded-[12px] border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
            >
              Manage billing
            </Link>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-[12px] border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
              onClick={() => void refreshWorkers({ keepSelection: true })}
            >
              Refresh
            </button>
          </div>

          {effectiveCheckoutUrl ? (
            <div className="mt-3 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="text-sm font-semibold text-amber-800">Payment needed before launch</p>
              <a
                href={effectiveCheckoutUrl}
                rel="noreferrer"
                className="mt-2 inline-flex rounded-[10px] border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-100"
              >
                Continue to checkout
              </a>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
          <input
            className="min-w-[170px] rounded-xl border border-slate-200 bg-[var(--dls-hover)] px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-slate-400"
            value={workerQuery}
            onChange={(event) => setWorkerQuery(event.target.value)}
            placeholder="Search..."
            aria-label="Search workers"
          />
          <select
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none"
            value={workerStatusFilter}
            onChange={(event) => setWorkerStatusFilter(event.target.value as "all" | "ready" | "starting" | "attention")}
          >
            <option value="all">All</option>
            <option value="ready">Ready</option>
            <option value="starting">Starting</option>
            <option value="attention">Attention</option>
          </select>
        </div>

        {workersBusy ? <p className="mt-3 text-xs text-slate-500">Loading workers...</p> : null}
        {workersError ? <p className="mt-3 text-xs font-medium text-rose-600">{workersError}</p> : null}

        <div className="mt-4 space-y-3 lg:max-h-[calc(100vh-24rem)] lg:overflow-y-auto lg:pr-1">
          {filteredWorkers.map((item) => {
            const meta = getWorkerStatusMeta(item.status);
            return (
              <button
                key={item.workerId}
                type="button"
                onClick={() => selectWorker(item)}
                className={`w-full rounded-[20px] border p-4 text-left transition-all ${
                  selectedWorker?.workerId === item.workerId
                    ? "border-slate-900/10 bg-slate-900/[0.03] ring-1 ring-slate-900/10"
                    : "border-slate-100 bg-white hover:border-slate-300"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate pr-2 text-sm font-semibold text-slate-800">{item.workerName}</span>
                  {item.isMine ? (
                    <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      Yours
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-slate-500">{meta.label}</div>
              </button>
            );
          })}

          {workers.length === 0 && !workersBusy ? (
            <p className="text-xs text-slate-500">No workers yet. Create one to get started.</p>
          ) : null}
        </div>

        <div className="mt-5 rounded-[24px] bg-[var(--dls-hover)] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-400">Signed in</p>
          <p className="mt-1 break-all text-sm font-medium text-slate-700">{user.email}</p>
          <p className="mt-2 text-xs text-slate-500">
            {billingSummary?.featureGateEnabled && !billingSummary.hasActivePlan ? "Billing required before the next launch." : `${ownedWorkerCount} worker${ownedWorkerCount === 1 ? "" : "s"} in your account.`}
          </p>
        </div>
      </aside>

      <section className="min-h-0 min-w-0 flex-1 p-5 md:p-8">
        {selectedWorker ? (
          <div className="space-y-6">
            <div className="rounded-[28px] border border-[var(--dls-border)] bg-[var(--dls-hover)] p-6">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</p>
                  <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{activeWorker?.workerName ?? selectedWorker.workerName}</h1>
                  <p className="mt-2 text-sm text-slate-500">{getWorkerStatusCopy(activeWorker?.status ?? selectedWorker.status)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {openworkAppConnectUrl ? (
                    <a
                      href={openworkAppConnectUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={`rounded-[16px] px-5 py-3 text-sm font-semibold transition ${
                        selectedStatusMeta.bucket === "ready"
                          ? "bg-slate-900 text-white shadow-[0_12px_24px_rgba(15,23,42,0.14)] hover:bg-black"
                          : "pointer-events-none cursor-not-allowed border border-slate-200 bg-white text-slate-400"
                      }`}
                      aria-disabled={selectedStatusMeta.bucket !== "ready"}
                    >
                      {selectedStatusMeta.bucket === "ready" ? "Open in Web" : "Preparing worker"}
                    </a>
                  ) : null}
                  <Link
                    href="/checkout"
                    className="rounded-[16px] border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    Billing
                  </Link>
                </div>
              </div>

              {selectedStatusMeta.bucket !== "ready" && openworkAppConnectUrl ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50/80 px-3 py-1.5 text-xs font-medium text-amber-800">
                  Browser access is being prepared - this button will light up automatically.
                </div>
              ) : null}
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <div className="space-y-6">
                <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
                  <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="text-lg font-bold tracking-tight text-slate-900">Connection details</h3>
                      <p className="text-sm text-slate-500">Connect now or copy manual credentials for another client.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-[16px] bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(15,23,42,0.14)] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => {
                          if (openworkDeepLink) {
                            window.location.href = openworkDeepLink;
                          }
                        }}
                        disabled={!openworkDeepLink || selectedStatusMeta.bucket !== "ready"}
                      >
                        {openworkDeepLink ? "Open in OpenWork" : "Preparing connection..."}
                      </button>
                      <button
                        type="button"
                        className="rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => void generateWorkerToken()}
                        disabled={actionBusy !== null}
                      >
                        {actionBusy === "token" ? "Refreshing token..." : "Refresh token"}
                      </button>
                    </div>
                  </div>

                  <div className="rounded-[16px] border border-slate-200 bg-[var(--dls-hover)] px-4 py-3">
                    <p className="text-sm text-slate-600">
                      {openworkDeepLink
                        ? openworkAppConnectUrl
                          ? "You are all set. Open in OpenWork or Open in Web to start working."
                          : "You are all set. Open in OpenWork to start working."
                        : "We are still preparing your connection. The button will unlock when ready."}
                    </p>
                  </div>

                  <div className="mt-4 space-y-4">
                    <CredentialRow
                      label="Connection URL"
                      value={activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null}
                      placeholder="Connection URL is still preparing..."
                      canCopy={Boolean(activeWorker?.openworkUrl ?? activeWorker?.instanceUrl)}
                      copied={copiedField === "openwork-url"}
                      onCopy={() => void copyToClipboard("openwork-url", activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null)}
                    />

                    <CredentialRow
                      label="Owner token"
                      value={activeWorker?.ownerToken ?? null}
                      placeholder="Use refresh token"
                      hint="Use this token when the remote client must answer permission prompts."
                      canCopy={Boolean(activeWorker?.ownerToken)}
                      copied={copiedField === "owner-token"}
                      onCopy={() => void copyToClipboard("owner-token", activeWorker?.ownerToken ?? null)}
                    />

                    <CredentialRow
                      label="Collaborator token"
                      value={activeWorker?.clientToken ?? null}
                      placeholder="Use refresh token"
                      hint="Routine remote access without owner-only actions."
                      canCopy={Boolean(activeWorker?.clientToken)}
                      copied={copiedField === "client-token"}
                      onCopy={() => void copyToClipboard("client-token", activeWorker?.clientToken ?? null)}
                    />

                    {!openworkDeepLink || !hasWorkspaceScopedUrl ? (
                      <p className="text-xs text-slate-500">
                        {!openworkDeepLink ? "Getting connection details ready..." : "Finishing your workspace URL..."}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
                  <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="text-lg font-bold tracking-tight text-slate-900">Worker runtime</h3>
                      <p className="text-sm text-slate-500">Compare installed runtime versions with the versions this worker should be running.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-[14px] border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void refreshRuntime(selectedWorker.workerId)}
                        disabled={runtimeBusy || runtimeUpgradeBusy}
                      >
                        {runtimeBusy ? "Checking..." : "Refresh runtime"}
                      </button>
                      <button
                        type="button"
                        className="rounded-[14px] bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void upgradeRuntime()}
                        disabled={runtimeUpgradeBusy || runtimeBusy || selectedStatusMeta.bucket !== "ready"}
                      >
                        {runtimeUpgradeBusy || runtimeSnapshot?.upgrade.status === "running" ? "Upgrading..." : "Upgrade runtime"}
                      </button>
                    </div>
                  </div>

                  {runtimeError ? <div className="mb-4 rounded-[14px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{runtimeError}</div> : null}

                  <div className="space-y-3">
                    {(runtimeSnapshot?.services ?? []).map((service) => (
                      <div key={service.name} className="flex flex-col gap-3 rounded-[18px] border border-[var(--dls-border)] bg-white px-4 py-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{getRuntimeServiceLabel(service.name)}</p>
                          <p className="text-xs text-slate-500">
                            Installed {service.actualVersion ?? "unknown"} · Target {service.targetVersion ?? "unknown"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
                          <span className={`rounded-full px-2.5 py-1 ${service.running ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                            {service.running ? "Running" : service.enabled ? "Stopped" : "Disabled"}
                          </span>
                          <span className={`rounded-full px-2.5 py-1 ${service.upgradeAvailable ? "bg-amber-100 text-amber-700" : "bg-slate-200 text-slate-600"}`}>
                            {service.upgradeAvailable ? "Upgrade available" : "Current"}
                          </span>
                        </div>
                      </div>
                    ))}
                    {!runtimeSnapshot && !runtimeBusy ? <p className="text-sm text-slate-500">Runtime details appear after the worker is reachable.</p> : null}
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold tracking-tight text-slate-900">Worker actions</h3>
                      <p className="text-sm text-slate-500">Refresh state, recover tokens, or replace the worker.</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void refreshWorkers({ keepSelection: true })}
                      disabled={workersBusy || actionBusy !== null}
                    >
                      {workersBusy ? "Refreshing..." : "Refresh list"}
                    </button>
                    <button
                      type="button"
                      className="rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void checkWorkerStatus({ workerId: selectedWorker.workerId })}
                      disabled={actionBusy !== null}
                    >
                      {actionBusy === "status" ? "Checking..." : "Check status"}
                    </button>
                    <button
                      type="button"
                      className="rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void generateWorkerToken()}
                      disabled={actionBusy !== null}
                    >
                      {actionBusy === "token" ? "Fetching..." : "Refresh token"}
                    </button>
                    <button
                      type="button"
                      className="rounded-[12px] border border-slate-200 bg-slate-900/5 px-3 py-2 text-xs font-semibold text-slate-900 transition hover:bg-slate-900/10 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void redeployWorker(selectedWorker.workerId)}
                      disabled={!isSelectedWorkerFailed || redeployBusyWorkerId !== null || deleteBusyWorkerId !== null || actionBusy !== null || launchBusy}
                    >
                      {redeployBusyWorkerId === selectedWorker.workerId ? "Redeploying..." : "Redeploy"}
                    </button>
                    <button
                      type="button"
                      className="rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void deleteWorker(selectedWorker.workerId)}
                      disabled={deleteBusyWorkerId !== null || redeployBusyWorkerId !== null || actionBusy !== null || launchBusy}
                    >
                      {deleteBusyWorkerId === selectedWorker.workerId ? "Deleting..." : "Delete worker"}
                    </button>
                  </div>
                </div>

                <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
                  <h3 className="text-lg font-bold tracking-tight text-slate-900">Recent activity</h3>
                  {events.length > 0 ? (
                    <ul className="mt-4 space-y-2">
                      {events.map((entry) => (
                        <li key={entry.id} className="rounded-[12px] border border-slate-100 bg-slate-50 px-3 py-3">
                          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-700">
                            <span>{entry.label}</span>
                            <span className="font-mono text-[10px] text-slate-500">{new Date(entry.at).toLocaleTimeString()}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-600">{entry.detail}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-4 text-sm text-slate-500">Actions and provisioning updates appear here.</p>
                  )}
                </div>

                <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
                  <h3 className="text-lg font-bold tracking-tight text-slate-900">Billing snapshot</h3>
                  <p className="mt-2 text-sm text-slate-600">
                    {billingSummary?.featureGateEnabled
                      ? billingSummary.hasActivePlan
                        ? "Your account has an active Den Cloud plan."
                        : "Your account needs billing before the next launch."
                      : "Billing gates are disabled in this environment."}
                  </p>
                  <Link
                    href="/checkout"
                    className="mt-4 inline-flex rounded-[12px] border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                  >
                    Open billing
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
            <div className="mx-auto max-w-[30rem] text-center">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">No workers yet</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">Create your first worker to unlock connection details and runtime controls.</p>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
