"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, ExternalLink, ShieldCheck, Trash2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { getWorkerStatusMeta } from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import {
  type TelegramPairing,
  useCreateTelegramPairing,
  useDeleteTelegramConnection,
  useSaveTelegramConnection,
  useTelegramConnection,
} from "./mcp-connections-data";

function pairingChatLabel(chat: { username: string | null; firstName: string | null }): string {
  if (chat.username) return `@${chat.username}`;
  return chat.firstName ?? "Private Telegram chat";
}

export function TelegramDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectionQuery = useTelegramConnection(open);
  const saveConnection = useSaveTelegramConnection();
  const createPairing = useCreateTelegramPairing();
  const deleteConnection = useDeleteTelegramConnection();
  const { workers, workersLoadedOnce, workersBusy, refreshWorkers } = useDenFlow();
  const [botToken, setBotToken] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [pairing, setPairing] = useState<TelegramPairing | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const readyWorkers = useMemo(
    () => workers.filter((worker) => getWorkerStatusMeta(worker.status).bucket === "ready"),
    [workers],
  );
  const connection = connectionQuery.data ?? null;

  useEffect(() => {
    if (!open) return;
    setBotToken("");
    setPairing(null);
    setCopied(false);
    setEditing(false);
    setConfirmingDelete(false);
    setLocalError(null);
    if (!workersLoadedOnce) void refreshWorkers({ quiet: true, keepSelection: true });
  }, [open, refreshWorkers, workersLoadedOnce]);

  useEffect(() => {
    if (!open || connection?.pairing.paired) return;
    const timer = window.setInterval(() => void connectionQuery.refetch(), 2500);
    return () => window.clearInterval(timer);
  }, [open, connection?.pairing.paired, connectionQuery.refetch]);

  useEffect(() => {
    if (workerId || readyWorkers.length === 0) return;
    setWorkerId(connection?.worker.id ?? readyWorkers[0]?.workerId ?? "");
  }, [connection?.worker.id, readyWorkers, workerId]);

  if (!open) return null;

  const busy = saveConnection.isPending || createPairing.isPending || deleteConnection.isPending;
  const formError = localError ?? saveConnection.error ?? createPairing.error ?? deleteConnection.error ?? connectionQuery.error;
  const showSetup = !connection || editing;

  async function generatePairing() {
    setLocalError(null);
    setPairing(await createPairing.mutateAsync());
    setCopied(false);
  }

  async function save() {
    setLocalError(null);
    try {
      await saveConnection.mutateAsync({ botToken: botToken.trim(), workerId });
      setBotToken("");
      setEditing(false);
      await generatePairing();
      await connectionQuery.refetch();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to connect Telegram.");
    }
  }

  async function copyPairingLink() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.url);
      setCopied(true);
    } catch {
      setLocalError("Could not copy the pairing link. Open it directly instead.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        data-testid="telegram-dialog"
        className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600"><Bot className="h-5 w-5" /></span>
          <div>
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">{connection ? "Telegram bot" : "Connect Telegram"}</h2>
            <p className="mt-1 text-[13px] leading-6 text-gray-600">Pair one private chat to one cloud worker. Messages become agent tasks and replies return to the same chat.</p>
          </div>
        </div>

        {connectionQuery.isLoading ? (
          <div className="mt-5 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-500">Checking Telegram setup…</div>
        ) : null}

        {connection && !editing ? (
          <div className="mt-5 space-y-4">
            <div className={`rounded-2xl border p-4 ${connection.connected && connection.webhook.registered ? "border-emerald-100 bg-emerald-50" : "border-amber-100 bg-amber-50"}`}>
              <div className="flex items-center gap-2">
                <Check className={`h-4 w-4 ${connection.connected && connection.webhook.registered ? "text-emerald-600" : "text-amber-600"}`} />
                <p className="text-[13px] font-semibold text-gray-900">
                  {connection.connected && connection.webhook.registered ? "Bot and webhook connected" : "Telegram needs attention"}
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-gray-500">Bot</dt><dd className="font-medium text-gray-900">{connection.bot.username ? `@${connection.bot.username}` : connection.bot.displayName}</dd>
                <dt className="text-gray-500">Worker</dt><dd className="font-medium text-gray-900">{connection.worker.name}</dd>
                <dt className="text-gray-500">Private chat</dt><dd className="font-medium text-gray-900">{connection.pairing.chat ? pairingChatLabel(connection.pairing.chat) : "Not paired yet"}</dd>
              </dl>
              {connection.webhook.lastError ? <p className="mt-2 text-[12px] text-amber-800">{connection.webhook.lastError}</p> : null}
            </div>

            {connection.pairing.paired ? (
              <div data-testid="telegram-paired" className="rounded-2xl border border-gray-100 bg-white p-4">
                <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /><p className="text-[13px] font-semibold text-gray-900">Private chat paired</p></div>
                <p className="mt-1 text-[12px] leading-5 text-gray-500">Only this chat can send tasks to the worker. Rotate pairing to move access to a different chat.</p>
                <DenButton className="mt-3" variant="secondary" size="sm" disabled={busy} onClick={() => void generatePairing()}>Pair a different chat</DenButton>
              </div>
            ) : !pairing ? (
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                <p className="text-[13px] font-semibold text-gray-900">Pair your private chat</p>
                <p className="mt-1 text-[12px] leading-5 text-gray-500">Generate a one-time link, open it in Telegram, then press Start.</p>
                <DenButton className="mt-3" variant="primary" size="sm" loading={createPairing.isPending} onClick={() => void generatePairing()}>Create pairing link</DenButton>
              </div>
            ) : null}
          </div>
        ) : null}

        {pairing ? (
          <div data-testid="telegram-pairing" className="mt-4 rounded-2xl border border-sky-100 bg-sky-50 p-4">
            <p className="text-[13px] font-semibold text-gray-900">One-time pairing link</p>
            <p className="mt-1 text-[12px] leading-5 text-gray-600">Open this link in the private Telegram account you want to authorize. It expires {new Date(pairing.expiresAt).toLocaleString()}.</p>
            <div className="mt-3 rounded-xl border border-sky-100 bg-white px-3 py-2 font-mono text-[11px] break-all text-gray-700">{pairing.url}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={pairing.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg bg-gray-900 px-3 text-[12px] font-medium text-white">Open Telegram <ExternalLink className="h-3.5 w-3.5" /></a>
              <DenButton variant="secondary" size="sm" onClick={() => void copyPairingLink()}><Copy className="mr-1 h-3.5 w-3.5" />{copied ? "Copied" : "Copy link"}</DenButton>
            </div>
          </div>
        ) : null}

        {showSetup && !connectionQuery.isLoading ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">1. Create a Telegram bot</p>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">Open {" "}<a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4">@BotFather</a>, run /newbot, and paste the token below. OpenWork encrypts it at rest and never shows it again.</p>
              <label className="mb-1.5 mt-3 block text-[12px] font-medium text-gray-700">Bot token</label>
              <DenInput data-testid="telegram-bot-token" type="password" autoComplete="off" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="123456789:AA…" />
            </div>
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">2. Choose a ready worker</p>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">Every accepted message starts a task on this worker.</p>
              <div className="mt-3">
                <DenSelect aria-label="Telegram worker" data-testid="telegram-worker" value={workerId} disabled={workersBusy || readyWorkers.length === 0} onChange={(event) => setWorkerId(event.target.value)}>
                  {readyWorkers.length === 0 ? <option value="">No ready workers</option> : readyWorkers.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.workerName}</option>)}
                </DenSelect>
              </div>
            </div>
            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-[12px] leading-5 text-amber-800">
              Self-hosted setup needs a stable public HTTPS OpenWork API URL so Telegram can deliver the webhook. This first version accepts private text chats only—no groups, channels, or media.
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {connection ? <DenButton variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel changes</DenButton> : null}
              <DenButton data-testid="save-telegram" variant="primary" loading={saveConnection.isPending} disabled={busy || !botToken.trim() || !workerId} onClick={() => void save()}>Connect bot</DenButton>
            </div>
          </div>
        ) : null}

        {formError ? <p className="mt-3 text-[13px] text-red-600">{formError instanceof Error ? formError.message : String(formError)}</p> : null}

        {connection && !editing ? (
          <div className="mt-5 border-t border-gray-100 pt-4">
            {confirmingDelete ? (
              <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
                <p className="text-[13px] font-semibold text-red-900">Disconnect this bot?</p>
                <p className="mt-1 text-[12px] leading-5 text-red-700">The webhook, encrypted token, and paired chat will be removed. Telegram messages will stop immediately.</p>
                <div className="mt-3 flex gap-2"><DenButton variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep connected</DenButton><DenButton variant="destructive" size="sm" loading={deleteConnection.isPending} onClick={async () => { await deleteConnection.mutateAsync(); setPairing(null); setConfirmingDelete(false); }}>Disconnect</DenButton></div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-between gap-2">
                <DenButton variant="secondary" size="sm" disabled={busy} onClick={() => { setWorkerId(connection.worker.id); setEditing(true); }} >Replace bot or worker</DenButton>
                <DenButton variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDelete(true)}><Trash2 className="mr-1 h-3.5 w-3.5" />Disconnect</DenButton>
              </div>
            )}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end"><DenButton variant="secondary" disabled={busy} onClick={onClose}>Close</DenButton></div>
      </div>
    </div>
  );
}
