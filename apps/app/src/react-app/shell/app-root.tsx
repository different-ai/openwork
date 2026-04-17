/** @jsxImportSource react */

import { Navigate, Route, Routes } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <Routes>
      <Route path="/session" element={<SessionRoute />} />
      <Route path="/session/:sessionId" element={<SessionRoute />} />
      <Route path="/settings/*" element={<SettingsRoute />} />
      <Route path="/" element={<Navigate to="/settings/general" replace />} />
      <Route path="*" element={<Navigate to="/settings/general" replace />} />
    </Routes>
  );
}
