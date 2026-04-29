/** @jsxImportSource react */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Trash2, X } from "lucide-react";

import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import {
  readOpenworkEnvPendingChanges,
  writeOpenworkEnvPendingChanges,
} from "../../../../app/lib/openwork-env-runtime";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { TextInput } from "../../../design-system/text-input";
import { clearOpenworkEnvSystemContextCache } from "../../session/sync/env-context";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const rowIconButtonClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-7/80 bg-gray-2 text-gray-11 shadow-sm transition-colors hover:border-gray-8 hover:bg-gray-4 hover:text-gray-12 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-50";
const rowDangerIconButtonClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-7/75 bg-red-3/40 text-red-10 shadow-sm transition-colors hover:border-red-8 hover:bg-red-4/80 hover:text-red-11 focus:outline-none focus:ring-2 focus:ring-red-7/30 disabled:cursor-not-allowed disabled:opacity-50";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"] as const;

type EnvItem = { key: string; value: string; updatedAt: number };
type ApplyEnvironmentChangesResult = { statusMessage?: string } | void;

export type EnvironmentViewProps = {
  client: OpenworkServerClient | null;
  isRemoteWorkspace: boolean;
  onStatusMessage: (message: string) => void;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason?: string | null;
  runtimeKey?: string | null;
};

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function formatUpdatedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function validateKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return t("settings.environment.validation_empty");
  if (!KEY_PATTERN.test(trimmed)) return t("settings.environment.validation_shape");
  if (RESERVED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return t("settings.environment.validation_reserved");
  }
  return null;
}

export function EnvironmentView(props: EnvironmentViewProps) {
  const { client, isRemoteWorkspace, onStatusMessage } = props;
  const canEdit = !isRemoteWorkspace && client !== null;
  const editorTitleId = useId();

  const [items, setItems] = useState<EnvItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<{ mode: "add" | "edit"; key: string; value: string } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<EnvItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState(() =>
    readOpenworkEnvPendingChanges(props.runtimeKey),
  );
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const refreshRequestId = useRef(0);
  const applyBlockedReason = props.applyBlocked
    ? props.applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks")
    : null;

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    if (!client || isRemoteWorkspace) {
      setItems([]);
      setRevealed({});
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await client.listUserEnv();
      if (requestId !== refreshRequestId.current) return;
      setItems(response.items);
    } catch (err) {
      if (requestId !== refreshRequestId.current) return;
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, [client, isRemoteWorkspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setPendingChanges(readOpenworkEnvPendingChanges(props.runtimeKey));
  }, [props.runtimeKey]);

  useEffect(() => {
    if (canEdit) return;
    setEditor(null);
    setEditorError(null);
    setDeleteCandidate(null);
    setDeletingKey(null);
    setApplyConfirmOpen(false);
    setApplyError(null);
  }, [canEdit]);

  const existingKeys = useMemo(() => new Set(items.map((item) => item.key)), [items]);

  const openAdd = () => {
    if (!canEdit) return;
    setEditorError(null);
    setEditor({ mode: "add", key: "", value: "" });
  };

  const openEdit = (item: EnvItem) => {
    if (!canEdit) return;
    setEditorError(null);
    setEditor({ mode: "edit", key: item.key, value: item.value });
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor(null);
    setEditorError(null);
  };

  const markChangesPending = () => {
    clearOpenworkEnvSystemContextCache();
    setPendingChanges(true);
    writeOpenworkEnvPendingChanges(true, props.runtimeKey);
    setApplyError(null);
    onStatusMessage(t("settings.environment.restart_required"));
  };

  useEffect(() => {
    if (!editor) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor, saving]);

  const submitEditor = async () => {
    if (!editor || !client) return;
    const keyError = validateKey(editor.key);
    if (keyError) {
      setEditorError(keyError);
      return;
    }
    if (editor.mode === "add" && existingKeys.has(editor.key.trim())) {
      setEditorError(t("settings.environment.validation_duplicate"));
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      await client.upsertUserEnv([{ key: editor.key.trim(), value: editor.value }]);
      markChangesPending();
      closeEditor();
      await refresh();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!client || !deleteCandidate || deletingKey) return;
    const key = deleteCandidate.key;
    setDeletingKey(key);
    try {
      await client.deleteUserEnv(key);
      markChangesPending();
      setDeleteCandidate(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setDeletingKey(null);
    }
  };

  const applyChanges = async () => {
    if (!props.onApplyChanges || applyBusy) return;
    if (props.applyBlocked) {
      const message = applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks");
      setApplyError(message);
      onStatusMessage(message);
      return;
    }
    setApplyBusy(true);
    setApplyError(null);
    try {
      const result = await props.onApplyChanges();
      clearOpenworkEnvSystemContextCache();
      setPendingChanges(false);
      writeOpenworkEnvPendingChanges(false);
      setApplyConfirmOpen(false);
      onStatusMessage(result?.statusMessage ?? t("settings.environment.apply_success"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("app.unknown_error");
      setApplyError(message);
      onStatusMessage(message);
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-12">
              {t("settings.environment.title")}
            </div>
            <p className="mt-1 max-w-[52ch] text-xs text-gray-10">
              {t("settings.environment.description")}
            </p>
          </div>
          {canEdit ? (
            <Button
              variant="primary"
              className="h-8 shrink-0 px-3 py-0 text-xs"
              onClick={openAdd}
            >
              <Plus size={13} className="mr-1.5" />
              {t("settings.environment.add_button")}
            </Button>
          ) : null}
        </div>

        {isRemoteWorkspace ? (
          <div className="rounded-lg border border-dls-border/60 bg-dls-surface-muted/40 px-3 py-2 text-xs text-gray-10">
            {t("settings.environment.remote_workspace_hint")}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
            {error}
          </div>
        ) : null}

        {pendingChanges && !isRemoteWorkspace ? (
          <div className="rounded-xl border border-amber-7/50 bg-amber-3/30 px-3 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-4/70 text-amber-11">
                  <RefreshCw size={14} />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-gray-12">
                    {t("settings.environment.apply_pending_title")}
                  </div>
                  <p className="mt-0.5 max-w-[54ch] text-xs text-gray-10">
                    {props.onApplyChanges
                      ? t("settings.environment.apply_pending_body")
                      : t("settings.environment.apply_pending_body_manual")}
                  </p>
                  {applyBlockedReason ? (
                    <div className="mt-2 rounded-lg border border-amber-7/50 bg-amber-3/30 px-3 py-2 text-xs text-amber-11">
                      {applyBlockedReason}
                    </div>
                  ) : applyError ? (
                    <div className="mt-2 rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
                      {applyError}
                    </div>
                  ) : null}
                </div>
              </div>
              {props.onApplyChanges ? (
                <Button
                  variant="primary"
                  className="h-8 shrink-0 px-3 py-0 text-xs"
                  onClick={() => {
                    if (props.applyBlocked) {
                      const message = applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks");
                      setApplyError(message);
                      onStatusMessage(message);
                      return;
                    }
                    setApplyConfirmOpen(true);
                  }}
                  disabled={applyBusy || props.applyBlocked}
                  title={applyBlockedReason ?? undefined}
                >
                  <RefreshCw size={13} className={applyBusy ? "animate-spin" : ""} />
                  {applyBusy ? t("settings.environment.applying") : t("settings.environment.apply_button")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {isRemoteWorkspace ? null : loading && items.length === 0 ? (
          <div className="py-6 text-center text-xs text-gray-10">
            {t("settings.environment.loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-dls-border/60 px-4 py-8 text-center">
            <div className="text-sm text-gray-12">
              {t("settings.environment.empty_title")}
            </div>
            <p className="mx-auto mt-1 max-w-[42ch] text-xs text-gray-10">
              {t("settings.environment.empty_body")}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-dls-border/60 overflow-hidden rounded-2xl border border-dls-border/60">
            {items.map((item) => {
              const isRevealed = Boolean(revealed[item.key]);
              const displayValue = isRevealed ? item.value : maskValue(item.value);
              return (
                <div
                  key={item.key}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => canEdit && openEdit(item)}
                      disabled={!canEdit}
                      className="font-mono text-[13px] text-gray-12 hover:underline disabled:cursor-default disabled:no-underline"
                      title={canEdit ? t("settings.environment.click_to_edit") : ""}
                    >
                      {item.key}
                    </button>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-8">
                      <span className="font-mono">{displayValue || t("settings.environment.empty_value")}</span>
                      <span>·</span>
                      <span>{formatUpdatedAt(item.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className={rowIconButtonClass}
                      onClick={() =>
                        setRevealed((current) => ({ ...current, [item.key]: !current[item.key] }))
                      }
                      title={isRevealed ? t("settings.environment.hide") : t("settings.environment.reveal")}
                      aria-pressed={isRevealed}
                      aria-label={(isRevealed
                        ? t("settings.environment.hide_value")
                        : t("settings.environment.reveal_value")
                      ).replace("{key}", item.key)}
                    >
                      {isRevealed ? <EyeOff className="h-4 w-4" strokeWidth={2.1} /> : <Eye className="h-4 w-4" strokeWidth={2.1} />}
                    </button>
                    {canEdit ? (
                      <button
                        type="button"
                        className={rowDangerIconButtonClass}
                        onClick={() => setDeleteCandidate(item)}
                        disabled={deletingKey === item.key}
                        title={t("settings.environment.delete")}
                        aria-label={t("settings.environment.delete_variable").replace("{key}", item.key)}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={2.1} />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!isRemoteWorkspace ? (
          <div className="space-y-1 text-[11px] text-gray-8">
            <div>{t("settings.environment.footer_hint")}</div>
            <div>{t("settings.environment.override_hint")}</div>
          </div>
        ) : null}
      </div>

      {editor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-1/60 backdrop-blur-sm" onClick={closeEditor} />
          <div
            className="relative w-full max-w-md rounded-2xl border border-gray-6 bg-gray-2 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editorTitleId}
          >
            <div className="flex items-center justify-between">
              <div id={editorTitleId} className="text-sm font-medium text-gray-12">
                {editor.mode === "add"
                  ? t("settings.environment.add_title")
                  : t("settings.environment.edit_title")}
              </div>
              <Button
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={closeEditor}
                aria-label={t("settings.environment.close_editor")}
                title={t("settings.environment.close_editor")}
              >
                <X size={14} />
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              <TextInput
                label={t("settings.environment.key_label")}
                hint={t("settings.environment.key_hint")}
                value={editor.key}
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, key: event.target.value } : current))
                }
                disabled={editor.mode === "edit" || saving}
                autoFocus={editor.mode === "add"}
                placeholder="ANTHROPIC_API_KEY"
              />
              <label className="block">
                <div className="mb-1 text-xs font-medium text-dls-secondary">
                  {t("settings.environment.value_label")}
                </div>
                <textarea
                  value={editor.value}
                  onChange={(event) =>
                    setEditor((current) => (current ? { ...current, value: event.target.value } : current))
                  }
                  disabled={saving}
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-[13px] text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                />
              </label>
              {editorError ? (
                <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
                  {editorError}
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" className="h-8 px-3 text-xs" onClick={closeEditor} disabled={saving}>
                {t("settings.environment.cancel")}
              </Button>
              <Button
                variant="primary"
                className="h-8 px-3 text-xs"
                onClick={() => void submitEditor()}
                disabled={saving}
              >
                {saving ? t("settings.environment.saving") : t("settings.environment.save")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={deleteCandidate !== null}
        title={t("settings.environment.delete_title")}
        message={deleteCandidate ? t("settings.environment.confirm_delete").replace("{key}", deleteCandidate.key) : ""}
        confirmLabel={deletingKey ? t("settings.environment.deleting") : t("settings.environment.delete")}
        cancelLabel={t("settings.environment.cancel")}
        variant="danger"
        confirmButtonVariant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deletingKey) setDeleteCandidate(null);
        }}
      />

      <ConfirmModal
        open={applyConfirmOpen}
        title={t("settings.environment.apply_title")}
        message={t("settings.environment.apply_confirm_body")}
        confirmLabel={applyBusy ? t("settings.environment.applying") : t("settings.environment.apply_button")}
        cancelLabel={t("settings.environment.cancel")}
        variant="warning"
        confirmButtonVariant="primary"
        onConfirm={() => void applyChanges()}
        onCancel={() => {
          if (!applyBusy) setApplyConfirmOpen(false);
        }}
      />
    </div>
  );
}
