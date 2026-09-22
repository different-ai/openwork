"use client";

import { useState } from "react";
import { ChevronRight, LockKeyhole } from "lucide-react";
import { DenPageHeader } from "../../(den)/_components/ui/page-header";
import { DenButton, buttonVariants } from "../../(den)/_components/ui/button";
import { DenNotice } from "../../(den)/_components/ui/notice";
import { denApiCredentials } from "../../(den)/_lib/den-api-origin";
import { gatewayBrowserEndpoint } from "./gateway-browser-endpoint";

function readString(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === "string" ? entry : null;
}

export function GatewayConnect() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  async function continueToGoogle() {
    if (busy) return;
    const attempt = new URLSearchParams(window.location.search).get("attempt");
    if (!attempt || !/^entry\.[A-Za-z0-9_-]{43}$/.test(attempt)) {
      setError("This connection link is invalid. Start Connect again in OpenWork.");
      return;
    }
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      const endpoint = await gatewayBrowserEndpoint(`/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`);
      const response = await fetch(endpoint, {
        credentials: denApiCredentials(endpoint),
        headers: { accept: "application/json" },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setCode(readString(payload, "error"));
        setError(readString(payload, "message") ?? "Unable to continue. Start Connect again in OpenWork.");
        return;
      }
      const authUrl = readString(payload, "authUrl");
      const url = authUrl ? new URL(authUrl) : null;
      if (!url || url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) {
        throw new Error("invalid_authorization_url");
      }
      window.location.assign(url.toString());
    } catch {
      setError("The connection could not be continued. If the request already completed, start a new Connect attempt in OpenWork.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const endpoint = await gatewayBrowserEndpoint("/api/auth/sign-out");
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: denApiCredentials(endpoint),
        headers: { "content-type": "application/json" },
        body: "{}",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("signout_failed");
      setCode("browser_signin_required");
      setError("Signed out. Sign in with the OpenWork account that started Connect, then return here.");
    } catch {
      setError("Could not sign out. Open OpenWork in another tab to change accounts, then return here.");
    } finally {
      setBusy(false);
    }
  }

  const blocked = code === "browser_account_mismatch" || code === "browser_signin_required";

  return (
    <main aria-busy={busy} className="flex min-h-dvh items-center justify-center bg-[var(--dls-surface)] p-4 text-sm text-[var(--dls-text-primary)]">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <DenPageHeader title="Connect Google" className="[&_h1]:text-xl [&_h1]:leading-tight [&_h1]:text-[var(--dls-text-primary)]" />
        <p>Use the OpenWork account that started Connect.</p>
        {error ? <DenNotice tone={blocked ? "neutral" : "error"} message={<span className="flex items-start gap-2">{blocked ? <LockKeyhole aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" /> : null}{error}</span>} /> : null}
        <p>Authorize Google Cloud access for OpenWork; failed sign-in cleanup may revoke previous or other connections using the same OAuth client.</p>
        <div className="flex flex-wrap gap-3">
          <DenButton loading={busy} onClick={() => void continueToGoogle()}>Continue to Google</DenButton>
          <a href="/" target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary" })}>Sign in to OpenWork</a>
          {code === "browser_account_mismatch" ? <DenButton variant="secondary" disabled={busy} onClick={() => void signOut()}>Sign out of this browser account</DenButton> : null}
        </div>
        <details className="group border-t border-[var(--dls-border)] py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)] [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" strokeWidth={1.5} className="size-4 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />Technical details</summary>
          <div className="flex flex-col gap-3 pt-3 text-[var(--dls-text-secondary)]">
            <p>Sign in to OpenWork in the other tab, then return here. Your Google and OpenWork email addresses need not match. Google consent does not grant Vertex project permissions or model access.</p>
            <p>Google tokens stay on the server. Google session policy can require interactive sign-in again; unattended access is not guaranteed.</p>
            <p>If sign-in fails after Google issues tokens, cleanup revocation may affect existing connections sharing the OAuth client. Reconnect affected accounts to restore access.</p>
            <p>To cancel, close this tab; connection attempts expire automatically. If this link expires, start Connect again in OpenWork. Disconnect revokes the saved credential and cancels pending sign-ins.</p>
          </div>
        </details>
      </div>
    </main>
  );
}
