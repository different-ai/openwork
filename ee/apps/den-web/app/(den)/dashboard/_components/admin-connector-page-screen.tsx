"use client";

import { ChevronDown, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { getMcpConnectionsRoute, getToolTesterRoute } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type AccessDraft, accessAddedToast } from "./access-summary";
import { signInSentence } from "./admin-connectors";
import { connectorAccountReady } from "./connector-detail";
import { ChatButton, WhatYourAiCanDo } from "./connector-page-screen";
import { GOOGLE_WORKSPACE_QUICK_ADD_ID, isNativeProviderCatalogId, MICROSOFT_365_QUICK_ADD_ID } from "./connector-catalog";
import { useMemberSignIn } from "./connector-setup";
import { ConnectorSettingsForm } from "./connector-settings";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { DetailRows, ItemMenu, removeEntry, ItemPanel } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useSaveConnectionAccess } from "./item-sharing";
import { connectionMcpSetupUrl } from "./mcp-connection-app-setup";
import {
  type ExternalMcpConnection,
  isNativeProviderConnectionId,
  useDeleteMcpConnection,
  useDisconnectMcpConnection,
  useMcpConnectionTools,
  useUpdateMcpConnection,
} from "./mcp-connections-data";
import { NativeProviderSettings } from "./native-provider-setup";
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

function Disclosure({ label, open, onToggle, children, testId }: { label: string; open: boolean; onToggle: () => void; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col border-t border-gray-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        data-testid={testId}
        className="flex items-center justify-between gap-4 rounded-2xl px-5 py-3 text-left text-[13px] font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-200"
      >
        {label}
        <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? children : null}
    </section>
  );
}

/** Google Workspace or Microsoft 365, by the provider key its connection belongs to. */
function nativeKeyFor(connection: ExternalMcpConnection) {
  const key = connection.nativeProviderKey ?? connection.id;
  return isNativeProviderCatalogId(key) ? key : null;
}

/** C6: a connector in Manage, with Who can use it inline instead of Share. */
export function AdminConnectorPageScreen({ connection }: { connection: ExternalMcpConnection }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const saveAccess = useSaveConnectionAccess();
  const deleteConnection = useDeleteMcpConnection();
  const disconnect = useDisconnectMcpConnection();
  const signIn = useMemberSignIn();
  const [saving, setSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(Boolean(connection.setupRequired) || Boolean(connection.issuerReviewRequired)
    || (connection.oauthClientRequired === true && connection.oauthClientConfigured !== true)
    || (connection.authType === "apikey" && !connection.connected));
  const [error, setError] = useState<string | null>(null);
  const connectionId = connection.id;
  const name = connection.name;
  const native = isNativeProviderConnectionId(connection.id, connection.nativeProviderKey);
  const nativeKey = native ? nativeKeyFor(connection) : null;
  const aliasOnly = connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID || connection.id === MICROSOFT_365_QUICK_ADD_ID;
  const signedIn = connection.authType === "none" || connectorAccountReady(connection);
  const tools = useMcpConnectionTools(connectionId, signedIn && !native);
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
    : connection.issuerReviewRequired ? <DenButton variant="secondary" size="xs" onClick={() => setSettingsOpen(true)}>Review sign-in server</DenButton>
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
                { label: "Edit settings", onSelect: () => setSettingsOpen(true) },
                ...(!native && signedIn ? [{ label: "Test tools", href: `${getToolTesterRoute(orgSlug)}?connectionId=${encodeURIComponent(connectionId)}` }] : []),
                ...(!native && connection.authType !== "none" && connection.connected ? [{
                  label: "Sign everyone out",
                  onSelect: async () => {
                    await disconnect.mutateAsync(connectionId);
                    toast({ title: `Everyone is signed out of ${name}`, description: "Its setup and who can use it stay the same." });
                  },
                  confirm: { title: `Sign everyone out of ${name}?`, description: "Each person signs in again to use it.", action: "Sign everyone out" },
                }] : []),
                ...(aliasOnly ? [] : [removeEntry(name, remove)]),
              ]}
            />
            <ChatButton name={name} />
          </>
        )}
      />

      {orgContext && !connection.access ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Who can use it" meta={signInSentence(connection)} />
          <ItemPanel>
            <div className="flex items-center justify-between gap-4 px-5 py-3 text-[13px]" data-testid="access-locked">
              <span className="font-medium text-gray-900">Everyone in your organization</span>
              <span className="flex items-center gap-1.5 text-gray-500"><Lock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />Set when it was added</span>
            </div>
          </ItemPanel>
        </section>
      ) : null}

      {orgContext && connection.access ? (
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

      {native ? null : <WhatYourAiCanDo tools={tools.data?.tools ?? []} loading={tools.isLoading} signedIn={signedIn} error={Boolean(tools.error)} />}

      {details.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Details" />
          <DetailRows rows={details} />
          {signIn.failure?.id === connectionId ? (
            <p className="text-[13px] text-red-600" role="alert">{`Could not sign in to ${name}. ${signIn.failure.message}`}</p>
          ) : null}
        </section>
      ) : null}

      <Disclosure label="Settings" open={settingsOpen} onToggle={() => setSettingsOpen((value) => !value)} testId="connector-settings-toggle">
        {nativeKey ? (
          <div className="px-5 py-4">
            <NativeProviderSettings
              providerKey={nativeKey}
              clientProviderId={connection.id}
              create={false}
              onSaved={() => toast({ title: `${name} is saved`, description: "People who signed in before may be asked to sign in again." })}
              footer={({ save, saving: savingSettings, disabled, label }) => (
                <div className="flex justify-end">
                  <DenButton size="sm" loading={savingSettings} disabled={disabled} onClick={save}>{label}</DenButton>
                </div>
              )}
            />
          </div>
        ) : (
          <ConnectorSettingsForm key={connection.updatedAt ?? connection.id} connection={connection} onSaved={(message) => toast({ title: message })} />
        )}
      </Disclosure>

      {native ? null : <UseInAnotherApp connection={connection} />}
    </ItemPage>
  );
}
