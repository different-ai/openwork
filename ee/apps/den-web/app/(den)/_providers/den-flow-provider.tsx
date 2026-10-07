"use client";

import { createContext, createElement, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SETUP_CONTINUATION_KEY, parseSetupContinuation, type SetupContinuation } from "../_lib/setup-continuation";
import {
  AUTH_TOKEN_STORAGE_KEY,
  DEFAULT_AUTH_NAME,
  PENDING_SOCIAL_SIGNUP_STORAGE_KEY,
  type AuthMode,
  type AuthUser,
  type SocialAuthProvider,
  getAuthInfoForMode,
  getEmailDomain,
  getErrorMessage,
  getSocialCallbackUrl,
  getSocialProviderLabel,
  getToken,
  getUser,
  identifyPosthogUser,
  normalizeAuthIntentParam,
  normalizeAuthModeParam,
  PENDING_AUTH_INTENT_STORAGE_KEY,
  requestJson,
  resetPosthogUser,
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
  setupPending: boolean;
  setupOrganizationId: string | null;
  continueSetup: (organizationId: string | null, route: string) => void;
  completeSetup: (organizationId: string) => Promise<boolean>;
  webAuthRequested: boolean;
  desktopRedirectUrl: string | null;
  desktopRedirectBusy: boolean;
  retryDesktopAuthHandoff: () => void;
  showAuthFeedback: boolean;
  submitAuth: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  submitVerificationCode: (event: FormEvent<HTMLFormElement>) => Promise<AuthNavigationResult>;
  resendVerificationCode: () => Promise<void>;
  cancelVerification: () => void;
  beginSocialAuth: (provider: SocialAuthProvider) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-checks the session with Den; clears the signed-in user when it is gone. */
  revalidateSession: () => Promise<AuthUser | null>;
  updateUserProfile: (input: { firstName: string; lastName: string }) => Promise<AuthUser>;
  resolveUserLandingRoute: () => Promise<string | null>;
  runtimeConfig: DenWebRuntimeConfig;
  runtimeConfigLoaded: boolean;
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
  const router = useRouter();
  const pathname = usePathname();
  const [continuation, setContinuation] = useState<SetupContinuation | null>(null);
  const continuationRef = useRef<SetupContinuation | null>(null);
  const handoffBusyRef = useRef(false);
  const sessionEpochRef = useRef(0);
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
  const [hydratedSession, setHydratedSession] = useState<{ token: string | null } | null>(null);
  const sessionHydrated = hydratedSession !== null && hydratedSession.token === authToken;
  const desktopAuthScheme = continuation?.desktopScheme ?? "openwork";
  const setupPending = Boolean(user && continuation?.userId === user.id && continuation.setup);
  const [webAuthRequested, setWebAuthRequested] = useState(false);
  const [webAuthReturnUrl, setWebAuthReturnUrl] = useState<string | null>(null);
  const [desktopRedirectBusy, setDesktopRedirectBusy] = useState(false);
  const [desktopRedirectUrl, setDesktopRedirectUrl] = useState<string | null>(null);
  const desktopAuthRequested = Boolean(continuation?.desktopScheme || desktopRedirectUrl);
  const [desktopRedirectAttempted, setDesktopRedirectAttempted] = useState(false);
  const [webRedirectBusy, setWebRedirectBusy] = useState(false);
  const [webRedirectAttempted, setWebRedirectAttempted] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<DenWebRuntimeConfig>(EMPTY_RUNTIME_CONFIG);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const isSingleOrgMode = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";

  const socialSignupHandledRef = useRef<string | null>(null);

  function persistContinuation(next: SetupContinuation | null) {
    continuationRef.current = next;
    setContinuation(next);
    if (next) window.sessionStorage.setItem(SETUP_CONTINUATION_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(SETUP_CONTINUATION_KEY);
  }

  function continueSetup(organizationId: string | null, route: string) {
    if (!runtimeConfigLoaded || !sessionHydrated || !user || isSingleOrgMode) return;
    const current = continuationRef.current;
    persistContinuation({ userId: user.id, desktopScheme: current?.userId === user.id ? current.desktopScheme : null,
      setup: { organizationId, route }, at: Date.now() });
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

    // Verifying an email proves the mailbox but does not sign anyone in:
    // /email-otp/verify-email answers with `token: null` and sets no cookie.
    // Exchange the password the person just typed for a session in sign-in
    // as well as sign-up, or an existing account that verifies from the
    // sign-in form is shown as signed in without a session (ENG-550).
    if (payload === undefined || (!getToken(payload) && Boolean(password))) {
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
    // A user object alone is not a session: the verify-email reply carries one
    // with `token: null`. Trust it only next to a token; otherwise ask Den.
    const payloadUser = token ? getUser(payload) : null;
    if (payloadUser) {
      authenticatedUser = payloadUser;
      setUser(payloadUser);
      setAuthInfo(`Signed in as ${payloadUser.email}.`);
    } else {
      const refreshed = await refreshSession(true);
      if (refreshed) {
        authenticatedUser = refreshed;
      } else if (getUser(payload)) {
        // Verified, but there is no password to exchange for a session. Keep
        // the person on the sign-in step instead of a signed-in screen that
        // every request would reject.
        setAuthMode("sign-in");
        setAuthInfo(`Email verified. Sign in as ${trimmedEmail} to continue.`);
        return null;
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

    if (authenticatedUser && (getPendingWorkspaceClaimToken() || getPendingOrgInvitationId())) {
      return "join-org";
    }

    if (desktopAuthRequested || webAuthRequested) {
      setAuthInfo("Signed in. Returning to OpenWork...");
      return null;
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

  async function refreshSession(quiet = false, isCurrent = () => true) {
    const epoch = sessionEpochRef.current;
    const headers = new Headers();
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    const { response, payload } = await requestJson("/v1/me", { method: "GET", headers }, 12000);
    if (!isCurrent() || epoch !== sessionEpochRef.current) return null;

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
      throw new Error(getErrorMessage(payload, "Could not load your organizations. Refresh to try again."));
    }
    if (!isRecord(payload) || !Array.isArray(payload.orgs)) throw new Error("Organization lookup returned incomplete details.");
    const directory = parseOrgListPayload(payload);
    if (directory.orgs.length !== payload.orgs.length) throw new Error("Organization lookup returned incomplete details.");
    return directory;
  }

  async function completeDesktopAuthHandoff(organizationId?: string) {
    const current = continuationRef.current;
    const epoch = sessionEpochRef.current;
    if (!runtimeConfigLoaded || !sessionHydrated || authBusy || !current?.desktopScheme || current.userId !== user?.id || handoffBusyRef.current
      || (current.setup && current.setup.organizationId !== organizationId)) {
      return false;
    }

    handoffBusyRef.current = true;
    setDesktopRedirectBusy(true);
    setDesktopRedirectAttempted(true);
    setAuthError(null);

    try {
      const headers = new Headers();
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }

      if (organizationId) {
        const selected = await requestJson("/v1/me/active-organization", {
          method: "POST", headers, body: JSON.stringify({ organizationId }),
        });
        if (!selected.response.ok) throw new Error(getErrorMessage(selected.payload, "Could not select your workspace."));
      }
      if (continuationRef.current !== current || epoch !== sessionEpochRef.current) return false;

      const { response, payload } = await requestJson("/api/auth/desktop-handoff", {
        method: "POST",
        headers,
        body: JSON.stringify({ desktopScheme: desktopAuthScheme })
      });
      if (continuationRef.current !== current || epoch !== sessionEpochRef.current) return false;

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Desktop handoff failed with ${response.status}.`));
        return false;
      }

      const openworkUrl = getDesktopHandoffOpenworkUrl(payload) ?? "";
      if (!openworkUrl) {
        setAuthError("Desktop handoff succeeded, but no OpenWork redirect URL was returned.");
        return false;
      }

      rememberDesktopHandoffGrant(getDesktopHandoffGrant(payload, openworkUrl));
      setDesktopRedirectUrl(openworkUrl);
      persistContinuation(null);
      clearPendingAuthIntent();
      window.location.assign(openworkUrl);
      return true;
    } catch (error) {
      if (continuationRef.current === current && epoch === sessionEpochRef.current) setAuthError(error instanceof Error ? error.message : "Failed to open OpenWork.");
      return false;
    } finally {
      handoffBusyRef.current = false;
      setDesktopRedirectBusy(false);
    }
  }

  async function completeSetup(organizationId: string) {
    const current = continuationRef.current;
    if (!runtimeConfigLoaded || !sessionHydrated) return false;
    if (!user || (current && current.userId !== user.id)
      || (current?.setup && current.setup.organizationId !== organizationId)) {
      setAuthError("Return to the workspace where you started setup before completing it.");
      return false;
    }
    if (getPendingOrgInvitationId() || getPendingWorkspaceClaimToken()) return false;
    if (current?.desktopScheme) return completeDesktopAuthHandoff(organizationId);
    persistContinuation(null);
    clearPendingAuthIntent();
    return true;
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

  async function resolveUserLandingRoute() {
    // Deliberately ignores desktopAuthRequested: callers that auto-redirect
    // (auth-screen) gate on it themselves, while explicit actions — the
    // "Go to dashboard" button on the signed-in handoff card — must resolve
    // a destination even mid desktop handoff.
    if (!runtimeConfigLoaded || !sessionHydrated || !user) {
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

    if (continuationRef.current?.userId === user.id && continuationRef.current.setup) {
      return continuationRef.current.setup.route;
    }
    if (runtimeConfig === EMPTY_RUNTIME_CONFIG) {
      setAuthError("Could not load workspace configuration. Refresh to try again.");
      return null;
    }

    const epoch = sessionEpochRef.current;
    let directory: Awaited<ReturnType<typeof loadOrgDirectory>>;
    try {
      directory = await loadOrgDirectory();
    } catch (error) {
      if (epoch === sessionEpochRef.current) setAuthError(error instanceof Error ? error.message : "Could not load your organizations.");
      return null;
    }
    if (epoch !== sessionEpochRef.current) return null;
    requestOrgSelectionOnNextLoad(directory.orgs);
    if (directory.orgs.length === 0) {
      if (!isSingleOrgMode) continueSetup(null, "/organization");
      return "/organization";
    }

    if (getPendingAuthIntent() === "models") {
      clearPendingAuthIntent();
      return getInferenceRoute();
    }
    return getOrgDashboardRoute();
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    sessionEpochRef.current += 1;
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

    sessionEpochRef.current += 1;
    persistContinuation(null);
    clearPendingAuthIntent();
    setDesktopRedirectUrl(null);
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
    setHydratedSession({ token: null });
    setDesktopRedirectUrl(null);
    setDesktopRedirectAttempted(false);
    setAuthMode("sign-up");
    setEmail("");
    setAuthName("");
    setPassword("");
    setAuthInfo(getAuthInfoForMode("sign-up"));
    resetPosthogUser();
    trackPosthogEvent("den_signout_completed", { method: "manual" });

    if (typeof window !== "undefined") {
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

    const stored = parseSetupContinuation(window.sessionStorage.getItem(SETUP_CONTINUATION_KEY));
    persistContinuation(params.get("desktopAuth") === "1"
      ? { userId: stored?.userId ?? null, setup: stored?.setup ?? null, at: Date.now(),
          desktopScheme: "openwork" }
      : stored);
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
    // Left behind by the removed cloud worker screen; clear them from browsers that still have them.
    window.localStorage.removeItem("openwork:web:last-worker");
    window.localStorage.removeItem("openwork:web:onboarding-intent");
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
      const epoch = sessionEpochRef.current;
      try {
        await refreshSession(true, () => !cancelled);
      } finally {
        if (!cancelled && epoch === sessionEpochRef.current) {
          setHydratedSession({ token: authToken });
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
  }, [user?.id]);

  useEffect(() => {
    if (!runtimeConfigLoaded || !sessionHydrated || !user || !continuation) return;
    if (continuation.userId && continuation.userId !== user.id) {
      persistContinuation(null);
      setDesktopRedirectUrl(null);
      setDesktopRedirectAttempted(false);
      clearPendingAuthIntent();
    } else if (!continuation.userId) {
      persistContinuation({ ...continuation, userId: user.id });
    }
  }, [runtimeConfigLoaded, sessionHydrated, user?.id, continuation]);

  useEffect(() => {
    const current = continuationRef.current;
    if (!runtimeConfigLoaded || !sessionHydrated || !user || current?.userId !== user.id || !current.setup) return;
    if (["/dashboard/onboarding/people", "/dashboard/onboarding/tools", "/dashboard/onboarding"].includes(pathname)
      && current.setup.route !== pathname) {
      persistContinuation({ ...current, setup: { ...current.setup, route: pathname } });
    }
  }, [pathname, user?.id, runtimeConfigLoaded, sessionHydrated]);

  useEffect(() => {
    if (!runtimeConfigLoaded || !sessionHydrated || authBusy || !desktopAuthRequested || !user || continuation?.userId !== user.id
      || setupPending || desktopRedirectUrl || desktopRedirectBusy || desktopRedirectAttempted) return;
    // Invitation acceptance and workspace claims own their explicit handoffs.
    if (pathname === "/join-org" || pathname === "/workspace-claim") return;
    const pendingClaim = getPendingWorkspaceClaimToken();
    const pendingInvitation = getPendingOrgInvitationId();
    if (pendingClaim) {
      router.replace(getWorkspaceClaimRoute(pendingClaim));
      return;
    }
    if (pendingInvitation) {
      router.replace(getJoinOrgRoute(pendingInvitation));
      return;
    }
    // Failed config fetches return the single-org fallback, not a deployment decision.
    if (runtimeConfig === EMPTY_RUNTIME_CONFIG) {
      setAuthError("Could not load workspace configuration. Refresh to try again.");
      setDesktopRedirectAttempted(true);
      return;
    }
    let cancelled = false;
    const current = continuationRef.current;
    const epoch = sessionEpochRef.current;
    void loadOrgDirectory().then((directory) => {
      if (cancelled || epoch !== sessionEpochRef.current || continuationRef.current !== current || getPendingOrgInvitationId() || getPendingWorkspaceClaimToken()) return;
      if (directory.orgs.length === 0) {
        if (!isSingleOrgMode) {
          persistContinuation({ userId: user.id, desktopScheme: desktopAuthScheme, setup: { organizationId: null, route: "/organization" }, at: Date.now() });
        }
        router.replace("/organization");
        return;
      }
      void completeDesktopAuthHandoff();
    }).catch((error: unknown) => {
      if (!cancelled && epoch === sessionEpochRef.current) {
        setAuthError(error instanceof Error ? error.message : "Could not load your organizations.");
        setDesktopRedirectAttempted(true);
      }
    });
    return () => { cancelled = true; };
  }, [runtimeConfig, runtimeConfigLoaded, isSingleOrgMode, sessionHydrated, authBusy, desktopAuthRequested, user?.id, authToken, continuation?.userId, setupPending, pathname, desktopRedirectUrl, desktopRedirectBusy, desktopRedirectAttempted, desktopAuthScheme]);

  useEffect(() => {
    if (!runtimeConfigLoaded || !sessionHydrated || !webAuthRequested || !user || webRedirectBusy || webRedirectAttempted
      || pathname === "/join-org" || pathname === "/workspace-claim"
      || getPendingOrgInvitationId() || getPendingWorkspaceClaimToken()) {
      return;
    }

    void completeWebAuthHandoff();
  }, [runtimeConfigLoaded, sessionHydrated, webAuthRequested, webAuthReturnUrl, user?.id, authToken, webRedirectBusy, webRedirectAttempted, pathname]);

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
    setupPending,
    setupOrganizationId: setupPending ? continuation?.setup?.organizationId ?? null : null,
    continueSetup,
    completeSetup,
    webAuthRequested,
    desktopRedirectUrl,
    desktopRedirectBusy,
    retryDesktopAuthHandoff: () => {
      if (handoffBusyRef.current || setupPending) return;
      setAuthError(null);
      setDesktopRedirectAttempted(false);
    },
    showAuthFeedback,
    submitAuth,
    submitVerificationCode,
    resendVerificationCode,
    cancelVerification,
    beginSocialAuth,
    signOut,
    revalidateSession: () => refreshSession(true),
    updateUserProfile,
    resolveUserLandingRoute,
    runtimeConfig,
    runtimeConfigLoaded,
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
