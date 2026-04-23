/** @jsxImportSource react */

import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { readDenBootstrapConfig } from "../../app/lib/den";
import { denSettingsChangedEvent } from "../../app/lib/den-session-events";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { ForcedSigninPage } from "../domains/cloud/forced-signin-page";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";

type DenSigninGateProps = {
  children: ReactNode;
};

/**
 * Forced-signin gate ported from the Solid shell.
 *
 * When the desktop bootstrap config has `requireSignin: true` (persisted by
 * the Tauri shell via `desktop-bootstrap.json`), the UI is held at `/signin`
 * until the user authenticates with Den. When sign-in is NOT required, we
 * never let users land on `/signin` — redirect them to `/session` instead.
 *
 * While we're still checking the Den session AND sign-in is required, we
 * render nothing so the transcript/settings never flash behind the gate.
 */
function DenSigninGate({ children }: DenSigninGateProps) {
  const denAuth = useDenAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // The bootstrap file is read synchronously; re-read on settings-changed so a
  // developer-mode override flips the gate live without a reload.
  const [requireSignin, setRequireSignin] = useState(
    () => readDenBootstrapConfig().requireSignin,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handler = () => {
      setRequireSignin(readDenBootstrapConfig().requireSignin);
    };

    window.addEventListener(denSettingsChangedEvent, handler);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, handler);
    };
  }, []);

  useEffect(() => {
    // Wait for the first auth check so we don't bounce the user between
    // `/session` and `/signin` every navigation while we figure out if
    // their cached token is still valid.
    if (denAuth.status === "checking") return;

    const path = location.pathname.toLowerCase();
    const onSignin = path === "/signin" || path.startsWith("/signin/");

    if (requireSignin) {
      if (!denAuth.isSignedIn && !onSignin) {
        navigate("/signin", { replace: true });
      } else if (denAuth.isSignedIn && onSignin) {
        navigate("/session", { replace: true });
      }
    } else if (onSignin) {
      navigate("/session", { replace: true });
    }
  }, [
    denAuth.isSignedIn,
    denAuth.status,
    location.pathname,
    navigate,
    requireSignin,
  ]);

  if (requireSignin && denAuth.status === "checking") {
    return null;
  }

  return <>{children}</>;
}

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <>
      <DevProfiler id="AppRoot">
        <DenSigninGate>
          <Routes>
            <Route
              path="/signin"
              element={
                <DevProfiler id="SigninRoute">
                  <ForcedSigninPage developerMode={false} />
                </DevProfiler>
              }
            />
            <Route
              path="/session"
              element={
                <DevProfiler id="SessionRoute">
                  <SessionRoute />
                </DevProfiler>
              }
            />
            <Route
              path="/session/:sessionId"
              element={
                <DevProfiler id="SessionRoute">
                  <SessionRoute />
                </DevProfiler>
              }
            />
            <Route
              path="/settings/*"
              element={
                <DevProfiler id="SettingsRoute">
                  <SettingsRoute />
                </DevProfiler>
              }
            />
            {/* Default + fallback: land on the session view. Users open
                settings deliberately via the sidebar or command palette. */}
            <Route path="/" element={<Navigate to="/session" replace />} />
            <Route path="*" element={<Navigate to="/session" replace />} />
          </Routes>
        </DenSigninGate>
        <LoadingOverlay />
      </DevProfiler>
      {/*
        DevProfilerOverlay sits OUTSIDE the AppRoot <Profiler> zone on
        purpose. The overlay re-renders on every emit() to refresh its
        table, and any commit inside a <Profiler> is recorded as a
        commit on that zone. Mounting the overlay inside AppRoot would
        inflate AppRoot's commit count by hundreds of overlay
        self-renders for every real user-visible commit, masking the
        true app-level signal.
      */}
      <DevProfilerOverlay />
    </>
  );
}
