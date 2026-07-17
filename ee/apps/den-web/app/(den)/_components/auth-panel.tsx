"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { isSingleOrgSignupDisabled, resolveVisibleAuthMode } from "../_lib/auth-ui-policy";
import { isSamePathname } from "../_lib/client-route";
import { getDesktopGrant } from "../_lib/desktop-handoff";
import { getErrorMessage, getSocialCallbackUrl, requestJson, type AuthMode } from "../_lib/den-flow";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
import { useDenFlow } from "../_providers/den-flow-provider";

type PanelContent = {
  title: string;
  copy: string;
  submitLabel: string;
};

type EmailFirstStep = "email" | "sso" | "google" | "github" | "password" | "new_account";
type ResolvedLoginStep = Exclude<EmailFirstStep, "email">;

type LoginOption = {
  nextStep: ResolvedLoginStep;
  signInPath: string | null;
  signInUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isResolvedLoginStep(value: unknown): value is ResolvedLoginStep {
  return value === "sso" || value === "google" || value === "github" || value === "password" || value === "new_account";
}

function readLoginOption(payload: unknown): LoginOption | null {
  if (!isRecord(payload) || !isResolvedLoginStep(payload.nextStep)) {
    return null;
  }

  return {
    nextStep: payload.nextStep,
    signInPath: typeof payload.signInPath === "string" ? payload.signInPath : null,
    signInUrl: typeof payload.signInUrl === "string" ? payload.signInUrl : null,
  };
}

function GitHubLogo() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="h-4 w-4 shrink-0">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.31-1.58-5.01-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.99 10.72A5.41 5.41 0 0 1 3.71 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.03-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.43 1.33l2.57-2.57C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.03 2.33c.7-2.12 2.67-3.7 5.01-3.7Z" />
    </svg>
  );
}

function SocialButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="den-button-secondary den-social-button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function AuthPanel({
  prefilledEmail,
  prefillKey,
  initialMode = "sign-up",
  lockEmail = false,
  hideSocialAuth = false,
  hideEmailField = false,
  hideLockedEmailSummary = false,
  emailFirstFlow = false,
  eyebrow = "Account",
  bare = false,
  signUpContent,
  signInContent,
  verificationContent,
}: {
  prefilledEmail?: string;
  prefillKey?: string;
  initialMode?: AuthMode;
  lockEmail?: boolean;
  hideSocialAuth?: boolean;
  hideEmailField?: boolean;
  hideLockedEmailSummary?: boolean;
  emailFirstFlow?: boolean;
  eyebrow?: string;
  // When true the panel renders without its own `den-frame`/padding, so a parent
  // (the unified split auth card) can own the surface. Defaults to a self-framed
  // card for standalone callers (invite, workspace-claim).
  bare?: boolean;
  signUpContent?: Partial<PanelContent>;
  signInContent?: Partial<PanelContent>;
  verificationContent?: Partial<PanelContent>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const prefillRef = useRef<string | null>(null);
  const [copiedDesktopField, setCopiedDesktopField] = useState<"link" | "code" | null>(null);
  const [passwordResetRequested, setPasswordResetRequested] = useState(false);
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const [passwordResetInfo, setPasswordResetInfo] = useState("");
  const [passwordResetError, setPasswordResetError] = useState<string | null>(null);
  const [loginOption, setLoginOption] = useState<LoginOption | null>(null);
  const [loginOptionBusy, setLoginOptionBusy] = useState(false);
  const [loginOptionError, setLoginOptionError] = useState<string | null>(null);
  const {
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
    desktopAuthRequested,
    desktopRedirectUrl,
    desktopRedirectBusy,
    showAuthFeedback,
    submitAuth,
    submitVerificationCode,
    resendVerificationCode,
    cancelVerification,
    beginSocialAuth,
    resolveUserLandingRoute,
    runtimeConfig,
    runtimeConfigLoaded,
  } = useDenFlow();
  const isSingleOrgMode = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";
  const isSingleOrgSsoMode = isSingleOrgMode && runtimeConfig.singleOrgSsoConfigured;
  const isSingleOrgPrivateSignup = isSingleOrgSignupDisabled(runtimeConfig, runtimeConfigLoaded);
  const visibleAuthMode = resolveVisibleAuthMode({ authMode, runtimeConfig, runtimeConfigLoaded });
  const singleOrgName = runtimeConfig.singleOrgName || "OpenWork";
  const singleOrgSlug = runtimeConfig.singleOrgSlug.trim();

  useEffect(() => {
    if (isSingleOrgPrivateSignup && authMode === "sign-up") {
      setAuthMode("sign-in");
    }
  }, [authMode, isSingleOrgPrivateSignup, setAuthMode]);

  useEffect(() => {
    if (!isSingleOrgSsoMode || pathname === "/") {
      return;
    }

    router.replace("/");
  }, [isSingleOrgSsoMode, pathname, router]);

  const resolvedSignUpContent: PanelContent = {
    title: isSingleOrgMode ? "Create your account." : "Get started.",
    copy: isSingleOrgMode
      ? `Join ${singleOrgName}. The organization is managed by this deployment.`
      : "Free to try. Team plans from $50/mo.",
    submitLabel: "Create account",
    ...signUpContent,
  };

  const resolvedSignInContent: PanelContent = {
    title: isSingleOrgMode ? `Sign in to ${singleOrgName}.` : "Welcome back.",
    copy: isSingleOrgMode
      ? "Use your organization account to continue."
      : "Sign in to open your team workspace.",
    submitLabel: "Sign in",
    ...signInContent,
  };

  const singleOrgSsoContent: PanelContent = {
    title: `Sign in to ${singleOrgName}.`,
    copy: "Use your organization's SSO to continue.",
    submitLabel: "Continue with SSO",
  };

  const resolvedVerificationContent: PanelContent = {
    title: "Verify your email.",
    copy: "Enter the six-digit code from your inbox.",
    submitLabel: "Verify email",
    ...verificationContent,
  };

  const passwordResetContent: PanelContent = {
    title: "Reset your password.",
    copy: "Enter your email and we'll send you a secure reset link.",
    submitLabel: "Send reset link",
  };

  const requestedEmailFirstStep = loginOption?.nextStep ?? "email";
  const emailFirstStep: EmailFirstStep = isSingleOrgPrivateSignup && requestedEmailFirstStep === "new_account" ? "password" : requestedEmailFirstStep;
  const emailFirstEmail = email.trim();
  const emailFirstContent: PanelContent =
    emailFirstStep === "email"
      ? {
          title: "Start using OpenWork",
          copy: "Enter your email and we'll send you to the right sign-in step.",
          submitLabel: "Next",
        }
      : emailFirstStep === "sso"
      ? {
          title: "Sign in with SSO.",
          copy: emailFirstEmail ? `${emailFirstEmail} is managed by your organization.` : "Your organization manages this account.",
          submitLabel: "Sign in with SSO",
        }
      : emailFirstStep === "google"
      ? {
          title: "Welcome back.",
          copy: "Use Google to continue with this account.",
          submitLabel: "Sign in with Google",
        }
      : emailFirstStep === "github"
      ? {
          title: "Welcome back.",
          copy: "Use GitHub to continue with this account.",
          submitLabel: "Sign in with GitHub",
        }
      : emailFirstStep === "password"
      ? {
          title: "Enter your password.",
          copy: emailFirstEmail ? `Sign in as ${emailFirstEmail}.` : "Sign in with your password.",
          submitLabel: "Sign in",
        }
      : {
          title: "Create your account.",
          copy: "Set up your OpenWork Cloud account.",
          submitLabel: "Sign up",
        };

  const desktopGrant = getDesktopGrant(desktopRedirectUrl);
  const isPasswordResetRequest = authMode === "sign-in" && passwordResetRequested && !verificationRequired;
  const formBusy = !runtimeConfigLoaded || (isPasswordResetRequest ? passwordResetBusy : authBusy || desktopRedirectBusy);
  const activeContent = verificationRequired
    ? resolvedVerificationContent
    : isPasswordResetRequest
      ? passwordResetContent
      : emailFirstFlow
      ? emailFirstContent
      : isSingleOrgSsoMode
      ? singleOrgSsoContent
      : visibleAuthMode === "sign-in"
      ? resolvedSignInContent
      : resolvedSignUpContent;
  const showLockedEmailSummary = Boolean(prefilledEmail && lockEmail && hideEmailField && !hideLockedEmailSummary);
  const shellClass = (gap: string, padding: string) =>
    bare ? `grid ${gap}` : `den-frame grid ${gap} ${padding}`;
  // The segmented tabs are the primary sign-in/sign-up switch. Hide them for the
  // focused sub-flows (email verification, password reset) where switching mode
  // mid-step would be confusing.
  const showModeTabs = !emailFirstFlow && !isSingleOrgSsoMode && !isSingleOrgPrivateSignup && !verificationRequired && !isPasswordResetRequest;
  const showSingleOrgSso = isSingleOrgMode && Boolean(singleOrgSlug) && !verificationRequired && !isPasswordResetRequest && (!hideSocialAuth || isSingleOrgSsoMode);
  const showSingleOrgSsoDivider = showSingleOrgSso && !isSingleOrgSsoMode;
  const showEmailPasswordAuth = !isSingleOrgSsoMode;
  const showSocialAuth = showEmailPasswordAuth && !verificationRequired && !isPasswordResetRequest && !hideSocialAuth;

  useEffect(() => {
    const key = prefillKey ?? prefilledEmail?.trim() ?? null;
    if (!key || prefillRef.current === key) {
      return;
    }

    prefillRef.current = key;
    setAuthMode(initialMode);
    setEmail(prefilledEmail?.trim() ?? "");
    setAuthName("");
    setPassword("");
    setVerificationCode("");
  }, [initialMode, prefillKey, prefilledEmail, setAuthMode, setAuthName, setEmail, setPassword, setVerificationCode]);

  const switchMode = (mode: AuthMode) => {
    if (mode === authMode && !passwordResetRequested) {
      return;
    }
    setPasswordResetRequested(false);
    setPasswordResetInfo("");
    setPasswordResetError(null);
    setAuthMode(mode);
  };

  const copyDesktopValue = async (field: "link" | "code", value: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedDesktopField(field);
    window.setTimeout(() => {
      setCopiedDesktopField((current) => (current === field ? null : current));
    }, 1800);
  };

  const startSingleOrgSso = () => {
    if (!singleOrgSlug) return;
    const nextUrl = new URL(`/sso/${encodeURIComponent(singleOrgSlug)}`, window.location.origin);
    nextUrl.searchParams.set("callbackURL", getSocialCallbackUrl(runtimeConfig.openworkAuthCallbackUrl));
    const trimmedEmail = email.trim();
    if (trimmedEmail) {
      nextUrl.searchParams.set("loginHint", trimmedEmail);
    }
    window.location.assign(nextUrl.toString());
  };

  const startEmailFirstSso = () => {
    const target = loginOption?.signInPath ?? loginOption?.signInUrl;
    if (!target) {
      setLoginOptionError("Could not find your organization SSO sign-in link. Try again.");
      return;
    }

    const nextUrl = new URL(target, window.location.origin);
    nextUrl.searchParams.set("callbackURL", getSocialCallbackUrl(runtimeConfig.openworkAuthCallbackUrl));
    const trimmedEmail = email.trim();
    if (trimmedEmail) {
      nextUrl.searchParams.set("loginHint", trimmedEmail);
    }
    window.location.assign(nextUrl.toString());
  };

  const resolveEmailFirstStep = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setLoginOptionError("Enter your email to continue.");
      return;
    }

    setLoginOptionBusy(true);
    setLoginOptionError(null);
    setLoginOption(null);
    setPassword("");
    setAuthName("");

    try {
      const { response, payload } = await requestJson(`/v1/auth/login-options?email=${encodeURIComponent(trimmedEmail)}`, { method: "GET" }, 12000);
      if (!response.ok) {
        setLoginOptionError(getErrorMessage(payload, `Could not check sign-in options (${response.status}).`));
        return;
      }

      const nextOption = readLoginOption(payload);
      if (!nextOption) {
        setLoginOptionError("The sign-in options response was incomplete. Try again.");
        return;
      }

      setEmail(trimmedEmail);
      setAuthMode(nextOption.nextStep === "new_account" ? "sign-up" : "sign-in");
      setLoginOption(nextOption);
    } catch (error) {
      setLoginOptionError(error instanceof Error ? error.message : "Could not check sign-in options.");
    } finally {
      setLoginOptionBusy(false);
    }
  };

  const handleAuthNavigation = async (next: Awaited<ReturnType<typeof submitAuth>>) => {
    const oauthRoute = typeof window === "undefined" ? null : getMcpOAuthSelectOrganizationRoute(window.location.search);
    if (next && oauthRoute) {
      router.replace(oauthRoute);
      return;
    }
    if (next === "dashboard" || next === "join-org") {
      const target = await resolveUserLandingRoute();
      if (target && !isSamePathname(pathname, target)) {
        router.replace(target);
      }
    }
  };

  const submitPasswordResetRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setPasswordResetError("Enter your email to receive a reset link.");
      return;
    }

    setPasswordResetBusy(true);
    setPasswordResetInfo("");
    setPasswordResetError(null);
    try {
      const { response, payload } = await requestJson("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({
          email: trimmedEmail,
          redirectTo: new URL("/reset-password", window.location.origin).toString(),
        }),
      });

      if (!response.ok) {
        setPasswordResetError(getErrorMessage(payload, `Could not send reset link (${response.status}).`));
        return;
      }

      setPasswordResetInfo(`If an account exists for ${trimmedEmail}, we sent a reset link.`);
    } catch (error) {
      setPasswordResetError(error instanceof Error ? error.message : "Could not send reset link.");
    } finally {
      setPasswordResetBusy(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Already signed in + desktop handoff: simplified view               */
  /* ------------------------------------------------------------------ */
  const isSignedInWithDesktopHandoff = desktopAuthRequested && desktopRedirectUrl && showAuthFeedback && authInfo && !authError;
  const emailFirstPanelActive = emailFirstFlow && !verificationRequired && !isPasswordResetRequest;
  const emailFirstFormBusy = loginOptionBusy || authBusy || desktopRedirectBusy;

  if (isSignedInWithDesktopHandoff) {
    return (
      <div className={shellClass("gap-6", "p-6 md:p-7")}>
        <div className="grid gap-3">
          <p className="den-eyebrow">{eyebrow}</p>
          <div className="grid gap-2">
            <h2 className="den-title-lg">You&apos;re signed in.</h2>
            <p className="den-copy">Open the desktop app to continue.</p>
          </div>
        </div>

        <button
          type="button"
          className="den-button-primary w-full"
          onClick={() => window.location.assign(desktopRedirectUrl)}
        >
          Open OpenWork
          <ArrowRight className="h-4 w-4" />
        </button>

        <div className="grid gap-2 text-center">
          <p className="m-0 text-xs text-[var(--dls-text-secondary)]">
            App didn&apos;t open?
          </p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              className="den-button-secondary"
              onClick={() => void copyDesktopValue("link", desktopRedirectUrl)}
            >
              {copiedDesktopField === "link" ? "Copied!" : "Copy sign-in link"}
            </button>
            {desktopGrant ? (
              <button
                type="button"
                className="den-button-secondary"
                onClick={() => void copyDesktopValue("code", desktopGrant)}
              >
                {copiedDesktopField === "code" ? "Copied!" : "Copy code"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="border-t border-[var(--dls-border)] pt-4 text-center">
          <button
            type="button"
            className="text-sm font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
            onClick={async () => {
              const target = await resolveUserLandingRoute();
              if (target) router.replace(target);
            }}
          >
            Go to dashboard &rarr;
          </button>
        </div>
      </div>
    );
  }

  if (emailFirstPanelActive) {
    return (
      <div className={shellClass("gap-4 sm:gap-5", "p-5 sm:p-6 md:p-7")}>
        <div className="grid gap-3">
          <p className="den-eyebrow">{eyebrow}</p>
          <div className="grid gap-2">
            <h2 className="den-title-lg">{activeContent.title}</h2>
            <p className="den-copy">{activeContent.copy}</p>
          </div>
        </div>

        {desktopAuthRequested && desktopRedirectUrl ? (
          <div className="grid gap-3">
            <button
              type="button"
              className="den-button-primary w-full"
              onClick={() => window.location.assign(desktopRedirectUrl)}
            >
              Open OpenWork
              <ArrowRight className="h-4 w-4" />
            </button>
            <p className="m-0 text-center text-xs text-[var(--dls-text-secondary)]">
              Sign in below, then click above to return to the app.
            </p>
          </div>
        ) : null}

        {emailFirstStep === "email" ? (
          <form className="grid gap-4" onSubmit={resolveEmailFirstStep}>
            <label className="grid gap-2">
              <span className="den-label">Email</span>
              <input
                className="den-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <button
              type="submit"
              className="den-button-primary w-full"
              disabled={emailFirstFormBusy}
            >
              {loginOptionBusy ? "Checking..." : "Next"}
              {!loginOptionBusy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>
        ) : null}

        {emailFirstStep === "sso" ? (
          <button
            type="button"
            className="den-button-primary w-full"
            onClick={startEmailFirstSso}
            disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
          >
            Sign in with SSO
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : null}

        {emailFirstStep === "google" ? (
          <SocialButton
            onClick={() => void beginSocialAuth("google")}
            disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
          >
            <GoogleLogo />
            <span>Sign in with Google</span>
          </SocialButton>
        ) : null}

        {emailFirstStep === "github" ? (
          <SocialButton
            onClick={() => void beginSocialAuth("github")}
            disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
          >
            <GitHubLogo />
            <span>Sign in with GitHub</span>
          </SocialButton>
        ) : null}

        {emailFirstStep === "password" ? (
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              const next = await submitAuth(event);
              await handleAuthNavigation(next);
            }}
          >
            <label className="grid gap-2">
              <span className="den-label">Password</span>
              <input
                className="den-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className="-mt-2 flex justify-end">
              <button
                type="button"
                className="text-sm font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
                onClick={() => {
                  setAuthMode("sign-in");
                  setPasswordResetRequested(true);
                  setPasswordResetInfo("");
                  setPasswordResetError(null);
                }}
              >
                Forgot password?
              </button>
            </div>
            <button type="submit" className="den-button-primary w-full" disabled={formBusy}>
              {formBusy ? "Working..." : "Sign in"}
              {!formBusy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>
        ) : null}

        {emailFirstStep === "new_account" ? (
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              const next = await submitAuth(event);
              await handleAuthNavigation(next);
            }}
          >
            <label className="grid gap-2">
              <span className="den-label">Email</span>
              <input
                className="den-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="grid gap-2">
              <span className="den-label">Name</span>
              <input
                className="den-input"
                type="text"
                value={authName}
                onChange={(event) => setAuthName(event.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <div className="den-divider" aria-hidden="true">
              <span>or</span>
            </div>
            <SocialButton
              onClick={() => void beginSocialAuth("google")}
              disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
            >
              <GoogleLogo />
              <span>Sign up with Google</span>
            </SocialButton>
            <label className="grid gap-2">
              <span className="den-label">Password</span>
              <input
                className="den-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <button type="submit" className="den-button-primary w-full" disabled={formBusy}>
              {formBusy ? "Working..." : "Sign up"}
              {!formBusy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>
        ) : null}

        {loginOptionError || showAuthFeedback ? (
          <div
            className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3 text-center text-[13px] text-[var(--dls-text-secondary)]"
            aria-live="polite"
          >
            {loginOptionError ? <p className="font-medium text-rose-600">{loginOptionError}</p> : <p>{authInfo}</p>}
            {!loginOptionError && authError ? <p className="font-medium text-rose-600">{authError}</p> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={shellClass("gap-4 sm:gap-5", "p-5 sm:p-6 md:p-7")}>
      <div className="grid gap-3">
        <p className="den-eyebrow">{eyebrow}</p>
        <div className="grid gap-2">
          <h2 className="den-title-lg">{activeContent.title}</h2>
          <p className="den-copy">{activeContent.copy}</p>
        </div>
      </div>

      {showModeTabs ? (
        <div
          className="grid grid-cols-2 gap-1 rounded-full border border-[var(--dls-border)] bg-[var(--dls-hover)] p-1"
          role="group"
          aria-label="Choose sign in or create account"
        >
          <button
            type="button"
            aria-pressed={visibleAuthMode === "sign-in"}
            onClick={() => switchMode("sign-in")}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
              visibleAuthMode === "sign-in"
                ? "bg-[var(--dls-surface)] text-[var(--dls-text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
                : "text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={visibleAuthMode === "sign-up"}
            onClick={() => switchMode("sign-up")}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
              visibleAuthMode === "sign-up"
                ? "bg-[var(--dls-surface)] text-[var(--dls-text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
                : "text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"
            }`}
          >
            Create account
          </button>
        </div>
      ) : null}

      {desktopAuthRequested && desktopRedirectUrl ? (
        <div className="grid gap-3">
          <button
            type="button"
            className="den-button-primary w-full"
            onClick={() => window.location.assign(desktopRedirectUrl)}
          >
            Open OpenWork
            <ArrowRight className="h-4 w-4" />
          </button>
          <p className="m-0 text-center text-xs text-[var(--dls-text-secondary)]">
            Sign in below, then click above to return to the app.
          </p>
        </div>
      ) : null}

      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          if (isPasswordResetRequest) {
            await submitPasswordResetRequest(event);
            return;
          }

          const next = verificationRequired
            ? await submitVerificationCode(event)
            : await submitAuth(event);
          await handleAuthNavigation(next);
        }}
      >
        {showSingleOrgSso ? (
          <>
            <button
              type="button"
              className="den-button-primary w-full"
              onClick={startSingleOrgSso}
              disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
            >
              Continue with SSO
              <ArrowRight className="h-4 w-4" />
            </button>

            {showSingleOrgSsoDivider ? (
              <div className="den-divider" aria-hidden="true">
                <span>or</span>
              </div>
            ) : null}
          </>
        ) : null}

        {showSocialAuth ? (
          <>
            <SocialButton
              onClick={() => void beginSocialAuth("github")}
              disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
            >
              <GitHubLogo />
              <span>Continue with GitHub</span>
            </SocialButton>

            <SocialButton
              onClick={() => void beginSocialAuth("google")}
              disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
            >
              <GoogleLogo />
              <span>Continue with Google</span>
            </SocialButton>

            <div className="den-divider" aria-hidden="true">
              <span>or</span>
            </div>
          </>
        ) : null}

        {showLockedEmailSummary ? (
          <div className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3">
            <p className="den-label">Invited email</p>
            <p className="m-0 text-sm font-medium text-[var(--dls-text-primary)]">{prefilledEmail}</p>
          </div>
        ) : null}

        {showEmailPasswordAuth && !hideEmailField ? (
          <label className="grid gap-2">
            <span className="den-label">Email</span>
            <input
              className="den-input disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              readOnly={lockEmail}
              disabled={lockEmail}
              required
            />
          </label>
        ) : null}

        {showEmailPasswordAuth && !verificationRequired && !isPasswordResetRequest ? (
          <label className="grid gap-2">
            <span className="den-label">Password</span>
            <input
              className="den-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={visibleAuthMode === "sign-up" ? "new-password" : "current-password"}
              required
            />
          </label>
        ) : verificationRequired ? (
          <label className="grid gap-2">
            <span className="den-label">Verification code</span>
            <input
              className="den-input text-center text-[18px] font-semibold tracking-[0.35em]"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={verificationCode}
              onChange={(event) =>
                setVerificationCode(event.target.value.replace(/\D+/g, "").slice(0, 6))
              }
              autoComplete="one-time-code"
              required
            />
          </label>
        ) : null}

        {showEmailPasswordAuth && !verificationRequired && !isPasswordResetRequest && !hideEmailField ? (
          // Always rendered (invisible in sign-up) so switching modes never
          // changes the card height.
          <div className={`-mt-2 flex justify-end ${visibleAuthMode === "sign-in" ? "" : "invisible"}`}>
            <button
              type="button"
              tabIndex={visibleAuthMode === "sign-in" ? 0 : -1}
              aria-hidden={visibleAuthMode !== "sign-in"}
              className="text-sm font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
              onClick={() => {
                setAuthMode("sign-in");
                setPasswordResetRequested(true);
                setPasswordResetInfo("");
                setPasswordResetError(null);
              }}
            >
              Forgot password?
            </button>
          </div>
        ) : null}

        {showEmailPasswordAuth ? (
          <button
            type="submit"
            className="den-button-primary w-full"
            disabled={formBusy}
          >
            {formBusy ? "Working..." : activeContent.submitLabel}
            {!formBusy ? <ArrowRight className="h-4 w-4" /> : null}
          </button>
        ) : null}

        {verificationRequired ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="den-button-secondary w-full"
              onClick={() => void resendVerificationCode()}
              disabled={authBusy || desktopRedirectBusy}
            >
              Resend code
            </button>
            <button
              type="button"
              className="den-button-secondary w-full"
              onClick={() => {
                cancelVerification();
              }}
              disabled={authBusy || desktopRedirectBusy}
            >
              Change email
            </button>
          </div>
        ) : null}
      </form>

      {isPasswordResetRequest ? (
        <div className="flex flex-col gap-2 border-t border-[var(--dls-border)] pt-4 text-sm text-[var(--dls-text-secondary)] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <p className="m-0">Remembered your password?</p>
          <button
            type="button"
            className="font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
            onClick={() => {
              setPasswordResetRequested(false);
              setPasswordResetInfo("");
              setPasswordResetError(null);
              setAuthMode("sign-in");
            }}
          >
            Back to sign in
          </button>
        </div>
      ) : null}

      {isPasswordResetRequest && (passwordResetInfo || passwordResetError) ? (
        <div
          className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3 text-center text-[13px] text-[var(--dls-text-secondary)]"
          aria-live="polite"
        >
          {passwordResetInfo ? <p>{passwordResetInfo}</p> : null}
          {passwordResetError ? <p className="font-medium text-rose-600">{passwordResetError}</p> : null}
        </div>
      ) : null}

      {!isPasswordResetRequest && showAuthFeedback ? (
        <div
          className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3 text-center text-[13px] text-[var(--dls-text-secondary)]"
          aria-live="polite"
        >
          <p>{authInfo}</p>
          {authError ? <p className="font-medium text-rose-600">{authError}</p> : null}
          {!authError && verificationRequired && !isSingleOrgMode ? (
            <div className="mt-1 inline-flex items-center justify-center gap-1 text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Waiting for your verification code</span>
            </div>
          ) : null}
          {authError && visibleAuthMode === "sign-in" && !isSingleOrgPrivateSignup && !verificationRequired && showEmailPasswordAuth ? (
            <button
              type="button"
              className="mt-1 inline-flex items-center justify-center gap-1 font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
              onClick={() => switchMode("sign-up")}
            >
              New here? Create an account
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
