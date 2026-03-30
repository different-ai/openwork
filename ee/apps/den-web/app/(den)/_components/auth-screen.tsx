"use client";

import { Dithering, MeshGradient } from "@paper-design/shaders-react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isSamePathname } from "../_lib/client-route";
import { useDenFlow } from "../_providers/den-flow-provider";

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

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <p className="mb-2 text-[14px] font-medium text-gray-900">{title}</p>
      <p className="text-[13px] leading-[1.6] text-gray-500">{body}</p>
    </div>
  );
}

function SocialButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-7">
      <div className="grid gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
          OpenWork Cloud
        </p>
        <h2 className="text-[28px] font-semibold tracking-[-0.04em] text-gray-900">{title}</h2>
        <p className="text-[14px] leading-relaxed text-gray-500">{body}</p>
      </div>
      <div className="mt-6 h-2 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-gray-900/80" />
      </div>
    </div>
  );
}

export function AuthScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const routingRef = useRef(false);
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
    resolveUserLandingRoute,
  } = useDenFlow();
  const desktopGrant = getDesktopGrant(desktopRedirectUrl);
  const hasResolvedSession = sessionHydrated && Boolean(user) && !desktopAuthRequested;

  const copyDesktopValue = async (field: "link" | "code", value: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedDesktopField(field);
    window.setTimeout(() => {
      setCopiedDesktopField((current) => (current === field ? null : current));
    }, 1800);
  };

  useEffect(() => {
    if (!hasResolvedSession || routingRef.current) {
      return;
    }

    routingRef.current = true;
    void resolveUserLandingRoute()
      .then((target) => {
        if (target && !isSamePathname(pathname, target)) {
          router.replace(target);
        }
      })
      .finally(() => {
        routingRef.current = false;
      });
  }, [hasResolvedSession, pathname, resolveUserLandingRoute, router]);

  const panelTitle = verificationRequired
    ? "Verify your email."
    : authMode === "sign-up"
      ? "Create your Cloud account."
      : "Sign in to Cloud.";

  const panelCopy = verificationRequired
    ? "Enter the six-digit code from your inbox to finish setup."
    : authMode === "sign-up"
      ? "Start with email, GitHub, or Google."
      : "Welcome back. Keep your team setup in sync across Cloud and desktop.";

  if (!sessionHydrated) {
    return (
      <section className="den-page flex w-full items-center py-4 lg:min-h-[calc(100vh-2.5rem)]">
        <LoadingPanel title="Checking your session." body="Loading your Cloud account state..." />
      </section>
    );
  }

  return (
    <section className="den-page flex w-full items-center py-4 lg:min-h-[calc(100vh-2.5rem)]">
      <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="order-2 flex flex-col gap-6 lg:order-1">
          <div className="relative min-h-[300px] overflow-hidden rounded-[32px] border border-gray-100 px-7 py-8 md:px-10 md:py-10">
            <div className="absolute inset-0 z-0">
              <Dithering
                speed={0}
                shape="warp"
                type="4x4"
                size={2.5}
                scale={1}
                frame={30214.2}
                colorBack="#00000000"
                colorFront="#FEFEFE"
                style={{ backgroundColor: "#142033", width: "100%", height: "100%" }}
              >
                <MeshGradient
                  speed={0.1}
                  distortion={0.8}
                  swirl={0.1}
                  grainMixer={0}
                  grainOverlay={0}
                  frame={176868.9}
                  colors={["#0F172A", "#1E40AF", "#4C1D95", "#0F766E"]}
                  style={{ width: "100%", height: "100%" }}
                />
              </Dithering>
            </div>

            <div className="relative z-10 flex h-full flex-col justify-between gap-10">
              <div className="flex items-center gap-3">
                <img src="/openwork-logo-transparent.svg" alt="OpenWork" className="h-9 w-auto" />
                <span className="text-[13px] font-medium text-white/80">OpenWork Cloud</span>
              </div>

              <div className="grid gap-4">
                <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                  Shared setups
                </span>
                <h1 className="max-w-[12ch] text-[2.25rem] font-semibold leading-[0.95] tracking-[-0.06em] text-white md:text-[3rem]">
                  Share your OpenWork setup with your team.
                </h1>
                <p className="max-w-[34rem] text-[15px] leading-7 text-white/80">
                  Provision shared setups, invite your org, and keep background workspaces available across Cloud and desktop.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard
              title="Team sharing"
              body="Package skills, MCPs, plugins, and config once so the whole org can use the same setup."
            />
            <FeatureCard
              title="Cloud Hosted Agents"
              body="Keep selected workflows running in the cloud without asking each teammate to run them locally."
            />
            <FeatureCard
              title="Custom LLM Providers"
              body="Whether you want to use LiteLLM, Azure, or any other provider, you can use OpenWork to provision your team."
            />
          </div>
        </div>

        <div className="order-1 lg:order-2">
          {hasResolvedSession ? (
            <LoadingPanel
              title="Redirecting to your workspace."
              body="We found your account and are sending you to the right Cloud destination now."
            />
          ) : (
            <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-7">
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                Account
              </p>
              <h2 className="text-[28px] font-semibold tracking-[-0.04em] text-gray-900">{panelTitle}</h2>
              <p className="text-[14px] leading-relaxed text-gray-500">{panelCopy}</p>
            </div>

            {desktopAuthRequested ? (
              <div className="mt-5 rounded-2xl border border-sky-100 bg-sky-50 p-4 text-[13px] text-sky-900">
                Finish auth here and we&apos;ll send you back into the OpenWork desktop app.
                {desktopRedirectUrl ? (
                  <div className="mt-4 grid gap-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-medium text-sky-900 transition-colors hover:bg-sky-100"
                        onClick={() => window.location.assign(desktopRedirectUrl)}
                      >
                        Open OpenWork
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-medium text-sky-900 transition-colors hover:bg-sky-100"
                        onClick={() => void copyDesktopValue("link", desktopRedirectUrl)}
                      >
                        {copiedDesktopField === "link" ? "Copied link" : "Copy sign-in link"}
                      </button>
                      {desktopGrant ? (
                        <button
                          type="button"
                          className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-medium text-sky-900 transition-colors hover:bg-sky-100"
                          onClick={() => void copyDesktopValue("code", desktopGrant)}
                        >
                          {copiedDesktopField === "code" ? "Copied code" : "Copy one-time code"}
                        </button>
                      ) : null}
                    </div>
                    <p className="text-xs leading-5 text-sky-800/80">
                      If OpenWork does not open automatically, copy the sign-in link or one-time code and paste it into the OpenWork desktop app.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            <form
              className="mt-5 grid gap-3"
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
              {!verificationRequired ? (
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

                  <div
                    className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400"
                    aria-hidden="true"
                  >
                    <span className="h-px flex-1 bg-gray-200" />
                    <span>or</span>
                    <span className="h-px flex-1 bg-gray-200" />
                  </div>
                </>
              ) : null}

              <label className="grid gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                  Email
                </span>
                <input
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-[14px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>

              {!verificationRequired ? (
                <label className="grid gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                    Password
                  </span>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-[14px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
                    required
                  />
                </label>
              ) : (
                <label className="grid gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                    Verification code
                  </span>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-center text-[18px] font-semibold tracking-[0.35em] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
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
                className="flex w-full items-center justify-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-[14px] font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={authBusy || desktopRedirectBusy}
              >
                {authBusy || desktopRedirectBusy
                  ? "Working..."
                  : verificationRequired
                    ? "Verify email"
                    : authMode === "sign-in"
                      ? "Sign in to Cloud"
                      : "Create Cloud account"}
                {!authBusy && !desktopRedirectBusy ? <ArrowRight className="h-4 w-4" /> : null}
              </button>

              {verificationRequired ? (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    className="w-full rounded-full border border-gray-200 bg-white px-4 py-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void resendVerificationCode()}
                    disabled={authBusy || desktopRedirectBusy}
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    className="w-full rounded-full border border-gray-200 bg-white px-4 py-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => cancelVerification()}
                    disabled={authBusy || desktopRedirectBusy}
                  >
                    Change email
                  </button>
                </div>
              ) : null}
            </form>

            {!verificationRequired ? (
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-200 pt-4 text-sm text-gray-500">
                <p>{authMode === "sign-in" ? "Need an account?" : "Already have an account?"}</p>
                <button
                  type="button"
                  className="font-medium text-gray-900 transition hover:opacity-70"
                  onClick={() => setAuthMode(authMode === "sign-in" ? "sign-up" : "sign-in")}
                >
                  {authMode === "sign-in" ? "Create account" : "Switch to sign in"}
                </button>
              </div>
            ) : null}

            {showAuthFeedback ? (
              <div
                className="mt-4 grid gap-1 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 text-center text-[13px] text-gray-500"
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
          )}
        </div>
      </div>
    </section>
  );
}
