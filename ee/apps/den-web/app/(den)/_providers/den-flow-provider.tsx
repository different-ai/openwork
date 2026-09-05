"use client";

import { createContext, createElement, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AUTH_TOKEN_STORAGE_KEY,
  DEFAULT_AUTH_NAME,
  DEFAULT_WORKER_NAME,
  LAST_WORKER_STORAGE_KEY,
  ONBOARDING_INTENT_STORAGE_KEY,
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
  getEmailDomain,
  getErrorMessage,
  getOrgLimitError,
  getRuntimeServiceLabel,
  getSocialCallbackUrl,
  getSocialProviderLabel,
  getToken,
  getUser,
  getWorker,
  getWorkerConnectionTargets,
  getWorkerConnectionTokens,
  getWorkerConnectionRefreshDelay,
  getWorkerConnectionPollDelay,
  getWorkerRuntimeSnapshot,
  getWorkerStatusCopy,
  getWorkerStatusMeta,
  getWorkerSummary,
  getWorkerTokens,
  getWorkersList,
  identifyPosthogUser,
  isWorkerLaunch,
  listItemToWorker,
  normalizeAuthIntentParam,
  normalizeAuthModeParam,
  PENDING_AUTH_INTENT_STORAGE_KEY,
  parseWorkspaceIdFromUrl,
  requestJson,
  resetPosthogUser,
  resolveOpenworkWorkspaceUrl,
  withWorkerConnection,
  workerConnectionEquals,
  workerNeedsConnectionResolution,
  trackPosthogEvent
} from "../_lib/den-flow";
import { EMPTY_RUNTIME_CONFIG, getRuntimeConfig, type DenWebRuntimeConfig } from "../_lib/runtime-config";
import {
  getDesktopHandoffGrant,
  getDesktopHandoffOpenworkUrl,
  rememberDesktopHandoffGrant,
} from "../_lib/desktop-handoff";
import {
  PENDING_ORG_INVITATION_STORAGE_KEY,
  PENDING_WORKSPACE_CLAIM_STORAGE_KEY,
  getInferenceRoute,
  getJoinOrgRoute,
  getOrgDashboardRoute,
  getWorkspaceClaimRoute,
  parseOrgListPayload,
} from "../_lib/den-org";
import { requestOrgSelectionOnNextLoad } from "../_lib/org-selection";

type LaunchWorkerResult = "success" | "limit" | "error";
type AuthNavigationResult = "dashboard" | "join-org" | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSignupPasswordFeedback(payload: unknown) {
  return isRecord(payload)
    && (payload.error === "password_too_short" || payload.error === "password_too_weak" || payload.error === "password_compromised");
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getSignupPasswordFeedback(payload: unknown, fallback: string) {
  if (!isRecord(payload)) {
    return [fallback];
  }

  const feedback = isRecord(payload.feedback) ? payload.feedback : null;
  const messages = [
    typeof feedback?.warning === "string" ? feedback.warning.trim() : "",
    ...readStringArray(feedback?.suggestions).map((suggestion) => suggestion.trim()),
  ].filter((message) => message.length > 0);

  return messages.length > 0 ? messages : [fallback];
}

type DenFlowContextValue = {
  authMode: AuthMode;
  setAuthMode: (mode: AuthMode) => void;
  email: string;
  setEmail: (value: string) => void;
  authName: string;
  setAuthName: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  verificationCode: string;
  setVerificationCode: (value: string) => void;
  verificationRequired: boolean;
  authBusy: boolean;
  authInfo: string;
  authError: string | null;
  signupPasswordFeedback: string[];
  user: AuthUser | null;
  sessionHydrated: boolean;
  desktopAuthRequested: boolean;
  desktopAuthScheme: string;
  webAuthRequested: boolean;
  desktopRedirectUrl: string | null;
  desktopRedirectBusy: boolean;
  showAuthFeedback: boolean;
  submitAuth: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  submitVerificationCode: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  resendVerificationCode: () => Promise<void>;
  cancelVerification: () => void;
  beginSocialAuth: (provider: SocialAuthProvider) => Promise<void>;
  signOut: () => Promise<void>;
  updateUserProfile: (input: { firstName: string; lastName: string }) => Promise<AuthUser>;
  resolveUserLandingRoute: () => Promise<string | null>;
  billingSummary: BillingSummary | null;
  billingBusy: boolean;
  billingError: string | null;
  orgLimitError: OrgLimitError | null;
  clearOrgLimitError: () => void;
  refreshBilling: (options?: { quiet?: boolean }) => Promise<BillingSummary | null>;
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
  runtimeConfig: DenWebRuntimeConfig;
  runtimeConfigLoaded: boolean;
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

function getPendingWorkspaceClaimToken() {
  if (typeof window === "undefined") {
    return null;
  }

  const token = window.sessionStorage.getItem(PENDING_WORKSPACE_CLAIM_STORAGE_KEY)?.trim() ?? "";
  return token || null;
}

function getPendingAuthIntent() {
  if (typeof window === "undefined") {
    return null;
  }

  return normalizeAuthIntentParam(window.sessionStorage.getItem(PENDING_AUTH_INTENT_STORAGE_KEY));
}

function clearPendingAuthIntent() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(PENDING_AUTH_INTENT_STORAGE_KEY);
}

export function DenFlowProvider({ children }: { children: ReactNode }) {
  const [authMode, setAuthModeState] = useState<AuthMode>("sign-up");
  const [email, setEmail] = useState("");
  const [authName, setAuthName] = useState("");
  const [password, setPasswordState] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authInfo, setAuthInfo] = useState(getAuthInfoForMode("sign-up"));
  const [authError, setAuthError] = useState<string | null>(null);
  const [signupPasswordFeedback, setSignupPasswordFeedback] = useState<string[]>([]);
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
  const [webAuthRequested, setWebAuthRequested] = useState(false);
  const [webAuthReturnUrl, setWebAuthReturnUrl] = useState<string | null>(null);
  const [desktopRedirectBusy, setDesktopRedirectBusy] = useState(false);
  const [desktopRedirectUrl, setDesktopRedirectUrl] = useState<string | null>(null);
  const [desktopRedirectAttempted, setDesktopRedirectAttempted] = useState(false);
  const [webRedirectBusy, setWebRedirectBusy] = useState(false);
  const [webRedirectAttempted, setWebRedirectAttempted] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
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
  const [deleteBusyWorkerId, setDeleteBusyWorkerId] = useState<string | null>(null);
  const [redeployBusyWorkerId, setRedeployBusyWorkerId] = useState<string | null>(null);
  const [renameBusyWorkerId, setRenameBusyWorkerId] = useState<string | null>(null);
  const [pendingRestoredWorkerId, setPendingRestoredWorkerId] = useState<string | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<WorkerRuntimeSnapshot | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeUpgradeBusy, setRuntimeUpgradeBusy] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<DenWebRuntimeConfig>(EMPTY_RUNTIME_CONFIG);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const isSingleOrgMode = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";

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
  const { desktopUrl: openworkConnectUrl, webUrl: previewConnectUrl } = getWorkerConnectionTargets(activeWorker);
  const { desktopToken: desktopOpenworkToken, webToken: webOpenworkToken } = getWorkerConnectionTokens(activeWorker);
  const hasWorkspaceScopedUrl = Boolean(openworkConnectUrl && /\/w\/[^/?#]+/.test(openworkConnectUrl));
  const openworkDeepLink = buildOpenworkDeepLink(
    openworkConnectUrl,
    desktopOpenworkToken,
    activeWorker?.workerId ?? null,
    activeWorker?.workerName ?? null
  );
  const openworkAppConnectUrl = buildOpenworkAppConnectUrl(
    runtimeConfig.openworkAppConnectUrl,
    previewConnectUrl,
    webOpenworkToken,
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
  const onboardingPending = Boolean(onboardingIntent?.shouldLaunch && !onboardingIntent.completed);
  const onboardingDecisionBusy = onboardingPending && !billingLoadedOnce && (billingBusy || !sessionHydrated);

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
    setSignupPasswordFeedback([]);
  }

  function setPassword(value: string) {
    setPasswordState(value);
    setSignupPasswordFeedback([]);
  }

  function openVerificationStep(targetEmail: string, message?: string) {
    setVerificationRequired(true);
    setVerificationCode("");
    setAuthInfo(message ?? `Enter the 6-digit code we sent to ${targetEmail}.`);
    setAuthError(null);
    setSignupPasswordFeedback([]);
  }

  function cancelVerification() {
    setVerificationRequired(false);
    setVerificationCode("");
    setAuthInfo(getAuthInfoForMode(authMode));
    setAuthError(null);
    setSignupPasswordFeedback([]);
  }

  async function redirectToRequiredSso(trimmedEmail: string) {
    const { response, payload } = await requestJson(`/api/auth/sso-resolve?email=${encodeURIComponent(trimmedEmail)}`, { method: "GET" }, 12000);

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, response.status === 403 ? "We could not verify this sign-in attempt. Please refresh and try again." : `Could not resolve workspace SSO (${response.status}).`));
    }

    const method = typeof (payload as { method?: unknown } | null)?.method === "string"
      ? (payload as { method: string }).method
      : "";
    if (method !== "sso") {
      return false;
    }

    const signInUrl = typeof (payload as { signInUrl?: unknown } | null)?.signInUrl === "string"
      ? (payload as { signInUrl: string }).signInUrl
      : "";
    if (!signInUrl) {
      return false;
    }

    const nextUrl = new URL(signInUrl, window.location.origin);
    nextUrl.searchParams.set("callbackURL", getSocialCallbackUrl());
    nextUrl.searchParams.set("loginHint", trimmedEmail);
    window.location.assign(nextUrl.toString());
    return true;
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

    if (webAuthRequested) {
      setAuthInfo("Signed in. Returning to OpenWork...");
      return null;
    }

    if (authenticatedUser && (getPendingWorkspaceClaimToken() || getPendingOrgInvitationId())) {
      return "join-org";
    }

    if (authenticatedUser && nextMode === "sign-up") {
      return await beginSignupOnboarding(authenticatedUser, "email");
    }

    return "dashboard" as const;
  }

  async function resendVerificationCode() {
    if (isSingleOrgMode) {
      setAuthError("Email verification codes are not used for this single-organization deployment.");
      return;
    }

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
    if (isSingleOrgMode) {
      setVerificationRequired(false);
      setAuthError("Email verification codes are not used for this single-organization deployment.");
      return null;
    }

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
    if (existingConnectUrl && (existingWorkspaceId || existingConnectUrl.includes("/v1/cloud/workers/"))) {
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

  async function refreshBilling(options: { quiet?: boolean } = {}) {
    if (!user) {
      setBillingSummary(null);
      if (!options.quiet) {
        setBillingError("Sign in to view billing details.");
      }
      return null;
    }

    const quiet = options.quiet === true;
    setBillingBusy(true);

    if (!quiet) {
      setBillingError(null);
    }

    try {
      const { response, payload } = await requestJson(
        "/v1/billing",
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

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!quiet) {
        setBillingError(message);
        appendEvent("error", "Billing check failed", message);
      }
      return null;
    } finally {
      setBillingBusy(false);
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
    requestOrgSelectionOnNextLoad(orgDirectory.orgs);

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

      const { response, payload } = await requestJson("/api/auth/desktop-handoff", {
        method: "POST",
        headers,
        body: JSON.stringify({ desktopScheme: desktopAuthScheme })
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Desktop handoff failed with ${response.status}.`));
        return;
      }

      const openworkUrl = getDesktopHandoffOpenworkUrl(payload) ?? "";
      if (!openworkUrl) {
        setAuthError("Desktop handoff succeeded, but no OpenWork redirect URL was returned.");
        return;
      }

      rememberDesktopHandoffGrant(getDesktopHandoffGrant(payload, openworkUrl));
      setDesktopRedirectUrl(openworkUrl);
      window.location.assign(openworkUrl);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to open OpenWork.");
    } finally {
      setDesktopRedirectBusy(false);
    }
  }

  function getWebHandoffReturnUrl(payload: unknown) {
    if (typeof payload !== "object" || payload === null || !("returnUrl" in payload)) {
      return null;
    }

    const returnUrl = payload.returnUrl;
    return typeof returnUrl === "string" && returnUrl.trim() ? returnUrl.trim() : null;
  }

  async function completeWebAuthHandoff() {
    if (!webAuthRequested || webRedirectBusy) {
      return;
    }

    setWebRedirectBusy(true);
    setWebRedirectAttempted(true);
    setAuthError(null);

    try {
      if (!webAuthReturnUrl) {
        setAuthError("Web handoff failed because no return URL was provided.");
        return;
      }

      const headers = new Headers();
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }

      const { response, payload } = await requestJson("/api/auth/desktop-handoff", {
        method: "POST",
        headers,
        body: JSON.stringify({ returnUrl: webAuthReturnUrl })
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Web handoff failed with ${response.status}.`));
        return;
      }

      const grant = getDesktopHandoffGrant(payload, null) ?? "";
      const approvedReturnUrl = getWebHandoffReturnUrl(payload) ?? "";
      if (!grant || !approvedReturnUrl) {
        setAuthError("Web handoff succeeded, but no Cloud return URL was returned.");
        return;
      }

      const redirectUrl = new URL(approvedReturnUrl);
      redirectUrl.searchParams.set("grant", grant);
      window.location.replace(redirectUrl.toString());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to return to OpenWork Cloud.");
    } finally {
      setWebRedirectBusy(false);
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
    // Deliberately ignores desktopAuthRequested: callers that auto-redirect
    // (auth-screen) gate on it themselves, while explicit actions — the
    // "Go to dashboard" button on the signed-in handoff card — must resolve
    // a destination even mid desktop handoff.
    if (!user) {
      return null;
    }

    const pendingClaimToken = getPendingWorkspaceClaimToken();
    if (pendingClaimToken) {
      return getWorkspaceClaimRoute(pendingClaimToken);
    }

    const pendingInvitationId = getPendingOrgInvitationId();
    if (pendingInvitationId) {
      return getJoinOrgRoute(pendingInvitationId);
    }

    const dashboardRoute = await resolveDashboardRoute();

    if (dashboardRoute) {
      if (getPendingAuthIntent() === "models") {
        clearPendingAuthIntent();
        return getInferenceRoute();
      }

      return dashboardRoute;
    }

    return "/organization";
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setAuthBusy(true);
    setAuthError(null);
    setSignupPasswordFeedback([]);
    const pendingInvitationId = getPendingOrgInvitationId();
    const submitMode: AuthMode = isSingleOrgMode
      && !runtimeConfig.singleOrgAllowPublicSignup
      && authMode === "sign-up"
      && !pendingInvitationId
      ? "sign-in"
      : authMode;
    trackPosthogEvent("den_auth_submitted", {
      mode: submitMode,
      method: "email"
    });

    try {
      const trimmedEmail = email.trim();
      if (trimmedEmail && await redirectToRequiredSso(trimmedEmail)) {
        return null;
      }
      const endpoint = submitMode === "sign-up" && pendingInvitationId
        ? `/api/auth/sign-up/email?invite=${encodeURIComponent(pendingInvitationId)}`
        : submitMode === "sign-up"
          ? "/api/auth/sign-up/email"
          : "/api/auth/sign-in/email";
      const body =
        submitMode === "sign-up"
          ? {
              name: authName.trim() || DEFAULT_AUTH_NAME,
              email: trimmedEmail,
              password,
              invite: pendingInvitationId ?? undefined,
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
        if (response.status === 403 && !isSingleOrgMode) {
          openVerificationStep(trimmedEmail, `Enter the 6-digit code we sent to ${trimmedEmail} to finish verifying your email.`);
        }
        const message = getErrorMessage(payload, `Authentication failed with ${response.status}.`);
        if (submitMode === "sign-up" && isSignupPasswordFeedback(payload)) {
          setSignupPasswordFeedback(getSignupPasswordFeedback(payload, message));
          setAuthError(null);
        } else {
          setAuthError(message);
        }
        trackPosthogEvent("den_auth_failed", {
          mode: submitMode,
          method: "email",
          status: response.status
        });
        return null;
      }

      const token = getToken(payload);

      if (submitMode === "sign-up" && !token) {
        setUser(null);
        openVerificationStep(trimmedEmail, `We emailed a 6-digit verification code to ${trimmedEmail}. Enter it below to finish creating your account.`);
        appendEvent("info", "Verification code sent", trimmedEmail);
        trackPosthogEvent("den_signup_verification_sent", {
          method: "email",
          email_domain: getEmailDomain(trimmedEmail),
        });
        return null;
      }
      return await finalizeEmailPasswordSignIn(submitMode, trimmedEmail, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setAuthError(message);
      setSignupPasswordFeedback([]);
      trackPosthogEvent("den_auth_failed", {
        mode: submitMode,
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
    setSignupPasswordFeedback([]);
    setAuthInfo(`Redirecting to ${getSocialProviderLabel(provider)}...`);
    trackPosthogEvent("den_auth_submitted", {
      mode: authMode,
      method: provider
    });

    try {
      const trimmedEmail = email.trim();
      if (trimmedEmail && await redirectToRequiredSso(trimmedEmail)) {
        if (shouldTrackSocialSignup) {
          window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
        }
        return;
      }
      const latestRuntimeConfig = await getRuntimeConfig();
      setRuntimeConfig(latestRuntimeConfig);
      const callbackURL = getSocialCallbackUrl(latestRuntimeConfig.openworkAuthCallbackUrl);
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
    setBillingSummary(null);
    setBillingError(null);
    setOrgLimitError(null);
    setBillingBusy(false);
    setBillingLoadedOnce(false);
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
    setAuthName("");
    setPassword("");
    setAuthInfo(getAuthInfoForMode("sign-up"));
    setLaunchStatus("Choose a worker name and launch.");
    setEvents([]);
    setWorkerQuery("");
    setWorkerStatusFilter("all");
    setWorkerName(DEFAULT_WORKER_NAME);
    persistOnboardingIntent(null);
    trackPosthogEvent("den_signout_completed", { method: "manual" });
    resetPosthogUser();

    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_WORKSPACE_CLAIM_STORAGE_KEY);
    }
  }

  async function updateUserProfile(input: { firstName: string; lastName: string }) {
    const { response, payload } = await requestJson(
      "/v1/me/profile",
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
      12000,
    );

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Failed to update profile (${response.status}).`));
    }

    const nextUser = getUser(payload);
    if (!nextUser) {
      throw new Error("Profile update response did not include a user.");
    }

    setUser(nextUser);
    identifyPosthogUser(nextUser);
    return nextUser;
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
        setBillingSummary((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            hasActivePlan: false,
            checkoutRequired: true,
          };
        });
        const message = getErrorMessage(payload, "New cloud worker launches are not available for this account.");
        setLaunchStatus(message);
        setLaunchError(message);
        appendEvent("warning", "Worker launch unavailable", message);
        return "error" as const;
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
              previewOpenworkUrl: null,
              previewExpiresAt: null,
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

  async function generateWorkerToken(options: { background?: boolean; workerId?: string } = {}) {
    const background = options.background === true;
    if (!user) {
      if (!background) setLaunchError("Sign in before fetching a worker access token.");
      return false;
    }

    const id = (options.workerId ?? workerLookupId.trim()) || worker?.workerId || workers[0]?.workerId || "";
    if (!id) {
      if (!background) setLaunchError("No worker selected yet. Launch one first, then fetch a token.");
      return false;
    }

    if (!background) {
      setWorkerLookupId(id);
      setActionBusy("token");
      setLaunchError(null);
    }

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}/tokens`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({ includeExpiringOpenworkUrl: true })
      });

      if (!response.ok) {
        if (!background) {
          const message = getErrorMessage(payload, `Token fetch failed with ${response.status}.`);
          setLaunchError(message);
          appendEvent("error", "Token fetch failed", message);
        }
        return false;
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        if (!background) {
          setLaunchError("Token response returned no token values.");
          appendEvent("error", "Token fetch failed", "Missing token payload");
        }
        return false;
      }

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === id
          ? withWorkerConnection(worker, tokens)
          : {
              workerId: id,
              workerName: "Existing worker",
              status: "unknown",
              provider: null,
              instanceUrl: null,
              openworkUrl: tokens.openworkUrl,
              previewOpenworkUrl: tokens.previewOpenworkUrl,
              previewExpiresAt: tokens.previewExpiresAt,
              workspaceId: tokens.workspaceId,
              clientToken: tokens.clientToken,
              ownerToken: tokens.ownerToken,
              hostToken: tokens.hostToken
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker((current) => {
        if (!current || current.workerId !== resolvedWorker.workerId) return resolvedWorker;
        if (workerConnectionEquals(current, resolvedWorker)) return current;
        return resolvedWorker;
      });
      setPendingRestoredWorkerId(null);
      if (!background) {
        setLaunchStatus("Worker is ready to connect.");
        appendEvent("success", "Owner token ready", `Worker ID ${id}`);
      }
      return !workerNeedsConnectionResolution(resolvedWorker);
    } catch (error) {
      if (!background) {
        const message = error instanceof Error ? error.message : "Unknown network error";
        setLaunchError(message);
        appendEvent("error", "Token fetch failed", message);
      }
      return false;
    } finally {
      if (!background) setActionBusy(null);
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

  function selectWorker(item: WorkerListItem) {
    setWorkerLookupId(item.workerId);
    setWorker((current) => listItemToWorker(item, current));
  }

  useEffect(() => {
    let cancelled = false;

    void getRuntimeConfig().then((config) => {
      if (!cancelled) {
        setRuntimeConfig(config);
        setRuntimeConfigLoaded(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
    setWebAuthRequested(params.get("webAuth") === "1");
    const requestedWebReturnUrl = params.get("webAuthReturn")?.trim() ?? "";
    setWebAuthReturnUrl(requestedWebReturnUrl || null);

    const invitationId = params.get("invite")?.trim() ?? "";
    if (invitationId) {
      window.sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, invitationId);
    }

    const requestedIntent = normalizeAuthIntentParam(params.get("intent"));
    if (requestedIntent) {
      window.sessionStorage.setItem(PENDING_AUTH_INTENT_STORAGE_KEY, requestedIntent);
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
    if (!runtimeConfigLoaded) {
      return;
    }

    let cancelled = false;

    const hydrateSession = async () => {
      try {
        await refreshSession(true);
      } finally {
        if (!cancelled) {
          setSessionHydrated(true);
        }
      }
    };

    void hydrateSession();

    return () => {
      cancelled = true;
    };
  }, [authToken, runtimeConfigLoaded]);

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
        openworkUrl: parsed.provider === "daytona" && parsed.openworkUrl && !parsed.openworkUrl.includes("/v1/cloud/workers/")
          ? null
          : parsed.openworkUrl ?? parsed.instanceUrl,
        previewOpenworkUrl: null,
        previewExpiresAt: null,
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
      previewOpenworkUrl: null,
      previewExpiresAt: null,
      clientToken: null,
      ownerToken: null,
      hostToken: null
    };

    window.localStorage.setItem(LAST_WORKER_STORAGE_KEY, JSON.stringify(serializable));
  }, [worker]);

  useEffect(() => {
    if (!user || !worker || actionBusy !== null || launchBusy || pendingRestoredWorkerId === worker.workerId) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      const ready = await generateWorkerToken({ background: true, workerId: worker.workerId });
      if (cancelled || ready) return;
      attempts += 1;
      const delay = getWorkerConnectionPollDelay(attempts);
      timer = window.setTimeout(() => void poll(), delay);
    };

    const refreshDelay = getWorkerConnectionRefreshDelay(worker);
    if (refreshDelay === null) return;
    timer = window.setTimeout(() => void poll(), refreshDelay);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [actionBusy, launchBusy, pendingRestoredWorkerId, user?.id, worker?.workerId, worker?.status, worker?.clientToken, worker?.hostToken, worker?.openworkUrl, worker?.previewOpenworkUrl, worker?.previewExpiresAt]);

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
    if (!webAuthRequested || !user || webRedirectBusy || webRedirectAttempted) {
      return;
    }

    void completeWebAuthHandoff();
  }, [webAuthRequested, webAuthReturnUrl, user?.id, authToken, webRedirectBusy, webRedirectAttempted]);

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
    // Launch the first worker through the canonical POST /v1/workers path;
    // the Den API selects the configured provisioner (render/daytona/static)
    // server-side. PR #1181 replaced this with a bare markOnboardingComplete,
    // which let signup finish with zero workers (#1961). launchWorker marks
    // onboarding complete itself on success; on failure onboarding stays
    // pending so the user sees the error and can retry.
    void launchWorker({ source: "signup_auto", workerNameOverride: onboardingIntent?.workerName ?? DEFAULT_WORKER_NAME });
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
    authName,
    setAuthName,
    password,
    setPassword,
    verificationCode,
    setVerificationCode,
    verificationRequired,
    authBusy,
    authInfo,
    authError,
    signupPasswordFeedback,
    user,
    sessionHydrated,
    desktopAuthRequested,
    desktopAuthScheme,
    webAuthRequested,
    desktopRedirectUrl,
    desktopRedirectBusy,
    showAuthFeedback,
    submitAuth,
    submitVerificationCode,
    resendVerificationCode,
    cancelVerification,
    beginSocialAuth,
    signOut,
    updateUserProfile,
    resolveUserLandingRoute,
    billingSummary,
    billingBusy,
    billingError,
    orgLimitError,
    clearOrgLimitError: () => setOrgLimitError(null),
    refreshBilling,
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
    runtimeConfig,
    runtimeConfigLoaded,
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
    generateWorkerToken: async () => {
      await generateWorkerToken();
    },
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
