/** @jsxImportSource react */

import { Navigate, Route, Routes } from "react-router-dom";

import { useDesktopFontZoomBehavior } from "./font-zoom";
import { SessionRoute } from "./session-route";

export function AppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <Routes>
      <Route path="/session" element={<SessionRoute />} />
      <Route path="/session/:sessionId" element={<SessionRoute />} />
      <Route path="*" element={<Navigate to="/session" replace />} />
    </Routes>
  );
}
