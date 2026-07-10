"use client";

import { ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "./ui/button";
import { DenInput } from "./ui/input";
import { type AuthUser, getErrorMessage, getUser, requestJson, type SocialAuthProvider } from "../_lib/den-flow";
import { type DenOrgContext, getRequireSsoFromMetadata } from "../_lib/den-org";

function getCurrentUrl() {
  return typeof window === "undefined" ? "/" : window.location.href;
}

function getSocialLabel(provider: SocialAuthProvider) {
  return provider === "google" ? "Google" : "GitHub";
}

function getRedirectUrl(response: Response, payload: unknown) {
  return payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string"
    ? payload.url
    : response.headers.get("location") ?? "";
}

function getReauthCompleteUrl(nonce: string, error = false) {
  const url = new URL("/reauth/complete", window.location.origin);
  url.searchParams.set("nonce", nonce);
  if (error) {
    url.searchParams.set("error", "1");
  }
  return url.toString();
}

type ReauthCompleteMessage = {
  type: "openwork:reauth-complete";
  nonce: string;
  error: string | null;
};

function getReauthCompleteMessage(data: unknown): ReauthCompleteMessage | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (!("type" in data) || data.type !== "openwork:reauth-complete") {
    return null;
  }
  if (!("nonce" in data) || typeof data.nonce !== "string") {
    return null;
  }
  const error = "error" in data ? data.error : null;
  if (error !== null && typeof error !== "string") {
    return null;
  }
  return { type: "openwork:reauth-complete", nonce: data.nonce, error };
}

const REAUTH_SOCIAL_PROVIDERS: readonly SocialAuthProvider[] = ["google", "github"];

export function ReauthDialog({
  open,
  user,
  orgContext,
  onCancel,
  onVerified,
}: {
  open: boolean;
  user: AuthUser | null;
  orgContext: DenOrgContext | null;
  onCancel: () => void;
  onVerified: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMethods, setLoadingMethods] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [ssoUrl, setSsoUrl] = useState<string | null>(null);
  const [nonce, setNonce] = useState("");
  const wasOpenRef = useRef(false);
  const onVerifiedRef = useRef(onVerified);
  const popupRef = useRef<Window | null>(null);
  const popupClosedIntervalRef = useRef<number | null>(null);

  const effectiveProviders = providers.length > 0 ? providers : user?.authProviders ?? [];
  const hasPassword = !loadingMethods && (effectiveProviders.length === 0 || effectiveProviders.includes("email"));
  const socialProviders = useMemo(
    () => REAUTH_SOCIAL_PROVIDERS.filter((provider) => effectiveProviders.includes(provider)),
    [effectiveProviders],
  );
  const hasManagedOrgSignIn = Boolean(
    ssoUrl ||
      getRequireSsoFromMetadata(orgContext?.organization.metadata ?? null) ||
      orgContext?.authMethods.sso ||
      orgContext?.authMethods.scim ||
      effectiveProviders.includes("sso") ||
      effectiveProviders.includes("scim"),
  );

  function stopPopupWatcher() {
    if (popupClosedIntervalRef.current !== null) {
      window.clearInterval(popupClosedIntervalRef.current);
      popupClosedIntervalRef.current = null;
    }
    popupRef.current = null;
  }

  function startPopupWatcher(popup: Window) {
    stopPopupWatcher();
    popupRef.current = popup;
    popupClosedIntervalRef.current = window.setInterval(() => {
      if (!popup.closed) {
        return;
      }
      stopPopupWatcher();
      setBusy(false);
    }, 500);
  }

  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      stopPopupWatcher();
      setPassword("");
      setError(null);
      setBusy(false);
      setLoadingMethods(false);
      return;
    }

    if (!wasOpenRef.current) {
      setNonce(crypto.randomUUID());
      wasOpenRef.current = true;
    }

    let cancelled = false;
    setLoadingMethods(true);

    void (async () => {
      try {
        const meResult = await requestJson("/v1/me", { method: "GET" }, 12000);
        const refreshedUser = getUser(meResult.payload);
        if (!cancelled && refreshedUser) {
          setProviders(refreshedUser.authProviders);
        }

        const email = refreshedUser?.email ?? user?.email ?? "";
        if (email) {
          const ssoResult = await requestJson(`/v1/orgs/sso/resolve?email=${encodeURIComponent(email)}`, { method: "GET" }, 12000);
          if (!cancelled && ssoResult.response.ok) {
            const payload = ssoResult.payload;
            const nextUrl = payload && typeof payload === "object" && "signInUrl" in payload && typeof payload.signInUrl === "string"
              ? payload.signInUrl
              : null;
            setSsoUrl(nextUrl);
          }
        }
      } finally {
        if (!cancelled) {
          setLoadingMethods(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, user?.email]);

  useEffect(() => {
    if (!open || !nonce) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const message = getReauthCompleteMessage(event.data);
      if (event.origin !== window.location.origin || !message || message.nonce !== nonce) {
        return;
      }

      const popup = popupRef.current;
      stopPopupWatcher();
      popup?.close();

      if (message.error) {
        setError("Sign-in was cancelled or failed. Try again.");
        setBusy(false);
        return;
      }

      // This message only says "try again now"; the retried request still hits
      // the server-side freshness check, so a forged message cannot bypass reauth.
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          await onVerifiedRef.current();
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : "Re-authentication failed.");
          setBusy(false);
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      stopPopupWatcher();
    };
  }, [open, nonce]);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.email) {
      setError("Confirm it's you to continue.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: user.email, password }),
      });

      if (!response.ok) {
        setError(getErrorMessage(payload, `Re-authentication failed (${response.status}).`));
        return;
      }

      await onVerified();
      setPassword("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Re-authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function continueSocial(provider: SocialAuthProvider) {
    const popup = window.open("", "openwork-reauth", "popup,width=480,height=640");
    setBusy(true);
    setError(null);
    try {
      const callbackURL = popup ? getReauthCompleteUrl(nonce) : getCurrentUrl();
      const errorCallbackURL = popup ? getReauthCompleteUrl(nonce, true) : callbackURL;
      const { response, payload } = await requestJson("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider, callbackURL, errorCallbackURL }),
      });
      if (!response.ok) {
        popup?.close();
        setError(getErrorMessage(payload, `${getSocialLabel(provider)} sign-in failed (${response.status}).`));
        setBusy(false);
        return;
      }

      const redirectUrl = getRedirectUrl(response, payload);
      if (!redirectUrl) {
        popup?.close();
        setError(`${getSocialLabel(provider)} sign-in did not return a redirect URL.`);
        setBusy(false);
        return;
      }

      if (!popup) {
        window.location.assign(redirectUrl);
        return;
      }

      popup.location.href = redirectUrl;
      startPopupWatcher(popup);
    } catch (nextError) {
      popup?.close();
      setError(nextError instanceof Error ? nextError.message : `${getSocialLabel(provider)} sign-in failed.`);
      setBusy(false);
    }
  }

  function continueSso() {
    if (!ssoUrl || !user?.email) {
      setError("This workspace is managed by your organization, but no SSO sign-in URL is available for this email.");
      return;
    }

    const popup = window.open("", "openwork-reauth", "popup,width=480,height=640");
    setBusy(true);
    setError(null);
    try {
      const nextUrl = new URL(ssoUrl, window.location.origin);
      nextUrl.searchParams.set("callbackURL", popup ? getReauthCompleteUrl(nonce) : getCurrentUrl());
      nextUrl.searchParams.set("loginHint", user.email);

      if (!popup) {
        window.location.assign(nextUrl.toString());
        return;
      }

      popup.location.href = nextUrl.toString();
      startPopupWatcher(popup);
    } catch (nextError) {
      popup?.close();
      setError(nextError instanceof Error ? nextError.message : "Organization SSO sign-in failed.");
      setBusy(false);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 py-6 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-dialog-title"
        // Test seam: the reauth popup eval matches the completion message to this nonce.
        data-reauth-nonce={nonce}
        className="w-full max-w-[460px] overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_32px_100px_-28px_rgba(15,23,42,0.55)]"
      >
        <div className="relative border-b border-slate-100 bg-gradient-to-br from-slate-50 via-white to-indigo-50/60 px-6 pb-6 pt-7">
          <button
            type="button"
            aria-label="Close security check"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            disabled={busy}
            onClick={onCancel}
          >
            <X size={17} aria-hidden="true" />
          </button>
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-indigo-100 bg-white text-indigo-600 shadow-sm">
            <ShieldCheck size={24} strokeWidth={1.8} aria-hidden="true" />
          </div>
          <div className="grid gap-2 pr-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-500">Security check</p>
            <h2 id="reauth-dialog-title" className="text-[25px] font-semibold tracking-[-0.035em] text-slate-950">
              Confirm it's you to continue
            </h2>
            <p className="text-[14px] leading-6 text-slate-600">
              Changing workspace settings requires a recent sign-in. OpenWork retries the pending action automatically after you confirm.
            </p>
          </div>
        </div>

        <div className="p-6">
          {user?.email ? (
            <div className="mb-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[12px] font-semibold uppercase text-white">
                {user.email.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">Signing in as</p>
                <p className="truncate text-[13px] font-medium text-slate-700">{user.email}</p>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mb-5 rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
              {error}
            </div>
          ) : null}

          <div className="grid gap-4">
            {loadingMethods ? (
              <div className="rounded-[18px] border border-gray-200 bg-gray-50 px-4 py-3 text-[14px] text-gray-500">
                Checking available sign-in methods...
              </div>
            ) : null}

            {hasManagedOrgSignIn ? (
              <DenButton className="w-full" onClick={continueSso} loading={busy || loadingMethods} disabled={!ssoUrl || busy || loadingMethods}>
                Continue with organization SSO
              </DenButton>
            ) : null}

            {socialProviders.map((provider) => {
              const primarySocial = !hasManagedOrgSignIn && (provider === "google" || socialProviders.length === 1);
              return (
                <button
                  key={provider}
                  type="button"
                  className={buttonVariants({ variant: primarySocial ? "primary" : "secondary", className: "w-full" })}
                  disabled={busy}
                  onClick={() => void continueSocial(provider)}
                >
                  Continue with {getSocialLabel(provider)}
                </button>
              );
            })}

            {hasPassword ? (
              <form className="grid gap-3" onSubmit={submitPassword}>
                <label className="grid gap-2">
                  <span className="text-[13px] font-medium text-gray-700">Password</span>
                  <DenInput
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    disabled={busy}
                    required
                  />
                </label>
                <DenButton className="w-full" type="submit" loading={busy} disabled={!password.trim()}>
                  Verify password
                </DenButton>
              </form>
            ) : null}
          </div>

          <button
            type="button"
            className="mt-5 w-full rounded-full py-2 text-[13px] font-medium text-slate-500 transition-colors hover:text-slate-800 disabled:opacity-60"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
