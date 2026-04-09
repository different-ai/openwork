"use client";

import { createContext, createElement, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AUTH_TOKEN_STORAGE_KEY,
  DEFAULT_AUTH_NAME,
  DEFAULT_WORKER_NAME,
  LAST_WORKER_STORAGE_KEY,
  ONBOARDING_INTENT_STORAGE_KEY,
  OPENWORK_APP_CONNECT_BASE_URL,
  PENDING_SOCIAL_SIGNUP_STORAGE_KEY,
  WORKER_STATUS_POLL_MS,
  type AuthMethod,
  type AuthMode,
  type AuthUser,
  type BillingSummary,
  type LaunchEvent,
  type OnboardingIntent,
  type OrgLimitError,
  type RuntimeServiceName,
  type SocialAuthProvider,
  type WorkerLaunch,
  type WorkerListItem,
  type WorkerRuntimeSnapshot,
  type WorkerSummary,
  type WorkerStatusBucket,
  buildOpenworkAppConnectUrl,
  buildOpenworkDeepLink,
  deriveOnboardingWorkerName,
  getAuthInfoForMode,
  getBillingSummary,
  getCheckoutUrl,
  getEmailDomain,
  getErrorMessage,
  getOrgLimitError,
  getRuntimeServiceLabel,
  getSocialCallbackUrl,
  getSocialProviderLabel,
  getToken,
  getUser,
  getWorker,
  getWorkerRuntimeSnapshot,
  getWorkerStatusCopy,
  getWorkerStatusMeta,
  getWorkerSummary,
  getWorkerTokens,
  getWorkersList,
  identifyPosthogUser,
  isWorkerLaunch,
  listItemToWorker,
  normalizeAuthModeParam,
  parseWorkspaceIdFromUrl,
  requestJson,
  resetPosthogUser,
  resolveOpenworkWorkspaceUrl,
  trackPosthogEvent
} from "../_lib/den-flow";
import {
  PENDING_ORG_INVITATION_STORAGE_KEY,
  getJoinOrgRoute,
  getOrgDashboardRoute,
  parseOrgListPayload,
} from "../_lib/den-org";

type LaunchWorkerResult = "success" | "checkout" | "limit" | "error";
type AuthNavigationResult = "dashboard" | "checkout" | "join-org" | null;

type DenFlowContextValue = {
  authMode: AuthMode;
  setAuthMode: (mode: AuthMode) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  verificationCode: string;
  setVerificationCode: (value: string) => void;
  verificationRequired: boolean;
  authBusy: boolean;
  authInfo: string;
  authError: string | null;
  user: AuthUser | null;
  sessionHydrated: boolean;
  desktopAuthRequested: boolean;
  desktopAuthScheme: string;
  desktopRedirectUrl: string | null;
  desktopRedirectBusy: boolean;
  showAuthFeedback: boolean;
  submitAuth: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  submitVerificationCode: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  resendVerificationCode: () => Promise<void>;
  cancelVerification: () => void;
  beginSocialAuth: (provider: SocialAuthProvider) => Promise<void>;
  signOut: () => Promise<void>;
  resolveUserLandingRoute: () => Promise<string | null>;
  billingSummary: BillingSummary | null;
  billingBusy: boolean;
  billingCheckoutBusy: boolean;
  billingSubscriptionBusy: boolean;
  billingError: string | null;
  effectiveCheckoutUrl: string | null;
  orgLimitError: OrgLimitError | null;
  clearOrgLimitError: () => void;
  refreshBilling: (options?: { includeCheckout?: boolean; quiet?: boolean }) => Promise<BillingSummary | null>;
  handleSubscriptionCancellation: (cancelAtPeriodEnd: boolean) => Promise<void>;
  refreshCheckoutReturn: (sessionTokenPresent: boolean) => Promise<string>;
  onboardingPending: boolean;
  onboardingDecisionBusy: boolean;
  workers: WorkerListItem[];
  filteredWorkers: WorkerListItem[];
  workersBusy: boolean;
  workersLoadedOnce: boolean;
  workersError: string | null;
  workerQuery: string;
  setWorkerQuery: (value: string) => void;
  workerStatusFilter: WorkerStatusBucket | "all";
  setWorkerStatusFilter: (value: WorkerStatusBucket | "all") => void;
  selectedWorker: WorkerListItem | null;
  activeWorker: WorkerLaunch | null;
  selectWorker: (item: WorkerListItem) => void;
  workerName: string;
  setWorkerName: (value: string) => void;
  launchBusy: boolean;
  launchStatus: string;
  launchError: string | null;
  actionBusy: "status" | "token" | null;
  deleteBusyWorkerId: string | null;
  redeployBusyWorkerId: string | null;
  renameBusyWorkerId: string | null;
  runtimeSnapshot: WorkerRuntimeSnapshot | null;
  runtimeBusy: boolean;
  runtimeError: string | null;
  runtimeUpgradeBusy: boolean;
  copiedField: string | null;
  events: LaunchEvent[];
  openworkDeepLink: string | null;
  openworkAppConnectUrl: string | null;
  hasWorkspaceScopedUrl: boolean;
  additionalWorkerNeedsPlan: boolean;
  selectedStatusMeta: { label: string; bucket: WorkerStatusBucket };
  isSelectedWorkerFailed: boolean;
  ownedWorkerCount: number;
  refreshWorkers: (options?: { keepSelection?: boolean; quiet?: boolean }) => Promise<void>;
  launchWorker: (options?: { source?: "manual" | "signup_auto"; workerNameOverride?: string }) => Promise<LaunchWorkerResult>;
  checkWorkerStatus: (options?: { workerId?: string; quiet?: boolean; background?: boolean }) => Promise<void>;
  generateWorkerToken: () => Promise<void>;
  renameWorker: (workerId: string, name: string) => Promise<boolean>;
  deleteWorker: (workerId: string) => Promise<void>;
  redeployWorker: (workerId: string) => Promise<void>;
  refreshRuntime: (workerId?: string, options?: { quiet?: boolean }) => Promise<WorkerRuntimeSnapshot | null>;
  upgradeRuntime: () => Promise<void>;
  copyToClipboard: (field: string, value: string | null) => Promise<void>;
  getRuntimeServiceLabel: (name: RuntimeServiceName) => string;
};

const DenFlowContext = createContext<DenFlowContextValue | null>(null);

function getPendingOrgInvitationId() {
  if (typeof window === "undefined") {
    return null;
  }

  const invitationId = window.sessionStorage.getItem(PENDING_ORG_INVITATION_STORAGE_KEY)?.trim() ?? "";
  return invitationId || null;
}

export function DenFlowProvider({ children }: { children: ReactNode }) {
  const [authMode, setAuthModeState] = useState<AuthMode>("sign-up");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authInfo, setAuthInfo] = useState(getAuthInfoForMode("sign-up"));
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (!token || token.trim().length === 0) {
      return null;
    }

    return token;
  });
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [desktopAuthRequested, setDesktopAuthRequested] = useState(false);
  const [desktopAuthScheme, setDesktopAuthScheme] = useState("openwork");
  const [desktopRedirectBusy, setDesktopRedirectBusy] = useState(false);
  const [desktopRedirectUrl, setDesktopRedirectUrl] = useState<string | null>(null);
  const [desktopRedirectAttempted, setDesktopRedirectAttempted] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingCheckoutBusy, setBillingCheckoutBusy] = useState(false);
  const [billingSubscriptionBusy, setBillingSubscriptionBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingLoadedOnce, setBillingLoadedOnce] = useState(false);
  const [orgLimitError, setOrgLimitError] = useState<OrgLimitError | null>(null);

  const [workerName, setWorkerName] = useState(DEFAULT_WORKER_NAME);
  const [worker, setWorker] = useState<WorkerLaunch | null>(null);
  const [workerLookupId, setWorkerLookupId] = useState("");
  const [workers, setWorkers] = useState<WorkerListItem[]>([]);
  const [workersBusy, setWorkersBusy] = useState(false);
  const [workersLoadedOnce, setWorkersLoadedOnce] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [workerQuery, setWorkerQuery] = useState("");
  const [workerStatusFilter, setWorkerStatusFilter] = useState<WorkerStatusBucket | "all">("all");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"status" | "token" | null>(null);
  const [launchStatus, setLaunchStatus] = useState("Choose a worker name and launch.");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [events, setEvents] = useState<LaunchEvent[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [tokenFetchedForWorkerId, setTokenFetchedForWorkerId] = useState<string | null>(null);
  const [deleteBusyWorkerId, setDeleteBusyWorkerId] = useState<string | null>(null);
  const [redeployBusyWorkerId, setRedeployBusyWorkerId] = useState<string | null>(null);
  const [renameBusyWorkerId, setRenameBusyWorkerId] = useState<string | null>(null);
  const [pendingRestoredWorkerId, setPendingRestoredWorkerId] = useState<string | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<WorkerRuntimeSnapshot | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeUpgradeBusy, setRuntimeUpgradeBusy] = useState(false);

  const [onboardingIntent, setOnboardingIntent] = useState<OnboardingIntent | null>(null);
  const onboardingAutoLaunchKeyRef = useRef<string | null>(null);
  const socialSignupHandledRef = useRef<string | null>(null);
  const pendingWorkersRequestRef = useRef<Promise<{ response: Response; payload: unknown }> | null>(null);

  const selectedWorker = workers.find((item) => item.workerId === workerLookupId) ?? null;
  const activeWorker =
    worker && workerLookupId === worker.workerId
      ? worker
      : selectedWorker
        ? listItemToWorker(selectedWorker, worker)
        : worker;
  const openworkConnectUrl = activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null;
  const preferredOpenworkToken = activeWorker?.clientToken ?? activeWorker?.ownerToken ?? null;
  const hasWorkspaceScopedUrl = Boolean(openworkConnectUrl && /\/w\/[^/?#]+/.test(openworkConnectUrl));
  const openworkDeepLink = buildOpenworkDeepLink(
    openworkConnectUrl,
    preferredOpenworkToken,
    activeWorker?.workerId ?? null,
    activeWorker?.workerName ?? null
  );
  const openworkAppConnectUrl = buildOpenworkAppConnectUrl(
    OPENWORK_APP_CONNECT_BASE_URL,
    openworkConnectUrl,
    preferredOpenworkToken,
    activeWorker?.workerId ?? null,
    activeWorker?.workerName ?? null,
    { autoConnect: true }
  );
  const ownedWorkerCount = workers.filter((item) => item.isMine).length;
  const additionalWorkerNeedsPlan = Boolean(
    user &&
      ownedWorkerCount > 0 &&
      billingSummary?.featureGateEnabled &&
      !billingSummary.hasActivePlan
  );
  const selectedWorkerStatus = activeWorker?.status ?? selectedWorker?.status ?? "unknown";
  const selectedStatusMeta = getWorkerStatusMeta(selectedWorkerStatus);
  const isSelectedWorkerFailed = selectedWorkerStatus.trim().toLowerCase() === "failed";
  const effectiveCheckoutUrl = checkoutUrl ?? billingSummary?.checkoutUrl ?? null;
  const onboardingPending = Boolean(onboardingIntent?.shouldLaunch && !onboardingIntent.completed);
  const onboardingDecisionBusy = onboardingPending && !billingLoadedOnce && (billingBusy || billingCheckoutBusy || !sessionHydrated);

  const filteredWorkers = workers.filter((item) => {
    const query = workerQuery.trim().toLowerCase();
    const matchesQuery =
      !query ||
      item.workerName.toLowerCase().includes(query) ||
      item.workerId.toLowerCase().includes(query);

    if (!matchesQuery) {
      return false;
    }

    if (workerStatusFilter === "all") {
      return true;
    }

    return getWorkerStatusMeta(item.status).bucket === workerStatusFilter;
  });

  function persistOnboardingIntent(next: OnboardingIntent | null) {
    setOnboardingIntent(next);

    if (typeof window === "undefined") {
      return;
    }

    if (!next) {
      window.localStorage.removeItem(ONBOARDING_INTENT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(ONBOARDING_INTENT_STORAGE_KEY, JSON.stringify(next));
  }

  function appendEvent(level: LaunchEvent["level"], label: string, detail: string) {
    setEvents((current) => {
      const next: LaunchEvent[] = [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          level,
          label,
          detail,
          at: new Date().toISOString()
        },
        ...current
      ];

      return next.slice(0, 10);
    });
  }

  function markOnboardingComplete() {
    if (!onboardingIntent || onboardingIntent.completed) {
      return;
    }

    persistOnboardingIntent({
      ...onboardingIntent,
      completed: true,
      shouldLaunch: false
    });
  }

  function setAuthMode(mode: AuthMode) {
    setAuthModeState(mode);
    setVerificationRequired(false);
    setVerificationCode("");
    setAuthInfo(getAuthInfoForMode(mode));
    setAuthError(null);
  }

  function openVerificationStep(targetEmail: string, message?: string) {
    setVerificationRequired(true);
    setVerificationCode("");
    setAuthInfo(message ?? `Enter the 6-digit code we sent to ${targetEmail}.`);
    setAuthError(null);
  }

  function cancelVerification() {
    setVerificationRequired(false);
    setVerificationCode("");
    setAuthInfo(getAuthInfoForMode(authMode));
    setAuthError(null);
  }

  async function finalizeEmailPasswordSignIn(
    nextMode: AuthMode,
    trimmedEmail: string,
    payloadOverride?: unknown,
  ): Promise<AuthNavigationResult> {
    let payload = payloadOverride;

    if (payload === undefined || (!getToken(payload) && nextMode === "sign-up" && Boolean(password))) {
      const signInBody = {
        email: trimmedEmail,
        password,
      };

      const signInResult = await requestJson("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify(signInBody)
      });

      if (!signInResult.response.ok) {
        setAuthError(getErrorMessage(signInResult.payload, `Authentication failed with ${signInResult.response.status}.`));
        trackPosthogEvent("den_auth_failed", {
          mode: nextMode,
          method: "email",
          status: signInResult.response.status
        });
        return null;
      }

      payload = signInResult.payload;
    }

    const token = getToken(payload);
    if (token) {
      setAuthToken(token);
    }

    let authenticatedUser: AuthUser | null = null;
    const payloadUser = getUser(payload);
    if (payloadUser) {
      authenticatedUser = payloadUser;
      setUser(payloadUser);
      setAuthInfo(`Signed in as ${payloadUser.email}.`);
      appendEvent("success", nextMode === "sign-up" ? "Account created" : "Signed in", payloadUser.email);
    } else {
      const refreshed = await refreshSession(true);
      if (refreshed) {
        authenticatedUser = refreshed;
        appendEvent("success", nextMode === "sign-up" ? "Account created" : "Signed in", refreshed.email);
      } else {
        setAuthInfo("Authentication succeeded, but session details are still syncing.");
      }
    }

    if (authenticatedUser) {
      identifyPosthogUser(authenticatedUser);
      const analyticsPayload = {
        mode: nextMode,
        method: "email",
        email_domain: getEmailDomain(authenticatedUser.email)
      };

      if (nextMode === "sign-up") {
        trackPosthogEvent("den_signup_completed", analyticsPayload);
      } else {
        trackPosthogEvent("den_signin_completed", analyticsPayload);
      }
    }

    if (desktopAuthRequested) {
      setAuthInfo("Signed in. Returning to OpenWork...");
      return null;
    }

    if (authenticatedUser && getPendingOrgInvitationId()) {
      return "join-org";
    }

    if (authenticatedUser && nextMode === "sign-up") {
      return await beginSignupOnboarding(authenticatedUser, "email");
    }

    return "dashboard" as const;
  }

  async function resendVerificationCode() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setAuthError("Enter your email before requesting a verification code.");
      return;
    }

    setAuthBusy(true);
    setAuthError(null);
    try {
      const { response, payload } = await requestJson("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: JSON.stringify({
          email: trimmedEmail,
          type: "email-verification"
        })
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Could not resend the code (${response.status}).`));
        return;
      }

      setAuthInfo(`We sent a fresh verification code to ${trimmedEmail}.`);
      appendEvent("info", "Verification code resent", trimmedEmail);
      trackPosthogEvent("den_signup_verification_sent", {
        method: "email",
        email_domain: getEmailDomain(trimmedEmail),
      });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not resend the verification code.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitVerificationCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const otp = verificationCode.trim();
    if (!trimmedEmail || !otp) {
      setAuthError("Enter the verification code from your email.");
      return null;
    }

    setAuthBusy(true);
    setAuthError(null);
    try {
      const { response, payload } = await requestJson("/api/auth/email-otp/verify-email", {
        method: "POST",
        body: JSON.stringify({
          email: trimmedEmail,
          otp,
        })
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Verification failed with ${response.status}.`));
        trackPosthogEvent("den_auth_failed", {
          mode: authMode,
          method: "email",
          status: response.status,
          reason: "verification_failed"
        });
        return null;
      }

      setVerificationRequired(false);
      setVerificationCode("");
      setAuthInfo(`Email verified for ${trimmedEmail}. Finishing sign-in...`);
      appendEvent("success", "Email verified", trimmedEmail);
      trackPosthogEvent("den_email_verified", {
        method: "email",
        email_domain: getEmailDomain(trimmedEmail),
      });

      return await finalizeEmailPasswordSignIn(authMode, trimmedEmail, payload);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Verification failed.");
      return null;
    } finally {
      setAuthBusy(false);
    }
  }

  async function withResolvedOpenworkCredentials(candidate: WorkerLaunch, options: { quiet?: boolean } = {}) {
    const existingConnectUrl = candidate.openworkUrl?.trim() ?? "";
    const existingWorkspaceId = candidate.workspaceId?.trim() ?? "";
    if (existingConnectUrl && existingWorkspaceId) {
      return {
        ...candidate,
        openworkUrl: existingConnectUrl,
        workspaceId: existingWorkspaceId
      };
    }

    const instanceUrl = candidate.instanceUrl?.trim() ?? "";
    if (!instanceUrl) {
      return {
        ...candidate,
        openworkUrl: null,
        workspaceId: null
      };
    }

    const accessToken = candidate.clientToken?.trim() ?? candidate.ownerToken?.trim() ?? "";
    if (!accessToken) {
      const mountedWorkspaceId = parseWorkspaceIdFromUrl(instanceUrl);
      return {
        ...candidate,
        openworkUrl: instanceUrl.trim().replace(/\/+$/, ""),
        workspaceId: mountedWorkspaceId
      };
    }

    try {
      const resolved = await resolveOpenworkWorkspaceUrl(instanceUrl, accessToken);
      if (resolved) {
        return {
          ...candidate,
          openworkUrl: resolved.openworkUrl,
          workspaceId: resolved.workspaceId
        };
      }
    } catch {
      if (!options.quiet) {
        appendEvent("warning", "Credential hint", "Could not resolve /w/ URL yet. Using host URL fallback.");
      }
    }

    return {
      ...candidate,
      openworkUrl: instanceUrl.trim().replace(/\/+$/, ""),
      workspaceId: parseWorkspaceIdFromUrl(instanceUrl)
    };
  }

  async function refreshWorkers(options: { keepSelection?: boolean; quiet?: boolean } = {}) {
    if (!user) {
      setWorkers([]);
      setWorkersLoadedOnce(false);
      setWorkersError(null);
      return;
    }

    if (!options.quiet) {
      setWorkersBusy(true);
      setWorkersError(null);
    }

    try {
      if (!pendingWorkersRequestRef.current) {
        pendingWorkersRequestRef.current = requestJson("/v1/workers?limit=20", {
          method: "GET",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
        });
      }

      const { response, payload } = await pendingWorkersRequestRef.current;

      if (!response.ok) {
        if (!options.quiet) {
          setWorkersError(getErrorMessage(payload, `Failed to load workers (${response.status}).`));
        }
        setWorkersLoadedOnce(true);
        return;
      }

      const nextWorkers = getWorkersList(payload);
      setWorkers(nextWorkers);
      setWorkersLoadedOnce(true);

      const restoredWorkerStillExists =
        pendingRestoredWorkerId && nextWorkers.some((item) => item.workerId === pendingRestoredWorkerId);
      const currentSelection = options.keepSelection ? workerLookupId : "";
      const nextSelectedId =
        currentSelection && nextWorkers.some((item) => item.workerId === currentSelection)
          ? currentSelection
          : nextWorkers[0]?.workerId ?? "";
      const nextSelectedWorker = nextSelectedId
        ? nextWorkers.find((item) => item.workerId === nextSelectedId) ?? null
        : null;

      setWorkerLookupId(nextSelectedId);

      if (!nextSelectedId) {
        setWorker(null);
        setTokenFetchedForWorkerId(null);
        setPendingRestoredWorkerId(null);
        setLaunchStatus("Choose a worker name and launch.");
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
        }
        return;
      }

      if (restoredWorkerStillExists) {
        setPendingRestoredWorkerId(null);
      }

      if (nextSelectedWorker) {
        setWorker((current) => listItemToWorker(nextSelectedWorker, current));
        if (!launchBusy) {
          setLaunchStatus(getWorkerStatusCopy(nextSelectedWorker.status));
        }
      }
    } catch (error) {
      if (!options.quiet) {
        setWorkersError(error instanceof Error ? error.message : "Unknown network error");
      }
      setWorkersLoadedOnce(true);
    } finally {
      pendingWorkersRequestRef.current = null;
      if (!options.quiet) {
        setWorkersBusy(false);
      }
    }
  }

  function mergeWorkerSummaryIntoList(summary: WorkerSummary) {
    setWorkers((current) => current.map((entry) =>
      entry.workerId === summary.workerId
        ? {
            ...entry,
            workerName: summary.workerName,
            status: summary.status,
            provider: summary.provider,
            instanceUrl: summary.instanceUrl,
            isMine: summary.isMine,
          }
        : entry,
    ));
  }

  async function refreshRuntime(workerId?: string, options: { quiet?: boolean } = {}) {
    const targetWorkerId = workerId ?? activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!user || !targetWorkerId) {
      setRuntimeSnapshot(null);
      if (!options.quiet) {
        setRuntimeError("Select a worker to inspect runtime versions.");
      }
      return null;
    }

    setRuntimeBusy(true);
    if (!options.quiet) {
      setRuntimeError(null);
    }

    try {
      const { response, payload } = await requestJson(
        `/v1/workers/${encodeURIComponent(targetWorkerId)}/runtime`,
        {
          method: "GET",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
        },
        12000
      );

      if (!response.ok) {
        const message = getErrorMessage(payload, `Runtime check failed with ${response.status}.`);
        if (!options.quiet) {
          setRuntimeError(message);
        }
        return null;
      }

      const snapshot = getWorkerRuntimeSnapshot(payload);
      if (!snapshot) {
        if (!options.quiet) {
          setRuntimeError("Runtime details were missing from the worker response.");
        }
        return null;
      }

      setRuntimeSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!options.quiet) {
        setRuntimeError(message);
      }
      return null;
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function upgradeRuntime() {
    const targetWorkerId = activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!user || !targetWorkerId || runtimeUpgradeBusy) {
      return;
    }

    setRuntimeUpgradeBusy(true);
    setRuntimeError(null);

    try {
      const { response, payload } = await requestJson(
        `/v1/workers/${encodeURIComponent(targetWorkerId)}/runtime/upgrade`,
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          body: JSON.stringify({ services: ["openwork-server", "opencode"] })
        },
        12000
      );

      if (!response.ok) {
        const message = getErrorMessage(payload, `Runtime upgrade failed with ${response.status}.`);
        setRuntimeError(message);
        appendEvent("error", "Runtime upgrade failed", message);
        return;
      }

      appendEvent("info", "Runtime upgrade started", activeWorker?.workerName ?? selectedWorker?.workerName ?? targetWorkerId);
      setRuntimeSnapshot((current) =>
        current
          ? {
              ...current,
              upgrade: {
                ...current.upgrade,
                status: "running",
                startedAt: new Date().toISOString(),
                finishedAt: null,
                error: null
              }
            }
          : current
      );

      window.setTimeout(() => {
        void refreshRuntime(targetWorkerId, { quiet: true });
      }, 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setRuntimeError(message);
      appendEvent("error", "Runtime upgrade failed", message);
    } finally {
      setRuntimeUpgradeBusy(false);
    }
  }

  async function refreshBilling(options: { includeCheckout?: boolean; quiet?: boolean } = {}) {
    if (!user) {
      setBillingSummary(null);
      if (!options.quiet) {
        setBillingError("Sign in to view billing details.");
      }
      return null;
    }

    const includeCheckout = options.includeCheckout === true;
    const quiet = options.quiet === true;

    if (includeCheckout) {
      setBillingCheckoutBusy(true);
    } else {
      setBillingBusy(true);
    }

    if (!quiet) {
      setBillingError(null);
    }

    try {
      const query = includeCheckout ? "?includeCheckout=1" : "";
      const { response, payload } = await requestJson(
        `/v1/workers/billing${query}`,
        {
          method: "GET",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
        },
        12000
      );

      if (!response.ok) {
        const message = getErrorMessage(payload, `Billing lookup failed with ${response.status}.`);
        if (!quiet) {
          setBillingError(message);
          appendEvent("error", "Billing check failed", message);
        }
        return null;
      }

      const summary = getBillingSummary(payload);
      if (!summary) {
        if (!quiet) {
          setBillingError("Billing response was missing details.");
          appendEvent("error", "Billing check failed", "Billing summary missing");
        }
        return null;
      }

      setBillingSummary(summary);
      setBillingLoadedOnce(true);
      if (summary.checkoutUrl) {
        setCheckoutUrl(summary.checkoutUrl);
      } else if (!summary.checkoutRequired) {
        setCheckoutUrl(null);
      }

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!quiet) {
        setBillingError(message);
        appendEvent("error", "Billing check failed", message);
      }
      return null;
    } finally {
      if (includeCheckout) {
        setBillingCheckoutBusy(false);
      } else {
        setBillingBusy(false);
      }
    }
  }

  async function handleSubscriptionCancellation(cancelAtPeriodEnd: boolean) {
    if (!user || billingSubscriptionBusy) {
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
      const { response, payload } = await requestJson(
        "/v1/workers/billing/subscription",
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          body: JSON.stringify({ cancelAtPeriodEnd })
        },
        12000
      );

      if (!response.ok) {
        const message = getErrorMessage(payload, `Subscription update failed (${response.status}).`);
        setBillingError(message);
        appendEvent("error", "Subscription update failed", message);
        return;
      }

      const summary = getBillingSummary(payload);
      if (!summary) {
        setBillingError("Subscription updated, but billing details could not be refreshed.");
        appendEvent("warning", "Subscription updated", "Billing summary missing");
        return;
      }

      setBillingSummary(summary);
      setBillingLoadedOnce(true);
      if (summary.checkoutUrl) {
        setCheckoutUrl(summary.checkoutUrl);
      } else if (!summary.checkoutRequired) {
        setCheckoutUrl(null);
      }

      appendEvent(
        "success",
        cancelAtPeriodEnd ? "Subscription will cancel at period end" : "Subscription auto-renew resumed",
        user.email
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setBillingError(message);
      appendEvent("error", "Subscription update failed", message);
    } finally {
      setBillingSubscriptionBusy(false);
    }
  }

  async function copyToClipboard(field: string, value: string | null) {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1800);
  }

  async function refreshSession(quiet = false) {
    const headers = new Headers();
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    const { response, payload } = await requestJson("/v1/me", { method: "GET", headers }, 12000);

    if (!response.ok) {
      setUser(null);
      if (response.status === 401 && authToken) {
        setAuthToken(null);
      }
      if (!quiet) {
        setAuthError("No active session found. Sign in first.");
      }
      return null;
    }

    const sessionUser = getUser(payload);
    if (!sessionUser) {
      if (!quiet) {
        setAuthError("Session response did not include a user.");
      }
      return null;
    }

    setUser(sessionUser);
    setAuthInfo(`Signed in as ${sessionUser.email}.`);
    return sessionUser;
  }

  async function loadOrgDirectory() {
    const headers = new Headers();
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET", headers }, 12000);
    if (!response.ok) {
      return {
        orgs: [],
        activeOrgId: null,
        activeOrgSlug: null,
      };
    }

    return parseOrgListPayload(payload);
  }

  async function resolveDashboardRoute() {
    const orgDirectory = await loadOrgDirectory();
    const activeOrgSlug = orgDirectory.activeOrgSlug ?? orgDirectory.orgs[0]?.slug ?? null;
    return activeOrgSlug ? getOrgDashboardRoute(activeOrgSlug) : null;
  }

  async function completeDesktopAuthHandoff() {
    if (!desktopAuthRequested || desktopRedirectBusy) {
      return;
    }

    setDesktopRedirectBusy(true);
    setDesktopRedirectAttempted(true);
    setAuthError(null);

    try {
      const headers = new Headers();
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }

      const { response, payload } = await requestJson("/v1/auth/desktop-handoff", {
        method: "POST",
        headers,
        body: JSON.stringify({ desktopScheme: desktopAuthScheme })
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Desktop handoff failed with ${response.status}.`));
        return;
      }

      const openworkPayload = payload as { openworkUrl?: unknown } | null;
      const openworkUrl = typeof openworkPayload?.openworkUrl === "string" ? openworkPayload.openworkUrl.trim() : "";
      if (!openworkUrl) {
        setAuthError("Desktop handoff succeeded, but no OpenWork redirect URL was returned.");
        return;
      }

      setDesktopRedirectUrl(openworkUrl);
      window.location.assign(openworkUrl);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to open OpenWork.");
    } finally {
      setDesktopRedirectBusy(false);
    }
  }

  async function beginSignupOnboarding(authenticatedUser: AuthUser, _authMethod: AuthMethod) {
    const autoName = deriveOnboardingWorkerName(authenticatedUser);
    setWorkerName(autoName);
    setLaunchError(null);
    setLaunchStatus("Create a workspace to get started.");
    persistOnboardingIntent(null);
    return "dashboard" as const;
  }

  async function resolveUserLandingRoute() {
    if (!user || desktopAuthRequested) {
      return null;
    }

    const pendingInvitationId = getPendingOrgInvitationId();
    if (pendingInvitationId) {
      return getJoinOrgRoute(pendingInvitationId);
    }

    const dashboardRoute = await resolveDashboardRoute();

    if (dashboardRoute) {
      return dashboardRoute;
    }

    return "/organization";
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setAuthBusy(true);
    setAuthError(null);
    trackPosthogEvent("den_auth_submitted", {
      mode: authMode,
      method: "email"
    });

    try {
      const endpoint = authMode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const trimmedEmail = email.trim();
      const body =
        authMode === "sign-up"
          ? {
              name: DEFAULT_AUTH_NAME,
              email: trimmedEmail,
              password
            }
          : {
              email: trimmedEmail,
              password
            };

      const { response, payload } = await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        if (response.status === 403) {
          openVerificationStep(trimmedEmail, `Enter the 6-digit code we sent to ${trimmedEmail} to finish verifying your email.`);
        }
        setAuthError(getErrorMessage(payload, `Authentication failed with ${response.status}.`));
        trackPosthogEvent("den_auth_failed", {
          mode: authMode,
          method: "email",
          status: response.status
        });
        return null;
      }

      const token = getToken(payload);

      if (authMode === "sign-up" && !token) {
        setUser(null);
        openVerificationStep(trimmedEmail, `We emailed a 6-digit verification code to ${trimmedEmail}. Enter it below to finish creating your account.`);
        appendEvent("info", "Verification code sent", trimmedEmail);
        trackPosthogEvent("den_signup_verification_sent", {
          method: "email",
          email_domain: getEmailDomain(trimmedEmail),
        });
        return null;
      }
      return await finalizeEmailPasswordSignIn(authMode, trimmedEmail);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setAuthError(message);
      trackPosthogEvent("den_auth_failed", {
        mode: authMode,
        method: "email",
        reason: "network_error"
      });
      return null;
    } finally {
      setAuthBusy(false);
    }
  }

  async function beginSocialAuth(provider: SocialAuthProvider) {
    if (authBusy || typeof window === "undefined") {
      return;
    }

    const shouldTrackSocialSignup = authMode === "sign-up";
    if (shouldTrackSocialSignup) {
      window.sessionStorage.setItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY, provider);
    }

    setAuthBusy(true);
    setAuthError(null);
    setAuthInfo(`Redirecting to ${getSocialProviderLabel(provider)}...`);
    trackPosthogEvent("den_auth_submitted", {
      mode: authMode,
      method: provider
    });

    try {
      const callbackURL = getSocialCallbackUrl();
      const { response, payload } = await requestJson("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider,
          callbackURL,
          errorCallbackURL: callbackURL
        })
      });

      if (!response.ok) {
        if (shouldTrackSocialSignup) {
          window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
        }
        setAuthInfo(getAuthInfoForMode(authMode));
        setAuthError(getErrorMessage(payload, `${getSocialProviderLabel(provider)} sign-in failed with ${response.status}.`));
        setAuthBusy(false);
        return;
      }

      const socialPayload = payload as { url?: unknown } | null;
      const payloadUrl = typeof socialPayload?.url === "string" ? socialPayload.url.trim() : "";
      const headerUrl = response.headers.get("location")?.trim() ?? "";
      const redirectUrl = payloadUrl || headerUrl;

      if (!redirectUrl) {
        if (shouldTrackSocialSignup) {
          window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
        }
        setAuthInfo(getAuthInfoForMode(authMode));
        setAuthError(`${getSocialProviderLabel(provider)} sign-in did not return a redirect URL.`);
        setAuthBusy(false);
        return;
      }

      window.location.assign(redirectUrl);
    } catch (error) {
      if (shouldTrackSocialSignup) {
        window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
      }
      setAuthInfo(getAuthInfoForMode(authMode));
      setAuthError(error instanceof Error ? error.message : "Unknown network error");
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (authBusy) {
      return;
    }

    setAuthBusy(true);
    setAuthError(null);

    try {
      await requestJson("/api/auth/sign-out", {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });
    } catch {
      // Ignore transport issues and clear local state anyway.
    } finally {
      setAuthBusy(false);
    }

    setUser(null);
    setAuthToken(null);
    setWorker(null);
    setWorkers([]);
    setWorkerLookupId("");
    setWorkersError(null);
    setLaunchError(null);
    setCheckoutUrl(null);
    setBillingSummary(null);
    setBillingError(null);
    setOrgLimitError(null);
    setBillingBusy(false);
    setBillingCheckoutBusy(false);
    setBillingSubscriptionBusy(false);
    setBillingLoadedOnce(false);
    setTokenFetchedForWorkerId(null);
    setDeleteBusyWorkerId(null);
    setActionBusy(null);
    setLaunchBusy(false);
    setRuntimeSnapshot(null);
    setRuntimeError(null);
    setRuntimeUpgradeBusy(false);
    setPendingRestoredWorkerId(null);
    setDesktopRedirectUrl(null);
    setDesktopRedirectAttempted(false);
    setAuthMode("sign-up");
    setEmail("");
    setPassword("");
    setAuthInfo(getAuthInfoForMode("sign-up"));
    setLaunchStatus("Choose a worker name and launch.");
    setEvents([]);
    setWorkerQuery("");
    setWorkerStatusFilter("all");
    setWorkerName(DEFAULT_WORKER_NAME);
    persistOnboardingIntent(null);
    resetPosthogUser();
    trackPosthogEvent("den_signout_completed", { method: "manual" });

    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
    }
  }

  async function launchWorker(options: { source?: "manual" | "signup_auto"; workerNameOverride?: string } = {}) {
    if (!user) {
      setAuthError("Sign in before launching a worker.");
      return "error" as const;
    }

    const resolvedLaunchName = options.workerNameOverride?.trim() || workerName.trim() || DEFAULT_WORKER_NAME;

    setLaunchBusy(true);
    setLaunchError(null);
    setOrgLimitError(null);
    setCheckoutUrl(null);
    setLaunchStatus(options.source === "signup_auto" ? "Creating your first worker..." : "Checking worker billing and launch eligibility...");
    appendEvent("info", "Launch requested", resolvedLaunchName);

    try {
      const { response, payload } = await requestJson(
        "/v1/workers",
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          body: JSON.stringify({
            name: resolvedLaunchName,
            destination: "cloud"
          })
        },
        12000
      );

      const limitError = getOrgLimitError(payload);
      if (limitError) {
        setOrgLimitError(limitError);
        setLaunchStatus(limitError.message);
        setLaunchError(limitError.message);
        appendEvent("warning", "Workspace limit reached", limitError.message);
        return "limit" as const;
      }

      if (response.status === 402) {
        const url = getCheckoutUrl(payload);
        setCheckoutUrl(url);
        setBillingSummary((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            hasActivePlan: false,
            checkoutRequired: true,
            checkoutUrl: url ?? current.checkoutUrl
          };
        });
        setLaunchStatus("Payment is required. Complete checkout and return to continue launch.");
        setLaunchError(url ? null : "Checkout URL missing from paywall response.");
        appendEvent("warning", "Paywall required", url ? "Checkout URL generated" : "Checkout URL missing");
        if (!url) {
          void refreshBilling({ includeCheckout: true, quiet: true });
        }
        return "checkout" as const;
      }

      if (!response.ok) {
        const message = getErrorMessage(payload, `Launch failed with ${response.status}.`);
        setLaunchError(message);
        setLaunchStatus("Launch failed. Fix the error and retry.");
        appendEvent("error", "Launch failed", message);
        return "error" as const;
      }

      const parsedWorker = getWorker(payload);
      if (!parsedWorker) {
        setLaunchError("Launch response was missing worker details.");
        setLaunchStatus("Launch response format was unexpected.");
        appendEvent("error", "Launch failed", "Worker payload missing");
        return "error" as const;
      }

      const resolvedWorker = await withResolvedOpenworkCredentials(parsedWorker);
      setWorker(resolvedWorker);
      setWorkerLookupId(parsedWorker.workerId);
      setPendingRestoredWorkerId(null);
      setCheckoutUrl(null);

      if (resolvedWorker.status === "provisioning") {
        setLaunchStatus("Provisioning started. We will keep checking automatically.");
        appendEvent("info", "Provisioning started", `Worker ID ${parsedWorker.workerId}`);
      } else {
        setLaunchStatus(getWorkerStatusCopy(resolvedWorker.status));
        appendEvent("success", "Worker launched", `Worker ID ${parsedWorker.workerId}`);
      }

      markOnboardingComplete();
      return "success" as const;
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Launch request took longer than expected. Provisioning can continue in the background. Refresh worker status below."
          : error instanceof Error
            ? error.message
            : "Unknown network error";

      setLaunchError(message);
      setLaunchStatus("Launch request failed.");
      appendEvent("error", "Launch failed", message);
      return "error" as const;
    } finally {
      setLaunchBusy(false);
      void refreshWorkers({ keepSelection: true });
    }
  }

  async function checkWorkerStatus(options: { workerId?: string; quiet?: boolean; background?: boolean } = {}) {
    const quiet = options.quiet === true;
    const background = options.background === true;

    if (!user) {
      if (!quiet) {
        setLaunchError("Sign in before checking worker status.");
      }
      return;
    }

    const fallbackId = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    const id = options.workerId ?? fallbackId;
    if (!id) {
      if (!quiet) {
        setLaunchError("No worker selected yet. Launch one first, then use this panel.");
      }
      return;
    }

    if (!background) {
      setWorkerLookupId(id);
    }

    if (!background) {
      setActionBusy("status");
    }
    if (!quiet) {
      setLaunchError(null);
    }

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Status check failed with ${response.status}.`);
        if (!quiet) {
          setLaunchError(message);
          appendEvent("error", "Status check failed", message);
        }
        return;
      }

      const summary = getWorkerSummary(payload);
      if (!summary) {
        if (!quiet) {
          setLaunchError("Status response was missing worker details.");
          appendEvent("error", "Status check failed", "Worker summary missing");
        }
        return;
      }

      mergeWorkerSummaryIntoList(summary);

      const previousStatus = worker?.workerId === summary.workerId ? worker.status : null;
      const nextWorker: WorkerLaunch =
        worker && worker.workerId === summary.workerId
          ? {
              ...worker,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl
            }
          : {
              workerId: summary.workerId,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl,
              openworkUrl: summary.instanceUrl,
              workspaceId: null,
              clientToken: null,
              ownerToken: null,
              hostToken: null
            };

      const shouldUpdateActiveWorker = worker?.workerId === summary.workerId || (!background && workerLookupId === summary.workerId);
      if (shouldUpdateActiveWorker) {
        const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
        setWorker(resolvedWorker);
        setPendingRestoredWorkerId(null);
        if (!background) {
          setWorkerLookupId(summary.workerId);
        }
      }

      if (!quiet) {
        setLaunchStatus(`Worker ${summary.workerName} is currently ${summary.status}.`);
        appendEvent("info", "Status refreshed", `${summary.workerName}: ${summary.status}`);
      } else if (previousStatus && previousStatus !== summary.status) {
        setLaunchStatus(getWorkerStatusCopy(summary.status));

        if (summary.status === "healthy") {
          appendEvent("success", "Provisioning complete", `${summary.workerName} is ready`);
          markOnboardingComplete();
        } else if (summary.status === "failed") {
          appendEvent("error", "Provisioning failed", `${summary.workerName} failed to provision`);
        } else {
          appendEvent("info", "Provisioning update", `${summary.workerName}: ${summary.status}`);
        }
      }

    } catch (error) {
      if (!quiet) {
        setLaunchError(error instanceof Error ? error.message : "Unknown network error");
      }
    } finally {
      if (!background) {
        setActionBusy(null);
      }
    }
  }

  async function generateWorkerToken() {
    if (!user) {
      setLaunchError("Sign in before fetching a worker access token.");
      return;
    }

    const id = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    if (!id) {
      setLaunchError("No worker selected yet. Launch one first, then fetch a token.");
      return;
    }

    setWorkerLookupId(id);
    setActionBusy("token");
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}/tokens`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Token fetch failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Token fetch failed", message);
        return;
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        setLaunchError("Token response returned no token values.");
        appendEvent("error", "Token fetch failed", "Missing token payload");
        return;
      }

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === id
          ? {
              ...worker,
              openworkUrl: tokens.openworkUrl ?? worker.openworkUrl,
              workspaceId: tokens.workspaceId ?? worker.workspaceId,
              clientToken: tokens.clientToken,
              ownerToken: tokens.ownerToken,
              hostToken: tokens.hostToken
            }
          : {
              workerId: id,
              workerName: "Existing worker",
              status: "unknown",
              provider: null,
              instanceUrl: null,
              openworkUrl: tokens.openworkUrl,
              workspaceId: tokens.workspaceId,
              clientToken: tokens.clientToken,
              ownerToken: tokens.ownerToken,
              hostToken: tokens.hostToken
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker(resolvedWorker);
      setPendingRestoredWorkerId(null);
      setLaunchStatus("Worker is ready to connect.");
      appendEvent("success", "Owner token ready", `Worker ID ${id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Token fetch failed", message);
    } finally {
      setActionBusy(null);
    }
  }

  async function renameWorker(workerId: string, name: string) {
    if (!user) {
      setLaunchError("Sign in before renaming a worker.");
      return false;
    }

    const nextName = name.trim();
    if (!nextName) {
      setLaunchError("Enter a worker name.");
      return false;
    }

    setRenameBusyWorkerId(workerId);
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "PATCH",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({ name: nextName })
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Rename failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Rename failed", message);
        return false;
      }

      setWorkers((current) => current.map((entry) => entry.workerId === workerId ? { ...entry, workerName: nextName } : entry));
      setWorker((current) => current && current.workerId === workerId ? { ...current, workerName: nextName } : current);
      setLaunchStatus(`Renamed worker to ${nextName}.`);
      appendEvent("success", "Worker renamed", nextName);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Rename failed", message);
      return false;
    } finally {
      setRenameBusyWorkerId(null);
    }
  }

  async function deleteWorker(workerId: string) {
    if (!user) {
      setLaunchError("Sign in before deleting a worker.");
      return;
    }

    if (deleteBusyWorkerId || redeployBusyWorkerId || actionBusy !== null || launchBusy) {
      return;
    }

    const target = workers.find((entry) => entry.workerId === workerId) ?? null;
    const workerLabel = target?.workerName ?? "this worker";

    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete \"${workerLabel}\"? This removes it from your worker list.`);
      if (!confirmed) {
        return;
      }
    }

    setDeleteBusyWorkerId(workerId);
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "DELETE",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (response.status !== 204 && !response.ok) {
        const message = getErrorMessage(payload, `Delete failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Delete failed", message);
        return;
      }

      setWorkers((current) => current.filter((entry) => entry.workerId !== workerId));
      setWorker((current) => (current && current.workerId === workerId ? null : current));
      setPendingRestoredWorkerId((current) => (current === workerId ? null : current));
      setWorkerLookupId((current) => (current === workerId ? "" : current));

      if (typeof window !== "undefined" && worker?.workerId === workerId) {
        window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
      }

      setLaunchStatus(`Deleted ${workerLabel}.`);
      appendEvent("success", "Worker deleted", workerLabel);
      await refreshWorkers({ keepSelection: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Delete failed", message);
    } finally {
      setDeleteBusyWorkerId(null);
    }
  }

  async function redeployWorker(workerId: string) {
    if (!user) {
      setLaunchError("Sign in before redeploying a worker.");
      return;
    }

    if (redeployBusyWorkerId || deleteBusyWorkerId || actionBusy !== null || launchBusy) {
      return;
    }

    const target = workers.find((entry) => entry.workerId === workerId) ?? null;
    const workerLabel = target?.workerName?.trim() || DEFAULT_WORKER_NAME;

    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Redeploy \"${workerLabel}\"? This removes the current worker and creates a new one with the same name.`);
      if (!confirmed) {
        return;
      }
    }

    setRedeployBusyWorkerId(workerId);
    setLaunchError(null);
    setCheckoutUrl(null);
    setLaunchStatus(`Redeploying ${workerLabel}...`);
    appendEvent("info", "Redeploy requested", workerLabel);

    try {
      const { response: deleteResponse, payload: deletePayload } = await requestJson(`/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "DELETE",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (deleteResponse.status !== 204 && !deleteResponse.ok) {
        const message = getErrorMessage(deletePayload, `Redeploy failed while deleting (${deleteResponse.status}).`);
        setLaunchError(message);
        appendEvent("error", "Redeploy failed", message);
        return;
      }

      const outcome = await launchWorker({ source: "manual", workerNameOverride: workerLabel });
      if (outcome === "success") {
        appendEvent("success", "Worker redeployed", workerLabel);
      }
    } finally {
      setRedeployBusyWorkerId(null);
      void refreshWorkers({ keepSelection: true });
    }
  }

  async function refreshCheckoutReturn(sessionTokenPresent: boolean) {
    if (sessionTokenPresent) {
      setCheckoutUrl(null);
      setLaunchStatus("Checkout return detected. Billing is refreshing now.");
      appendEvent("success", "Returned from checkout", sessionTokenPresent ? "Polar session token received" : "Return detected");
      trackPosthogEvent("den_paywall_checkout_returned", {
        source: "polar",
        session_token_present: sessionTokenPresent
      });
    }

    const summary = await refreshBilling({ includeCheckout: false, quiet: true });
    if (!summary) {
      return "/checkout" as const;
    }

    if (!summary.featureGateEnabled || summary.hasActivePlan) {
      return (await resolveUserLandingRoute()) ?? "/organization";
    }

    return "/checkout" as const;
  }

  function selectWorker(item: WorkerListItem) {
    setWorkerLookupId(item.workerId);
    setWorker((current) => listItemToWorker(item, current));
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const requestedMode = normalizeAuthModeParam(params.get("mode"));
    if (requestedMode) {
      setAuthMode(requestedMode);
    }

    setDesktopAuthRequested(params.get("desktopAuth") === "1");
    const requestedScheme = params.get("desktopScheme")?.trim() ?? "";
    if (/^[a-z][a-z0-9+.-]*$/i.test(requestedScheme)) {
      setDesktopAuthScheme(requestedScheme);
    }

    const invitationId = params.get("invite")?.trim() ?? "";
    if (invitationId) {
      window.sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, invitationId);
    }
  }, []);

  useEffect(() => {
    if (authToken) {
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken);
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;

    const hydrateSession = async () => {
      await refreshSession(true);
      if (!cancelled) {
        setSessionHydrated(true);
      }
    };

    void hydrateSession();

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (!user) {
      setWorkers([]);
      setWorkersLoadedOnce(false);
      setWorkersError(null);
      return;
    }

    void refreshWorkers();
  }, [user?.id, authToken]);

  useEffect(() => {
    if (!user) {
      setBillingSummary(null);
      setBillingError(null);
      setBillingLoadedOnce(false);
      return;
    }

    void refreshBilling({ quiet: true });
  }, [user?.id, authToken]);

  useEffect(() => {
    if (!user) {
      return;
    }

    identifyPosthogUser(user);
  }, [user?.id]);

  useEffect(() => {
    if (!user || typeof window === "undefined") {
      return;
    }

    const pendingSocialSignup = window.sessionStorage.getItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
    if (pendingSocialSignup !== "github" && pendingSocialSignup !== "google") {
      return;
    }
    if (socialSignupHandledRef.current === user.id) {
      return;
    }

    socialSignupHandledRef.current = user.id;
    window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
    trackPosthogEvent("den_signup_completed", {
      mode: "sign-up",
      method: pendingSocialSignup,
      email_domain: getEmailDomain(user.email)
    });

    if (getPendingOrgInvitationId()) {
      return;
    }

    void beginSignupOnboarding(user, pendingSocialSignup);
  }, [user?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(LAST_WORKER_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isWorkerLaunch(parsed)) {
        return;
      }

      const restored: WorkerLaunch = {
        ...parsed,
        openworkUrl: parsed.openworkUrl ?? parsed.instanceUrl,
        workspaceId: parsed.workspaceId ?? parseWorkspaceIdFromUrl(parsed.instanceUrl ?? ""),
        clientToken: null,
        ownerToken: null,
        hostToken: null
      };

      setWorker(restored);
      setWorkerLookupId(restored.workerId);
      setPendingRestoredWorkerId(restored.workerId);
      setLaunchStatus(`Recovered worker ${restored.workerName}. ${getWorkerStatusCopy(restored.status)}`);
      appendEvent("info", "Recovered worker context", `Worker ID ${restored.workerId}`);
    } catch {
      // Ignore invalid saved worker state.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !worker) {
      return;
    }

    const serializable: WorkerLaunch = {
      ...worker,
      clientToken: null,
      ownerToken: null,
      hostToken: null
    };

    window.localStorage.setItem(LAST_WORKER_STORAGE_KEY, JSON.stringify(serializable));
  }, [worker]);

  useEffect(() => {
    if (!user || !worker) {
      return;
    }
    if (pendingRestoredWorkerId === worker.workerId) {
      return;
    }
    if (worker.ownerToken || worker.clientToken) {
      return;
    }
    if (actionBusy !== null || launchBusy) {
      return;
    }
    if (tokenFetchedForWorkerId === worker.workerId) {
      return;
    }

    setTokenFetchedForWorkerId(worker.workerId);
    void generateWorkerToken();
  }, [actionBusy, launchBusy, pendingRestoredWorkerId, tokenFetchedForWorkerId, user, worker]);

  const provisioningWorkerIds = workers
    .filter((item) => item.status === "provisioning")
    .map((item) => item.workerId);

  useEffect(() => {
    if (!user || provisioningWorkerIds.length === 0) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      if (cancelled || actionBusy !== null || launchBusy) {
        return;
      }

      await Promise.all(
        provisioningWorkerIds.map((workerId) =>
          checkWorkerStatus({ workerId, quiet: true, background: true }),
        ),
      );
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, WORKER_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [actionBusy, launchBusy, provisioningWorkerIds.join(","), user?.id]);

  useEffect(() => {
    const targetWorkerId = activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!user || !targetWorkerId || pendingRestoredWorkerId === targetWorkerId) {
      setRuntimeSnapshot(null);
      setRuntimeError(null);
      return;
    }

    void refreshRuntime(targetWorkerId, { quiet: true });
  }, [user?.id, authToken, activeWorker?.workerId, pendingRestoredWorkerId, selectedWorker?.workerId]);

  useEffect(() => {
    const targetWorkerId = activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!targetWorkerId || runtimeSnapshot?.upgrade.status !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshRuntime(targetWorkerId, { quiet: true });
    }, WORKER_STATUS_POLL_MS);

    return () => window.clearInterval(timer);
  }, [activeWorker?.workerId, selectedWorker?.workerId, runtimeSnapshot?.upgrade.status]);

  useEffect(() => {
    if (!desktopAuthRequested || !user || desktopRedirectUrl || desktopRedirectBusy || desktopRedirectAttempted) {
      return;
    }

    void completeDesktopAuthHandoff();
  }, [desktopAuthRequested, user?.id, authToken, desktopRedirectUrl, desktopRedirectBusy, desktopRedirectAttempted, desktopAuthScheme]);

  useEffect(() => {
    if (!user || !onboardingPending) {
      onboardingAutoLaunchKeyRef.current = null;
      return;
    }

    if (!billingSummary) {
      return;
    }

    if (billingSummary.featureGateEnabled && !billingSummary.hasActivePlan) {
      return;
    }

    if (ownedWorkerCount > 0) {
      markOnboardingComplete();
      return;
    }

    if (launchBusy) {
      return;
    }

    const autoLaunchKey = `${user.id}:${onboardingIntent?.workerName ?? DEFAULT_WORKER_NAME}`;
    if (onboardingAutoLaunchKeyRef.current === autoLaunchKey) {
      return;
    }

    onboardingAutoLaunchKeyRef.current = autoLaunchKey;
    markOnboardingComplete();
  }, [billingSummary?.featureGateEnabled, billingSummary?.hasActivePlan, launchBusy, onboardingIntent?.workerName, onboardingPending, ownedWorkerCount, user?.id]);

  useEffect(() => {
    if (!user) {
      return;
    }

    if ((workerName === DEFAULT_WORKER_NAME || workerName.trim().length === 0) && !onboardingPending) {
      setWorkerName(deriveOnboardingWorkerName(user));
    }
  }, [onboardingPending, user?.id, workerName]);

  const showAuthFeedback = authInfo !== getAuthInfoForMode(authMode) || authError !== null;

  const value: DenFlowContextValue = {
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    verificationCode,
    setVerificationCode,
    verificationRequired,
    authBusy,
    authInfo,
    authError,
    user,
    sessionHydrated,
    desktopAuthRequested,
    desktopAuthScheme,
    desktopRedirectUrl,
    desktopRedirectBusy,
    showAuthFeedback,
    submitAuth,
    submitVerificationCode,
    resendVerificationCode,
    cancelVerification,
    beginSocialAuth,
    signOut,
    resolveUserLandingRoute,
    billingSummary,
    billingBusy,
    billingCheckoutBusy,
    billingSubscriptionBusy,
    billingError,
    effectiveCheckoutUrl,
    orgLimitError,
    clearOrgLimitError: () => setOrgLimitError(null),
    refreshBilling,
    handleSubscriptionCancellation,
    refreshCheckoutReturn,
    onboardingPending,
    onboardingDecisionBusy,
    workers,
    filteredWorkers,
    workersBusy,
    workersLoadedOnce,
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
    renameBusyWorkerId,
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
    refreshWorkers,
    launchWorker,
    checkWorkerStatus,
    generateWorkerToken,
    renameWorker,
    deleteWorker,
    redeployWorker,
    refreshRuntime,
    upgradeRuntime,
    copyToClipboard,
    getRuntimeServiceLabel,
  };

  return createElement(DenFlowContext.Provider, { value }, children);
}

export function useDenFlow() {
  const value = useContext(DenFlowContext);
  if (!value) {
    throw new Error("useDenFlow must be used within DenFlowProvider.");
  }
  return value;
}
