/** @jsxImportSource react */
import { Dithering } from "@paper-design/shaders-react";
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import {
  buildDenAuthUrl,
  readDenBootstrapConfig,
  setDenBootstrapConfig,
} from "@/app/lib/den";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { markDesktopSignInInitiated } from "@/app/lib/den-sign-in-intent";
import { enterpriseActivationRequired } from "@/app/lib/enterprise-activation";
import { readDesktopDistributionInfo } from "@/app/lib/desktop";
import { parseManualAuthInput } from "@/app/lib/manual-auth-input";
import { normalizeOrganizationServerInput } from "@/app/lib/organization-server-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { tryOpenBrowserAuthUrl } from "./open-browser-auth";

function subscribeToBootstrap(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

type PendingServerConfirmation =
  | { kind: "browser"; baseUrl: string }
  | { kind: "manual"; baseUrl: string; grant: string };

export function useEnterpriseActivationRequired() {
  const bootstrap = useSyncExternalStore(
    subscribeToBootstrap,
    readDenBootstrapConfig,
    readDenBootstrapConfig,
  );
  return enterpriseActivationRequired(readDesktopDistributionInfo(), bootstrap);
}

function EnterpriseActivationPage() {
  const [serverInput, setServerInput] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingServerConfirmation | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const submitServer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // The field accepts a pasted openwork:// sign-in link as
    // the recovery path when the browser round trip cannot come back.
    const pastedLink = parseManualAuthInput(serverInput);
    if (pastedLink?.baseUrl && pastedLink.grant) {
      const linkBaseUrl = normalizeOrganizationServerInput(pastedLink.baseUrl);
      if (linkBaseUrl) {
        setPendingConfirmation({ kind: "manual", baseUrl: linkBaseUrl, grant: pastedLink.grant });
        setServerError(null);
        setAuthError(null);
        setStatusMessage(`Confirm ${linkBaseUrl} before continuing.`);
        return;
      }
    }

    const baseUrl = normalizeOrganizationServerInput(serverInput);
    if (!baseUrl) {
      setServerError("Enter a valid workspace address or a full OpenWork sign-in link.");
      return;
    }

    setServerInput(baseUrl);
    setPendingConfirmation({ kind: "browser", baseUrl });
    setServerError(null);
    setAuthError(null);
    setStatusMessage(`Confirm ${baseUrl} before continuing.`);
  };

  const exchangeConfirmedGrant = async (grant: string, baseUrl: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setServerError(null);
    setStatusMessage("Finishing OpenWork Enterprise sign-in…");
    try {
      // The confirmed server, session, and activation stamp commit in one
      // handoff transaction, so activation can never leave the bootstrap and
      // the session pointing at different servers.
      const result = await exchangeHandoffAndSignIn(grant, {
        baseUrl,
        desktopInitiated: true,
        fallbackErrorMessage: "OpenWork Enterprise did not return a session token.",
        bootstrap: {
          requireSignin: true,
          enterpriseActivation: {
            activatedAt: new Date().toISOString(),
            denBaseUrl: baseUrl,
          },
        },
      });
      if (!result.ok) {
        setStatusMessage(null);
        setAuthError(result.error);
        return;
      }
    } catch (error) {
      setStatusMessage(null);
      setAuthError(
        error instanceof Error ? error.message : "Unable to finish OpenWork Enterprise sign-in.",
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const confirmServer = async () => {
    const pending = pendingConfirmation;
    if (!pending || browserBusy || authBusy) return;

    setPendingConfirmation(null);
    setServerInput(pending.baseUrl);
    if (pending.kind === "manual") {
      await exchangeConfirmedGrant(pending.grant, pending.baseUrl);
      return;
    }

    setBrowserBusy(true);
    setServerError(null);
    setAuthError(null);
    try {
      await setDenBootstrapConfig({ baseUrl: pending.baseUrl, requireSignin: true });
      markDesktopSignInInitiated();
      const opened = await tryOpenBrowserAuthUrl(buildDenAuthUrl(pending.baseUrl, "sign-in"));
      if (!opened) {
        setStatusMessage(null);
        setAuthError("We couldn't open your browser automatically. Try again, or paste the sign-in link from your browser into the Workspace address or sign-in link field.");
        return;
      }
      setStatusMessage("Finish signing in in your browser. If OpenWork does not open, copy the sign-in link and paste it here.");
    } catch (error) {
      setStatusMessage(null);
      setServerError(
        error instanceof Error ? error.message : "Unable to save this OpenWork server.",
      );
    } finally {
      setBrowserBusy(false);
    }
  };

  // While the origin confirmation is on screen it is the only decision; the
  // redundant "Confirm X before continuing" status would repeat its question.
  const liveMessage = serverError ?? authError ?? (pendingConfirmation ? null : statusMessage);

  return (
    <div
      className="relative min-h-dvh bg-background text-foreground"
      data-state="enterprise-activation"
      data-testid="enterprise-activation-root"
    >
      <div
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-[0.1] dark:invert"
        data-testid="enterprise-activation-background"
      >
        <Dithering
          className="size-full"
          speed={0.01}
          shape="warp"
          type="2x2"
          size={20.3}
          scale={1.19}
          frame={264559.21}
          colorBack="#00000000"
          colorFront="#000000"
        />
      </div>

      <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

      <div
        className="relative z-10 flex min-h-dvh items-center justify-center px-6 py-16"
        data-testid="enterprise-activation-foreground"
      >
        <section
          className="w-full max-w-[720px] rounded-3xl border border-border bg-background px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14"
          data-testid="enterprise-activation-card"
        >
          <div className="flex items-center gap-2.5">
            <img
              src={resolveExtensionIconSrc("/openwork-mark.svg")}
              alt=""
              width={26}
              height={26}
              className="max-h-[26px] shrink-0 object-contain object-left dark:invert"
              aria-hidden="true"
            />
            <span className="text-[15px] font-semibold tracking-tight text-foreground">
              OpenWork Enterprise
            </span>
          </div>

          <div className="mt-10 flex flex-col gap-2.5 sm:mt-14">
            <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-foreground sm:text-[38px] sm:leading-[46px]">
              Link this app to your organization
            </h1>
            <p className="text-[15px] leading-[23px] text-muted-foreground">
              Enter your workspace address — the page where you downloaded this app — to sign in through your browser.
            </p>
          </div>

          <div className="mt-11 flex flex-col gap-4">
            {pendingConfirmation ? null : (
              <form className="space-y-2" onSubmit={submitServer}>
                <label
                  className="text-sm font-medium text-foreground"
                  htmlFor="organization-server-input"
                >
                  Workspace address or sign-in link
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="organization-server-input"
                    data-testid="organization-server-input"
                    value={serverInput}
                    onChange={(event) => setServerInput(event.currentTarget.value)}
                    placeholder="openwork.acme.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={browserBusy || authBusy}
                    aria-invalid={serverError ? true : undefined}
                    aria-describedby="organization-server-hint"
                  />
                  <Button
                    type="submit"
                    className="sm:min-w-40"
                    disabled={browserBusy || authBusy}
                    data-testid="organization-server-continue"
                  >
                    Continue
                  </Button>
                </div>
                <p id="organization-server-hint" className="text-xs leading-5 text-muted-foreground">
                  Browser not returning to OpenWork? Paste the full sign-in link copied from your browser, including the workspace address. A code on its own is not supported here.
                </p>
              </form>
            )}

            {pendingConfirmation ? (
              <section className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
                <p className="text-sm leading-6 text-foreground">
                  Connect this app to <strong className="break-all font-semibold">{pendingConfirmation.baseUrl}</strong>? This signs you in with that organization and binds OpenWork Enterprise to it.
                </p>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPendingConfirmation(null);
                      setStatusMessage(null);
                    }}
                    disabled={browserBusy || authBusy}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void confirmServer()}
                    disabled={browserBusy || authBusy}
                    data-testid="organization-server-confirm"
                  >
                    {pendingConfirmation.kind === "browser"
                      ? "Continue in browser"
                      : "Confirm and finish sign-in"}
                  </Button>
                </div>
              </section>
            ) : null}

            <div className="min-h-5 text-xs leading-5" aria-live="polite" role="status">
              {liveMessage ? (
                <span className={serverError || authError ? "text-destructive" : "text-muted-foreground"}>
                  {liveMessage}
                </span>
              ) : null}
            </div>

          </div>
        </section>
      </div>
    </div>
  );
}

export function EnterpriseActivationGate({ children }: { children: ReactNode }) {
  return useEnterpriseActivationRequired()
    ? <EnterpriseActivationPage />
    : children;
}
