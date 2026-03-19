"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getWorkerStatusCopy, getWorkerStatusMeta } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

type IconProps = {
  className?: string;
};

function CubeIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M12 3 4.5 7v10L12 21l7.5-4V7L12 3Z" />
      <path d="M4.5 7 12 11l7.5-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function MonitorIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

function GlobeIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.4 2.6 3.6 5.6 3.6 9S14.4 18.4 12 21" />
      <path d="M12 3c-2.4 2.6-3.6 5.6-3.6 9S9.6 18.4 12 21" />
    </svg>
  );
}

function LockIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </svg>
  );
}

function TerminalIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

function ActivityIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M3 12h4l2.5-5 5 10 2.5-5H21" />
    </svg>
  );
}

function RefreshIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0 2 5.3" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function CredentialRow({
  label,
  value,
  placeholder,
  hint,
  canCopy,
  copied,
  onCopy,
  muted = false
}: {
  label: string;
  value: string | null;
  placeholder: string;
  hint?: string;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
  muted?: boolean;
}) {
  return (
    <label className="grid gap-2">
      <span className="px-0.5 text-[0.67rem] font-bold uppercase tracking-[0.11em] text-slate-500">{label}</span>
      <div className={`flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-1.5 ${muted ? "opacity-75" : ""}`}>
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

function SkeletonBar({ widthClass }: { widthClass: string }) {
  return <div className={`h-11 rounded-xl bg-slate-200/70 ${widthClass}`} aria-hidden="true" />;
}

function ProvisioningGraphic({ ready }: { ready: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-[22px] border border-gray-100 bg-gray-50/80 p-6">
      <div className="pointer-events-none absolute -right-8 -top-8 text-slate-900/5" aria-hidden="true">
        <CubeIcon className="h-44 w-44" />
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center gap-6">
        <div className="flex items-center gap-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm">
            <CubeIcon className="h-6 w-6 text-slate-400" />
          </div>

          <div className="flex w-32 flex-col gap-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full w-1/2 rounded-full ${ready ? "bg-emerald-400" : "animate-[pulse_1.5s_ease-in-out_infinite] bg-amber-400"}`} />
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full w-2/3 rounded-full ${ready ? "bg-emerald-300" : "animate-[pulse_1.5s_ease-in-out_0.4s_infinite] bg-amber-300"}`} />
            </div>
          </div>

          <div className="relative flex h-14 w-14 items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm">
            <MonitorIcon className={ready ? "h-6 w-6 text-emerald-500" : "h-6 w-6 text-amber-500"} />
            <span className={`absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white ${ready ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
          <RefreshIcon className={ready ? "h-4 w-4 text-emerald-500" : "h-4 w-4 animate-spin text-amber-500"} />
          <span>{ready ? "Connection details are ready to use." : "Allocating resources and configuring your worker..."}</span>
        </div>
      </div>
    </div>
  );
}

function SectionBadge({
  icon,
  title,
  body,
  dimmed = false
}: {
  icon: ReactNode;
  title: string;
  body: string;
  dimmed?: boolean;
}) {
  return (
    <div className={`rounded-[28px] border border-gray-200 p-8 shadow-sm ${dimmed ? "bg-gray-50/60 grayscale-[0.25] opacity-70" : "bg-white"}`}>
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-slate-500 shadow-sm">{icon}</div>
        <h3 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h3>
      </div>
      <p className="text-[15px] leading-relaxed text-gray-500">{body}</p>
    </div>
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
    selectedWorker,
    activeWorker,
    selectWorker,
    launchBusy,
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
    selectedStatusMeta,
    isSelectedWorkerFailed,
    ownedWorkerCount,
    billingSummary,
    refreshWorkers,
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

  const currentWorker = activeWorker ?? (selectedWorker ? { workerName: selectedWorker.workerName, status: selectedWorker.status } : null);
  const isReady = selectedStatusMeta.bucket === "ready";
  const isStarting = selectedStatusMeta.bucket === "starting";
  const webDisabled = !openworkAppConnectUrl || !isReady;
  const desktopDisabled = !openworkDeepLink || !isReady;
  const showConnectionHint = !openworkDeepLink || !hasWorkspaceScopedUrl;

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[32px] border border-white/70 bg-[#f3f4f6]/95 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.2)] md:min-h-[calc(100vh-8.5rem)] md:flex-row">
      <aside className="order-2 w-full shrink-0 border-t border-gray-200 bg-[#f9fafb] md:order-1 md:w-[280px] md:border-r md:border-t-0">
        <div className="flex h-full flex-col justify-between gap-4 p-4 md:gap-6 md:p-6">
          <div className="flex flex-col gap-4 md:gap-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#011627] text-white">
                  <CubeIcon className="h-4 w-4" />
                </div>
                <span className="text-lg font-semibold tracking-tight text-[#011627]">OpenWork</span>
              </div>
              <button
                type="button"
                className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-gray-50"
                onClick={() => void signOut()}
              >
                Log out
              </button>
            </div>

            <div className="flex flex-col gap-3 md:gap-4">
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">Dashboard</div>
                <span className="text-lg font-medium text-[#011627] md:text-xl">Workers</span>
              </div>

              <nav className="flex flex-col gap-1.5 md:gap-2">
                {filteredWorkers.map((item) => {
                  const meta = getWorkerStatusMeta(item.status);
                  const selected = selectedWorker?.workerId === item.workerId;
                  return (
                    <button
                      key={item.workerId}
                      type="button"
                      onClick={() => selectWorker(item)}
                      className={`flex items-center justify-between rounded-2xl border px-3.5 py-3 text-left transition-colors md:px-4 ${
                        selected
                          ? "border-blue-100 bg-blue-50"
                          : "border-transparent bg-transparent hover:border-gray-200 hover:bg-white"
                      }`}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className={`truncate text-sm font-semibold ${selected ? "text-blue-950" : "text-slate-800"}`}>{item.workerName}</span>
                        <span className={`text-xs ${selected ? "text-blue-600" : "text-gray-500"}`}>{meta.label}</span>
                      </span>
                      {item.isMine ? (
                        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${selected ? "bg-blue-100 text-blue-500" : "bg-slate-100 text-slate-500"}`}>
                          Yours
                        </span>
                      ) : null}
                    </button>
                  );
                })}

                <Link
                  href="/checkout"
                  className="rounded-2xl px-4 py-3 text-left text-sm font-medium text-gray-600 transition-colors hover:bg-white hover:text-[#011627]"
                >
                  Billing
                </Link>
              </nav>
            </div>

            {workersBusy ? <p className="text-xs text-slate-500">Loading workers...</p> : null}
            {workersError ? <p className="text-xs font-medium text-rose-600">{workersError}</p> : null}
            {workers.length === 0 && !workersBusy ? <p className="text-xs text-slate-500">No workers yet. Create one to get started.</p> : null}
          </div>

            <div className="text-xs text-gray-500 md:text-sm">
              Signed in as <span className="font-medium text-[#011627]">{user.email}</span>
              <div className="mt-2 text-xs text-slate-400">
                {billingSummary?.featureGateEnabled && !billingSummary.hasActivePlan
                  ? "Billing required before the next launch."
                  : `${ownedWorkerCount} worker${ownedWorkerCount === 1 ? "" : "s"} in your account.`}
            </div>
          </div>
        </div>
      </aside>

      <main className="order-1 min-h-0 flex-1 overflow-y-auto bg-[#f3f4f6] md:order-2">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 md:gap-6 md:p-12">
          {selectedWorker ? (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">Overview</div>
                  <h1 className="text-2xl font-semibold tracking-tight text-[#011627] md:text-3xl">{currentWorker?.workerName ?? selectedWorker.workerName}</h1>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm md:rounded-[32px] md:p-10">
                <div className="pointer-events-none absolute -right-10 -top-10 text-slate-900/[0.03]" aria-hidden="true">
                  <CubeIcon className="h-[15rem] w-[15rem]" />
                </div>

                <div className="relative z-10 flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
                  <div className="flex max-w-xl flex-col gap-6">
                    <div className="flex items-center gap-3">
                      <div className="relative flex h-3 w-3">
                        <span className={`absolute inline-flex h-full w-full rounded-full ${isReady ? "bg-emerald-400/60" : "animate-ping bg-amber-400/70"}`} />
                        <span className={`relative inline-flex h-3 w-3 rounded-full ${isReady ? "bg-emerald-500" : "bg-amber-500"}`} />
                      </div>
                      <h2 className="text-xl font-semibold tracking-tight text-[#011627] md:text-2xl">
                        {isReady ? "Your worker is ready." : isStarting ? "Provisioning in the background" : currentWorker ? getWorkerStatusCopy(currentWorker.status) : "Preparing worker"}
                      </h2>
                    </div>

                    <p className="text-[16px] leading-relaxed text-gray-600 md:text-[17px]">
                      {isReady
                        ? "Open the worker in web or desktop, or copy the live credentials below."
                        : "We are allocating resources and preparing the OpenWork connection before unlocking the rest of the controls."}
                    </p>

                    <ProvisioningGraphic ready={isReady} />
                  </div>

                  <div className="flex w-full flex-col gap-3 md:w-[200px] md:shrink-0 md:items-end">
                    {openworkAppConnectUrl ? (
                      <a
                        href={openworkAppConnectUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={`flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-base font-medium shadow-md transition-all md:min-h-[52px] md:text-sm ${
                          webDisabled ? "pointer-events-none border border-gray-200 bg-white text-gray-400 shadow-sm" : "bg-[#011627] text-white hover:bg-black"
                        }`}
                        aria-disabled={webDisabled}
                      >
                        <GlobeIcon className="h-[18px] w-[18px]" />
                        {webDisabled ? "Preparing web access" : "Open in Web"}
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-6 py-3.5 font-medium text-gray-400 shadow-sm"
                      >
                        <GlobeIcon className="h-[18px] w-[18px]" />
                        Preparing web access
                      </button>
                    )}

                    <div className="hidden w-full flex-col items-center md:flex">
                      <button
                        type="button"
                        className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${
                          desktopDisabled ? "border border-gray-200 bg-white text-gray-400 shadow-sm" : "border border-gray-200 bg-white text-gray-600 shadow-sm hover:bg-gray-50 hover:text-[#011627]"
                        }`}
                        onClick={() => {
                          if (!desktopDisabled && openworkDeepLink) {
                            window.location.href = openworkDeepLink;
                          }
                        }}
                        disabled={desktopDisabled}
                      >
                        <MonitorIcon className="h-4 w-4" />
                        {desktopDisabled ? "Preparing desktop launch" : "Open in Desktop"}
                      </button>
                      <span className="mt-2 text-[11px] font-medium text-gray-400">requires the OpenWork desktop app</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <div className={`rounded-[28px] border border-gray-200 shadow-sm transition-all ${isReady ? "bg-white" : "bg-gray-50/60 opacity-80"}`}>
                  <details className="group" open>
                    <summary className="flex cursor-pointer list-none items-center justify-between p-8 outline-none [&::-webkit-details-marker]:hidden">
                      <div>
                        <div className="mb-4 flex items-center gap-3">
                          <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-slate-500 shadow-sm">
                            <LockIcon className="h-[18px] w-[18px]" />
                          </div>
                          <h3 className="text-xl font-semibold tracking-tight text-slate-900">Connection details</h3>
                        </div>
                        <p className="text-[15px] leading-relaxed text-gray-500">
                          Connect now or copy manual credentials for another client.
                        </p>
                      </div>
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-400 transition-transform group-open:rotate-180">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 4 4 4 4-4"/></svg>
                      </div>
                    </summary>
                    
                    <div className="px-8 pb-8 pt-0">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-[16px] bg-[#011627] px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(15,23,42,0.14)] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => {
                            if (openworkDeepLink) {
                              window.location.href = openworkDeepLink;
                            }
                          }}
                          disabled={!openworkDeepLink || !isReady}
                        >
                          {openworkDeepLink ? "Open in Desktop" : "Preparing connection..."}
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

                      <div className="mt-6 space-y-4">
                        <CredentialRow
                          label="Connection URL"
                          value={activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null}
                          placeholder="Connection URL is still preparing..."
                          hint={showConnectionHint ? (!openworkDeepLink ? "Getting connection details ready..." : "Finishing your workspace URL...") : undefined}
                          canCopy={Boolean(activeWorker?.openworkUrl ?? activeWorker?.instanceUrl)}
                          copied={copiedField === "openwork-url"}
                          onCopy={() => void copyToClipboard("openwork-url", activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null)}
                          muted={!isReady}
                        />

                        <CredentialRow
                          label="Owner token"
                          value={activeWorker?.ownerToken ?? null}
                          placeholder="Use refresh token"
                          hint="Use this token when the remote client must answer permission prompts."
                          canCopy={Boolean(activeWorker?.ownerToken)}
                          copied={copiedField === "owner-token"}
                          onCopy={() => void copyToClipboard("owner-token", activeWorker?.ownerToken ?? null)}
                          muted={!isReady}
                        />

                        <CredentialRow
                          label="Collaborator token"
                          value={activeWorker?.clientToken ?? null}
                          placeholder="Use refresh token"
                          hint="Routine remote access without owner-only actions."
                          canCopy={Boolean(activeWorker?.clientToken)}
                          copied={copiedField === "client-token"}
                          onCopy={() => void copyToClipboard("client-token", activeWorker?.clientToken ?? null)}
                          muted={!isReady}
                        />
                      </div>
                    </div>
                  </details>
                </div>

                <div className="flex flex-col gap-6">
                  <div className={`rounded-[28px] border border-gray-200 shadow-sm transition-all ${isReady ? "bg-white" : "bg-gray-50/60 opacity-80"}`}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center justify-between p-8 outline-none [&::-webkit-details-marker]:hidden">
                        <div>
                          <div className="mb-4 flex items-center gap-3">
                            <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-slate-500 shadow-sm">
                              <ActivityIcon className="h-[18px] w-[18px]" />
                            </div>
                            <h3 className="text-xl font-semibold tracking-tight text-slate-900">Worker actions</h3>
                          </div>
                          <p className="text-[15px] leading-relaxed text-gray-500">
                            Refresh state, recover tokens, or replace the worker. Controls unlock as the worker becomes reachable.
                          </p>
                        </div>
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-400 transition-transform group-open:rotate-180">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 4 4 4 4-4"/></svg>
                        </div>
                      </summary>
                      
                      <div className="px-8 pb-8 pt-0">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void refreshWorkers({ keepSelection: true })}
                            disabled={workersBusy || actionBusy !== null}
                          >
                            {workersBusy ? "Refreshing..." : "Refresh list"}
                          </button>
                          <button
                            type="button"
                            className="rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void checkWorkerStatus({ workerId: selectedWorker.workerId })}
                            disabled={actionBusy !== null}
                          >
                            {actionBusy === "status" ? "Checking..." : "Check status"}
                          </button>
                          <button
                            type="button"
                            className="rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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
                            className="rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void deleteWorker(selectedWorker.workerId)}
                            disabled={deleteBusyWorkerId !== null || redeployBusyWorkerId !== null || actionBusy !== null || launchBusy}
                          >
                            {deleteBusyWorkerId === selectedWorker.workerId ? "Deleting..." : "Delete worker"}
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>

                  <div className={`rounded-[28px] border border-gray-200 shadow-sm transition-all ${isReady ? "bg-white" : "bg-gray-50/60 opacity-80"}`}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center justify-between p-8 outline-none [&::-webkit-details-marker]:hidden">
                        <div>
                          <div className="mb-4 flex items-center gap-3">
                            <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-slate-500 shadow-sm">
                              <TerminalIcon className="h-[18px] w-[18px]" />
                            </div>
                            <h3 className="text-xl font-semibold tracking-tight text-slate-900">Worker runtime</h3>
                          </div>
                          <p className="text-[15px] leading-relaxed text-gray-500">
                            Compare installed runtime versions with the versions this worker should be running.
                          </p>
                        </div>
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-400 transition-transform group-open:rotate-180">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 4 4 4 4-4"/></svg>
                        </div>
                      </summary>

                      <div className="px-8 pb-8 pt-0">
                        <div className="mb-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void refreshRuntime(selectedWorker.workerId)}
                            disabled={runtimeBusy || runtimeUpgradeBusy}
                          >
                            {runtimeBusy ? "Checking..." : "Refresh runtime"}
                          </button>
                          <button
                            type="button"
                            className="rounded-[12px] bg-[#011627] px-3 py-2 text-xs font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void upgradeRuntime()}
                            disabled={runtimeUpgradeBusy || runtimeBusy || !isReady}
                          >
                            {runtimeUpgradeBusy || runtimeSnapshot?.upgrade.status === "running" ? "Upgrading..." : "Upgrade runtime"}
                          </button>
                        </div>

                        {runtimeError ? <div className="mb-4 rounded-[14px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{runtimeError}</div> : null}

                        <div className="space-y-3">
                          {(runtimeSnapshot?.services ?? []).map((service) => (
                            <div key={service.name} className="rounded-[18px] border border-slate-200 bg-white px-4 py-3">
                              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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
                            </div>
                          ))}

                          {!runtimeSnapshot && !runtimeBusy ? (
                            <div className="space-y-3">
                              <SkeletonBar widthClass="w-full" />
                              <SkeletonBar widthClass="w-4/5" />
                              <p className="text-sm text-slate-500">Runtime details appear after the worker is reachable.</p>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </details>
                  </div>

                  <SectionBadge
                    icon={<ActivityIcon className="h-[18px] w-[18px]" />}
                    title="Recent activity"
                    body={events.length > 0 ? `${events[0]?.label ?? "Activity"}: ${events[0]?.detail ?? "Waiting for updates."}` : "Actions and provisioning updates appear here as they happen."}
                    dimmed={false}
                  />

                  <div className="rounded-[28px] border border-gray-200 bg-white p-8 shadow-sm">
                    <div className="mb-4 flex items-center gap-3">
                      <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-slate-500 shadow-sm">
                        <GlobeIcon className="h-[18px] w-[18px]" />
                      </div>
                      <h3 className="text-xl font-semibold tracking-tight text-slate-900">Billing snapshot</h3>
                    </div>
                    <p className="text-[15px] leading-relaxed text-gray-500">
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
            </>
          ) : (
            <div className="rounded-[24px] border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mx-auto max-w-[30rem] text-center">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-900">No workers yet</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">Create your first worker to unlock connection details and runtime controls.</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </section>
  );
}
