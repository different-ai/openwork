"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AdminAccessScreen } from "./admin-access-screen";
import { adminDataEndpoint, type AdminDataSection } from "./admin-list-location";
import { useAdminSessionCookie } from "./admin-shell";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";

// The signed-out path never downloads or mounts the dashboard and its controls.
const loadPanel = () => import("../den-admin-panel");
const DenAdminPanel = lazy(() => loadPanel().then((module) => ({ default: module.DenAdminPanel })));

type OverviewState = AdminResult<unknown> | { access: "checking" };

export function AdminDataPage({ section }: { section: AdminDataSection }) {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<OverviewState>(() => hasSessionCookie ? { access: "checking" } : { access: "signed-out", message: "" });
  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(async (force = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const fixture = process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("adminScaleFixture") === "1";
    // Drop the legacy persisted snapshot. Never render admin records before a
    // successful access check, including on a shared browser after sign-out.
    try { window.sessionStorage.removeItem("den-admin-overview-cache"); } catch { /* Storage is optional. */ }
    if (!force && !hasSessionCookie && !withStoredBearer({}).Authorization && !fixture) {
      setState({ access: "signed-out", message: "" });
      return;
    }
    setState({ access: "checking" });
    // Download the panel while the data request runs instead of after it.
    void loadPanel().catch(() => undefined);
    try {
      const path = adminDataEndpoint(section, new URLSearchParams(window.location.search));
      const result = fixture
        ? { access: "ready", data: (await import("../den-admin-panel")).adminScaleFixturePayload(path) } satisfies AdminResult<unknown>
        : await requestAdmin(path, (payload) => payload, controller.signal);
      if (!controller.signal.aborted) setState(result);
    } catch (error) {
      if (!controller.signal.aborted) setState({ access: "error", message: error instanceof Error ? error.message : "Could not check admin access." });
    }
  }, [hasSessionCookie, section]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  return state.access === "ready"
    ? <Suspense fallback={<AdminAccessScreen state="checking" />}><DenAdminPanel key={section} section={section} initialPayload={state.data} /></Suspense>
    : <AdminAccessScreen state={state.access} message={"message" in state ? state.message : undefined} onRetry={() => void load(true)} />;
}
