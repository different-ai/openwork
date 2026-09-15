import { useState } from "react";
import { coworkerBridge, type RuntimeInfo } from "@/lib/bridge";
import { buildDenSignInUrl, parsePastedGrant } from "@/lib/den";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
import { CoworkerMark, InlineLoader } from "@/ui/brand";

/**
 * Sign-in is the OpenWork desktop handoff: Den issues a one-time grant and
 * returns it as an `opencoworker://den-auth` link. Packaged builds receive
 * that link from the OS; every build also accepts it pasted. Nothing here
 * invents a second account mechanism, and the grant is exchanged by `App`.
 */
export function SignInGate({
  runtime,
  busy,
  error,
  onGrant,
  onDismiss,
}: {
  runtime: RuntimeInfo;
  busy: boolean;
  error: string;
  onGrant: (grant: string, baseUrl?: string) => void;
  /** Present only when the app can be used without signing in right now. */
  onDismiss?: (() => void) | null;
}) {
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [opened, setOpened] = useState(false);
  const signInUrl = buildDenSignInUrl(runtime.denBaseUrl, runtime.deepLinkScheme);

  function connect() {
    const parsed = parsePastedGrant(pasted);
    if (!parsed) {
      setPasteError("Paste the full sign-in link from OpenWork (or the raw sign-in code).");
      return;
    }
    setPasteError("");
    onGrant(parsed.grant, parsed.baseUrl);
  }

  return (
    <div className="window-shell window-drag flex h-full items-center justify-center p-8" data-testid="sign-in-gate">
      <div className="window-no-drag w-full max-w-md rounded-[26px] border border-line bg-ink/90 p-8">
        <div className="mb-5 flex items-center gap-3">
          <CoworkerMark animated label="Open Coworker" size={52} />
          <div>
            <p className="text-sm font-semibold tracking-[-0.02em] text-snow">Open Coworker</p>
            <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-mist">OpenWork account</p>
          </div>
        </div>
        <h1 className="mb-2 text-2xl font-semibold tracking-[-0.035em] text-snow">Continue with OpenWork</h1>
        <p className="mb-6 text-sm leading-relaxed text-mist">
          Sign in with the same OpenWork account you use in OpenWork Desktop. Your organization's models become
          available to every coworker here, and responsibilities can run in OpenWork Cloud while this Mac is off.
        </p>
        <div className="space-y-4">
          <Button
            variant="primary"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setOpened(true);
              void coworkerBridge.openExternal(signInUrl);
            }}
          >
            {opened ? "Open OpenWork sign-in again" : "Open OpenWork sign-in"}
          </Button>
          <p className="text-xs leading-relaxed text-mist">
            {runtime.deepLinksRegistered
              ? "After signing in, choose “Open in app” and you will land back here. If the browser cannot open the app, copy the link and paste it below."
              : "After signing in, copy the sign-in link OpenWork shows and paste it below."}
          </p>
          <Field label="Paste sign-in link">
            <input
              className={inputClass}
              value={pasted}
              disabled={busy}
              placeholder={`${runtime.deepLinkScheme}://den-auth?grant=…`}
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") connect();
              }}
            />
          </Field>
          {busy ? <InlineLoader label="Connecting your OpenWork account" /> : null}
          {pasteError || error ? <ErrorNote>{pasteError || error}</ErrorNote> : null}
          <Button aria-busy={busy} className="w-full" disabled={busy || !pasted.trim()} onClick={connect}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          {onDismiss ? (
            <Button variant="ghost" className="w-full" disabled={busy} onClick={onDismiss}>
              Back
            </Button>
          ) : null}
          <p className="text-center text-[10px] uppercase tracking-[0.13em] text-mist/75">Secure sign-in · Powered by OpenWork</p>
        </div>
      </div>
    </div>
  );
}
