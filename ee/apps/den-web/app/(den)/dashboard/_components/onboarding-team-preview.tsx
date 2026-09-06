"use client";

import { OnboardingIntro, OnboardingResourceRow } from "@openwork/ui/react";
import { Plug } from "lucide-react";
import { useMcpConnections } from "./mcp-connections-data";

/** Only organization-wide tools can be promised to a newly invited member. */
export function OnboardingTeamPreview() {
  const connections = useMcpConnections("manageable");
  const sharedTools = connections.data?.filter((connection) => connection.access?.orgWide);

  return <section data-testid="onboarding-team-preview" className="border-t border-neutral-200 pt-5">
    <OnboardingIntro headingLevel={2} size="compact" title="Shared with everyone" description="Teammates connect personal accounts after joining." />
    {connections.isPending ? <p role="status" className="mt-4 text-sm text-neutral-500">Checking shared tools…</p>
      : connections.isError ? <div role="alert" className="mt-4 text-sm text-neutral-600">We couldn’t check shared tools. <button type="button" className="underline underline-offset-4" onClick={() => void connections.refetch()}>Try again</button></div>
      : sharedTools?.length ? <div className="mt-4">{sharedTools.map((connection) => <OnboardingResourceRow
        key={connection.id} title={connection.name} icon={<Plug className="size-4" />}
        status={<span className="text-xs text-neutral-500">{connection.setupRequired || (connection.needsReconnect && connection.reconnectActionOwner === "organization_admin") ? "Setup needs attention" : connection.credentialMode === "per_member" ? "Personal account" : connection.authType === "none" ? "No sign-in" : "Team account"}</span>}
      />)}</div>
      : <p className="mt-4 text-sm leading-6 text-neutral-500">No shared tools yet.</p>}
  </section>;
}
