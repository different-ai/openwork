/** @jsxImportSource react */

import { Navigate, Route, Routes } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <>
      <DevProfiler id="AppRoot">
        <Routes>
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
