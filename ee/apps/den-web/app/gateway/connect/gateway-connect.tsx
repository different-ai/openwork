"use client";

import { useState } from "react";
import { DenStatusScreen } from "../../../components/den-status-screen";
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
      setError("Signed out. Open Sign in to OpenWork below, use the account that started Connect, then return to this tab.");
    } catch {
      setError("Could not sign out. Open OpenWork in another tab to change accounts, then return here.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenStatusScreen
      title="Connect Google for AI Gateway"
      description="First sign in to OpenWork in this browser using the account that started Connect. Then continue to Google to authorize your own Cloud access. Your Google and OpenWork email addresses do not need to match."
      status={busy ? "Checking your browser session…" : undefined}
      error={error}
    >
      <div className="mt-8 grid gap-4">
        <p className="text-sm text-[var(--dls-text-secondary)]">
          Sign-in opens in another tab. Finish there, then return to this tab and continue. If the connection expires, start Connect again in OpenWork. Google consent alone does not grant Vertex project or model permissions.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href="/" target="_blank" rel="noopener noreferrer" className="den-button-ghost">Sign in to OpenWork</a>
          {code === "browser_account_mismatch" ? (
            <button type="button" className="den-button-ghost" disabled={busy} onClick={() => void signOut()}>Sign out of this browser account</button>
          ) : null}
          <button type="button" className="den-button-primary" disabled={busy} onClick={() => void continueToGoogle()}>Continue to Google</button>
        </div>
        <p className="text-xs text-[var(--dls-text-secondary)]">To cancel, close this tab. Connection attempts expire automatically.</p>
      </div>
    </DenStatusScreen>
  );
}
