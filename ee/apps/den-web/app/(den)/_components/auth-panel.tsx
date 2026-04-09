"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isSamePathname } from "../_lib/client-route";
import type { AuthMode } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

type PanelContent = {
  title: string;
  copy: string;
  submitLabel: string;
  togglePrompt?: string;
  toggleActionLabel?: string;
};

function getDesktopGrant(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const grant = parsed.searchParams.get("grant")?.trim() ?? "";
    return grant || null;
  } catch {
    return null;
  }
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
  eyebrow = "Account",
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
  eyebrow?: string;
  signUpContent?: Partial<PanelContent>;
  signInContent?: Partial<PanelContent>;
  verificationContent?: Partial<PanelContent>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const prefillRef = useRef<string | null>(null);
  const [copiedDesktopField, setCopiedDesktopField] = useState<"link" | "code" | null>(null);
  const {
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
  } = useDenFlow();

  const resolvedSignUpContent: PanelContent = {
    title: "Get started.",
    copy: "Free to try. Team plans from $50/mo.",
    submitLabel: "Create account",
    togglePrompt: "Have an account?",
    toggleActionLabel: "Sign in",
    ...signUpContent,
  };

  const resolvedSignInContent: PanelContent = {
    title: "Welcome back.",
    copy: "Sign in to open your team workspace.",
    submitLabel: "Sign in",
    togglePrompt: "Need an account?",
    toggleActionLabel: "Create one",
    ...signInContent,
  };

  const resolvedVerificationContent: PanelContent = {
    title: "Verify your email.",
    copy: "Enter the six-digit code from your inbox.",
    submitLabel: "Verify email",
    ...verificationContent,
  };

  const desktopGrant = getDesktopGrant(desktopRedirectUrl);
  const activeContent = verificationRequired
    ? resolvedVerificationContent
    : authMode === "sign-in"
      ? resolvedSignInContent
      : resolvedSignUpContent;
  const showLockedEmailSummary = Boolean(prefilledEmail && lockEmail && hideEmailField);

  useEffect(() => {
    const key = prefillKey ?? prefilledEmail?.trim() ?? null;
    if (!key || prefillRef.current === key) {
      return;
    }

    prefillRef.current = key;
    setAuthMode(initialMode);
    setEmail(prefilledEmail?.trim() ?? "");
    setPassword("");
    setVerificationCode("");
  }, [initialMode, prefillKey, prefilledEmail, setAuthMode, setEmail, setPassword, setVerificationCode]);

  const copyDesktopValue = async (field: "link" | "code", value: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedDesktopField(field);
    window.setTimeout(() => {
      setCopiedDesktopField((current) => (current === field ? null : current));
    }, 1800);
  };

  return (
    <div className="den-frame grid gap-5 p-6 md:p-7">
      <div className="grid gap-3">
        <p className="den-eyebrow">{eyebrow}</p>
        <div className="grid gap-2">
          <h2 className="den-title-lg">{activeContent.title}</h2>
          <p className="den-copy">{activeContent.copy}</p>
        </div>
      </div>

      {desktopAuthRequested ? (
        <div className="den-notice is-info grid gap-3 text-[13px]">
          <p className="m-0">Finish sign-in here, then jump back into the OpenWork desktop app.</p>
          {desktopRedirectUrl ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="den-button-secondary w-full sm:w-auto"
                  onClick={() => window.location.assign(desktopRedirectUrl)}
                >
                  Open OpenWork
                </button>
                <button
                  type="button"
                  className="den-button-secondary w-full sm:w-auto"
                  onClick={() => void copyDesktopValue("link", desktopRedirectUrl)}
                >
                  {copiedDesktopField === "link" ? "Copied link" : "Copy sign-in link"}
                </button>
                {desktopGrant ? (
                  <button
                    type="button"
                    className="den-button-secondary w-full sm:w-auto"
                    onClick={() => void copyDesktopValue("code", desktopGrant)}
                  >
                    {copiedDesktopField === "code" ? "Copied code" : "Copy one-time code"}
                  </button>
                ) : null}
              </div>
              <p className="m-0 text-xs leading-5 text-sky-800/80">
                If OpenWork does not open automatically, copy the sign-in link or one-time code and paste it into the OpenWork desktop app.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          const next = verificationRequired
            ? await submitVerificationCode(event)
            : await submitAuth(event);
          if (next === "dashboard" || next === "join-org") {
            const target = await resolveUserLandingRoute();
            if (target && !isSamePathname(pathname, target)) {
              router.replace(target);
            }
          } else if (next === "checkout" && !isSamePathname(pathname, "/checkout")) {
            router.replace("/checkout");
          }
        }}
      >
        {!verificationRequired && !hideSocialAuth ? (
          <>
            <SocialButton
              onClick={() => void beginSocialAuth("github")}
              disabled={authBusy || desktopRedirectBusy}
            >
              <GitHubLogo />
              <span>Continue with GitHub</span>
            </SocialButton>

            <SocialButton
              onClick={() => void beginSocialAuth("google")}
              disabled={authBusy || desktopRedirectBusy}
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

        {!hideEmailField ? (
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

        {!verificationRequired ? (
          <label className="grid gap-2">
            <span className="den-label">Password</span>
            <input
              className="den-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
              required
            />
          </label>
        ) : (
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
        )}

        <button
          type="submit"
          className="den-button-primary w-full"
          disabled={authBusy || desktopRedirectBusy}
        >
          {authBusy || desktopRedirectBusy ? "Working..." : activeContent.submitLabel}
          {!authBusy && !desktopRedirectBusy ? <ArrowRight className="h-4 w-4" /> : null}
        </button>

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
              onClick={() => cancelVerification()}
              disabled={authBusy || desktopRedirectBusy}
            >
              Change email
            </button>
          </div>
        ) : null}
      </form>

      {!verificationRequired ? (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--dls-border)] pt-4 text-sm text-[var(--dls-text-secondary)]">
          <p className="m-0">
            {authMode === "sign-in"
              ? resolvedSignInContent.togglePrompt
              : resolvedSignUpContent.togglePrompt}
          </p>
          <button
            type="button"
            className="font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
            onClick={() => setAuthMode(authMode === "sign-in" ? "sign-up" : "sign-in")}
          >
            {authMode === "sign-in"
              ? resolvedSignInContent.toggleActionLabel
              : resolvedSignUpContent.toggleActionLabel}
          </button>
        </div>
      ) : null}

      {showAuthFeedback ? (
        <div
          className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3 text-center text-[13px] text-[var(--dls-text-secondary)]"
          aria-live="polite"
        >
          <p>{authInfo}</p>
          {authError ? <p className="font-medium text-rose-600">{authError}</p> : null}
          {!authError && verificationRequired ? (
            <div className="mt-1 inline-flex items-center justify-center gap-1 text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Waiting for your verification code</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
