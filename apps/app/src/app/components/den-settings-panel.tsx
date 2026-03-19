import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { ArrowUpRight, Cloud, CreditCard, LogOut, RefreshCcw, Server, Users } from "lucide-solid";
import Button from "./button";
import TextInput from "./text-input";
import {
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenBillingSummary,
  createDenClient,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../lib/den";
import { isDesktopDeployment } from "../lib/openwork-deployment";
import { usePlatform } from "../context/platform";

type DenSettingsPanelProps = {
  developerMode: boolean;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
};

function statusBadgeClass(kind: "ready" | "warning" | "neutral" | "error") {
  switch (kind) {
    case "ready":
      return "border-green-7/30 bg-green-3/20 text-green-11";
    case "warning":
      return "border-amber-7/30 bg-amber-3/20 text-amber-11";
    case "error":
      return "border-red-7/30 bg-red-3/20 text-red-11";
    default:
      return "border-gray-6/60 bg-gray-3/20 text-gray-11";
  }
}

function workerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: "Ready", tone: "ready" as const, canOpen: true };
    case "provisioning":
      return { label: "Provisioning", tone: "warning" as const, canOpen: false };
    case "failed":
      return { label: "Failed", tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "Unknown",
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

function formatMoneyMinor(amount: number | null, currency: string | null): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Not available";
  }

  const normalizedCurrency = (currency ?? "USD").toUpperCase();
  const majorValue = amount / 100;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
    }).format(majorValue);
  } catch {
    return `${majorValue.toFixed(2)} ${normalizedCurrency}`;
  }
}

function formatIsoDate(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }
    return date.toLocaleDateString();
  } catch {
    return "Not available";
  }
}

function formatRecurringInterval(interval: string | null, count: number | null): string {
  if (!interval) {
    return "billing cycle";
  }

  const normalizedInterval = interval.replace(/_/g, " ");
  const normalizedCount = typeof count === "number" && Number.isFinite(count) ? count : 1;
  if (normalizedCount <= 1) {
    return `per ${normalizedInterval}`;
  }

  const pluralSuffix = normalizedInterval.endsWith("s") ? "" : "s";
  return `every ${normalizedCount} ${normalizedInterval}${pluralSuffix}`;
}

function formatSubscriptionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export default function DenSettingsPanel(props: DenSettingsPanelProps) {
  const platform = usePlatform();
  const initial = readDenSettings();
  const initialBaseUrl = props.developerMode ? initial.baseUrl || DEFAULT_DEN_BASE_URL : DEFAULT_DEN_BASE_URL;

  const [baseUrl, setBaseUrl] = createSignal(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = createSignal(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = createSignal<string | null>(null);
  const [authToken, setAuthToken] = createSignal(initial.authToken?.trim() || "");
  const [activeOrgId, setActiveOrgId] = createSignal(initial.activeOrgId?.trim() || "");
  const [authBusy, setAuthBusy] = createSignal(false);
  const [sessionBusy, setSessionBusy] = createSignal(false);
  const [orgsBusy, setOrgsBusy] = createSignal(false);
  const [workersBusy, setWorkersBusy] = createSignal(false);
  const [billingBusy, setBillingBusy] = createSignal(false);
  const [billingCheckoutBusy, setBillingCheckoutBusy] = createSignal(false);
  const [billingSubscriptionBusy, setBillingSubscriptionBusy] = createSignal(false);
  const [openingWorkerId, setOpeningWorkerId] = createSignal<string | null>(null);
  const [user, setUser] = createSignal<{ id: string; email: string; name: string | null } | null>(null);
  const [orgs, setOrgs] = createSignal<Array<{ id: string; name: string; slug: string; role: "owner" | "member" }>>([]);
  const [workers, setWorkers] = createSignal<
    Array<{
      workerId: string;
      workerName: string;
      status: string;
      instanceUrl: string | null;
      provider: string | null;
      isMine: boolean;
      createdAt: string | null;
    }>
  >([]);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [orgsError, setOrgsError] = createSignal<string | null>(null);
  const [workersError, setWorkersError] = createSignal<string | null>(null);
  const [billingSummary, setBillingSummary] = createSignal<DenBillingSummary | null>(null);
  const [billingError, setBillingError] = createSignal<string | null>(null);

  const activeOrg = createMemo(() => orgs().find((org) => org.id === activeOrgId()) ?? null);
  const client = createMemo(() => createDenClient({ baseUrl: baseUrl(), token: authToken() }));
  const isSignedIn = createMemo(() => Boolean(user() && authToken().trim()));
  const billingSubscription = createMemo(() => billingSummary()?.subscription ?? null);
  const billingCheckoutUrl = createMemo(() => billingSummary()?.checkoutUrl ?? null);
  const summaryTone = createMemo(() => {
    if (authError() || workersError() || orgsError() || billingError()) return "error" as const;
    if (sessionBusy() || orgsBusy() || workersBusy() || billingBusy() || billingCheckoutBusy() || billingSubscriptionBusy()) return "warning" as const;
    if (isSignedIn()) return "ready" as const;
    return "neutral" as const;
  });
  const summaryLabel = createMemo(() => {
    if (authError()) return "Needs attention";
    if (billingError()) return "Billing issue";
    if (sessionBusy()) return "Checking session";
    if (isSignedIn()) return "Connected";
    return "Signed out";
  });

  createEffect(() => {
    writeDenSettings({
      baseUrl: props.developerMode ? baseUrl() : DEFAULT_DEN_BASE_URL,
      authToken: authToken() || null,
      activeOrgId: activeOrgId() || null,
    });
  });

  createEffect(() => {
    if (!props.developerMode) {
      setBaseUrl(DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      setBaseUrlError(null);
    }
  });

  const openControlPlane = () => {
    platform.openLink(resolveDenBaseUrls(baseUrl()).baseUrl);
  };

  const openBrowserAuth = (mode: "sign-in" | "sign-up") => {
    const target = new URL(resolveDenBaseUrls(baseUrl()).baseUrl);
    target.searchParams.set("mode", mode);
    if (isDesktopDeployment()) {
      target.searchParams.set("desktopAuth", "1");
      target.searchParams.set("desktopScheme", "openwork");
    }
    platform.openLink(target.toString());
    setStatusMessage(mode === "sign-up" ? "Finish account creation in your browser to connect OpenWork." : "Finish signing in in your browser to connect OpenWork.");
    setAuthError(null);
  };

  const clearSessionState = () => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setBillingSummary(null);
    setActiveOrgId("");
    setOrgsError(null);
    setWorkersError(null);
    setBillingError(null);
    setBillingBusy(false);
    setBillingCheckoutBusy(false);
    setBillingSubscriptionBusy(false);
  };

  const openExternalUrl = (url: string | null | undefined) => {
    const normalized = (url ?? "").trim();
    if (!normalized) {
      return;
    }
    platform.openLink(normalized);
  };

  const clearSignedInState = (message?: string | null) => {
    clearDenSession({ includeBaseUrls: !props.developerMode });
    if (!props.developerMode) {
      setBaseUrl(DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
    }
    setAuthToken("");
    setOpeningWorkerId(null);
    clearSessionState();
    setBaseUrlError(null);
    setAuthError(null);
    setStatusMessage(message ?? null);
  };

  const applyBaseUrl = () => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft());
    if (!normalized) {
      setBaseUrlError("Enter a valid http:// or https:// Den control plane URL.");
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);

    setBaseUrlError(null);
    if (resolved.baseUrl === baseUrl()) {
      setBaseUrlDraft(resolved.baseUrl);
      return;
    }

    setBaseUrl(resolved.baseUrl);
    setBaseUrlDraft(resolved.baseUrl);
    clearSignedInState("Updated the Den control plane URL. Sign in again to continue.");
  };

  const refreshOrgs = async (quiet = false) => {
    if (!authToken().trim()) {
      setOrgs([]);
      setActiveOrgId("");
      return;
    }

    setOrgsBusy(true);
    if (!quiet) {
      setOrgsError(null);
    }

    try {
      const response = await client().listOrgs();
      setOrgs(response.orgs);
      const current = activeOrgId().trim();
      const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
      const next = response.orgs.some((org) => org.id === current) ? current : fallback;
      setActiveOrgId(next);
      if (!quiet && response.orgs.length > 0) {
        setStatusMessage(`Loaded ${response.orgs.length} org${response.orgs.length === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load orgs.";
      setOrgsError(message);
    } finally {
      setOrgsBusy(false);
    }
  };

  const refreshWorkers = async (quiet = false) => {
    const orgId = activeOrgId().trim();
    if (!authToken().trim() || !orgId) {
      setWorkers([]);
      return;
    }

    setWorkersBusy(true);
    if (!quiet) {
      setWorkersError(null);
    }

    try {
      const nextWorkers = await client().listWorkers(orgId, 20);
      setWorkers(nextWorkers);
      if (!quiet) {
        setStatusMessage(
          nextWorkers.length > 0
            ? `Loaded ${nextWorkers.length} worker${nextWorkers.length === 1 ? "" : "s"} for ${activeOrg()?.name ?? "this org"}.`
            : `No workers found for ${activeOrg()?.name ?? "this org"}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load workers.";
      setWorkersError(message);
    } finally {
      setWorkersBusy(false);
    }
  };

  const refreshBilling = async (options: { quiet?: boolean; includeCheckout?: boolean } = {}) => {
    if (!authToken().trim()) {
      setBillingSummary(null);
      return null;
    }

    const quiet = options.quiet === true;
    if (options.includeCheckout) {
      setBillingCheckoutBusy(true);
    } else {
      setBillingBusy(true);
    }
    if (!quiet) {
      setBillingError(null);
    }

    try {
      const summary = await client().getBillingStatus({ includeCheckout: options.includeCheckout });
      setBillingSummary(summary);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load billing.";
      if (!quiet) {
        setBillingError(message);
      }
      return null;
    } finally {
      if (options.includeCheckout) {
        setBillingCheckoutBusy(false);
      } else {
        setBillingBusy(false);
      }
    }
  };

  const handleSubscriptionCancellation = async (cancelAtPeriodEnd: boolean) => {
    if (!user() || billingSubscriptionBusy()) {
      return;
    }

    if (cancelAtPeriodEnd && typeof window !== "undefined") {
      const confirmed = window.confirm("Cancel subscription at period end? You can still use your current billing period.");
      if (!confirmed) {
        return;
      }
    }

    setBillingSubscriptionBusy(true);
    setBillingError(null);

    try {
      const next = await client().updateSubscriptionCancellation(cancelAtPeriodEnd);
      setBillingSummary(next.billing);
      setStatusMessage(cancelAtPeriodEnd ? "Subscription will cancel at period end." : "Subscription auto-renew resumed.");
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : "Failed to update subscription.");
    } finally {
      setBillingSubscriptionBusy(false);
    }
  };

  createEffect(() => {
    const token = authToken().trim();
    const currentBaseUrl = baseUrl();
    let cancelled = false;

    if (!token) {
      setSessionBusy(false);
      clearSessionState();
      setAuthError(null);
      return;
    }

    setSessionBusy(true);
    setAuthError(null);

    void createDenClient({ baseUrl: currentBaseUrl, token })
      .getSession()
      .then((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setStatusMessage(`Signed in as ${nextUser.email}.`);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(error instanceof Error ? error.message : "No active Den session found.");
      })
      .finally(() => {
        if (!cancelled) {
          setSessionBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  });

  createEffect(() => {
    if (!user()) {
      return;
    }
    void refreshOrgs(true);
  });

  createEffect(() => {
    if (!user() || !activeOrgId().trim()) {
      return;
    }
    void refreshWorkers(true);
  });

  createEffect(() => {
    if (!user()) {
      return;
    }
    void refreshBilling({ quiet: true });
  });

  createEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ status?: string; email?: string | null; message?: string | null }>;
      const nextSettings = readDenSettings();
      setBaseUrl(nextSettings.baseUrl || DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(nextSettings.baseUrl || DEFAULT_DEN_BASE_URL);
      setAuthToken(nextSettings.authToken?.trim() || "");
      setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
      if (customEvent.detail?.status === "success") {
        setAuthError(null);
        setStatusMessage(
          customEvent.detail.email?.trim()
            ? `Connected OpenWork Den as ${customEvent.detail.email.trim()}.`
            : "Connected OpenWork Den.",
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(customEvent.detail.message?.trim() || "Failed to finish OpenWork Den sign-in.");
      }
    };

    window.addEventListener("openwork-den-session-updated", handler as EventListener);
    return () => window.removeEventListener("openwork-den-session-updated", handler as EventListener);
  });

  const signOut = async () => {
    if (authBusy()) {
      return;
    }

    setAuthBusy(true);
    try {
      if (authToken().trim()) {
        await client().signOut();
      }
    } catch {
      // Ignore remote sign-out failures and clear local state anyway.
    } finally {
      setAuthBusy(false);
    }

    clearSignedInState("Signed out and cleared your OpenWork Den session on this device.");
  };

  const handleOpenWorker = async (workerId: string, workerName: string) => {
    const orgId = activeOrgId().trim();
    if (!orgId) {
      setWorkersError("Choose an org before opening a worker.");
      return;
    }

    setOpeningWorkerId(workerId);
    setWorkersError(null);

    try {
      const tokens = await client().getWorkerTokens(workerId, orgId);
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error("Worker is not ready to open yet. Try again after provisioning finishes.");
      }

      const ok = await props.connectRemoteWorkspace({
        openworkHostUrl: openworkUrl,
        openworkToken: accessToken,
        directory: null,
        displayName: workerName,
      });
      if (!ok) {
        throw new Error(`Failed to open ${workerName} in OpenWork.`);
      }

      setStatusMessage(`Opened ${workerName} in OpenWork.`);
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : `Failed to open ${workerName}.`);
    } finally {
      setOpeningWorkerId(null);
    }
  };

  return (
    <div class="space-y-6">
      <div class="relative overflow-hidden rounded-2xl border border-sky-7/20 bg-gradient-to-br from-sky-3/25 via-gray-1/80 to-cyan-3/20 p-5">
        <div class="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-sky-6/15 blur-2xl" />
        <div class="pointer-events-none absolute -bottom-10 left-4 h-24 w-24 rounded-full bg-cyan-6/15 blur-2xl" />
        <div class="relative space-y-4">
          <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div class="space-y-2">
              <div class="inline-flex items-center gap-2 rounded-full border border-sky-7/25 bg-sky-3/20 px-2.5 py-1 text-[11px] font-medium text-sky-11">
                <Cloud size={12} />
                OpenWork Den
              </div>
              <div>
                <div class="text-sm font-semibold text-gray-12">Sign in, pick an org, and open Den workers from Settings.</div>
                <div class="mt-1 max-w-[60ch] text-xs text-gray-10">Sign in to OpenWork Den to keep your tasks alive even when your computer sleeps.</div>
              </div>
            </div>
            <div class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusBadgeClass(summaryTone())}`}>
              <span class={`h-2 w-2 rounded-full ${summaryTone() === "ready" ? "bg-green-9" : summaryTone() === "warning" ? "bg-amber-9" : summaryTone() === "error" ? "bg-red-9" : "bg-gray-8"}`} />
              {summaryLabel()}
            </div>
          </div>

          <Show
            when={props.developerMode}
            fallback={<></>}
          >
            <>
              <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <TextInput
                  label="Den control plane URL"
                  value={baseUrlDraft()}
                  onInput={(event) => setBaseUrlDraft(event.currentTarget.value)}
                  placeholder={DEFAULT_DEN_BASE_URL}
                  hint="Developer mode only. Use this to target a local or self-hosted Den control plane. Changing it signs you out so the app can re-hydrate against the new control plane."
                  disabled={authBusy() || sessionBusy()}
                />
                <div class="flex flex-wrap items-center gap-2">
                  <Button variant="outline" class="h-9 px-3 text-xs" onClick={() => setBaseUrlDraft(baseUrl())} disabled={authBusy() || sessionBusy()}>
                    Reset
                  </Button>
                  <Button variant="secondary" class="h-9 px-3 text-xs" onClick={applyBaseUrl} disabled={authBusy() || sessionBusy()}>
                    Save URL
                  </Button>
                  <Button variant="outline" class="h-9 px-3 text-xs" onClick={openControlPlane}>
                    Open in browser
                    <ArrowUpRight size={13} />
                  </Button>
                </div>
              </div>

              <Show when={baseUrlError()}>
                {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
              </Show>
            </>
          </Show>
          <Show when={statusMessage() && !authError() && !workersError() && !orgsError() && !billingError()}>
            {(value) => <div class="rounded-xl border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-xs text-gray-11">{value()}</div>}
          </Show>
        </div>
      </div>

      <Show when={!isSignedIn()}>
        <div class="rounded-2xl border border-gray-7/60 bg-gray-2/30 p-5 space-y-4">
          <div class="space-y-2">
            <div class="text-sm font-medium text-gray-12">Sign in to OpenWork Den</div>
            <div class="max-w-[54ch] text-sm text-gray-10">Sign in to OpenWork Den to keep your tasks alive even when your computer sleeps.</div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => openBrowserAuth("sign-in")}>
              Sign in
              <ArrowUpRight size={13} />
            </Button>
            <Button variant="outline" class="text-xs h-9 px-3" onClick={() => openBrowserAuth("sign-up")}>
              Create account
              <ArrowUpRight size={13} />
            </Button>
          </div>

          <Show when={authError()}>
            {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}</Show>
          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
            Finish auth in your browser and OpenWork will reconnect here automatically.
          </div>
        </div>
      </Show>

      <Show when={isSignedIn()}>
        <div class="space-y-6">
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div class="rounded-2xl border border-gray-7/60 bg-gray-2/30 p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">Account</div>
                  <div class="text-xs text-gray-9 mt-1">Desktop session hydrated from Den. Signing out clears saved Cloud auth on this device.</div>
                </div>
                <Button variant="outline" class="text-xs h-8 px-3" onClick={() => void signOut()} disabled={authBusy() || sessionBusy()}>
                  <LogOut size={13} />
                  {authBusy() ? "Signing out..." : "Sign out"}
                </Button>
              </div>
              <div class="rounded-xl border border-gray-6/60 bg-gray-1/50 px-4 py-3">
                <div class="text-sm font-medium text-gray-12">{user()?.name || user()?.email}</div>
                <div class="mt-1 text-xs text-gray-9">{user()?.email}</div>
              </div>
            </div>

            <div class="rounded-2xl border border-gray-7/60 bg-gray-2/30 p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">Active org</div>
                  <div class="text-xs text-gray-9 mt-1">Workers are scoped to the selected org.</div>
                </div>
                <Button variant="outline" class="text-xs h-8 px-3" onClick={() => void refreshOrgs()} disabled={orgsBusy()}>
                  <RefreshCcw size={13} class={orgsBusy() ? "animate-spin" : ""} />
                  Refresh orgs
                </Button>
              </div>
              <label class="block">
                <div class="mb-1 text-xs font-medium text-dls-secondary">Org</div>
                <select
                  class="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                  value={activeOrgId()}
                  onChange={(event) => {
                    setActiveOrgId(event.currentTarget.value);
                    setStatusMessage(`Switched to ${activeOrg()?.name ?? "the selected org"}.`);
                  }}
                  disabled={orgsBusy() || orgs().length === 0}
                >
                  <For each={orgs()}>
                    {(org) => (
                      <option value={org.id}>
                        {org.name} {org.role === "owner" ? "(Owner)" : "(Member)"}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <Show when={orgsError()}>
                {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
              </Show>
            </div>
          </div>

          <div class="rounded-2xl border border-gray-7/60 bg-gray-2/30 p-5 space-y-4">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
                  <CreditCard size={15} class="text-gray-11" />
                  Billing
                </div>
                <div class="text-xs text-gray-9 mt-1">Manage checkout, subscription renewal, and invoice access for additional Den cloud workers.</div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Show when={billingSummary()?.featureGateEnabled && billingSummary()?.checkoutRequired && !billingCheckoutUrl()}>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 px-3"
                    onClick={() => void refreshBilling({ includeCheckout: true })}
                    disabled={billingBusy() || billingCheckoutBusy() || billingSubscriptionBusy()}
                  >
                    {billingCheckoutBusy() ? "Generating checkout..." : "Generate checkout"}
                  </Button>
                </Show>
                <Button
                  variant="outline"
                  class="text-xs h-8 px-3"
                  onClick={() => void refreshBilling()}
                  disabled={billingBusy() || billingCheckoutBusy() || billingSubscriptionBusy()}
                >
                  <RefreshCcw size={13} class={billingBusy() ? "animate-spin" : ""} />
                  Refresh billing
                </Button>
              </div>
            </div>

            <Show when={billingError()}>
              {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
            </Show>

            <Show when={billingBusy() && !billingSummary()}>
              <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-4 text-sm text-gray-10">Loading billing details...</div>
            </Show>

            <Show when={!billingBusy() && !billingSummary() && !billingError()}>
              <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-4 text-sm text-gray-10">Billing details are not available yet. Refresh billing to try again.</div>
            </Show>

            <Show when={billingSummary()}>
              {(summaryAccessor) => {
                const summary = summaryAccessor();
                return (
                  <div class="space-y-4">
                    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4 space-y-2">
                        <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Plan status</div>
                        <div class="text-lg font-semibold text-gray-12">
                          {!summary.featureGateEnabled ? "Billing disabled" : summary.hasActivePlan ? "Active plan" : "Payment required"}
                        </div>
                        <div class="text-sm text-gray-10">
                          {!summary.featureGateEnabled
                            ? "Cloud billing gates are disabled in this environment."
                            : summary.hasActivePlan
                              ? "This account can launch additional cloud workers right now."
                              : "Complete checkout to unlock additional cloud worker launches."}
                        </div>
                        <div class="text-sm font-medium text-gray-11">
                          {summary.price && summary.price.amount !== null
                            ? `${formatMoneyMinor(summary.price.amount, summary.price.currency)} ${formatRecurringInterval(summary.price.recurringInterval, summary.price.recurringIntervalCount)}`
                            : "Current plan amount is unavailable."}
                        </div>
                      </div>

                      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4 space-y-2">
                        <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Subscription</div>
                        <Show
                          when={billingSubscription()}
                          fallback={<div class="text-sm text-gray-10">No active subscription found yet.</div>}
                        >
                          {(subscriptionAccessor) => {
                            const subscription = subscriptionAccessor();
                            return (
                              <>
                                <div class="text-base font-semibold text-gray-12">{formatSubscriptionStatus(subscription.status)}</div>
                                <div class="text-sm text-gray-10">
                                  {formatMoneyMinor(subscription.amount, subscription.currency)} {formatRecurringInterval(subscription.recurringInterval, subscription.recurringIntervalCount)}
                                </div>
                                <div class="text-xs text-gray-9">
                                  {subscription.cancelAtPeriodEnd
                                    ? `Cancels on ${formatIsoDate(subscription.currentPeriodEnd)}`
                                    : `Renews on ${formatIsoDate(subscription.currentPeriodEnd)}`}
                                </div>
                              </>
                            );
                          }}
                        </Show>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={billingCheckoutUrl()}>
                        {(checkoutUrl) => (
                          <Button variant="secondary" class="text-xs h-9 px-3" onClick={() => openExternalUrl(checkoutUrl())}>
                            Continue checkout
                            <ArrowUpRight size={13} />
                          </Button>
                        )}
                      </Show>
                      <Show when={summary.portalUrl}>
                        {(portalUrl) => (
                          <Button variant="outline" class="text-xs h-9 px-3" onClick={() => openExternalUrl(portalUrl())}>
                            Open billing portal
                            <ArrowUpRight size={13} />
                          </Button>
                        )}
                      </Show>
                      <Show when={billingSubscription()}>
                        {(subscriptionAccessor) => {
                          const subscription = subscriptionAccessor();
                          return (
                            <Button
                              variant={subscription.cancelAtPeriodEnd ? "outline" : "secondary"}
                              class="text-xs h-9 px-3"
                              onClick={() => void handleSubscriptionCancellation(!subscription.cancelAtPeriodEnd)}
                              disabled={billingBusy() || billingCheckoutBusy() || billingSubscriptionBusy()}
                            >
                              {billingSubscriptionBusy()
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
                      <div class="space-y-2">
                        <div class="text-xs font-medium uppercase tracking-[0.08em] text-gray-9">Invoices</div>
                        <div class="space-y-2">
                          <For each={summary.invoices}>
                            {(invoice) => (
                              <div class="flex flex-col gap-2 rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-3 md:flex-row md:items-center md:justify-between">
                                <div>
                                  <div class="text-sm font-medium text-gray-12">{invoice.invoiceNumber ?? formatSubscriptionStatus(invoice.status)}</div>
                                  <div class="text-xs text-gray-9">
                                    {formatIsoDate(invoice.createdAt)} · {formatMoneyMinor(invoice.totalAmount, invoice.currency)} · {formatSubscriptionStatus(invoice.status)}
                                  </div>
                                </div>
                                <Show
                                  when={invoice.invoiceUrl}
                                  fallback={<div class="text-xs font-medium text-gray-9">Invoice link unavailable</div>}
                                >
                                  {(invoiceUrl) => (
                                    <Button variant="outline" class="text-xs h-8 px-3" onClick={() => openExternalUrl(invoiceUrl())}>
                                      Open invoice
                                      <ArrowUpRight size={13} />
                                    </Button>
                                  )}
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </Show>
          </div>

          <div class="rounded-2xl border border-gray-7/60 bg-gray-2/30 p-5 space-y-4">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
                  <Server size={15} class="text-gray-11" />
                  Den workers
                </div>
                <div class="text-xs text-gray-9 mt-1">Open workers directly into OpenWork using the same remote-connect flow the app already uses elsewhere.</div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class="inline-flex items-center gap-1.5 rounded-full border border-gray-6/60 bg-gray-1/60 px-2.5 py-1 text-[11px] font-medium text-gray-11">
                  <Users size={12} />
                  {activeOrg()?.name || "No org selected"}
                </div>
                <Button variant="outline" class="text-xs h-8 px-3" onClick={() => void refreshWorkers()} disabled={workersBusy() || !activeOrgId().trim()}>
                  <RefreshCcw size={13} class={workersBusy() ? "animate-spin" : ""} />
                  Refresh workers
                </Button>
              </div>
            </div>

            <Show when={workersError()}>
              {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
            </Show>

            <Show when={!workersBusy() && workers().length === 0}>
              <div class="rounded-2xl border border-dashed border-gray-6/60 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">
                {billingSummary()?.featureGateEnabled && billingSummary()?.checkoutRequired
                  ? "No cloud workers are visible yet. Finish billing in Den, create a worker, then refresh this tab."
                  : "No cloud workers are visible for this org yet. Create one in Den, then refresh this tab."}
              </div>
            </Show>

            <div class="space-y-3">
              <For each={workers()}>
                {(worker) => {
                  const status = createMemo(() => workerStatusMeta(worker.status));
                  return (
                    <div class="rounded-2xl border border-gray-6/60 bg-gray-1/50 p-4">
                      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div class="min-w-0 space-y-2">
                          <div class="flex flex-wrap items-center gap-2">
                            <div class="text-sm font-medium text-gray-12">{worker.workerName}</div>
                            <div class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(status().tone)}`}>
                              {status().label}
                            </div>
                            <Show when={worker.isMine}>
                              <div class="inline-flex items-center rounded-full border border-gray-6/60 bg-gray-1/60 px-2 py-0.5 text-[11px] font-medium text-gray-11">
                                Mine
                              </div>
                            </Show>
                          </div>
                          <div class="text-xs text-gray-9">
                            {worker.provider ? `${worker.provider} worker` : "Cloud worker"}
                            <Show when={worker.instanceUrl}>
                              {(value) => <span class="truncate"> · {value()}</span>}
                            </Show>
                          </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            class="text-xs h-9 px-3"
                            onClick={() => void handleOpenWorker(worker.workerId, worker.workerName)}
                            disabled={openingWorkerId() !== null || !status().canOpen}
                            title={!status().canOpen ? "This worker is not ready to open yet." : undefined}
                          >
                            {openingWorkerId() === worker.workerId ? "Opening..." : "Open"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
