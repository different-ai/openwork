"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useDenFlow } from "../_providers/den-flow-provider";

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

export function AuthScreen() {
  const router = useRouter();
  const routingRef = useRef(false);
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
    user,
    sessionHydrated,
    desktopAuthRequested,
    desktopRedirectUrl,
    desktopRedirectBusy,
    showAuthFeedback,
    submitAuth,
    submitVerificationCode,
    resendVerificationCode,
    cancelVerification,
    beginSocialAuth,
    resolveUserLandingRoute
  } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated || !user || desktopAuthRequested || routingRef.current) {
      return;
    }

    routingRef.current = true;
    void resolveUserLandingRoute().then((target) => {
      if (target) {
        router.replace(target);
      }
      routingRef.current = false;
    });
  }, [desktopAuthRequested, resolveUserLandingRoute, router, sessionHydrated, user]);

  return (
    <section className="mx-auto grid w-full max-w-[32rem] gap-6 px-1 py-2">
      {sessionHydrated ? (
        <div className="grid gap-6 rounded-[32px] border border-white/70 bg-white/92 p-5 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)] backdrop-blur md:p-6">
          <div className="grid gap-3 text-center">
            <h1 className="text-[2rem] font-semibold leading-[1.02] tracking-[-0.045em] text-[var(--dls-text-primary)] md:text-[2.5rem]">
              {verificationRequired
                ? "Verify your email code."
                : authMode === "sign-up"
                  ? "Create your OpenWork Den account."
                  : "Sign in to OpenWork Den."}
            </h1>
            <p className="mx-auto max-w-[24rem] text-[15px] leading-7 text-[var(--dls-text-secondary)]">
              {verificationRequired
                ? "Enter the code from your inbox to finish setting up access to your cloud worker dashboard."
                : "Keep your tasks alive even when your computer sleeps."}
            </p>
          </div>

          {desktopAuthRequested ? (
            <div className="rounded-[24px] border border-sky-200 bg-sky-50/80 px-4 py-3 text-sm text-sky-900">
              Finish auth here and we&apos;ll bounce you back into the OpenWork desktop app automatically.
              {desktopRedirectUrl ? (
                <div className="mt-3">
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-medium text-sky-900 transition hover:border-sky-300 hover:bg-sky-50"
                    onClick={() => window.location.assign(desktopRedirectUrl)}
                  >
                    Open OpenWork
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <form
            className="grid gap-3 rounded-[28px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)] md:p-6"
            onSubmit={async (event) => {
              const next = verificationRequired ? await submitVerificationCode(event) : await submitAuth(event);
              if (next === "dashboard") {
                router.replace("/dashboard");
              } else if (next === "checkout") {
                router.replace("/checkout");
              }
            }}
          >
            {!verificationRequired ? (
              <>
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void beginSocialAuth("github")}
                  disabled={authBusy || desktopRedirectBusy}
                >
                  <GitHubLogo />
                  <span>Continue with GitHub</span>
                </button>

                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void beginSocialAuth("google")}
                  disabled={authBusy || desktopRedirectBusy}
                >
                  <GoogleLogo />
                  <span>Continue with Google</span>
                </button>

                <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400" aria-hidden="true">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span>or</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
              </>
            ) : null}

            <label className="grid gap-2">
              <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Email</span>
              <input
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[15px] text-slate-900 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>

            {!verificationRequired ? (
              <label className="grid gap-2">
                <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Password</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[15px] text-slate-900 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
                  required
                />
              </label>
            ) : (
              <label className="grid gap-2">
                <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Verification code</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-[18px] font-semibold tracking-[0.35em] text-slate-900 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                  autoComplete="one-time-code"
                  required
                />
              </label>
            )}

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center rounded-2xl bg-[#011627] px-4 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(15,23,42,0.14)] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
              disabled={authBusy || desktopRedirectBusy}
            >
              {authBusy || desktopRedirectBusy
                ? "Working..."
                : verificationRequired
                  ? "Verify email"
                  : authMode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
            </button>

            {verificationRequired ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void resendVerificationCode()}
                  disabled={authBusy || desktopRedirectBusy}
                >
                  Resend code
                </button>
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => cancelVerification()}
                  disabled={authBusy || desktopRedirectBusy}
                >
                  Change email
                </button>
              </div>
            ) : null}
          </form>

          {!verificationRequired ? (
            <div className="flex items-center justify-between gap-3 px-1 text-sm text-[var(--dls-text-secondary)]">
              <p>{authMode === "sign-in" ? "Need an account?" : "Already have an account?"}</p>
              <button
                type="button"
                className="font-medium text-[var(--dls-text-primary)] transition hover:opacity-70"
                onClick={() => setAuthMode(authMode === "sign-in" ? "sign-up" : "sign-in")}
              >
                {authMode === "sign-in" ? "Create account" : "Switch to sign in"}
              </button>
            </div>
          ) : null}

          {showAuthFeedback ? (
            <div className="grid gap-1 rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-hover)] px-4 py-3 text-center text-[13px] text-[var(--dls-text-secondary)]" aria-live="polite">
              <p>{authInfo}</p>
              {authError ? <p className="font-medium text-rose-600">{authError}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3 rounded-[32px] border border-white/70 bg-white/92 p-6 text-center shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)]">
          <p className="text-sm text-slate-500">Checking your session...</p>
        </div>
      )}
    </section>
  );
}
