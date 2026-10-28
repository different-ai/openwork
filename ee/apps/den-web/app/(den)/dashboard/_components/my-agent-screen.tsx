"use client";

import { useState } from "react";
import { getLibraryAddConnectorRoute, getLibraryConnectorRoute, getLibraryMyAgentRoute, getLibraryRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemHeader, ItemPage } from "./item-header";
import { useLibrary, type LibraryConnectionItem, type LibraryItem } from "./library-data";
import { MyAgentPanel, MyAgentPanelSkeleton, MyAgentRow, MyAgentRowError, MyAgentRowSkeleton, type MyAgentLinks } from "./my-agent";
import { useMyAgent, useMyAgentChecks, useSaveMyAgent } from "./my-agent-data";
import { fromMyAgent, myAgentGoogleHref } from "./my-agent-connector-navigation";
import { myAgentAvailable } from "./my-agent-availability"

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** The Library row, pinned above the filters. */
export function MyAgentLibraryEntry() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const agent = useMyAgent(orgId);
  const save = useSaveMyAgent(orgId);
  if (agent.isError) return <MyAgentRowError message={errorMessage(agent.error, "Couldn't load your agent.")} retrying={agent.isFetching} onRetry={() => void agent.refetch()} />;
  if (!agent.data) return <MyAgentRowSkeleton />;
  return <MyAgentRow view={agent.data} href={getLibraryMyAgentRoute(orgSlug)} now={Date.now()} saving={save.isPending} onToggle={(on) => save.mutate({ on })} />;
}

function isConnection(item: LibraryItem): item is LibraryConnectionItem {
  return item.type === "connection";
}

const CONNECTION_STATUS: Record<LibraryConnectionItem["state"], string> = {
  connected: "Ready",
  needs_signin: "Sign in",
  needs_admin_setup: "Needs admin setup",
  available: "Not connected",
};

/** Work › My bot: the member's own agent. */
export function MyAgentScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const available = myAgentAvailable(orgContext);
  const agent = useMyAgent(orgId, available);
  const library = useLibrary();
  const save = useSaveMyAgent(orgId);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const earlier = useMyAgentChecks(orgId, available && earlierOpen);
  const libraryHref = getLibraryRoute(orgSlug);

  if (!available) return <ItemPage><ItemHeader title="My bot isn't on for you" description="Your organization hasn't turned it on yet." /></ItemPage>;
  if (agent.isError) return <ItemPage><ItemHeader title="It did not load" description={`${errorMessage(agent.error, "Couldn't load your agent.")} Reload the page to try again.`} /></ItemPage>;
  if (!agent.data) return <MyAgentPanelSkeleton library={libraryHref} />;

  const connections = (library.data ?? []).filter(isConnection);
  const google = connections.find((item) => item.provider === "google-workspace");
  const links: MyAgentLinks = {
    library: libraryHref,
    google: {
      href: myAgentGoogleHref(orgSlug, google?.id),
      status: google ? CONNECTION_STATUS[google.state] : library.isError ? "Couldn't verify" : library.isLoading ? "" : "Not added",
    },
    connector: (connectionId) => fromMyAgent(getLibraryConnectorRoute(orgSlug, connectionId)),
    catalog: fromMyAgent(getLibraryAddConnectorRoute(orgSlug)),
  };

  return (
    <MyAgentPanel
      view={agent.data}
      now={Date.now()}
      links={links}
      saving={save.isPending}
      error={save.isError ? errorMessage(save.error, "Couldn't save. Try again.") : null}
      earlier={{
        open: earlierOpen,
        onToggle: setEarlierOpen,
        checks: earlier.data ?? null,
        loading: earlier.isLoading && earlierOpen,
        error: earlier.isError ? errorMessage(earlier.error, "Couldn't load this week's checks.") : null,
      }}
      onChange={(change) => save.mutate(change)}
    />
  );
}
