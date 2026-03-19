import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  clearDenSession,
  createDenClient,
  type DenAdminOverview,
  DenApiError,
  type DenBillingSummary,
  type DenSocialProvider,
  type DenUser,
  type DenWorkerLaunch,
  type DenWorkerRuntimeSnapshot,
  type DenWorkerSummary,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../../lib/den";
import {
  canConfigureDenBaseUrlOverride,
  DEN_CONFIG_UPDATED_EVENT,
  dispatchDenConfigUpdated,
  readDenFeatureGate,
} from "../../lib/den-gate";
import { isDesktopDeployment } from "../../lib/openwork-deployment";
import {
  buildDenBrowserAuthUrl,
  buildDenSocialCallbackUrl,
} from "./browser-auth";

type DenAuthMode = "sign-in" | "sign-up";

type DenFeatureStateOptions = {
  developerMode: Accessor<boolean>;
  openLink: (url: string) => void;
  connectRemoteWorkspace?: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
};

const DEFAULT_WORKER_NAME = "My Worker";

function workerSummaryToLaunch(
  worker: DenWorkerSummary,
  current?: DenWorkerLaunch | null,
): DenWorkerLaunch {
  return {
    workerId: worker.workerId,
    workerName: worker.workerName,
    status: worker.status,
    provider: worker.provider,
    instanceUrl: worker.instanceUrl,
    openworkUrl:
      current?.workerId === worker.workerId
        ? current.openworkUrl
        : worker.instanceUrl,
    workspaceId: current?.workerId === worker.workerId ? current.workspaceId : null,
    clientToken: current?.workerId === worker.workerId ? current.clientToken : null,
    ownerToken: current?.workerId === worker.workerId ? current.ownerToken : null,
    hostToken: current?.workerId === worker.workerId ? current.hostToken : null,
  };
}

export function createDenFeatureState(options: DenFeatureStateOptions) {
  const initialGate = readDenFeatureGate(options.developerMode());
  const initialSettings = readDenSettings();
  const initialBaseUrl = initialGate.baseUrl ?? "";

  const [authMode, setAuthMode] = createSignal<DenAuthMode>("sign-in");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [workerName, setWorkerName] = createSignal(DEFAULT_WORKER_NAME);
  const [baseUrl, setBaseUrl] = createSignal(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = createSignal(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = createSignal<string | null>(null);
  const [authToken, setAuthToken] = createSignal(
    initialGate.enabled ? initialSettings.authToken?.trim() || "" : "",
  );
  const [activeOrgId, setActiveOrgId] = createSignal(
    initialGate.enabled ? initialSettings.activeOrgId?.trim() || "" : "",
  );
  const [selectedWorkerId, setSelectedWorkerId] = createSignal<string | null>(null);
  const [selectedWorkerLaunch, setSelectedWorkerLaunch] =
    createSignal<DenWorkerLaunch | null>(null);
  const [desktopAuthRequested, setDesktopAuthRequested] = createSignal(false);
  const [desktopAuthScheme, setDesktopAuthScheme] = createSignal("openwork");
  const [desktopRedirectBusy, setDesktopRedirectBusy] = createSignal(false);
  const [desktopRedirectUrl, setDesktopRedirectUrl] = createSignal<string | null>(null);

  const [authBusy, setAuthBusy] = createSignal(false);
  const [sessionBusy, setSessionBusy] = createSignal(false);
  const [orgsBusy, setOrgsBusy] = createSignal(false);
  const [workersBusy, setWorkersBusy] = createSignal(false);
  const [billingBusy, setBillingBusy] = createSignal(false);
  const [billingCheckoutBusy, setBillingCheckoutBusy] = createSignal(false);
  const [billingSubscriptionBusy, setBillingSubscriptionBusy] =
    createSignal(false);
  const [workerActionBusy, setWorkerActionBusy] = createSignal(false);
  const [runtimeBusy, setRuntimeBusy] = createSignal(false);
  const [adminBusy, setAdminBusy] = createSignal(false);
  const [openingWorkerId, setOpeningWorkerId] = createSignal<string | null>(null);

  const [user, setUser] = createSignal<DenUser | null>(null);
  const [orgs, setOrgs] = createSignal<
    Array<{ id: string; name: string; slug: string; role: "owner" | "member" }>
  >([]);
  const [workers, setWorkers] = createSignal<DenWorkerSummary[]>([]);
  const [runtimeSnapshot, setRuntimeSnapshot] =
    createSignal<DenWorkerRuntimeSnapshot | null>(null);
  const [billingSummary, setBillingSummary] =
    createSignal<DenBillingSummary | null>(null);
  const [adminOverview, setAdminOverview] =
    createSignal<DenAdminOverview | null>(null);

  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [orgsError, setOrgsError] = createSignal<string | null>(null);
  const [workersError, setWorkersError] = createSignal<string | null>(null);
  const [runtimeError, setRuntimeError] = createSignal<string | null>(null);
  const [billingError, setBillingError] = createSignal<string | null>(null);
  const [adminError, setAdminError] = createSignal<string | null>(null);

  const canEditBaseUrl = createMemo(() =>
    canConfigureDenBaseUrlOverride(options.developerMode()),
  );
  const isConfigured = createMemo(() => Boolean(baseUrl().trim()));
  const client = createMemo(() =>
    isConfigured()
      ? createDenClient({ baseUrl: baseUrl(), token: authToken() })
      : null,
  );
  const activeOrg = createMemo(
    () => orgs().find((org) => org.id === activeOrgId()) ?? null,
  );
  const isSignedIn = createMemo(
    () => isConfigured() && Boolean(user() && authToken().trim()),
  );
  const billingSubscription = createMemo(
    () => billingSummary()?.subscription ?? null,
  );
  const billingCheckoutUrl = createMemo(
    () => billingSummary()?.checkoutUrl ?? null,
  );
  const selectedWorkerSummary = createMemo(
    () => workers().find((worker) => worker.workerId === selectedWorkerId()) ?? null,
  );
  const selectedWorker = createMemo<DenWorkerLaunch | null>(() => {
    const summary = selectedWorkerSummary();
    const current = selectedWorkerLaunch();
    if (summary) {
      return workerSummaryToLaunch(summary, current);
    }
    return current && current.workerId === selectedWorkerId() ? current : null;
  });
  const selectedWorkerStatus = createMemo(
    () => selectedWorker()?.status ?? selectedWorkerSummary()?.status ?? "",
  );

  const clearRuntimeState = () => {
    setRuntimeSnapshot(null);
    setRuntimeError(null);
    setRuntimeBusy(false);
  };

  const clearSessionState = () => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setSelectedWorkerId(null);
    setSelectedWorkerLaunch(null);
    setBillingSummary(null);
    setAdminOverview(null);
    setActiveOrgId("");
    setOrgsError(null);
    setWorkersError(null);
    setBillingError(null);
    setAdminError(null);
    setDesktopRedirectUrl(null);
    setDesktopRedirectBusy(false);
    clearRuntimeState();
  };

  const clearSignedInState = (message?: string | null) => {
    clearDenSession();
    setAuthToken("");
    clearSessionState();
    setAuthError(null);
    setStatusMessage(message ?? null);
  };

  const syncGateState = () => {
    const nextGate = readDenFeatureGate(options.developerMode());
    const nextSettings = readDenSettings();
    const nextBaseUrl = nextGate.baseUrl ?? "";
    setBaseUrl(nextBaseUrl);
    setBaseUrlDraft(nextBaseUrl);
    setBaseUrlError(null);
    if (!nextGate.enabled) {
      setAuthToken("");
      setActiveOrgId("");
      clearSessionState();
      return;
    }
    setAuthToken(nextSettings.authToken?.trim() || "");
    setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
  };

  createEffect(() => {
    const nextBaseUrl = baseUrl().trim();
    if (!nextBaseUrl) {
      clearDenSession({ includeBaseUrls: true });
      return;
    }

    const nextSettings = readDenSettings();
    writeDenSettings({
      baseUrl: nextBaseUrl,
      authToken: authToken() || null,
      activeOrgId: activeOrgId() || null,
      apiBaseUrl: nextSettings.apiBaseUrl,
    });
  });

  createEffect(() => {
    options.developerMode();
    if (!canEditBaseUrl()) {
      syncGateState();
    }
  });

  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      const requestedMode = params.get("mode")?.trim().toLowerCase();
      if (requestedMode === "sign-up" || requestedMode === "sign-in") {
        setAuthMode(requestedMode);
      }

      if (params.get("desktopAuth") === "1") {
        setDesktopAuthRequested(true);
      }

      const requestedScheme = params.get("desktopScheme")?.trim() ?? "";
      if (/^[a-z][a-z0-9+.-]*$/i.test(requestedScheme)) {
        setDesktopAuthScheme(requestedScheme);
      }

      if (!readDenFeatureGate(options.developerMode()).enabled) {
        const queryBaseUrl = normalizeDenBaseUrl(params.get("denBaseUrl")?.trim() ?? "");
        if (queryBaseUrl) {
          setBaseUrl(queryBaseUrl);
          setBaseUrlDraft(queryBaseUrl);
        }
      }
    } catch {
      // ignore search param parsing failures
    }
  }

  createEffect(() => {
    const currentBaseUrl = baseUrl().trim();
    const token = authToken().trim();
    let cancelled = false;

    if (!currentBaseUrl) {
      setSessionBusy(false);
      clearSessionState();
      setAuthError(null);
      return;
    }

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
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(
          error instanceof Error ? error.message : "No active Cloud session found.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setSessionBusy(false);
        }
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!user()) return;
    void refreshOrgs(true);
  });

  createEffect(() => {
    if (!user() || !activeOrgId().trim()) return;
    void refreshWorkers(true);
  });

  createEffect(() => {
    if (!user()) return;
    void refreshBilling({ quiet: true });
  });

  createEffect(() => {
    const worker = selectedWorker();
    if (!worker) {
      clearRuntimeState();
      return;
    }

    if (!["provisioning", "starting"].includes(worker.status.trim().toLowerCase())) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshSelectedWorker(true);
    }, 5_000);

    onCleanup(() => window.clearInterval(interval));
  });

  if (typeof window !== "undefined") {
    const handleSessionUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{
        status?: string;
        email?: string | null;
        message?: string | null;
      }>;
      syncGateState();
      if (customEvent.detail?.status === "success") {
        setAuthError(null);
        setStatusMessage(
          customEvent.detail.email?.trim()
            ? `Connected OpenWork Den as ${customEvent.detail.email.trim()}.`
            : "Connected OpenWork Den.",
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() ||
            "Failed to finish OpenWork Den sign-in.",
        );
      }
    };

    const handleConfigUpdated = () => {
      syncGateState();
    };

    window.addEventListener(
      "openwork-den-session-updated",
      handleSessionUpdated as EventListener,
    );
    window.addEventListener(DEN_CONFIG_UPDATED_EVENT, handleConfigUpdated);
    onCleanup(() => {
      window.removeEventListener(
        "openwork-den-session-updated",
        handleSessionUpdated as EventListener,
      );
      window.removeEventListener(DEN_CONFIG_UPDATED_EVENT, handleConfigUpdated);
    });
  }

  createEffect(() => {
    if (!desktopAuthRequested() || !isSignedIn() || desktopRedirectUrl() || desktopRedirectBusy()) {
      return;
    }
    void createDesktopRedirect();
  });

  async function refreshOrgs(quiet = false) {
    const activeClient = client();
    if (!activeClient || !authToken().trim()) {
      setOrgs([]);
      setActiveOrgId("");
      return;
    }

    setOrgsBusy(true);
    if (!quiet) setOrgsError(null);

    try {
      const response = await activeClient.listOrgs();
      setOrgs(response.orgs);
      const current = activeOrgId().trim();
      const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
      const next = response.orgs.some((org) => org.id === current)
        ? current
        : fallback;
      setActiveOrgId(next);
      if (!quiet && response.orgs.length > 0) {
        setStatusMessage(
          `Loaded ${response.orgs.length} org${response.orgs.length === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : "Failed to load orgs.");
    } finally {
      setOrgsBusy(false);
    }
  }

  async function refreshWorkers(quiet = false) {
    const activeClient = client();
    const orgId = activeOrgId().trim();
    if (!activeClient || !authToken().trim() || !orgId) {
      setWorkers([]);
      setSelectedWorkerId(null);
      setSelectedWorkerLaunch(null);
      clearRuntimeState();
      return;
    }

    setWorkersBusy(true);
    if (!quiet) setWorkersError(null);

    try {
      const nextWorkers = await activeClient.listWorkers(orgId, 20);
      setWorkers(nextWorkers);
      const currentId = selectedWorkerId();
      const fallbackId = nextWorkers[0]?.workerId ?? null;
      const nextSelectedId =
        currentId && nextWorkers.some((worker) => worker.workerId === currentId)
          ? currentId
          : fallbackId;
      setSelectedWorkerId(nextSelectedId);
      if (!nextSelectedId) {
        setSelectedWorkerLaunch(null);
        clearRuntimeState();
      }
      if (!quiet) {
        setStatusMessage(
          nextWorkers.length > 0
            ? `Loaded ${nextWorkers.length} worker${nextWorkers.length === 1 ? "" : "s"}.`
            : `No workers found for ${activeOrg()?.name ?? "this org"}.`,
        );
      }
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : "Failed to load workers.",
      );
    } finally {
      setWorkersBusy(false);
    }
  }

  async function refreshBilling(options: {
    quiet?: boolean;
    includeCheckout?: boolean;
  } = {}) {
    const activeClient = client();
    if (!activeClient || !authToken().trim()) {
      setBillingSummary(null);
      return null;
    }

    const quiet = options.quiet === true;
    if (options.includeCheckout) {
      setBillingCheckoutBusy(true);
    } else {
      setBillingBusy(true);
    }
    if (!quiet) setBillingError(null);

    try {
      const summary = await activeClient.getBillingStatus({
        includeCheckout: options.includeCheckout,
      });
      setBillingSummary(summary);
      return summary;
    } catch (error) {
      if (!quiet) {
        setBillingError(
          error instanceof Error ? error.message : "Failed to load billing.",
        );
      }
      return null;
    } finally {
      if (options.includeCheckout) {
        setBillingCheckoutBusy(false);
      } else {
        setBillingBusy(false);
      }
    }
  }

  function resolveLandingRoute() {
    const summary = billingSummary();
    if (
      summary &&
      summary.featureGateEnabled &&
      summary.checkoutRequired &&
      !summary.hasActivePlan
    ) {
      return "/cloud/checkout" as const;
    }
    return "/cloud/dashboard" as const;
  }

  async function handleCheckoutReturn(customerSessionToken: string | null) {
    if (customerSessionToken) {
      setStatusMessage(
        "Checkout return detected. Billing is refreshing now.",
      );
    }
    await refreshBilling({ quiet: true });
    return resolveLandingRoute();
  }

  async function submitEmailAuth() {
    const activeClient = client();
    if (!activeClient) {
      setBaseUrlError(
        "Set a Den control plane URL before attempting Cloud auth.",
      );
      return null;
    }

    const nextEmail = email().trim();
    if (!nextEmail || !password()) {
      setAuthError("Enter your email and password.");
      return null;
    }

    setAuthBusy(true);
    setAuthError(null);

    try {
      const result =
        authMode() === "sign-up"
          ? await activeClient.signUpEmail(nextEmail, password())
          : await activeClient.signInEmail(nextEmail, password());

      if (!result.token || !result.user) {
        throw new Error(
          authMode() === "sign-up"
            ? "Cloud sign-up completed, but the response was missing session details."
            : "Cloud sign-in completed, but the response was missing session details.",
        );
      }

      setAuthToken(result.token);
      setUser(result.user);
      setPassword("");
      setStatusMessage(
        authMode() === "sign-up"
          ? `Created Cloud account for ${result.user.email}.`
          : `Signed in as ${result.user.email}.`,
      );
      await refreshOrgs(true);
      await refreshBilling({ includeCheckout: authMode() === "sign-up", quiet: true });
      return resolveLandingRoute();
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to complete Cloud auth.",
      );
      return null;
    } finally {
      setAuthBusy(false);
    }
  }

  async function beginSocialAuth(provider: DenSocialProvider) {
    if (!isConfigured()) {
      setBaseUrlError("Set a Den control plane URL before starting Cloud auth.");
      return false;
    }

    if (isDesktopDeployment()) {
      openBrowserAuth(authMode());
      return true;
    }

    const activeClient = client();
    if (!activeClient || typeof window === "undefined") {
      setAuthError("Cloud social auth is unavailable in this environment.");
      return false;
    }

    try {
      const callbackUrl = buildDenSocialCallbackUrl(authMode());
      if (!callbackUrl) {
        openBrowserAuth(authMode());
        return true;
      }
      const result = await activeClient.beginSocialAuth({
        provider,
        callbackURL: callbackUrl,
        errorCallbackURL: callbackUrl,
      });
      window.location.assign(result.url);
      return true;
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to start social auth.",
      );
      return false;
    }
  }

  function openControlPlane() {
    if (!isConfigured()) {
      setBaseUrlError(
        "Set a Den control plane URL before opening Cloud in your browser.",
      );
      return;
    }
    options.openLink(resolveDenBaseUrls(baseUrl()).baseUrl);
  }

  function openBrowserAuth(mode: DenAuthMode) {
    if (!isConfigured()) {
      setBaseUrlError(
        "Set a Den control plane URL before starting Cloud auth.",
      );
      return;
    }
    const target = buildDenBrowserAuthUrl({
      baseUrl: baseUrl(),
      mode,
      desktopAuth: isDesktopDeployment(),
      desktopScheme: "openwork",
    });
    options.openLink(target);
    setStatusMessage(
      mode === "sign-up"
        ? "Finish account creation in your browser to connect OpenWork."
        : "Finish signing in in your browser to connect OpenWork.",
    );
    setAuthError(null);
  }

  function applyBaseUrl() {
    if (!canEditBaseUrl()) return;
    const normalized = normalizeDenBaseUrl(baseUrlDraft());
    if (!normalized) {
      setBaseUrlError(
        "Enter a valid http:// or https:// Den control plane URL.",
      );
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlError(null);
    setBaseUrl(resolved.baseUrl);
    setBaseUrlDraft(resolved.baseUrl);
    clearSignedInState("Updated the Den control plane URL. Sign in again to continue.");
    dispatchDenConfigUpdated({
      source: "override",
      baseUrl: resolved.baseUrl,
      enabled: true,
    });
  }

  function disableCloud() {
    if (!canEditBaseUrl()) return;
    setBaseUrl("");
    setBaseUrlDraft("");
    setAuthToken("");
    clearSessionState();
    setBaseUrlError(null);
    setAuthError(null);
    setStatusMessage("Cloud features disabled on this device.");
    dispatchDenConfigUpdated({
      source: "none",
      baseUrl: null,
      enabled: false,
    });
  }

  async function signOut() {
    const activeClient = client();
    if (authBusy()) return;
    setAuthBusy(true);
    try {
      if (activeClient && authToken().trim()) {
        await activeClient.signOut();
      }
    } catch {
      // ignore remote sign-out failures
    } finally {
      setAuthBusy(false);
    }
    clearSignedInState(
      "Signed out and cleared your OpenWork Den session on this device.",
    );
  }

  async function createDesktopRedirect() {
    const activeClient = client();
    if (!activeClient || !desktopAuthRequested() || !isSignedIn()) {
      return null;
    }

    setDesktopRedirectBusy(true);
    try {
      const result = await activeClient.createDesktopHandoffGrant({
        desktopScheme: desktopAuthScheme(),
      });
      if (!result.openworkUrl) {
        throw new Error(
          "Cloud auth completed, but OpenWork did not receive a desktop handoff link.",
        );
      }
      setDesktopRedirectUrl(result.openworkUrl);
      setStatusMessage("Desktop handoff is ready. Open OpenWork to finish sign-in.");
      return result.openworkUrl;
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Failed to prepare desktop sign-in handoff.",
      );
      return null;
    } finally {
      setDesktopRedirectBusy(false);
    }
  }

  function openDesktopRedirect() {
    const target = desktopRedirectUrl();
    if (!target) return;
    options.openLink(target);
  }

  async function launchWorker() {
    const activeClient = client();
    if (!activeClient || !isSignedIn()) {
      setWorkersError("Sign in before launching a Cloud worker.");
      return null;
    }

    const nextWorkerName = workerName().trim() || DEFAULT_WORKER_NAME;
    setWorkerActionBusy(true);
    setWorkersError(null);
    try {
      const result = await activeClient.createWorker({
        name: nextWorkerName,
        destination: "cloud",
      });
      if (result.kind === "paywall") {
        setBillingSummary((current) =>
          current
            ? {
                ...current,
                hasActivePlan: false,
                checkoutRequired: true,
                checkoutUrl: result.checkoutUrl ?? current.checkoutUrl,
                productId: result.productId ?? current.productId,
                benefitId: result.benefitId ?? current.benefitId,
              }
            : current,
        );
        setStatusMessage(
          "Payment is required before another Cloud worker can be created.",
        );
        return "/cloud/checkout" as const;
      }

      setSelectedWorkerId(result.worker.workerId);
      setSelectedWorkerLaunch(result.worker);
      setStatusMessage(
        result.launchMode === "async"
          ? `Provisioning ${result.worker.workerName}...`
          : `${result.worker.workerName} is ready.`,
      );
      await refreshWorkers(true);
      return "/cloud/dashboard" as const;
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : "Failed to launch a worker.",
      );
      return null;
    } finally {
      setWorkerActionBusy(false);
    }
  }

  function selectWorker(workerId: string) {
    setSelectedWorkerId(workerId);
    setRuntimeSnapshot(null);
    setRuntimeError(null);
  }

  async function refreshSelectedWorker(quiet = false) {
    const activeClient = client();
    const workerId = selectedWorkerId();
    if (!activeClient || !workerId) return null;

    if (!quiet) {
      setWorkerActionBusy(true);
      setWorkersError(null);
    }

    try {
      const summary = await activeClient.getWorker(workerId);
      setWorkers((current) => {
        const next = current.slice();
        const index = next.findIndex((worker) => worker.workerId === workerId);
        if (index >= 0) {
          next[index] = summary;
          return next;
        }
        return [summary, ...next];
      });
      setSelectedWorkerLaunch((current) =>
        current?.workerId === workerId ? workerSummaryToLaunch(summary, current) : current,
      );
      return summary;
    } catch (error) {
      if (!quiet) {
        setWorkersError(
          error instanceof Error ? error.message : "Failed to refresh worker.",
        );
      }
      return null;
    } finally {
      if (!quiet) setWorkerActionBusy(false);
    }
  }

  async function openWorker(workerId?: string) {
    const activeClient = client();
    const targetWorkerId = workerId ?? selectedWorkerId();
    const orgId = activeOrgId().trim();
    if (!activeClient || !targetWorkerId || !orgId) {
      setWorkersError("Choose an org and worker before opening Cloud.");
      return false;
    }
    if (!options.connectRemoteWorkspace) {
      setWorkersError("Opening a Cloud worker is unavailable in this environment.");
      return false;
    }

    const workerLabel =
      workers().find((worker) => worker.workerId === targetWorkerId)?.workerName ??
      "Cloud worker";
    setOpeningWorkerId(targetWorkerId);
    setWorkersError(null);
    try {
      const tokens = await activeClient.getWorkerTokens(targetWorkerId, orgId);
      setSelectedWorkerLaunch((current) => {
        if (current?.workerId === targetWorkerId) {
          return {
            ...current,
            openworkUrl: tokens.openworkUrl ?? current.openworkUrl,
            workspaceId: tokens.workspaceId ?? current.workspaceId,
            clientToken: tokens.clientToken,
            ownerToken: tokens.ownerToken,
            hostToken: tokens.hostToken,
          };
        }
        const summary = workers().find((worker) => worker.workerId === targetWorkerId);
        return summary
          ? {
              ...workerSummaryToLaunch(summary, null),
              openworkUrl: tokens.openworkUrl,
              workspaceId: tokens.workspaceId,
              clientToken: tokens.clientToken,
              ownerToken: tokens.ownerToken,
              hostToken: tokens.hostToken,
            }
          : current;
      });
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken =
        tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error(
          "Worker is not ready to open yet. Try again after provisioning finishes.",
        );
      }

      const ok = await options.connectRemoteWorkspace({
        openworkHostUrl: openworkUrl,
        openworkToken: accessToken,
        directory: null,
        displayName: workerLabel,
      });
      if (!ok) {
        throw new Error(`Failed to open ${workerLabel} in OpenWork.`);
      }
      setStatusMessage(`Opened ${workerLabel} in OpenWork.`);
      return true;
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : `Failed to open ${workerLabel}.`,
      );
      return false;
    } finally {
      setOpeningWorkerId(null);
    }
  }

  async function refreshRuntime() {
    const activeClient = client();
    const worker = selectedWorker();
    if (!activeClient || !worker) {
      setRuntimeSnapshot(null);
      return null;
    }
    setRuntimeBusy(true);
    setRuntimeError(null);
    try {
      const runtime = await activeClient.getWorkerRuntime(worker.workerId);
      setRuntimeSnapshot(runtime);
      return runtime;
    } catch (error) {
      setRuntimeError(
        error instanceof Error ? error.message : "Failed to load runtime details.",
      );
      return null;
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function upgradeRuntime() {
    const activeClient = client();
    const worker = selectedWorker();
    if (!activeClient || !worker) return null;
    setRuntimeBusy(true);
    setRuntimeError(null);
    try {
      const runtime = await activeClient.upgradeWorkerRuntime(worker.workerId);
      setRuntimeSnapshot(runtime);
      setStatusMessage(`Requested runtime upgrade for ${worker.workerName}.`);
      return runtime;
    } catch (error) {
      setRuntimeError(
        error instanceof Error ? error.message : "Failed to upgrade runtime.",
      );
      return null;
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function deleteWorker(workerId?: string) {
    const activeClient = client();
    const targetWorkerId = workerId ?? selectedWorkerId();
    if (!activeClient || !targetWorkerId) return false;

    setWorkerActionBusy(true);
    setWorkersError(null);
    try {
      await activeClient.deleteWorker(targetWorkerId);
      setWorkers((current) =>
        current.filter((worker) => worker.workerId !== targetWorkerId),
      );
      if (selectedWorkerId() === targetWorkerId) {
        setSelectedWorkerId(null);
        setSelectedWorkerLaunch(null);
        clearRuntimeState();
      }
      setStatusMessage("Deleted Cloud worker.");
      return true;
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : "Failed to delete worker.",
      );
      return false;
    } finally {
      setWorkerActionBusy(false);
    }
  }

  async function redeployWorker(workerId?: string) {
    const worker =
      workers().find((entry) => entry.workerId === (workerId ?? selectedWorkerId())) ??
      selectedWorkerSummary();
    if (!worker) return null;
    const deleted = await deleteWorker(worker.workerId);
    if (!deleted) return null;
    setWorkerName(worker.workerName);
    return launchWorker();
  }

  async function updateSubscriptionCancellation(cancelAtPeriodEnd: boolean) {
    const activeClient = client();
    if (!activeClient || !user()) return null;
    setBillingSubscriptionBusy(true);
    setBillingError(null);
    try {
      const next = await activeClient.updateSubscriptionCancellation(
        cancelAtPeriodEnd,
      );
      setBillingSummary(next.billing);
      setStatusMessage(
        cancelAtPeriodEnd
          ? "Subscription will cancel at period end."
          : "Subscription auto-renew resumed.",
      );
      return next;
    } catch (error) {
      setBillingError(
        error instanceof Error
          ? error.message
          : "Failed to update subscription.",
      );
      return null;
    } finally {
      setBillingSubscriptionBusy(false);
    }
  }

  async function refreshAdminOverview(includeBilling = true) {
    const activeClient = client();
    if (!activeClient || !authToken().trim()) {
      setAdminOverview(null);
      return null;
    }
    setAdminBusy(true);
    setAdminError(null);
    try {
      const overview = await activeClient.getAdminOverview({ includeBilling });
      setAdminOverview(overview);
      return overview;
    } catch (error) {
      setAdminError(
        error instanceof Error
          ? error.message
          : "Failed to load Cloud admin overview.",
      );
      return null;
    } finally {
      setAdminBusy(false);
    }
  }

  return {
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    workerName,
    setWorkerName,
    baseUrl,
    baseUrlDraft,
    setBaseUrlDraft,
    baseUrlError,
    authToken,
    activeOrgId,
    setActiveOrgId,
    user,
    orgs,
    workers,
    selectedWorkerId,
    selectedWorker,
    selectedWorkerSummary,
    billingSummary,
    billingSubscription,
    billingCheckoutUrl,
    runtimeSnapshot,
    adminOverview,
    activeOrg,
    isConfigured,
    isSignedIn,
    canEditBaseUrl,
    authBusy,
    sessionBusy,
    orgsBusy,
    workersBusy,
    billingBusy,
    billingCheckoutBusy,
    billingSubscriptionBusy,
    workerActionBusy,
    runtimeBusy,
    adminBusy,
    openingWorkerId,
    desktopAuthRequested,
    desktopRedirectBusy,
    desktopRedirectUrl,
    statusMessage,
    authError,
    orgsError,
    workersError,
    runtimeError,
    billingError,
    adminError,
    summaryTone: createMemo(() => {
      if (!isConfigured()) return "neutral" as const;
      if (authError() || workersError() || orgsError() || billingError()) {
        return "error" as const;
      }
      if (
        sessionBusy() ||
        orgsBusy() ||
        workersBusy() ||
        billingBusy() ||
        billingCheckoutBusy() ||
        billingSubscriptionBusy() ||
        workerActionBusy()
      ) {
        return "warning" as const;
      }
      if (isSignedIn()) return "ready" as const;
      return "neutral" as const;
    }),
    summaryLabel: createMemo(() => {
      if (!isConfigured()) return canEditBaseUrl() ? "Cloud hidden" : "Unavailable";
      if (authError()) return "Needs attention";
      if (billingError()) return "Billing issue";
      if (sessionBusy()) return "Checking session";
      if (isSignedIn()) return "Connected";
      return "Signed out";
    }),
    resolveLandingRoute,
    handleCheckoutReturn,
    openControlPlane,
    openBrowserAuth,
    applyBaseUrl,
    disableCloud,
    submitEmailAuth,
    beginSocialAuth,
    createDesktopRedirect,
    openDesktopRedirect,
    signOut,
    refreshSession: syncGateState,
    refreshOrgs,
    refreshWorkers,
    launchWorker,
    selectWorker,
    refreshSelectedWorker,
    openWorker,
    refreshRuntime,
    upgradeRuntime,
    deleteWorker,
    redeployWorker,
    refreshBilling,
    updateSubscriptionCancellation,
    refreshAdminOverview,
  };
}

export type DenFeatureState = ReturnType<typeof createDenFeatureState>;
