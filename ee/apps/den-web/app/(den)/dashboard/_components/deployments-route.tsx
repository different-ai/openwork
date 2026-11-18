"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getDeploymentsRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GuidedDeploymentPage, GuidedDeploymentsList } from "./managed-deployments-guided";
import { ManagedDeploymentsScreen } from "./managed-deployments-screen";

/** Manage › Deployments: the list, or one deployment's own page. */
export function DeploymentsRoute({ deploymentId }: { deploymentId?: string }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  const router = useRouter();
  const guided = orgFeatureEnabled(orgContext, "managedDeploymentAwsSignIn");
  const leave = Boolean(orgContext && !guided && deploymentId);
  const list = getDeploymentsRoute(orgSlug);
  useEffect(() => {
    if (leave) router.replace(list);
  }, [leave, list, router]);
  if (!guided) return leave ? null : <ManagedDeploymentsScreen />;
  return deploymentId ? <GuidedDeploymentPage deploymentId={deploymentId} /> : <GuidedDeploymentsList />;
}
