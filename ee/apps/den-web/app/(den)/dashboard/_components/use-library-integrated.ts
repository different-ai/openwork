"use client";

import { orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Presentation only: a missing feature or a kill switch retains the original Library. */
export function useLibraryIntegrated() {
  const { orgContext } = useOrgDashboard();
  return orgFeatureEnabled(orgContext, "libraryIntegrated");
}
