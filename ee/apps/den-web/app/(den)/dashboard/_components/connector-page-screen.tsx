"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, MessageSquare, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { getLibraryConnectorShareRoute, getLibraryRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ownedAccessStatus } from "./access-summary";
import { connectorChatDeepLink, connectorChatPrompt } from "./connector-catalog";
import { connectorAccountReady } from "./connector-detail";
import { toolSummary, toolTitle, useMemberSignIn } from "./connector-setup";
import { useDenToast } from "./den-toast";
import { formatAddedDate } from "./item-dates";
import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { DetailRows, ItemMenu, ItemPanel, LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { libraryQueryKeys, useLibrary } from "./library-data";
import { isOwnedByViewer, libraryItemDescription, receivedStatus } from "./library-view";
import {
  type ExternalMcpTool,
  useDeleteMcpConnection,
  useDisconnectMyProviderAccount,
  useMcpConnections,
  useMcpConnectionTools,
} from "./mcp-connections-data";

const TOOLS_PREVIEW = 3;

export function WhatYourAiCanDo({ tools, loading, signedIn, error }: {
  tools: readonly ExternalMcpTool[];
  loading: boolean;
  signedIn: boolean;
  error: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? tools : tools.slice(0, TOOLS_PREVIEW);
  const count = tools.length === 1 ? "1 thing" : `${tools.length} things`;
  return (
    <section className="flex flex-col gap-2.5" data-testid="what-your-ai-can-do">
      <SectionTitle title="What your AI can do" meta={tools.length > 0 ? count : undefined} />
      <ItemPanel>
        {!signedIn ? <p className="px-5 py-4 text-[13px] text-gray-500">They show up after you sign in.</p> : null}
        {signedIn && loading ? <p className="px-5 py-4 text-[13px] text-gray-500">Reading them now...</p> : null}
        {signedIn && error ? <p className="px-5 py-4 text-[13px] text-gray-500">OpenWork could not read them right now.</p> : null}
        {visible.map((tool) => (
          <div key={tool.name} className="px-5 py-3" data-testid="connector-tool">
            <p className="text-[14px] font-medium leading-5 text-gray-900">{toolTitle(tool)}</p>
            {toolSummary(tool) ? <p className="text-[13px] leading-[18px] text-gray-500">{toolSummary(tool)}</p> : null}
          </div>
        ))}
        {tools.length > TOOLS_PREVIEW ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 px-5 py-3 text-left text-[13px] font-medium text-gray-700 hover:text-gray-900"
          >
            {expanded ? "Show less" : `Show all ${tools.length}`}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
          </button>
        ) : null}
      </ItemPanel>
    </section>
  );
}

export function ChatButton({ name }: { name: string }) {
  return (
    <DenButton icon={MessageSquare} href={connectorChatDeepLink({ connector: name, prompt: connectorChatPrompt(name) })}>
      Chat
    </DenButton>
  );
}

/** A6: a connector in My Library. */
export function LibraryConnectorScreen({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const library = useLibrary();
  const usable = useMcpConnections("usable");
  const signIn = useMemberSignIn();
  const deleteConnection = useDeleteMcpConnection();
  const disconnect = useDisconnectMyProviderAccount();
  const connection = usable.data?.find((entry) => entry.id === connectionId) ?? null;
  const item = library.data?.find((entry) => entry.type === "connection" && entry.id === connectionId) ?? null;
  const signedIn = Boolean(connection && (connection.authType === "none" || connectorAccountReady(connection)));
  const tools = useMcpConnectionTools(connectionId, signedIn);
  const viewerId = orgContext?.currentMember.id ?? null;
  const mine = Boolean(connection?.access) || Boolean(item && isOwnedByViewer(item, viewerId, new Set()));
  const back = { href: getLibraryRoute(orgSlug), label: "My Library" };

  if (!connection && (usable.isLoading || library.isLoading)) {
    return <ItemPage><ItemHeader back={back} title="Loading..." /></ItemPage>;
  }
  if (!connection && (usable.error || library.error)) {
    return <ItemPage><ItemHeader back={back} title="It did not load" description="Reload the page to try again." /></ItemPage>;
  }
  if (!connection) {
    return <ItemPage><ItemHeader back={back} title="Not in your Library" description="It may have been removed, or it is no longer shared with you." /></ItemPage>;
  }

  const name = connection.name;
  const personEdge = item?.edges.find((edge) => edge.kind === "person");
  const added = formatAddedDate(personEdge?.kind === "person" ? personEdge.grantedAt : connection.connectedAt);
  const who = mine && orgContext
    ? ownedAccessStatus(connection.access, orgContext, viewerId)
    : item ? receivedStatus(item.edges) : "";

  async function remove() {
    await deleteConnection.mutateAsync(connectionId);
    await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
    toast({ title: `${name} is removed`, description: "Nobody can use it anymore." });
    router.push(getLibraryRoute(orgSlug));
  }

  async function signOut() {
    if (!connection) return;
    await disconnect.mutateAsync(connection);
    await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
  }

  return (
    <ItemPage testId="library-connector">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={connection.url} size="lg" />}
        title={name}
        description={item ? libraryItemDescription(item) : undefined}
        actions={(
          <>
            <ItemMenu
              size="md"
              label={`More for ${name}`}
              entries={[
                ...(connection.connectedForMe && connection.credentialMode === "per_member" ? [{ label: "Sign out", onSelect: () => void signOut() }] : []),
                ...(mine ? [{ label: "Remove", destructive: true, onSelect: () => void remove() }] : []),
              ]}
            />
            {mine ? (
              <LinkButton href={getLibraryConnectorShareRoute(orgSlug, connectionId)}>
                <UserPlus className="h-4 w-4" aria-hidden />
                Share
              </LinkButton>
            ) : null}
            <ChatButton name={name} />
          </>
        )}
      />
      <WhatYourAiCanDo tools={tools.data?.tools ?? []} loading={tools.isLoading} signedIn={signedIn} error={Boolean(tools.error)} />
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Details" />
        <DetailRows
          rows={[
            { label: "Who can use it", value: who },
            ...(connection.authType === "none" ? [] : [{
              label: "Signed in as",
              value: signedIn
                ? connection.externalAccountId ?? "You"
                : <DenButton variant="secondary" size="xs" loading={signIn.pendingId === connectionId} onClick={() => void signIn.signIn(connection)}>Sign in</DenButton>,
            }]),
            ...(added ? [{ label: "Added", value: added }] : []),
          ]}
        />
      </section>
    </ItemPage>
  );
}
