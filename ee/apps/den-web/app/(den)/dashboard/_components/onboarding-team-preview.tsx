"use client";

import { OnboardingIntro, OnboardingResourceRow } from "@openwork/ui/react";
import { Plug } from "lucide-react";
import { useMcpConnections } from "./mcp-connections-data";

/** Only organization-wide tools can be promised to a newly invited member. */
export function OnboardingTeamPreview() {
  const connections = useMcpConnections("manageable");
  const sharedTools = connections.data?.filter((connection) => connection.access?.orgWide);

  return <section data-testid="onboarding-team-preview" className="rounded-2xl border border-neutral-200 bg-white p-5">
    <OnboardingIntro headingLevel={2} size="compact" eyebrow="Teammate experience" title="What everyone will discover" description="Tools available to every member. Personal accounts and permissions still apply." />
    {connections.isPending ? <p role="status" className="mt-4 text-sm text-neutral-500">Checking shared tools…</p>
      : connections.isError ? <div role="alert" className="mt-4 text-sm text-neutral-600">We couldn’t check shared tools. <button type="button" className="underline underline-offset-4" onClick={() => void connections.refetch()}>Try again</button></div>
      : sharedTools?.length ? <div className="mt-4">{sharedTools.map((connection) => <OnboardingResourceRow
        key={connection.id} title={connection.name} icon={<Plug className="size-4" />}
        description={connection.credentialMode === "per_member" ? "Each teammate connects their own account." : connection.authType === "none" ? "No personal sign-in required." : "Uses the account managed by your team."}
        status={<span className="text-xs text-neutral-500">{connection.setupRequired || (connection.needsReconnect && connection.reconnectActionOwner === "organization_admin") ? "Setup needs attention" : "Available to everyone"}</span>}
      />)}</div>
      : <p className="mt-4 text-sm leading-6 text-neutral-500">No tools shared with everyone yet. You can add tools now or from your workspace later.</p>}
    <p className="mt-4 text-xs leading-5 text-neutral-500">Making a tool available does not connect anyone’s account or verify that it can run a task.</p>
  </section>;
}
