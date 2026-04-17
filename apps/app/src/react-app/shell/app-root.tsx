/** @jsxImportSource react */

import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";

export function AppRoot() {
  useDesktopFontZoomBehavior();
  const location = useLocation();

  return (
    <Routes location={location} key={location.pathname}>
      <Route path="/session" element={<SessionRoute />} />
      <Route path="/session/:sessionId" element={<SessionRoute />} />
      <Route path="/settings/*" element={<SettingsRoute />} />
      <Route path="/" element={<Navigate to="/settings/general" replace />} />
      <Route path="*" element={<Navigate to="/settings/general" replace />} />
    </Routes>
  );
}
