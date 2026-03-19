import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  ArrowUpRight,
  Cloud,
  CreditCard,
  LogOut,
  RefreshCcw,
  Server,
  Settings,
  Shield,
  Sparkles,
  UserCircle2,
} from "lucide-solid";
import Button from "../components/button";
import TextInput from "../components/text-input";
import { usePlatform } from "../context/platform";
import {
  formatDenIsoDate,
  formatDenMoneyMinor,
  formatDenRecurringInterval,
  formatDenSubscriptionStatus,
  denStatusBadgeClass,
  denWorkerStatusMeta,
} from "../features/den/formatters";
import { createDenFeatureState } from "../features/den/state";
import { getRuntimeServiceLabel } from "../lib/den";

export type CloudViewProps = {
  developerMode: boolean;
  openCloudSettings: () => void;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
};

type CloudRoute = "auth" | "dashboard" | "checkout" | "admin";

function routeButtonClass(active: boolean) {
  return active
    ? "bg-gray-12/10 text-white border-gray-6/30"
    : "text-gray-10 border-gray-6/50 hover:text-gray-12 hover:bg-gray-2/40";
}

export default function CloudView(props: CloudViewProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const platform = usePlatform();
  const state = createDenFeatureState({
    developerMode: () => props.developerMode,
    openLink: platform.openLink,
    connectRemoteWorkspace: props.connectRemoteWorkspace,
  });
  const [checkoutTokenHandled, setCheckoutTokenHandled] = createSignal<string | null>(
    null,
  );
  const [includeBillingDetails, setIncludeBillingDetails] = createSignal(true);

  const route = createMemo<CloudRoute>(() => {
    const path = location.pathname.toLowerCase();
    if (path === "/cloud/admin") return "admin";
    if (path === "/cloud/checkout") return "checkout";
    if (path === "/cloud/dashboard") return "dashboard";
    return "auth";
  });

  const customerSessionToken = createMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("customer_session_token")?.trim() ?? null;
  });

  createEffect(() => {
    const path = location.pathname.toLowerCase();
    if (!path.startsWith("/cloud")) return;
    if (
      path !== "/cloud" &&
      path !== "/cloud/dashboard" &&
      path !== "/cloud/checkout" &&
      path !== "/cloud/admin"
    ) {
      navigate("/cloud", { replace: true });
    }
  });

  createEffect(() => {
    if (location.pathname.toLowerCase() !== "/cloud") return;
    if (!state.isConfigured()) return;
    if (!state.isSignedIn()) return;
    if (state.desktopAuthRequested()) return;
    navigate(state.resolveLandingRoute(), { replace: true });
  });

  createEffect(() => {
    const token = customerSessionToken();
    if (!token) return;
    if (checkoutTokenHandled() === token) return;
    setCheckoutTokenHandled(token);
    void state.handleCheckoutReturn(token).then((target) => {
      navigate(target, { replace: true });
    });
  });

  const cloudTabs: Array<{ key: Exclude<CloudRoute, "auth">; label: string }> = [
    { key: "dashboard", label: "Dashboard" },
    { key: "checkout", label: "Billing" },
    { key: "admin", label: "Admin" },
  ];

  return (
    <section class="min-h-screen bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.12),transparent_40%),linear-gradient(180deg,rgba(248,250,252,0.95),rgba(241,245,249,0.9))] px-4 py-6 sm:px-6 lg:px-8">
      <div class="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div class="relative overflow-hidden rounded-[28px] border border-sky-7/20 bg-white/80 p-6 shadow-[0_24px_70px_-40px_rgba(15,23,42,0.35)] backdrop-blur">
          <div class="pointer-events-none absolute -right-16 top-0 h-40 w-40 rounded-full bg-sky-5/15 blur-3xl" />
          <div class="pointer-events-none absolute bottom-0 left-10 h-32 w-32 rounded-full bg-cyan-5/15 blur-3xl" />
          <div class="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div class="space-y-3">
              <div class="inline-flex items-center gap-2 rounded-full border border-sky-7/25 bg-sky-3/20 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-sky-11">
                <Cloud size={12} />
                OpenWork Cloud
              </div>
              <div class="space-y-2">
                <h1 class="text-2xl font-semibold tracking-tight text-gray-12 sm:text-3xl">
                  Launch, manage, and reconnect your Den workers from the main app.
                </h1>
                <p class="max-w-3xl text-sm leading-6 text-gray-10 sm:text-[15px]">
                  Cloud routes live inside OpenWork now. Configure a Den control plane, sign in, then launch workers and reconnect them with the same remote flow the desktop app already understands.
                </p>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${denStatusBadgeClass(state.summaryTone())}`}>
                <span class={`h-2 w-2 rounded-full ${state.summaryTone() === "ready" ? "bg-green-9" : state.summaryTone() === "warning" ? "bg-amber-9" : state.summaryTone() === "error" ? "bg-red-9" : "bg-gray-8"}`} />
                {state.summaryLabel()}
              </div>
              <Button variant="outline" class="h-9 px-3 text-xs" onClick={props.openCloudSettings}>
                <Settings size={14} />
                Cloud settings
              </Button>
            </div>
          </div>

          <Show when={state.statusMessage() && !state.authError() && !state.workersError() && !state.billingError() && !state.adminError()}>
            {(value) => (
              <div class="mt-4 rounded-xl border border-gray-6/60 bg-gray-1/70 px-4 py-3 text-sm text-gray-11">
                {value()}
              </div>
            )}
          </Show>
        </div>

        <Show when={state.isConfigured()}>
          <div class="flex flex-wrap gap-2 rounded-2xl border border-gray-6/40 bg-gray-1/40 px-3 py-2">
            <For each={cloudTabs}>
              {(tab) => (
                <button
                  class={`rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${routeButtonClass(route() === tab.key)}`}
                  onClick={() => navigate(`/cloud/${tab.key}`)}
                >
                  {tab.label}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={!state.isConfigured()}>
          <div class="rounded-[28px] border border-gray-7/60 bg-white/80 p-6 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="rounded-2xl border border-sky-7/25 bg-sky-3/20 p-3 text-sky-11">
                <Sparkles size={18} />
              </div>
              <div class="space-y-2">
                <div class="text-lg font-semibold text-gray-12">
                  {state.canEditBaseUrl() ? "Unlock Cloud locally" : "Cloud is unavailable in this build"}
                </div>
                <p class="max-w-2xl text-sm leading-6 text-gray-10">
                  {state.canEditBaseUrl()
                    ? "Open Cloud settings, save a Den control plane URL, and this route will unlock immediately on this device."
                    : "This build has no Den API URL configured. Enable developer mode or provide VITE_DEN_BASE_URL to surface Cloud features."}
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <Button variant="secondary" onClick={props.openCloudSettings}>
                    Open Cloud settings
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Show>

        <Show when={state.isConfigured()}>
          <Switch>
            <Match when={route() === "auth"}>
              <div class="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                  <div class="space-y-3">
                    <div class="inline-flex items-center gap-2 rounded-full border border-gray-6/60 bg-gray-1/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-10">
                      <UserCircle2 size={12} />
                      Cloud access
                    </div>
                    <h2 class="text-2xl font-semibold tracking-tight text-gray-12">
                      {state.authMode() === "sign-up"
                        ? "Create your OpenWork Cloud account."
                        : "Sign in to OpenWork Cloud."}
                    </h2>
                    <p class="text-sm leading-6 text-gray-10">
                      Direct email auth works inside the app. Social auth and browser handoff are also available when you want the full external flow.
                    </p>
                  </div>
                </div>

                <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                  <div class="space-y-4">
                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant={state.authMode() === "sign-in" ? "secondary" : "outline"}
                        class="h-9 px-3 text-xs"
                        onClick={() => state.setAuthMode("sign-in")}
                      >
                        Sign in
                      </Button>
                      <Button
                        variant={state.authMode() === "sign-up" ? "secondary" : "outline"}
                        class="h-9 px-3 text-xs"
                        onClick={() => state.setAuthMode("sign-up")}
                      >
                        Create account
                      </Button>
                    </div>

                    <div class="grid gap-3">
                      <TextInput
                        label="Email"
                        type="email"
                        value={state.email()}
                        onInput={(event) => state.setEmail(event.currentTarget.value)}
                        placeholder="you@example.com"
                        disabled={state.authBusy()}
                      />
                      <TextInput
                        label="Password"
                        type="password"
                        value={state.password()}
                        onInput={(event) => state.setPassword(event.currentTarget.value)}
                        placeholder="••••••••"
                        disabled={state.authBusy()}
                      />
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        disabled={state.authBusy()}
                        onClick={() => {
                          void state.submitEmailAuth().then((target) => {
                            if (target) navigate(target);
                          });
                        }}
                      >
                        {state.authBusy()
                          ? "Working..."
                          : state.authMode() === "sign-up"
                            ? "Create account"
                            : "Sign in"}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={state.authBusy()}
                        onClick={() => state.openBrowserAuth(state.authMode())}
                      >
                        Continue in browser
                        <ArrowUpRight size={13} />
                      </Button>
                    </div>

                    <div class="grid gap-2 border-t border-gray-6/60 pt-4">
                      <div class="text-xs font-medium uppercase tracking-[0.12em] text-gray-9">
                        Social auth
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={state.authBusy()}
                          onClick={() => void state.beginSocialAuth("github")}
                        >
                          Continue with GitHub
                        </Button>
                        <Button
                          variant="outline"
                          disabled={state.authBusy()}
                          onClick={() => void state.beginSocialAuth("google")}
                        >
                          Continue with Google
                        </Button>
                      </div>
                    </div>

                    <Show when={state.desktopAuthRequested()}>
                      <div class="rounded-2xl border border-sky-7/25 bg-sky-3/15 px-4 py-4 text-sm text-sky-11">
                        <div class="font-medium">Finish in OpenWork</div>
                        <div class="mt-1 text-sky-11/90">
                          Sign in here, then bounce back into the desktop app with a one-time handoff link.
                        </div>
                        <Show when={state.desktopRedirectUrl()}>
                          {(redirectAccessor) => (
                            <div class="mt-3 flex flex-wrap gap-2">
                              <Button variant="secondary" onClick={() => state.openDesktopRedirect()}>
                                Open OpenWork
                                <ArrowUpRight size={13} />
                              </Button>
                              <div class="self-center text-xs text-sky-11/80">{redirectAccessor()}</div>
                            </div>
                          )}
                        </Show>
                        <Show when={state.desktopRedirectBusy()}>
                          <div class="mt-3 text-xs text-sky-11/80">Preparing desktop handoff...</div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={state.authError()}>
                      {(value) => (
                        <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-4 py-3 text-sm text-red-11">
                          {value()}
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              </div>
            </Match>

            <Match when={route() === "dashboard"}>
              <Show
                when={state.isSignedIn()}
                fallback={
                  <div class="rounded-[28px] border border-gray-7/60 bg-white/80 p-6 shadow-sm">
                    <div class="space-y-3">
                      <div class="text-lg font-semibold text-gray-12">Sign in to continue</div>
                      <p class="text-sm text-gray-10">
                        Cloud dashboard routes need an active Den session.
                      </p>
                      <Button variant="secondary" onClick={() => navigate("/cloud")}>Go to Cloud auth</Button>
                    </div>
                  </div>
                }
              >
                <div class="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                  <div class="space-y-6">
                    <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div class="text-sm font-semibold text-gray-12">Account</div>
                          <div class="mt-1 text-sm text-gray-10">
                            {state.user()?.name || state.user()?.email}
                          </div>
                          <div class="text-xs text-gray-9">{state.user()?.email}</div>
                        </div>
                        <Button variant="outline" class="h-9 px-3 text-xs" onClick={() => void state.signOut()}>
                          <LogOut size={13} />
                          Sign out
                        </Button>
                      </div>
                    </div>

                    <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div class="text-sm font-semibold text-gray-12">Active org</div>
                          <div class="mt-1 text-xs text-gray-9">
                            Workers are listed from the selected org.
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          class="h-8 px-3 text-xs"
                          onClick={() => void state.refreshOrgs()}
                          disabled={state.orgsBusy()}
                        >
                          <RefreshCcw
                            size={13}
                            class={state.orgsBusy() ? "animate-spin" : ""}
                          />
                          Refresh orgs
                        </Button>
                      </div>
                      <div class="mt-4">
                        <label class="block">
                          <div class="mb-1 text-xs font-medium text-dls-secondary">Org</div>
                          <select
                            class="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                            value={state.activeOrgId()}
                            onChange={(event) => state.setActiveOrgId(event.currentTarget.value)}
                            disabled={state.orgsBusy() || state.orgs().length === 0}
                          >
                            <For each={state.orgs()}>
                              {(org) => (
                                <option value={org.id}>
                                  {org.name} {org.role === "owner" ? "(Owner)" : "(Member)"}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                      </div>
                      <Show when={state.orgsError()}>
                        {(value) => (
                          <div class="mt-3 rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                            {value()}
                          </div>
                        )}
                      </Show>
                    </div>

                    <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div class="text-sm font-semibold text-gray-12">Create Cloud worker</div>
                          <div class="mt-1 text-xs text-gray-9">
                            Launch a new cloud worker from the unified app experience.
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          class="h-9 px-3 text-xs"
                          disabled={state.workerActionBusy()}
                          onClick={() => {
                            void state.launchWorker().then((target) => {
                              if (target) navigate(target);
                            });
                          }}
                        >
                          <Sparkles size={14} />
                          {state.workerActionBusy() ? "Launching..." : "Launch worker"}
                        </Button>
                      </div>
                      <div class="mt-4">
                        <TextInput
                          label="Worker name"
                          value={state.workerName()}
                          onInput={(event) => state.setWorkerName(event.currentTarget.value)}
                          placeholder="My Worker"
                          disabled={state.workerActionBusy()}
                        />
                      </div>
                    </div>

                    <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div class="flex items-center gap-2 text-sm font-semibold text-gray-12">
                            <CreditCard size={15} />
                            Billing snapshot
                          </div>
                          <div class="mt-1 text-xs text-gray-9">
                            Quick access to checkout, invoices, and renewal state.
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => navigate("/cloud/checkout")}>Open billing</Button>
                          <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void state.refreshBilling()} disabled={state.billingBusy() || state.billingCheckoutBusy()}>
                            <RefreshCcw size={13} class={state.billingBusy() ? "animate-spin" : ""} />
                            Refresh
                          </Button>
                        </div>
                      </div>
                      <Show when={state.billingSummary()} fallback={<div class="mt-4 text-sm text-gray-10">Billing details will appear after your first refresh.</div>}>
                        {(summaryAccessor) => {
                          const summary = summaryAccessor();
                          return (
                            <div class="mt-4 space-y-2 text-sm text-gray-10">
                              <div class="font-medium text-gray-12">
                                {!summary.featureGateEnabled
                                  ? "Billing disabled"
                                  : summary.hasActivePlan
                                    ? "Active plan"
                                    : "Payment required"}
                              </div>
                              <div>
                                {summary.price && summary.price.amount !== null
                                  ? `${formatDenMoneyMinor(summary.price.amount, summary.price.currency)} ${formatDenRecurringInterval(summary.price.recurringInterval, summary.price.recurringIntervalCount)}`
                                  : "Current plan amount unavailable."}
                              </div>
                            </div>
                          );
                        }}
                      </Show>
                    </div>
                  </div>

                  <div class="space-y-6">
                    <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div class="flex items-center gap-2 text-sm font-semibold text-gray-12">
                            <Server size={15} />
                            Workers
                          </div>
                          <div class="mt-1 text-xs text-gray-9">
                            Select a worker to inspect runtime, open it in OpenWork, or manage lifecycle actions.
                          </div>
                        </div>
                        <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void state.refreshWorkers()} disabled={state.workersBusy() || !state.activeOrgId().trim()}>
                          <RefreshCcw size={13} class={state.workersBusy() ? "animate-spin" : ""} />
                          Refresh workers
                        </Button>
                      </div>

                      <Show when={state.workersError()}>
                        {(value) => (
                          <div class="mt-4 rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                            {value()}
                          </div>
                        )}
                      </Show>

                      <div class="mt-4 space-y-3">
                        <Show when={state.workers().length > 0} fallback={<div class="rounded-2xl border border-dashed border-gray-6/60 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">No Cloud workers are visible for this org yet.</div>}>
                          <For each={state.workers()}>
                            {(worker) => {
                              const meta = createMemo(() => denWorkerStatusMeta(worker.status));
                              return (
                                <button
                                  class={`w-full rounded-2xl border p-4 text-left transition-colors ${state.selectedWorkerId() === worker.workerId ? "border-sky-7/40 bg-sky-2/20" : "border-gray-6/60 bg-gray-1/40 hover:bg-gray-1/70"}`}
                                  onClick={() => state.selectWorker(worker.workerId)}
                                >
                                  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div class="space-y-1">
                                      <div class="flex flex-wrap items-center gap-2">
                                        <div class="text-sm font-medium text-gray-12">{worker.workerName}</div>
                                        <div class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${denStatusBadgeClass(meta().tone)}`}>
                                          {meta().label}
                                        </div>
                                      </div>
                                      <div class="text-xs text-gray-9">
                                        {worker.provider ? `${worker.provider} worker` : "Cloud worker"}
                                      </div>
                                    </div>
                                    <div class="flex flex-wrap gap-2">
                                      <Button
                                        variant="secondary"
                                        class="h-8 px-3 text-xs"
                                        disabled={!meta().canOpen || state.openingWorkerId() !== null}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void state.openWorker(worker.workerId);
                                        }}
                                      >
                                        {state.openingWorkerId() === worker.workerId ? "Opening..." : "Open"}
                                      </Button>
                                      <Button
                                        variant="outline"
                                        class="h-8 px-3 text-xs"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void state.redeployWorker(worker.workerId).then((target) => {
                                            if (target) navigate(target);
                                          });
                                        }}
                                        disabled={state.workerActionBusy()}
                                      >
                                        Redeploy
                                      </Button>
                                      <Button
                                        variant="danger"
                                        class="h-8 px-3 text-xs"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void state.deleteWorker(worker.workerId);
                                        }}
                                        disabled={state.workerActionBusy()}
                                      >
                                        Delete
                                      </Button>
                                    </div>
                                  </div>
                                </button>
                              );
                            }}
                          </For>
                        </Show>
                      </div>
                    </div>

                    <Show when={state.selectedWorker()}>
                      {(workerAccessor) => {
                        const worker = workerAccessor();
                        const meta = createMemo(() => denWorkerStatusMeta(worker.status));
                        return (
                          <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <div class="text-sm font-semibold text-gray-12">{worker.workerName}</div>
                                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-9">
                                  <span class={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${denStatusBadgeClass(meta().tone)}`}>{meta().label}</span>
                                  <span>{worker.provider || "Cloud worker"}</span>
                                  <Show when={worker.instanceUrl}><span>{worker.instanceUrl}</span></Show>
                                </div>
                              </div>
                              <div class="flex flex-wrap gap-2">
                                <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void state.refreshSelectedWorker()} disabled={state.workerActionBusy()}>
                                  Refresh status
                                </Button>
                                <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void state.refreshRuntime()} disabled={state.runtimeBusy()}>
                                  Runtime
                                </Button>
                              </div>
                            </div>

                            <Show when={state.runtimeError()}>
                              {(value) => <div class="mt-4 rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
                            </Show>

                            <Show when={state.runtimeSnapshot()} fallback={<div class="mt-4 text-sm text-gray-10">Load runtime details to inspect service versions and upgrades.</div>}>
                              {(runtimeAccessor) => {
                                const runtime = runtimeAccessor();
                                return (
                                  <div class="mt-4 space-y-3">
                                    <div class="grid gap-3 sm:grid-cols-3">
                                      <For each={runtime.services}>
                                        {(service) => (
                                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">{getRuntimeServiceLabel(service.name)}</div>
                                            <div class="mt-2 text-sm font-medium text-gray-12">
                                              {service.running ? "Running" : service.enabled ? "Installed" : "Unavailable"}
                                            </div>
                                            <div class="mt-1 text-xs text-gray-9">
                                              {service.actualVersion || service.targetVersion || "Version unavailable"}
                                            </div>
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                    <div class="flex flex-wrap gap-2">
                                      <Button variant="secondary" class="h-8 px-3 text-xs" onClick={() => void state.upgradeRuntime()} disabled={state.runtimeBusy()}>
                                        {state.runtimeBusy() ? "Updating..." : "Upgrade runtime"}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              }}
                            </Show>
                          </div>
                        );
                      }}
                    </Show>
                  </div>
                </div>
              </Show>
            </Match>

            <Match when={route() === "checkout"}>
              <Show
                when={state.isSignedIn()}
                fallback={
                  <div class="rounded-[28px] border border-gray-7/60 bg-white/80 p-6 shadow-sm">
                    <div class="space-y-3">
                      <div class="text-lg font-semibold text-gray-12">Sign in to view billing</div>
                      <p class="text-sm text-gray-10">
                        Cloud checkout and subscription management need an active Den session.
                      </p>
                      <Button variant="secondary" onClick={() => navigate("/cloud")}>Go to Cloud auth</Button>
                    </div>
                  </div>
                }
              >
                <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div class="text-xl font-semibold text-gray-12">Cloud billing</div>
                      <div class="mt-1 max-w-2xl text-sm text-gray-10">
                        Review plan state, open checkout or billing portal links, and manage your subscription from inside the app.
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => navigate("/cloud/dashboard")}>Back to dashboard</Button>
                      <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void state.refreshBilling({ includeCheckout: true })} disabled={state.billingBusy() || state.billingCheckoutBusy()}>
                        <RefreshCcw size={13} class={state.billingBusy() || state.billingCheckoutBusy() ? "animate-spin" : ""} />
                        Refresh billing
                      </Button>
                    </div>
                  </div>

                  <Show when={state.billingError()}>
                    {(value) => <div class="mt-4 rounded-xl border border-red-7/30 bg-red-1/40 px-4 py-3 text-sm text-red-11">{value()}</div>}
                  </Show>

                  <Show when={state.billingSummary()} fallback={<div class="mt-6 text-sm text-gray-10">Load billing to inspect Cloud plan state.</div>}>
                    {(summaryAccessor) => {
                      const summary = summaryAccessor();
                      return (
                        <div class="mt-6 space-y-6">
                        <div class="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-5 space-y-3">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Plan status</div>
                            <div class="text-2xl font-semibold text-gray-12">
                              {!summary.featureGateEnabled
                                ? "Billing disabled"
                                : summary.hasActivePlan
                                  ? "Active plan"
                                  : "Payment required"}
                            </div>
                            <div class="text-sm text-gray-10">
                              {!summary.featureGateEnabled
                                ? "Cloud billing gates are disabled in this environment."
                                : summary.hasActivePlan
                                  ? "This account can launch additional cloud workers right now."
                                  : "Complete checkout to unlock additional Cloud worker launches."}
                            </div>
                            <div class="text-sm font-medium text-gray-11">
                              {summary.price && summary.price.amount !== null
                                ? `${formatDenMoneyMinor(summary.price.amount, summary.price.currency)} ${formatDenRecurringInterval(summary.price.recurringInterval, summary.price.recurringIntervalCount)}`
                                : "Current plan amount is unavailable."}
                            </div>
                          </div>

                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-5 space-y-3">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Subscription</div>
                            <Show when={state.billingSubscription()} fallback={<div class="text-sm text-gray-10">No active subscription found yet.</div>}>
                              {(subscriptionAccessor) => {
                                const subscription = subscriptionAccessor();
                                return (
                                  <>
                                    <div class="text-lg font-semibold text-gray-12">{formatDenSubscriptionStatus(subscription.status)}</div>
                                    <div class="text-sm text-gray-10">
                                      {formatDenMoneyMinor(subscription.amount, subscription.currency)} {formatDenRecurringInterval(subscription.recurringInterval, subscription.recurringIntervalCount)}
                                    </div>
                                    <div class="text-xs text-gray-9">
                                      {subscription.cancelAtPeriodEnd
                                        ? `Cancels on ${formatDenIsoDate(subscription.currentPeriodEnd)}`
                                        : `Renews on ${formatDenIsoDate(subscription.currentPeriodEnd)}`}
                                    </div>
                                  </>
                                );
                              }}
                            </Show>
                          </div>
                        </div>

                        <div class="flex flex-wrap gap-2">
                          <Show when={state.billingCheckoutUrl()}>
                            {(checkoutUrl) => (
                              <Button variant="secondary" onClick={() => platform.openLink(checkoutUrl())}>
                                Continue checkout
                                <ArrowUpRight size={13} />
                              </Button>
                            )}
                          </Show>
                          <Show when={summary.portalUrl}>
                            {(portalUrl) => (
                              <Button variant="outline" onClick={() => platform.openLink(portalUrl())}>
                                Open billing portal
                                <ArrowUpRight size={13} />
                              </Button>
                            )}
                          </Show>
                          <Show when={state.billingSubscription()}>
                            {(subscriptionAccessor) => {
                              const subscription = subscriptionAccessor();
                              return (
                                <Button
                                  variant={subscription.cancelAtPeriodEnd ? "outline" : "secondary"}
                                  onClick={() => void state.updateSubscriptionCancellation(!subscription.cancelAtPeriodEnd)}
                                  disabled={state.billingSubscriptionBusy()}
                                >
                                  {state.billingSubscriptionBusy()
                                    ? "Updating..."
                                    : subscription.cancelAtPeriodEnd
                                      ? "Resume auto-renew"
                                      : "Cancel at period end"}
                                </Button>
                              );
                            }}
                          </Show>
                        </div>

                        <Show when={summary.invoices.length > 0}>
                          <div class="space-y-3">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Invoices</div>
                            <For each={summary.invoices}>
                              {(invoice) => (
                                <div class="flex flex-col gap-2 rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-3 md:flex-row md:items-center md:justify-between">
                                  <div>
                                    <div class="text-sm font-medium text-gray-12">
                                      {invoice.invoiceNumber || formatDenSubscriptionStatus(invoice.status)}
                                    </div>
                                    <div class="text-xs text-gray-9">
                                      {formatDenIsoDate(invoice.createdAt)} · {formatDenMoneyMinor(invoice.totalAmount, invoice.currency)} · {formatDenSubscriptionStatus(invoice.status)}
                                    </div>
                                  </div>
                                  <Show when={invoice.invoiceUrl}>
                                    {(invoiceUrl) => (
                                      <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => platform.openLink(invoiceUrl())}>
                                        Open invoice
                                        <ArrowUpRight size={13} />
                                      </Button>
                                    )}
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                        </div>
                      );
                    }}
                  </Show>
                </div>
              </Show>
            </Match>

            <Match when={route() === "admin"}>
              <Show
                when={state.isSignedIn()}
                fallback={
                  <div class="rounded-[28px] border border-gray-7/60 bg-white/80 p-6 shadow-sm">
                    <div class="space-y-3">
                      <div class="text-lg font-semibold text-gray-12">Sign in to view admin data</div>
                      <p class="text-sm text-gray-10">
                        Cloud admin screens need an authenticated Den session before they can check your access level.
                      </p>
                      <Button variant="secondary" onClick={() => navigate("/cloud")}>Go to Cloud auth</Button>
                    </div>
                  </div>
                }
              >
                <div class="rounded-[28px] border border-gray-7/60 bg-white/85 p-6 shadow-sm">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div class="flex items-center gap-2 text-xl font-semibold text-gray-12">
                        <Shield size={18} />
                        Cloud admin
                      </div>
                      <div class="mt-1 max-w-2xl text-sm text-gray-10">
                        Inspect Cloud users, worker counts, provider usage, and billing state when your account is on the admin allowlist.
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => setIncludeBillingDetails((value) => !value)}>
                        {includeBillingDetails() ? "Hide billing lookups" : "Include billing lookups"}
                      </Button>
                      <Button variant="secondary" class="h-8 px-3 text-xs" onClick={() => void state.refreshAdminOverview(includeBillingDetails())} disabled={state.adminBusy()}>
                        <RefreshCcw size={13} class={state.adminBusy() ? "animate-spin" : ""} />
                        Load admin overview
                      </Button>
                    </div>
                  </div>

                  <Show when={state.adminError()}>
                    {(value) => <div class="mt-4 rounded-xl border border-red-7/30 bg-red-1/40 px-4 py-3 text-sm text-red-11">{value()}</div>}
                  </Show>

                  <Show when={state.adminOverview()} fallback={<div class="mt-6 text-sm text-gray-10">Load the admin overview to inspect Cloud user and worker activity.</div>}>
                    {(overviewAccessor) => {
                      const overview = overviewAccessor();
                      return (
                        <div class="mt-6 space-y-6">
                        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Users</div>
                            <div class="mt-2 text-2xl font-semibold text-gray-12">{overview.summary.totalUsers}</div>
                            <div class="text-xs text-gray-9">{overview.summary.verifiedUsers} verified</div>
                          </div>
                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Workers</div>
                            <div class="mt-2 text-2xl font-semibold text-gray-12">{overview.summary.totalWorkers}</div>
                            <div class="text-xs text-gray-9">{overview.summary.cloudWorkers} cloud / {overview.summary.localWorkers} local</div>
                          </div>
                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Paid users</div>
                            <div class="mt-2 text-2xl font-semibold text-gray-12">{overview.summary.paidUsers ?? "-"}</div>
                            <div class="text-xs text-gray-9">Billing loaded: {overview.summary.billingLoaded ? "yes" : "no"}</div>
                          </div>
                          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                            <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Recent users</div>
                            <div class="mt-2 text-2xl font-semibold text-gray-12">{overview.summary.recentUsers7d}</div>
                            <div class="text-xs text-gray-9">{overview.summary.recentUsers30d} in the last 30 days</div>
                          </div>
                        </div>

                        <div class="overflow-hidden rounded-2xl border border-gray-6/60 bg-gray-1/40">
                          <div class="overflow-x-auto">
                            <table class="min-w-full divide-y divide-gray-6/60 text-left text-sm">
                              <thead class="bg-gray-2/70 text-xs uppercase tracking-[0.08em] text-gray-9">
                                <tr>
                                  <th class="px-4 py-3 font-medium">User</th>
                                  <th class="px-4 py-3 font-medium">Providers</th>
                                  <th class="px-4 py-3 font-medium">Workers</th>
                                  <th class="px-4 py-3 font-medium">Billing</th>
                                  <th class="px-4 py-3 font-medium">Last seen</th>
                                </tr>
                              </thead>
                              <tbody class="divide-y divide-gray-6/40 text-gray-11">
                                <For each={overview.users}>
                                  {(entry) => (
                                    <tr>
                                      <td class="px-4 py-3 align-top">
                                        <div class="font-medium text-gray-12">{entry.name || entry.email}</div>
                                        <div class="text-xs text-gray-9">{entry.email}</div>
                                      </td>
                                      <td class="px-4 py-3 align-top">
                                        <div class="text-xs text-gray-10">{entry.authProviders.join(", ") || "-"}</div>
                                      </td>
                                      <td class="px-4 py-3 align-top">
                                        <div>{entry.workerCount}</div>
                                        <div class="text-xs text-gray-9">{entry.cloudWorkerCount} cloud / {entry.localWorkerCount} local</div>
                                      </td>
                                      <td class="px-4 py-3 align-top">
                                        <div>{entry.billing ? formatDenSubscriptionStatus(entry.billing.status) : "-"}</div>
                                        <div class="text-xs text-gray-9">{entry.billing?.note || "No billing note"}</div>
                                      </td>
                                      <td class="px-4 py-3 align-top text-xs text-gray-9">
                                        {formatDenIsoDate(entry.lastSeenAt)}
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </div>
                        </div>
                      );
                    }}
                  </Show>
                </div>
              </Show>
            </Match>
          </Switch>
        </Show>
      </div>
    </section>
  );
}
