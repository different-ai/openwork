import { useEffect, useRef, useState } from "react";
import { createDenClient, readDenSettings, writeDenSettings } from "@/app/lib/den";
import { deepLinkBridgeEvent, type DeepLinkBridgeDetail } from "@/app/lib/deep-link-bridge";
import { dispatchDenSessionUpdated } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDenAuth } from "./den-auth-provider";
import { tryOpenBrowserAuthUrl } from "./open-browser-auth";

/** Verification replaces only this account's session; it cannot enroll another account or workspace. */
export function DenReauthNotice({ onVerified, onCancel }: {
  onVerified: (client: ReturnType<typeof createDenClient>) => Promise<void>;
  onCancel: () => void;
}) {
  const auth = useDenAuth();
  const [user] = useState(auth.user);
  const [settings] = useState(readDenSettings);
  const [nonce] = useState(() => crypto.randomUUID());
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const exchanging = useRef(false);
  const completeRef = useRef(onVerified);
  completeRef.current = onVerified;

  const url = new URL("/reauth/desktop", settings.baseUrl);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("userId", user?.id ?? "");
  url.searchParams.set("email", user?.email ?? "");

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function finish(value: string) {
    if (exchanging.current || !active.current) return;
    if (!user) { setError("Your account could not be confirmed. Cancel and try again."); return; }
    let returned: URL;
    try { returned = new URL(value.trim()); }
    catch { setError("Paste the verification link from your browser."); return; }
    if (returned.protocol !== "openwork:" || returned.hostname !== "den-reauth" || returned.searchParams.get("nonce") !== nonce) {
      setError("This link belongs to another security check. Open verification again for a new link.");
      return;
    }
    const grant = returned.searchParams.get("grant");
    if (!grant) { setError("This verification link is incomplete. Open verification again."); return; }
    exchanging.current = true;
    setBusy(true);
    setError(null);
    const ensureCurrent = () => {
      const current = readDenSettings();
      if (!active.current || current.baseUrl !== settings.baseUrl || current.apiBaseUrl !== settings.apiBaseUrl
        || current.authToken !== settings.authToken || current.activeOrgId !== settings.activeOrgId) {
        throw new Error("Your account or workspace changed. Cancel and start sharing again.");
      }
    };
    try {
      ensureCurrent();
      // Never send a grant to a destination supplied by a link.
      const exchange = await createDenClient(settings).exchangeDesktopHandoff(grant);
      if (!exchange.token || exchange.user?.id !== user.id) {
        throw new Error(`Sign in as ${user.email} to confirm this share.`);
      }
      const client = createDenClient({ ...settings, token: exchange.token });
      const verifiedUser = await client.getSession();
      if (verifiedUser.id !== user.id) throw new Error(`Sign in as ${user.email} to confirm this share.`);
      ensureCurrent();
      writeDenSettings({ ...settings, authToken: exchange.token }, { persistBootstrap: false });
      dispatchDenSessionUpdated({ status: "success", baseUrl: settings.baseUrl, token: exchange.token, user: verifiedUser, email: verifiedUser.email });
      // The resumed mutation still enforces freshness and resource permissions on the server.
      await completeRef.current(client);
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "Could not confirm your identity. Try again.");
    } finally {
      exchanging.current = false;
      if (active.current) setBusy(false);
    }
  }

  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const receive = (event: Event) => {
      const { urls } = (event as CustomEvent<DeepLinkBridgeDetail>).detail;
      for (const value of urls) {
        try {
          const returned = new URL(value);
          if (returned.protocol === "openwork:" && returned.hostname === "den-reauth" && returned.searchParams.get("nonce") === nonce) {
            void finishRef.current(value);
          }
        } catch { /* Other deep links belong to their existing handlers. */ }
      }
    };
    window.addEventListener(deepLinkBridgeEvent, receive);
    return () => window.removeEventListener(deepLinkBridgeEvent, receive);
  }, [nonce]);

  return <div className="space-y-3 rounded-lg border p-4">
    <p className="text-sm font-medium">Confirm your identity to share apps</p>
    <p className="text-sm text-muted-foreground">Verify in your browser, then return here. Your selected apps and teammate’s email will be kept.</p>
    <Button type="button" disabled={busy || !user} onClick={() => {
      setError(null);
      void tryOpenBrowserAuthUrl(url.toString()).then((opened) => {
        if (!opened) setError("Your browser could not open. Copy the verification address below into your browser.");
      });
    }}>Verify in browser</Button>
    <details className="text-sm">
      <summary className="cursor-pointer">Browser didn’t open?</summary>
      <Input aria-label="Verification address" readOnly value={url.toString()} onFocus={(event) => event.target.select()} className="mt-2" />
    </details>
    <label className="block space-y-2 text-sm">
      <span>Or paste your verification link</span>
      <Input value={link} onChange={(event) => setLink(event.target.value)} disabled={busy} autoComplete="off" />
    </label>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel verification</Button>
      <Button type="button" disabled={busy || !link.trim()} onClick={() => void finish(link)}>{busy ? "Confirming…" : "Confirm and share"}</Button>
    </div>
  </div>;
}
