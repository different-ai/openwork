"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, ExternalLink, Hash, MessageSquareText, ShieldCheck, Trash2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { getWorkerStatusMeta } from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import {
  useDeleteTagConnection,
  useSaveTagConnection,
  useStartTagOAuth,
  useTagConnection,
  useTagOAuthConfig,
  useTagRuns,
  useUpdateTagConnection,
  type TagPolicyInput,
} from "./mcp-connections-data";

const DEFAULT_INSTRUCTIONS = "Help the team complete concrete work in this channel. Prefer verified changes and concise, evidence-backed updates. Ask before destructive or externally visible actions.";
const REQUIRED_SCOPES = "app_mentions:read, chat:write, channels:history, channels:read, groups:history, groups:read, users:read";
const REQUIRED_EVENTS = "app_mention, message.channels, message.groups, app_uninstalled, tokens_revoked";

function parseIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function runStatusClass(status: string): string {
  if (status === "completed") return "bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "cancelled") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-700";
}

export function TagDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectionQuery = useTagConnection(open);
  const connection = connectionQuery.data ?? null;
  const oauthConfigQuery = useTagOAuthConfig(open);
  const runsQuery = useTagRuns(open && Boolean(connection));
  const saveConnection = useSaveTagConnection();
  const updateConnection = useUpdateTagConnection();
  const startOAuth = useStartTagOAuth();
  const deleteConnection = useDeleteTagConnection();
  const { workers, workersLoadedOnce, workersBusy, refreshWorkers } = useDenFlow();
  const readyWorkers = useMemo(
    () => workers.filter((worker) => getWorkerStatusMeta(worker.status).bucket === "ready"),
    [workers],
  );
  const [editing, setEditing] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [serviceName, setServiceName] = useState("OpenWork");
  const [defaultInstructions, setDefaultInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [channelIds, setChannelIds] = useState("");
  const [allowedUserIds, setAllowedUserIds] = useState("");
  const [allowGuests, setAllowGuests] = useState(false);
  const [allowSharedChannels, setAllowSharedChannels] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [manualInstall, setManualInstall] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEditing(false);
    setBotToken("");
    setSigningSecret("");
    setCopied(null);
    setConfirmingDelete(false);
    setLocalError(null);
    setManualInstall(false);
    if (!workersLoadedOnce) void refreshWorkers({ quiet: true, keepSelection: true });
  }, [open, refreshWorkers, workersLoadedOnce]);

  useEffect(() => {
    if (!open || !connection) return;
    setWorkerId(connection.worker.id);
    setServiceName(connection.policy.serviceName);
    setDefaultInstructions(connection.policy.defaultInstructions);
    setChannelIds(connection.policy.channels.map((channel) => channel.id).join(", "));
    setAllowedUserIds(connection.policy.allowedUserIds.join(", "));
    setAllowGuests(connection.policy.allowGuests);
    setAllowSharedChannels(connection.policy.allowSharedChannels);
  }, [connection, open]);

  useEffect(() => {
    if (workerId || readyWorkers.length === 0) return;
    setWorkerId(readyWorkers[0]?.workerId ?? "");
  }, [readyWorkers, workerId]);

  if (!open) return null;

  const busy = saveConnection.isPending || updateConnection.isPending || startOAuth.isPending || deleteConnection.isPending;
  const showSetup = !connection || editing;
  const oauthConfigured = oauthConfigQuery.data?.configured === true;
  const formError = localError ?? saveConnection.error ?? updateConnection.error ?? startOAuth.error ?? deleteConnection.error ?? connectionQuery.error ?? oauthConfigQuery.error;

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setLocalError("Could not copy that value. Select it manually instead.");
    }
  }

  function policyInput(): TagPolicyInput | null {
    const channels = parseIds(channelIds);
    if (channels.length === 0) {
      setLocalError("Add at least one Slack channel ID.");
      return null;
    }
    if (!workerId || !serviceName.trim() || !defaultInstructions.trim()) {
      setLocalError("Choose a ready worker and complete the service identity fields.");
      return null;
    }
    return {
      workerId,
      serviceName: serviceName.trim(),
      defaultInstructions: defaultInstructions.trim(),
      allowedUserIds: parseIds(allowedUserIds),
      allowGuests,
      allowSharedChannels,
      channels: channels.map((id) => ({ id })),
    };
  }

  async function save() {
    setLocalError(null);
    const policy = policyInput();
    if (!policy) return;
    try {
      if (connection) {
        await updateConnection.mutateAsync(policy);
      } else {
        await saveConnection.mutateAsync({ ...policy, botToken: botToken.trim(), signingSecret: signingSecret.trim() });
      }
      setBotToken("");
      setSigningSecret("");
      setEditing(false);
      await connectionQuery.refetch();
      await runsQuery.refetch();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to connect OpenWork Tag.");
    }
  }

  async function installWithSlack() {
    setLocalError(null);
    const policy = policyInput();
    if (!policy) return;
    try {
      const started = await startOAuth.mutateAsync(policy);
      const popup = window.open(started.authorizeUrl, "openwork-tag-slack-oauth", "popup,width=720,height=760");
      if (!popup) throw new Error("Your browser blocked the Slack installation window. Allow popups for Den and try again.");
      popup.focus();
      const outcome = await new Promise<{ ok: boolean; message: string }>((resolve) => {
        let finished = false;
        const finish = (result: { ok: boolean; message: string }) => {
          if (finished) return;
          finished = true;
          window.removeEventListener("message", onMessage);
          window.clearInterval(poll);
          window.clearTimeout(timeout);
          resolve(result);
        };
        const onMessage = (event: MessageEvent) => {
          const data: unknown = event.data;
          if (event.source !== popup || event.origin !== started.callbackOrigin || typeof data !== "object" || data === null) return;
          if (!("type" in data) || data.type !== "openwork-tag-slack-oauth" || !("ok" in data) || typeof data.ok !== "boolean") return;
          const message = "message" in data && typeof data.message === "string" ? data.message : "Slack installation finished.";
          finish({ ok: data.ok, message });
        };
        window.addEventListener("message", onMessage);
        const poll = window.setInterval(async () => {
          const refreshed = await connectionQuery.refetch();
          if (refreshed.data) return finish({ ok: true, message: "Slack is connected." });
          if (popup.closed) finish({ ok: false, message: "The Slack installation window closed before the workspace was connected." });
        }, 1200);
        const timeout = window.setTimeout(() => finish({ ok: false, message: "Slack installation timed out. Start it again to create a fresh secure request." }), 2 * 60 * 1000);
      });
      if (!outcome.ok) throw new Error(outcome.message);
      popup.close();
      setEditing(false);
      await connectionQuery.refetch();
      await runsQuery.refetch();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to install OpenWork Tag in Slack.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        data-testid="tag-dialog"
        className="max-h-[calc(100vh-3rem)] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><MessageSquareText className="h-5 w-5" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">OpenWork Tag</h2>
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-700">Slack alpha</span>
            </div>
            <p className="mt-1 text-[13px] leading-6 text-gray-600">Mention your OpenWork agent in Slack, keep working together in the thread, and inspect every real OpenCode run from Den.</p>
          </div>
        </div>

        {connectionQuery.isLoading ? <div className="mt-5 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-500">Checking Tag setup…</div> : null}

        {connection && !editing ? (
          <div className="mt-5 space-y-4">
            <div className={`rounded-2xl border p-4 ${connection.connected ? "border-emerald-100 bg-emerald-50" : "border-amber-100 bg-amber-50"}`}>
              <div className="flex items-center gap-2"><Check className={`h-4 w-4 ${connection.connected ? "text-emerald-600" : "text-amber-600"}`} /><p className="text-[13px] font-semibold text-gray-900">{connection.connected ? "Slack and OpenWork worker connected" : "Tag needs attention"}</p></div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-gray-500">Slack</dt><dd className="font-medium text-gray-900">{connection.slack.teamName} · @{connection.slack.botName}</dd>
                <dt className="text-gray-500">Installation</dt><dd className="font-medium text-gray-900">{connection.installation.source === "oauth" ? "Managed Slack OAuth" : "Manual credentials"}{connection.installation.enterpriseInstall ? " · Enterprise Grid" : ""}</dd>
                <dt className="text-gray-500">Worker</dt><dd className="font-medium text-gray-900">{connection.worker.name}</dd>
                <dt className="text-gray-500">Channels</dt><dd className="font-medium text-gray-900">{connection.policy.channels.map((channel) => channel.name ? `#${channel.name}` : channel.id).join(", ")}</dd>
                <dt className="text-gray-500">Last event</dt><dd className="font-medium text-gray-900">{connection.webhook.lastReceivedAt ? new Date(connection.webhook.lastReceivedAt).toLocaleString() : "Waiting for Slack"}</dd>
              </dl>
            </div>

            <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <div className="flex items-center gap-2"><Hash className="h-4 w-4 text-violet-700" /><p className="text-[13px] font-semibold text-gray-900">{connection.installation.source === "oauth" ? "Managed Slack event delivery" : "Finish Slack Events API setup"}</p></div>
              {connection.installation.source === "oauth" ? (
                <p className="mt-2 text-[12px] leading-5 text-gray-600">This workspace uses Den&apos;s managed Slack app. OAuth tokens rotate automatically, and uninstall or token-revocation events disable execution immediately.</p>
              ) : (
                <ol className="mt-2 list-decimal space-y-2 pl-4 text-[12px] leading-5 text-gray-600">
                  <li>In your Slack app, open Event Subscriptions and enable events.</li>
                  <li>Paste this Request URL. Slack&apos;s challenge is verified with your signing secret.</li>
                </ol>
              )}
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-violet-100 bg-white p-2">
                <p className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-gray-800">{connection.eventsUrl}</p>
                <DenButton variant="secondary" size="sm" onClick={() => void copy(connection.eventsUrl, "events")}>{copied === "events" ? "Copied" : "Copy"}</DenButton>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-gray-600">{connection.installation.source === "oauth" ? "The deployment app subscribes to" : "Subscribe to bot events"}: <span className="font-mono text-[11px]">{REQUIRED_EVENTS}</span>. Add the bot to each approved channel.</p>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /><p className="text-[13px] font-semibold text-gray-900">Thread-safe execution boundary</p></div>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">One Slack thread maps to one durable OpenCode session. Authorized teammates can continue without re-mentioning. DMs, unapproved channels, guests, and Slack Connect are denied unless explicitly enabled.</p>
              <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-[12px] text-gray-700"><span className="font-medium">Try it:</span> <span className="font-mono">@{connection.slack.botName} investigate the failing checkout tests and propose a fix</span></div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3"><p className="text-[13px] font-semibold text-gray-900">Recent execution records</p><span className="text-[11px] text-gray-400">Live from Den</span></div>
              {runsQuery.isLoading ? <p className="mt-3 text-[12px] text-gray-500">Loading runs…</p> : (runsQuery.data?.length ?? 0) === 0 ? <p className="mt-3 text-[12px] text-gray-500">No accepted Slack requests yet.</p> : (
                <div className="mt-3 divide-y divide-gray-100">
                  {runsQuery.data?.slice(0, 6).map((run) => (
                    <div key={run.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2"><p className="truncate text-[12px] font-medium text-gray-900">{run.prompt}</p><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${runStatusClass(run.status)}`}>{run.status}</span></div>
                      <p className="mt-1 text-[11px] text-gray-400">{run.channelId} · {new Date(run.createdAt).toLocaleString()} · {run.sessionId ? `session ${run.sessionId}` : "session starting"}</p>
                      {run.error ? <p className="mt-1 text-[11px] text-red-600">{run.error}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {showSetup && !connectionQuery.isLoading && !oauthConfigQuery.isLoading ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-gray-700" /><p className="text-[13px] font-semibold text-gray-900">1. {connection ? "Installation credentials stay protected" : oauthConfigured && !manualInstall ? "Install securely with Slack" : "Connect a self-managed Slack app"}</p></div>
              {connection ? (
                <p className="mt-1 text-[12px] leading-5 text-gray-500">Update policy without re-entering secrets. Den preserves the encrypted installation and revalidates every selected channel with Slack.</p>
              ) : oauthConfigured && !manualInstall ? (
                <div>
                  <p className="mt-1 text-[12px] leading-5 text-gray-500">Choose the worker and channel policy below, then approve the OpenWork app in Slack. Den keeps setup state single-use and stores rotating tokens encrypted.</p>
                  <div className="mt-3 grid gap-2 text-[11px] text-gray-600 sm:grid-cols-2">
                    <div className="rounded-xl border border-gray-200 bg-white p-2"><span className="font-medium text-gray-800">Redirect URI</span><p className="mt-1 break-all font-mono">{oauthConfigQuery.data?.redirectUri}</p></div>
                    <div className="rounded-xl border border-gray-200 bg-white p-2"><span className="font-medium text-gray-800">Events endpoint</span><p className="mt-1 break-all font-mono">{oauthConfigQuery.data?.eventsUrl}</p></div>
                  </div>
                  <button type="button" className="mt-3 text-[11px] font-medium text-gray-500 underline underline-offset-2" onClick={() => setManualInstall(true)}>Use a self-managed Slack app instead</button>
                </div>
              ) : (
                <div>
                  <p className="mt-1 text-[12px] leading-5 text-gray-500">Create an app at api.slack.com/apps, add a bot, install it to your workspace, and grant these bot scopes:</p>
                  <div className="mt-2 flex items-start gap-2 rounded-xl border border-gray-200 bg-white p-2"><p className="min-w-0 flex-1 break-words font-mono text-[11px] leading-5 text-gray-700">{REQUIRED_SCOPES}</p><DenButton variant="secondary" size="sm" onClick={() => void copy(REQUIRED_SCOPES, "scopes")}>{copied === "scopes" ? "Copied" : <Copy className="h-3.5 w-3.5" />}</DenButton></div>
                  <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Bot user OAuth token</label>
                  <DenInput data-testid="tag-bot-token" type="password" autoComplete="off" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="xoxb-…" />
                  <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Signing secret</label>
                  <DenInput data-testid="tag-signing-secret" type="password" autoComplete="off" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} placeholder="From Basic Information → App Credentials" />
                  <p className="mt-2 text-[11px] leading-5 text-gray-500">Both values are encrypted in Den and never returned, logged, sent to OpenCode, or exposed to the model.</p>
                  {oauthConfigured ? <button type="button" className="mt-3 text-[11px] font-medium text-violet-700 underline underline-offset-2" onClick={() => setManualInstall(false)}>Use managed Slack installation</button> : null}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">2. Choose where Tag can work</p>
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Ready OpenWork worker</label>
              <DenSelect aria-label="OpenWork Tag worker" value={workerId} disabled={workersBusy || readyWorkers.length === 0} onChange={(event) => setWorkerId(event.target.value)}>
                {readyWorkers.length === 0 ? <option value="">No ready workers</option> : readyWorkers.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.workerName}</option>)}
              </DenSelect>
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Approved channel IDs</label>
              <DenInput data-testid="tag-channel-ids" value={channelIds} onChange={(event) => setChannelIds(event.target.value)} placeholder="C012ABCDEF, C034GHIJKL" />
              <p className="mt-1 text-[11px] text-gray-500">Comma-separated IDs from Slack channel details. Tag denies every other channel.</p>
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Allowed Slack user IDs <span className="font-normal text-gray-400">(optional)</span></label>
              <DenInput value={allowedUserIds} onChange={(event) => setAllowedUserIds(event.target.value)} placeholder="U012ABCDEF, U034GHIJKL" />
              <p className="mt-1 text-[11px] text-gray-500">Leave empty to allow all full members in approved channels.</p>
              <div className="mt-3 space-y-2">
                <label className="flex items-center gap-2 text-[12px] text-gray-700"><input type="checkbox" checked={allowGuests} onChange={(event) => setAllowGuests(event.target.checked)} />Allow guest accounts</label>
                <label className="flex items-center gap-2 text-[12px] text-gray-700"><input type="checkbox" checked={allowSharedChannels} onChange={(event) => setAllowSharedChannels(event.target.checked)} />Allow Slack Connect / externally shared channels</label>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">3. Shape the channel agent</p>
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Service identity</label>
              <DenInput value={serviceName} maxLength={80} onChange={(event) => setServiceName(event.target.value)} placeholder="OpenWork" />
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Instructions for new threads</label>
              <textarea className="min-h-28 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[13px] leading-5 text-gray-900 outline-none focus:border-gray-400" value={defaultInstructions} maxLength={12000} onChange={(event) => setDefaultInstructions(event.target.value)} />
              <p className="mt-1 text-[11px] text-gray-500">Each thread gets an immutable policy snapshot, so later admin edits cannot silently change an in-flight run.</p>
            </div>

            {connection ? <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4 text-[12px] leading-5 text-violet-800">Policy updates affect new threads only. Existing thread snapshots, session bindings, and run history remain immutable.</div> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {connection ? <DenButton variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel changes</DenButton> : null}
              {connection ? (
                <DenButton data-testid="save-tag" variant="primary" loading={updateConnection.isPending} disabled={busy || !workerId || !serviceName.trim() || !defaultInstructions.trim() || parseIds(channelIds).length === 0} onClick={() => void save()}>Save and re-verify policy</DenButton>
              ) : oauthConfigured && !manualInstall ? (
                <DenButton data-testid="install-tag-oauth" variant="primary" loading={startOAuth.isPending} disabled={busy || !workerId || !serviceName.trim() || !defaultInstructions.trim() || parseIds(channelIds).length === 0} onClick={() => void installWithSlack()}><ExternalLink className="mr-1 h-3.5 w-3.5" />Install with Slack</DenButton>
              ) : (
                <DenButton data-testid="save-tag" variant="primary" loading={saveConnection.isPending} disabled={busy || !botToken.trim() || !signingSecret.trim() || !workerId || !serviceName.trim() || !defaultInstructions.trim() || parseIds(channelIds).length === 0} onClick={() => void save()}>Connect self-managed app</DenButton>
              )}
            </div>
          </div>
        ) : null}

        {formError ? <p className="mt-3 text-[13px] text-red-600">{formError instanceof Error ? formError.message : String(formError)}</p> : null}

        {connection && !editing ? (
          <div className="mt-5 border-t border-gray-100 pt-4">
            {confirmingDelete ? (
              <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
                <p className="text-[13px] font-semibold text-red-900">Disconnect OpenWork Tag?</p>
                <p className="mt-1 text-[12px] leading-5 text-red-700">Den will revoke the Slack bot token when possible, then delete encrypted credentials, queued events, thread bindings, and execution records.</p>
                <div className="mt-3 flex gap-2"><DenButton variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep connected</DenButton><DenButton variant="destructive" size="sm" loading={deleteConnection.isPending} onClick={async () => { await deleteConnection.mutateAsync(); setConfirmingDelete(false); }}>Disconnect</DenButton></div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-between gap-2"><DenButton variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>Update policy</DenButton><DenButton variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDelete(true)}><Trash2 className="mr-1 h-3.5 w-3.5" />Disconnect</DenButton></div>
            )}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end"><DenButton variant="secondary" disabled={busy} onClick={onClose}>Close</DenButton></div>
      </div>
    </div>
  );
}
