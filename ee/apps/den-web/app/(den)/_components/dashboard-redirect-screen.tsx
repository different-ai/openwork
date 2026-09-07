"use client";

import { WorkspaceLoadingScreen } from "./workspace-loading-screen";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isSamePathname } from "../_lib/client-route";
import { useDenFlow } from "../_providers/den-flow-provider";

export function DashboardRedirectScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const redirectingRef = useRef(false);
  const { resolveUserLandingRoute, sessionHydrated } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated || redirectingRef.current) {
      return;
    }

    redirectingRef.current = true;
    void resolveUserLandingRoute()
      .then((target) => {
        const nextTarget = target ?? "/";
        if (!isSamePathname(pathname, nextTarget)) {
          router.replace(nextTarget);
        }
      })
      .finally(() => {
        redirectingRef.current = false;
      });
  }, [pathname, resolveUserLandingRoute, router, sessionHydrated]);

  return <WorkspaceLoadingScreen />;
}
