"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
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

  useEffect(() => {
    if (!open) {
      setPassword("");
      setError(null);
      setBusy(false);
      setLoadingMethods(false);
      return;
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

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.email) {
      setError("Sign in again to continue.");
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
    setBusy(true);
    setError(null);
    try {
      const callbackURL = getCurrentUrl();
      const { response, payload } = await requestJson("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider, callbackURL, errorCallbackURL: callbackURL }),
      });
      if (!response.ok) {
        setError(getErrorMessage(payload, `${getSocialLabel(provider)} sign-in failed (${response.status}).`));
        setBusy(false);
        return;
      }

      const redirectUrl = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string"
        ? payload.url
        : response.headers.get("location") ?? "";
      if (!redirectUrl) {
        setError(`${getSocialLabel(provider)} sign-in did not return a redirect URL.`);
        setBusy(false);
        return;
      }

      window.location.assign(redirectUrl);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `${getSocialLabel(provider)} sign-in failed.`);
      setBusy(false);
    }
  }

  function continueSso() {
    if (!ssoUrl || !user?.email) {
      setError("This workspace is managed by your organization, but no SSO sign-in URL is available for this email.");
      return;
    }

    const nextUrl = new URL(ssoUrl, window.location.origin);
    nextUrl.searchParams.set("callbackURL", getCurrentUrl());
    nextUrl.searchParams.set("loginHint", user.email);
    window.location.assign(nextUrl.toString());
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]">
        <div className="grid gap-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">Re-authentication required</p>
          <div className="grid gap-2">
            <h2 className="text-[24px] font-semibold tracking-[-0.03em] text-gray-950">Sign in again to continue</h2>
            <p className="text-[15px] leading-7 text-gray-600">
              This admin action needs a recent sign-in. Password verification retries automatically; redirect sign-ins return you here to retry safely.
            </p>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-6 grid gap-4">
          {loadingMethods ? (
            <div className="rounded-[18px] border border-gray-200 bg-gray-50 px-4 py-3 text-[14px] text-gray-500">
              Checking available sign-in methods...
            </div>
          ) : null}

          {hasManagedOrgSignIn ? (
            <DenButton onClick={continueSso} loading={busy || loadingMethods} disabled={!ssoUrl || busy || loadingMethods}>
              Continue with organization SSO
            </DenButton>
          ) : null}

          {socialProviders.map((provider) => (
            <button
              key={provider}
              type="button"
              className={buttonVariants({ variant: "secondary", className: "w-full" })}
              disabled={busy}
              onClick={() => void continueSocial(provider)}
            >
              Continue with {getSocialLabel(provider)}
            </button>
          ))}

          {hasPassword ? (
            <form className="grid gap-3" onSubmit={submitPassword}>
              <label className="grid gap-2">
                <span className="text-[13px] font-medium text-gray-700">Password for {user?.email ?? "your account"}</span>
                <DenInput
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                  required
                />
              </label>
              <DenButton type="submit" loading={busy} disabled={!password.trim()}>
                Verify password
              </DenButton>
            </form>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end">
          <DenButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </DenButton>
        </div>
      </div>
    </div>
  );
}
