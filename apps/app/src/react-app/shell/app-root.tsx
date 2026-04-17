/** @jsxImportSource react */

import { Navigate, Route, Routes } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <>
      <Routes>
        <Route path="/session" element={<SessionRoute />} />
        <Route path="/session/:sessionId" element={<SessionRoute />} />
        <Route path="/settings/*" element={<SettingsRoute />} />
        {/* Default + fallback: land on the session view. Users open settings
             deliberately via the sidebar or command palette. */}
        <Route path="/" element={<Navigate to="/session" replace />} />
        <Route path="*" element={<Navigate to="/session" replace />} />
      </Routes>
      <LoadingOverlay />
    </>
  );
}
