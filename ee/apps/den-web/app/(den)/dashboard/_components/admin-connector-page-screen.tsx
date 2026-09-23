"use client";

import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { getConfiguredMcpConnectionsRoute, getMcpConnectionsRoute } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type AccessDraft, accessAddedToast } from "./access-summary";
import { signInSentence } from "./admin-connectors";
import { connectorAccountReady } from "./connector-detail";
import { ChatButton, WhatYourAiCanDo } from "./connector-page-screen";
import { useMemberSignIn } from "./connector-setup";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { DetailRows, ItemMenu, ItemPanel } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useSaveConnectionAccess } from "./item-sharing";
import { connectionMcpSetupUrl } from "./mcp-connection-app-setup";
import {
  type ExternalMcpConnection,
  useDeleteMcpConnection,
  useMcpConnectionTools,
  useUpdateMcpConnection,
} from "./mcp-connections-data";
import { WhoCanUseIt } from "./who-can-use-it";

function UseInAnotherApp({ connection }: { connection: ExternalMcpConnection }) {
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const updateConnection = useUpdateMcpConnection();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = connectionMcpSetupUrl(runtimeConfigLoaded ? runtimeConfig.denApiUrl : "", connection.id);

  async function turnOn() {
    setError(null);
    try {
      await updateConnection.mutateAsync({
        connectionId: connection.id,
        expectedUpdatedAt: connection.updatedAt ?? new Date().toISOString(),
        name: connection.name,
        url: connection.url,
        authType: connection.authType,
        credentialMode: connection.credentialMode,
        exposeDirectly: true,
        access: connection.access ?? { orgWide: false, memberIds: [], teamIds: [] },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Could not copy it. Select the address and copy it yourself.");
    }
  }

  return (
    <ItemPanel>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center justify-between gap-4 rounded-2xl px-5 py-3 text-left text-[13px] font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-200"
      >
        Use in another app
        <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 px-5 py-4 text-[13px] leading-[18px] text-gray-500">
          {connection.exposeDirectly ? (
            <>
              <p>People who can use {connection.name} can add it to Claude, Cursor or any MCP app with this address, then sign in to OpenWork.</p>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-900">{url ?? "The address is not available yet. Reload the page."}</p>
                <DenButton variant="secondary" size="sm" disabled={!url} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</DenButton>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p>Let people add {connection.name} to Claude, Cursor or any MCP app.</p>
              <DenButton variant="secondary" size="sm" loading={updateConnection.isPending} onClick={() => void turnOn()}>Turn on</DenButton>
            </div>
          )}
          {error ? <p className="text-red-600" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </ItemPanel>
  );
}

/** C6: a connector in Manage, with Who can use it inline instead of Share. */
export function AdminConnectorPageScreen({ connection }: { connection: ExternalMcpConnection }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const saveAccess = useSaveConnectionAccess();
  const deleteConnection = useDeleteMcpConnection();
  const signIn = useMemberSignIn();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionId = connection.id;
  const name = connection.name;
  const signedIn = connection.authType === "none" || connectorAccountReady(connection);
  const tools = useMcpConnectionTools(connectionId, signedIn);
  const viewerId = orgContext?.currentMember.id ?? null;
  const draft: AccessDraft = connection.access
    ? { orgWide: connection.access.orgWide, memberIds: connection.access.memberIds, teamIds: connection.access.teamIds }
    : { orgWide: false, memberIds: [], teamIds: [] };
  const addedBy = connection.createdByName?.trim();

  async function changeAccess(next: AccessDraft) {
    if (!orgContext) return;
    const previous = draft;
    setSaving(true);
    setError(null);
    try {
      await saveAccess(connectionId, next);
      const message = accessAddedToast(previous, next, orgContext, viewerId);
      if (message) {
        toast({ ...message, action: { label: "Undo", onClick: () => saveAccess(connectionId, previous) } });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change did not save.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await deleteConnection.mutateAsync(connectionId);
    toast({ title: `${name} is removed`, description: "Nobody can use it anymore." });
    router.push(getMcpConnectionsRoute(orgSlug));
  }

  const accountValue = signedIn
    ? connection.authType === "none" ? "Not needed" : connection.externalAccountId ?? "Signed in"
    : <DenButton variant="secondary" size="xs" loading={signIn.pendingId === connectionId} onClick={() => void signIn.signIn(connection)}>Sign in</DenButton>;

  const details = [
    ...(connection.authType === "oauth"
      ? [{ label: connection.credentialMode === "shared" ? "Organization account" : "Your account", value: accountValue }]
      : []),
    ...(addedBy ? [{ label: "Added by", value: addedBy }] : []),
  ];

  return (
    <ItemPage testId="admin-connector-page">
      <ItemHeader
        back={{ href: getMcpConnectionsRoute(orgSlug), label: "Connectors" }}
        logo={<ConnectorLogo name={name} url={connection.url} size="lg" />}
        title={name}
        actions={(
          <>
            <ItemMenu
              size="md"
              label={`More for ${name}`}
              entries={[
                { label: "Edit settings", href: getConfiguredMcpConnectionsRoute(orgSlug, connectionId) },
                { label: "Remove", destructive: true, onSelect: () => void remove() },
              ]}
            />
            <ChatButton name={name} />
          </>
        )}
      />

      {orgContext ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Who can use it" meta={signInSentence(connection)} />
          <WhoCanUseIt
            value={draft}
            onChange={(next) => void changeAccess(next)}
            members={orgContext.members}
            teams={orgContext.teams}
            owner={null}
            canShareWithEveryone
            everyoneOffDescription={draft.memberIds.length === 0 && draft.teamIds.length === 0
              ? "Off. Nobody has it yet."
              : "Off. Only the people and teams below have it."}
            disabled={saving}
          />
          {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
        </section>
      ) : null}

      <WhatYourAiCanDo tools={tools.data?.tools ?? []} loading={tools.isLoading} signedIn={signedIn} error={Boolean(tools.error)} />

      {details.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Details" />
          <DetailRows rows={details} />
        </section>
      ) : null}

      <UseInAnotherApp connection={connection} />
    </ItemPage>
  );
}
