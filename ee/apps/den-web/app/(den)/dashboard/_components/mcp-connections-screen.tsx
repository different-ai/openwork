"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plug, Plus, Trash2, Users } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type CreateMcpConnectionInput,
  type ExternalMcpAuthType,
  type ExternalMcpConnection,
  type ExternalMcpCredentialMode,
  type ExternalMcpPreset,
  type McpConnectionAccessInput,
  formatMcpConnectedTimestamp,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useMcpConnectionPresets,
  useMcpConnections,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;

export function McpConnectionsScreen() {
  const { data: connections = [], isLoading, error, refetch } = useMcpConnections();
  const { data: presets = [] } = useMcpConnectionPresets();
  const createConnection = useCreateMcpConnection();
  const startOAuth = useStartMcpConnectionOAuth();
  const deleteConnection = useDeleteMcpConnection();

  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState<ExternalMcpPreset | null>(null);
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setPollingConnectionId(null);
  }

  function pollUntilConnected(connectionId: string) {
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      if (connection?.connected || Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function handleConnectOAuth(connectionId: string) {
    const result = await startOAuth.mutateAsync(connectionId);
    if (result.status === "connected") {
      void refetch();
      return;
    }
    if (result.authorizeUrl) {
      window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
      pollUntilConnected(connectionId);
    }
  }

  async function handleCreate(input: CreateMcpConnectionInput) {
    const created = await createConnection.mutateAsync(input);
    setFormOpen(false);
    setFormPreset(null);
    // Shared-credential OAuth: the admin authorizes the org's single account
    // right now. Per-member: nothing to authorize here — each granted person
    // connects their own account from Your Connections.
    if (input.authType === "oauth" && input.credentialMode === "shared") {
      await handleConnectOAuth(created.id);
    }
  }

  return (
    <DashboardPageTemplate
      icon={Plug}
      badgeLabel="New"
      title="MCP Connections"
      description="Connect any MCP server — Notion, Linear, Stripe, or a custom URL — once for the whole org. search_capabilities and execute_capability pick these up automatically."
      colors={["#EDE9FE", "#4C1D95", "#7C3AED", "#C4B5FD"]}
    >
      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load MCP connections."}
        </div>
      ) : null}

      <div className="mb-6 flex items-center justify-between rounded-2xl border border-gray-100 bg-white px-6 py-5">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">Add a custom MCP server</h2>
          <p className="mt-1 text-[13px] text-gray-500">Connect any MCP server by URL, with OAuth, an API key, or no auth.</p>
        </div>
        <DenButton
          variant="primary"
          size="sm"
          icon={Plus}
          onClick={() => {
            setFormPreset(null);
            setFormOpen(true);
          }}
        >
          Add Custom
        </DenButton>
      </div>

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Quick add</h3>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presets.map((preset) => {
          const alreadyAdded = connections.some((connection) => connection.url === preset.url);
          return (
            <button
              key={preset.presetId}
              type="button"
              disabled={alreadyAdded}
              onClick={() => {
                setFormPreset(preset);
                setFormOpen(true);
              }}
              className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <p className="text-[14px] font-semibold text-gray-900">{preset.displayName}</p>
              <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">{preset.description}</p>
              <p className="mt-2 text-[12px] font-medium text-violet-600">
                {alreadyAdded ? "Already added" : "Tap to add"}
              </p>
            </button>
          );
        })}
      </div>

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Your connections</h3>
      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading MCP connections…
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-center text-[14px] text-gray-500">
          No MCP connections yet.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              polling={pollingConnectionId === connection.id}
              connecting={startOAuth.isPending && startOAuth.variables === connection.id}
              onConnect={() => void handleConnectOAuth(connection.id)}
              onRemove={() => deleteConnection.mutate(connection.id)}
              removing={deleteConnection.isPending && deleteConnection.variables === connection.id}
            />
          ))}
        </div>
      )}

      <AddConnectionDialog
        open={formOpen}
        preset={formPreset}
        submitting={createConnection.isPending}
        error={createConnection.error}
        onClose={() => {
          setFormOpen(false);
          setFormPreset(null);
        }}
        onSubmit={handleCreate}
      />
    </DashboardPageTemplate>
  );
}

function accessSummaryLabel(connection: ExternalMcpConnection): string {
  const access = connection.access;
  if (!access) return "";
  if (access.orgWide) return "Everyone in the org";
  const parts: string[] = [];
  if (access.teamIds.length > 0) parts.push(`${access.teamIds.length} ${access.teamIds.length === 1 ? "team" : "teams"}`);
  if (access.memberIds.length > 0) parts.push(`${access.memberIds.length} ${access.memberIds.length === 1 ? "person" : "people"}`);
  return parts.length > 0 ? parts.join(", ") : "Nobody yet";
}

function ConnectionRow({
  connection,
  polling,
  connecting,
  onConnect,
  onRemove,
  removing,
}: {
  connection: ExternalMcpConnection;
  polling: boolean;
  connecting: boolean;
  onConnect: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const isPerMember = connection.credentialMode === "per_member";
  const needsOAuthConnect = !isPerMember && connection.authType === "oauth" && !connection.connected;

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
          {isPerMember ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
              <Users className="h-3 w-3" />
              Per-member accounts
            </span>
          ) : connection.connected ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <Check className="h-3 w-3" />
              Connected
            </span>
          ) : polling ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for authorization…
            </span>
          ) : (
            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              Not connected
            </span>
          )}
          {connection.access ? (
            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              {accessSummaryLabel(connection)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-gray-500">
          {connection.url} · {formatMcpConnectedTimestamp(connection.connectedAt)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {needsOAuthConnect ? (
          <DenButton variant="secondary" size="sm" loading={connecting || polling} onClick={onConnect}>
            Connect
          </DenButton>
        ) : null}
        <DenButton
          variant="destructive"
          size="sm"
          icon={Trash2}
          loading={removing}
          onClick={onRemove}
          aria-label={`Remove ${connection.name}`}
        >
          Remove
        </DenButton>
      </div>
    </div>
  );
}

function AddConnectionDialog({
  open,
  preset,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  preset: ExternalMcpPreset | null;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: CreateMcpConnectionInput) => void;
}) {
  const { orgContext } = useOrgDashboard();
  const [name, setName] = useState(preset?.displayName ?? "");
  const [url, setUrl] = useState(preset?.url ?? "");
  const [authType, setAuthType] = useState<ExternalMcpAuthType>(preset?.authType ?? "oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("shared");
  const [apiKey, setApiKey] = useState("");
  const [accessMode, setAccessMode] = useState<"everyone" | "teams" | "people">("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(preset?.displayName ?? "");
    setUrl(preset?.url ?? "");
    setAuthType(preset?.authType ?? "oauth");
    setCredentialMode("shared");
    setApiKey("");
    setAccessMode("everyone");
    setSelectedTeamIds([]);
    setSelectedMemberIds([]);
  }, [open, preset]);

  const teams = useMemo(() => orgContext?.teams ?? [], [orgContext?.teams]);
  const members = useMemo(
    () => (orgContext?.members ?? []).filter((member) => Boolean(member.userId)),
    [orgContext?.members],
  );

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  if (!open) {
    return null;
  }

  const access: McpConnectionAccessInput = accessMode === "everyone"
    ? { orgWide: true, memberIds: [], teamIds: [] }
    : { orgWide: false, memberIds: accessMode === "people" ? selectedMemberIds : [], teamIds: accessMode === "teams" ? selectedTeamIds : [] };
  const accessIncomplete = accessMode === "teams" ? selectedTeamIds.length === 0 : accessMode === "people" ? selectedMemberIds.length === 0 : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {preset ? `Add ${preset.displayName}` : "Add a custom MCP server"}
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          Connect an MCP server org-wide. If it requires OAuth, you&apos;ll authorize it in a new tab next.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</label>
            <DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="notion" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Server URL</label>
            <DenInput
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp"
              disabled={Boolean(preset)}
            />
          </div>
          {!preset ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication</label>
              <div className="flex gap-2">
                {(["oauth", "apikey", "none"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setAuthType(option)}
                    className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                      authType === option
                        ? "border-gray-900 bg-gray-900 text-white"
                        : "border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    {option === "oauth" ? "OAuth" : option === "apikey" ? "API key" : "None"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {authType === "apikey" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">API key</label>
              <DenInput type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
            </div>
          ) : null}

          {authType === "oauth" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Account</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCredentialMode("shared")}
                  className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                    credentialMode === "shared" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  One shared account
                </button>
                <button
                  type="button"
                  onClick={() => setCredentialMode("per_member")}
                  className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                    credentialMode === "per_member" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  Each person connects their own
                </button>
              </div>
              <p className="mt-1.5 text-[12px] leading-5 text-gray-500">
                {credentialMode === "shared"
                  ? "You'll authorize a single account now; everyone granted access acts as it."
                  : "You publish the connection; each person authorizes their own account from Your Connections and acts as themselves."}
              </p>
            </div>
          ) : null}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Who can use this?</label>
            <div className="flex gap-2">
              {(["everyone", "teams", "people"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAccessMode(option)}
                  className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                    accessMode === option ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  {option === "everyone" ? "Everyone in the org" : option === "teams" ? "Specific teams" : "Specific people"}
                </button>
              ))}
            </div>
            {accessMode === "teams" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {teams.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No teams in this org yet.</p>
                ) : (
                  teams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => setSelectedTeamIds((current) => toggle(current, team.id))}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        selectedTeamIds.includes(team.id) ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="truncate">{team.name}</span>
                      {selectedTeamIds.includes(team.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {accessMode === "people" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {members.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No members in this org yet.</p>
                ) : (
                  members.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => setSelectedMemberIds((current) => toggle(current, member.id))}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        selectedMemberIds.includes(member.id) ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="truncate">{member.user.name || member.user.email}</span>
                      {selectedMemberIds.includes(member.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-[13px] text-red-600">{error instanceof Error ? error.message : "Failed to add connection."}</p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </DenButton>
          <DenButton
            variant="primary"
            loading={submitting}
            disabled={!name.trim() || !url.trim() || (authType === "apikey" && !apiKey.trim()) || accessIncomplete}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                url: url.trim(),
                authType,
                credentialMode: authType === "oauth" ? credentialMode : "shared",
                apiKey: authType === "apikey" ? apiKey.trim() : undefined,
                access,
              })
            }
          >
            Add connection
          </DenButton>
        </div>
      </div>
    </div>
  );
}
