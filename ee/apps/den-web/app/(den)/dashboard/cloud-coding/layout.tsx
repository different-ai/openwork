"use client";

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DenNotice } from "../../_components/ui/notice";
import { orgFeatureEnabled } from "../../_lib/den-org";
import { ItemRowsSkeleton } from "../_components/item-list";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export default function CloudCodingLayout({ children }: { children: ReactNode }) {
  const { orgBusy, orgContext, orgError } = useOrgDashboard();
  if (orgBusy || !orgContext) {
    return orgError && !orgBusy ? <DenNotice tone="error" message="Couldn't load your workspace. Refresh the page to try again." /> : <ItemRowsSkeleton label="Checking Cloud coding access" rows={1} />;
  }
  if (!orgFeatureEnabled(orgContext, "cloudCoding")) notFound();
  return children;
}
