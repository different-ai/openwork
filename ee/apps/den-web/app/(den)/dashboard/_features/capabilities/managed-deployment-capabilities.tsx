"use client";

import { capability } from "@openwork/managed-deployments/capabilities";
import { CAPABILITY_STATE_REASON_LABELS } from "@openwork/managed-deployments/capability-state";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useManagedDeploymentCapabilities } from "./capabilities-data";
import { INFRASTRUCTURE_LABELS } from "./capabilities-model";
import { ExplainedState } from "./capability-parts";

export function ManagedDeploymentCapabilities({ deploymentId }: { deploymentId: string }) {
  const { orgContext } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, "deploymentCapabilitiesView");
  const query = useManagedDeploymentCapabilities(deploymentId, enabled);
  if (!enabled) return null;
  return (
    <section aria-labelledby="deployment-capabilities-heading" data-testid="deployment-capabilities">
      <h2 id="deployment-capabilities-heading" className="text-[13px] font-medium text-[var(--dls-text-primary)]">Capabilities</h2>
      {query.error ? (
        <DenNotice presentation="inline" message={query.error instanceof Error ? query.error.message : "Couldn't load this deployment's capabilities."} />
      ) : !query.data ? (
        <div className="mt-2 grid gap-2" role="status" aria-label="Loading capabilities">
          {[0, 1, 2].map((row) => <DenSkeleton key={row} className="h-9" />)}
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--dls-border)]">
          {query.data.capabilities.map((entry) => (
            <li key={entry.id} className="flex min-h-10 items-center justify-between gap-4 py-2 text-[13px]" data-testid={`deployment-capability-${entry.id}`}>
              <span className="min-w-0 truncate font-medium text-[var(--dls-text-primary)]">{capability(entry.id).label}</span>
              <ExplainedState label={INFRASTRUCTURE_LABELS[entry.state]} detail={CAPABILITY_STATE_REASON_LABELS[entry.reason]} testId={`deployment-capability-state-${entry.id}`} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
