/** @jsxImportSource react */

import { Navigate, Route, Routes } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { SessionRoute } from "./session-route";
import { SolidAppHost } from "./solid-app-host";

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <Routes>
      <Route path="/session" element={<SessionRoute />} />
      <Route path="/session/:sessionId" element={<SessionRoute />} />
      <Route path="/settings/*" element={<SolidAppHost />} />
      <Route path="/" element={<Navigate to="/settings/general" replace />} />
      <Route path="*" element={<SolidAppHost />} />
    </Routes>
  );
}
