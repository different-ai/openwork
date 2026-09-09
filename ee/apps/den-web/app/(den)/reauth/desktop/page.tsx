"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReauthDialog } from "../../_components/reauth-dialog";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getUser, getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getDesktopHandoffGrant } from "../../_lib/desktop-handoff";

function DesktopReauth() {
  const params = useSearchParams();
  const nonce = params.get("nonce") ?? "";
  const [identity, setIdentity] = useState<URLSearchParams | null>(null);
  useEffect(() => { setIdentity(new URLSearchParams(window.location.hash.slice(1))); }, [nonce]);
  const userId = identity?.get("userId") ?? "";
  const email = identity?.get("email") ?? "";
  const [cancelled, setCancelled] = useState(false);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  // These are identity hints, never credentials. Both this page and the desktop
  // validate the signed-in identity; sharing rechecks authorization server-side.
  const user = useMemo(() => ({ id: userId, email, name: null, authProviders: ["email", "google", "github"] }), [userId, email]);
  const valid = /^[a-f0-9-]{36}$/i.test(nonce) && Boolean(userId) && email.includes("@");

  async function verified() {
    // Read the cookie just created by browser sign-in, through that same origin.
    // API discovery and a legacy web bearer token must not select another session.
    const me = await requestJson("/api/auth/get-session", { method: "GET" });
    if (!me.response.ok || !getUser(me.payload)) throw new Error("Your browser session could not be confirmed. Try verification again.");
    if (getUser(me.payload)?.id !== userId) throw new Error(`Sign in as ${email} to confirm this share.`);
    const result = await requestJson("/api/auth/desktop-handoff", { method: "POST", body: JSON.stringify({ desktopScheme: "openwork" }) });
    if (!result.response.ok) throw new Error(getErrorMessage(result.payload, "Could not return verification to OpenWork. Try again."));
    const grant = getDesktopHandoffGrant(result.payload, null);
    if (!grant) throw new Error("Could not create a verification link. Try again.");
    const returned = new URL("openwork://den-reauth");
    returned.searchParams.set("nonce", nonce);
    returned.searchParams.set("grant", grant);
    setLink(returned.toString());
  }

  return <div className="den-page flex min-h-screen items-center justify-center p-6">
    <div className="den-frame grid w-full max-w-[520px] gap-4 p-6">
      <h1 className="den-title-lg">{link ? "Return to OpenWork to finish sharing" : "Confirm your identity to share apps"}</h1>
      {!identity ? <p>Loading security check…</p> : !valid ? <p>Open verification from the Share dialog in OpenWork to start a new security check.</p>
        : cancelled ? <><p>Verification cancelled. Return to the Share dialog in OpenWork.</p><DenButton onClick={() => setCancelled(false)}>Try verification again</DenButton></>
        : link ? <>
          <p>Return to the app to finish your pending share. If it doesn’t open, copy this link and paste it into the Share dialog.</p>
          <a className={buttonVariants()} href={link}>Return to OpenWork</a>
          <DenInput aria-label="Verification link" readOnly value={link} onFocus={(event) => event.target.select()} />
          <DenButton variant="secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Copied" : "Copy verification link"}</DenButton>
        </> : <p>Complete the security check to return to your pending share.</p>}
    </div>
    <ReauthDialog open={valid && !cancelled && !link} user={user} orgContext={null} onCancel={() => setCancelled(true)} onVerified={verified}
      title="Confirm your identity to share apps" description="After verification, return to OpenWork to finish sharing your selected apps." />
  </div>;
}

export default function DesktopReauthPage() {
  return <Suspense fallback={<p>Loading security check…</p>}><DesktopReauth /></Suspense>;
}
