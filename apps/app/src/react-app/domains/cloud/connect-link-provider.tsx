/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ConnectLinkClaims, ConnectLinkTransport, ConnectLinkVerifyErrorCode } from "@openwork/types/connect-link";

import { refreshDenBootstrapConfigFromShell } from "../../../app/lib/den";
import { connectLinkAccept, connectLinkVerify } from "../../../app/lib/desktop";
import {
  deepLinkBridgeEvent,
  drainPendingDeepLinks,
  type DeepLinkBridgeDetail,
} from "../../../app/lib/deep-link-bridge";
import { parseConnectDeepLink } from "../../../app/lib/openwork-links";
import { isDesktopRuntime } from "../../../app/utils";
import { ConnectConfirmDialog, type ConnectConfirmPhase } from "./connect-confirm-dialog";

type ConnectLinkError = { code: ConnectLinkVerifyErrorCode; message: string };

type PendingConnectLink = {
  rawUrl: string;
  key: string;
  claims: ConnectLinkClaims;
  transport: ConnectLinkTransport;
};

type ConnectLinkProviderProps = {
  children: ReactNode;
};

/**
 * Global consumer for signed and short-lived exchange connect links in the
 * normal desktop app. Relays the raw URL to the Electron main process for validation,
 * walks the user through an explicit
 * confirmation, and only then lets the main process persist the new desktop
 * bootstrap config. Mirrors the den-auth-provider deep-link listener pattern.
 */
export function ConnectLinkProvider({ children }: ConnectLinkProviderProps) {
  const [phase, setPhase] = useState<ConnectConfirmPhase | "idle">("idle");
  const [pending, setPending] = useState<PendingConnectLink | null>(null);
  const [error, setError] = useState<ConnectLinkError | null>(null);
  const handledLinksRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<PendingConnectLink | null>(null);

  const beginVerify = useCallback((rawUrl: string, key: string) => {
    handledLinksRef.current.add(key);
    setError(null);
    setPending(null);
    pendingRef.current = null;
    setPhase("verifying");

    void connectLinkVerify(rawUrl).then((result) => {
      if (result.ok) {
        const next = { rawUrl, key, claims: result.claims, transport: result.transport };
        pendingRef.current = next;
        setPending(next);
        setPhase("confirm");
        return;
      }
      // Leave failed links handled — the same broken link should not
      // re-prompt every time the queue replays it.
      setError({ code: result.code, message: result.message });
      setPhase("error");
    }).catch(() => {
      setError({ code: "invalid_token", message: "Could not verify the connect link." });
      setPhase("error");
    });
  }, []);

  const handleUrls = useCallback((urls: readonly string[]) => {
    for (const rawUrl of urls) {
      const parsed = parseConnectDeepLink(rawUrl);
      if (!parsed || handledLinksRef.current.has(parsed.key)) continue;
      beginVerify(parsed.rawUrl, parsed.key);
      // One prompt at a time; later links can arrive again as new deep-link
      // events after the current prompt is resolved.
      break;
    }
  }, [beginVerify]);

  useEffect(() => {
    if (typeof window === "undefined" || !isDesktopRuntime()) return;

    handleUrls(drainPendingDeepLinks(window));
    const handleDeepLink = (event: Event) => {
      handleUrls(((event as CustomEvent<DeepLinkBridgeDetail>).detail?.urls ?? []) as string[]);
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, [handleUrls]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setPending(null);
    pendingRef.current = null;
    setError(null);
  }, []);

  const confirm = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    setPhase("applying");

    void connectLinkAccept(current.rawUrl).then(async (result) => {
      if (!result.ok) {
        setError({ code: result.code, message: result.message });
        setPhase("error");
        return;
      }
      // The shell already persisted desktop-bootstrap.json; converge the
      // renderer snapshot so DenSigninGate takes over (requireSignin flow).
      await refreshDenBootstrapConfigFromShell();
      dismiss();
    }).catch(() => {
      setError({ code: "invalid_token", message: "Could not apply the connect link." });
      setPhase("error");
    });
  }, [dismiss]);

  return (
    <>
      {children}
      <ConnectConfirmDialog
        open={phase !== "idle"}
        phase={phase === "idle" ? "verifying" : phase}
        claims={pending?.claims ?? null}
        transport={pending?.transport ?? null}
        currentHost={null}
        error={error}
        onConfirm={confirm}
        onDismiss={dismiss}
      />
    </>
  );
}
