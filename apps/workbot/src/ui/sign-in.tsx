import { useState } from "react";
import { workbot } from "@/lib/bridge";
import { buildDenSignInUrl, exchangeGrant, parsePastedGrant, writeDenSession, type DenSession } from "@/lib/den";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";

/**
 * Work Bot requires the OpenWork Cloud connection: workers, schedules, and
 * asynchronous runs outlive the desktop session. Sign-in reuses the Den
 * desktop handoff — open Den, copy the sign-in link, paste it here.
 */
export function SignInGate({
  denBaseUrl,
  onSignedIn,
  onDismiss,
}: {
  denBaseUrl: string;
  onSignedIn: (session: DenSession) => void;
  /** Present only when the app can be used without signing in right now. */
  onDismiss?: (() => void) | null;
}) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    const parsed = parsePastedGrant(pasted);
    if (!parsed) {
      setError("Paste the full sign-in link from Den (or the raw sign-in code).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = await exchangeGrant(parsed.baseUrl ?? denBaseUrl, parsed.grant);
      writeDenSession(session);
      onSignedIn(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-8">
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-spark">Work Bot</p>
        <h1 className="mb-2 text-2xl font-semibold text-snow">Connect your OpenWork account</h1>
        <p className="mb-6 text-sm leading-relaxed text-mist">
          Workers keep working when this window is closed, so Work Bot runs on your OpenWork Cloud
          account. Sign in on the web, copy the sign-in link, and paste it below.
        </p>
        <div className="space-y-4">
          <Button variant="primary" className="w-full" onClick={() => void workbot.openExternal(buildDenSignInUrl(denBaseUrl))}>
            Open OpenWork sign-in
          </Button>
          <Field label="Paste sign-in link">
            <input
              className={inputClass}
              value={pasted}
              placeholder="openwork://den-auth?grant=…"
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
            />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button className="w-full" disabled={busy || !pasted.trim()} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          {onDismiss ? (
            <Button variant="ghost" className="w-full" onClick={onDismiss}>
              Not now
            </Button>
          ) : null}
          <p className="text-center text-xs text-mist">Powered by OpenWork</p>
        </div>
      </div>
    </div>
  );
}
