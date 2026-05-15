/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  type SetStateAction,
} from "react";
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
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-7/80 bg-gray-2 text-gray-11 shadow-sm transition-colors hover:border-gray-8 hover:bg-gray-4 hover:text-gray-12 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-50";
const rowDangerIconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-red-7/75 bg-red-3/40 text-red-10 shadow-sm transition-colors hover:border-red-8 hover:bg-red-4/80 hover:text-red-11 focus:outline-none focus:ring-2 focus:ring-red-7/30 disabled:cursor-not-allowed disabled:opacity-50";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"] as const;

type EnvItem = { key: string; value: string; updatedAt: number };
type ApplyEnvironmentChangesResult = { statusMessage?: string } | void;
type EnvironmentEditorState = { mode: "add" | "edit"; key: string; value: string } | null;

type EnvironmentLocalState = {
  items: EnvItem[];
  loading: boolean;
  error: string | null;
  revealed: Record<string, boolean>;
  editor: EnvironmentEditorState;
  editorError: string | null;
  saving: boolean;
  deleteCandidate: EnvItem | null;
  deletingKey: string | null;
  pendingChanges: boolean;
  applyConfirmOpen: boolean;
  applyBusy: boolean;
  applyError: string | null;
};

type EnvironmentLocalAction<K extends keyof EnvironmentLocalState = keyof EnvironmentLocalState> =
  | {
      type: "set";
      key: K;
      value: SetStateAction<any>;
    }
  | { type: "editingDisabled" };

function environmentLocalReducer(
  state: EnvironmentLocalState,
  action: EnvironmentLocalAction,
): EnvironmentLocalState {
  if (action.type === "editingDisabled") {
    return {
      ...state,
      editor: null,
      editorError: null,
      deleteCandidate: null,
      deletingKey: null,
      applyConfirmOpen: false,
      applyError: null,
    };
  }
  const current = state[action.key];
  const next =
    typeof action.value === "function"
      ? (action.value as (value: typeof current) => typeof current)(current)
      : action.value;
  if (Object.is(current, next)) return state;
  return { ...state, [action.key]: next };
}

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

  const [localState, setLocalState] = useReducer(
    environmentLocalReducer,
    props.runtimeKey,
    (runtimeKey): EnvironmentLocalState => ({
      items: [],
      loading: false,
      error: null,
      revealed: {},
      editor: null,
      editorError: null,
      saving: false,
      deleteCandidate: null,
      deletingKey: null,
      pendingChanges: readOpenworkEnvPendingChanges(runtimeKey),
      applyConfirmOpen: false,
      applyBusy: false,
      applyError: null,
    }),
  );
  const {
    items,
    loading,
    error,
    revealed,
    editor,
    editorError,
    saving,
    deleteCandidate,
    deletingKey,
    pendingChanges,
    applyConfirmOpen,
    applyBusy,
    applyError,
  } = localState;
  const updateLocalState = <K extends keyof EnvironmentLocalState>(
    key: K,
    value: SetStateAction<EnvironmentLocalState[K]>,
  ) => setLocalState({ type: "set", key, value });
  const setItems = (value: SetStateAction<EnvItem[]>) => updateLocalState("items", value);
  const setLoading = (value: SetStateAction<boolean>) => updateLocalState("loading", value);
  const setError = (value: SetStateAction<string | null>) => updateLocalState("error", value);
  const setRevealed = (value: SetStateAction<Record<string, boolean>>) => updateLocalState("revealed", value);
  const setEditor = (value: SetStateAction<EnvironmentEditorState>) => updateLocalState("editor", value);
  const setEditorError = (value: SetStateAction<string | null>) => updateLocalState("editorError", value);
  const setSaving = (value: SetStateAction<boolean>) => updateLocalState("saving", value);
  const setDeleteCandidate = (value: SetStateAction<EnvItem | null>) => updateLocalState("deleteCandidate", value);
  const setDeletingKey = (value: SetStateAction<string | null>) => updateLocalState("deletingKey", value);
  const setPendingChanges = (value: SetStateAction<boolean>) => updateLocalState("pendingChanges", value);
  const setApplyConfirmOpen = (value: SetStateAction<boolean>) => updateLocalState("applyConfirmOpen", value);
  const setApplyBusy = (value: SetStateAction<boolean>) => updateLocalState("applyBusy", value);
  const setApplyError = (value: SetStateAction<string | null>) => updateLocalState("applyError", value);
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
    setLocalState({ type: "editingDisabled" });
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
    <div className="space-y-6 max-w-3xl w-full">
      <EnvironmentSettingsPanel
        canEdit={canEdit}
        isRemoteWorkspace={isRemoteWorkspace}
        error={error}
        pendingChanges={pendingChanges}
        onApplyChanges={props.onApplyChanges}
        applyBlocked={props.applyBlocked}
        applyBlockedReason={applyBlockedReason}
        applyBusy={applyBusy}
        applyError={applyError}
        loading={loading}
        items={items}
        revealed={revealed}
        deletingKey={deletingKey}
        onAdd={openAdd}
        onEdit={openEdit}
        onToggleReveal={(key) => setRevealed((current) => ({ ...current, [key]: !current[key] }))}
        onDeleteCandidate={setDeleteCandidate}
        onApplyBlocked={(message) => {
          setApplyError(message);
          onStatusMessage(message);
        }}
        onOpenApplyConfirm={() => setApplyConfirmOpen(true)}
      />

      {editor ? (
        <EnvironmentEditorModal
          editor={editor}
          titleId={editorTitleId}
          saving={saving}
          error={editorError}
          onClose={closeEditor}
          onChange={setEditor}
          onSubmit={submitEditor}
        />
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

function EnvironmentSettingsPanel(props: {
  canEdit: boolean;
  isRemoteWorkspace: boolean;
  error: string | null;
  pendingChanges: boolean;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason: string | null;
  applyBusy: boolean;
  applyError: string | null;
  loading: boolean;
  items: EnvItem[];
  revealed: Record<string, boolean>;
  deletingKey: string | null;
  onAdd: () => void;
  onEdit: (item: EnvItem) => void;
  onToggleReveal: (key: string) => void;
  onDeleteCandidate: (item: EnvItem) => void;
  onApplyBlocked: (message: string) => void;
  onOpenApplyConfirm: () => void;
}) {
  return (
    <div className={`${settingsPanelClass} space-y-4`}>
      <EnvironmentPanelHeader canEdit={props.canEdit} onAdd={props.onAdd} />

      {props.isRemoteWorkspace ? (
        <div className="rounded-lg border border-dls-border/60 bg-dls-surface-muted/40 px-3 py-2 text-xs text-gray-10">
          {t("settings.environment.remote_workspace_hint")}
        </div>
      ) : null}

      {props.error ? (
        <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
          {props.error}
        </div>
      ) : null}

      {props.pendingChanges && !props.isRemoteWorkspace ? (
        <EnvironmentPendingChanges
          onApplyChanges={props.onApplyChanges}
          applyBlocked={props.applyBlocked}
          applyBlockedReason={props.applyBlockedReason}
          applyBusy={props.applyBusy}
          applyError={props.applyError}
          onApplyBlocked={props.onApplyBlocked}
          onOpenApplyConfirm={props.onOpenApplyConfirm}
        />
      ) : null}

      <EnvironmentItemsList
        isRemoteWorkspace={props.isRemoteWorkspace}
        loading={props.loading}
        items={props.items}
        revealed={props.revealed}
        canEdit={props.canEdit}
        deletingKey={props.deletingKey}
        onEdit={props.onEdit}
        onToggleReveal={props.onToggleReveal}
        onDeleteCandidate={props.onDeleteCandidate}
      />

      {!props.isRemoteWorkspace ? (
        <div className="space-y-1 text-[11px] text-gray-8">
          <div>{t("settings.environment.footer_hint")}</div>
          <div>{t("settings.environment.override_hint")}</div>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentPanelHeader(props: { canEdit: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-12">{t("settings.environment.title")}</div>
        <p className="mt-1 max-w-[52ch] text-xs text-gray-10">{t("settings.environment.description")}</p>
      </div>
      {props.canEdit ? (
        <Button variant="primary" className="h-8 shrink-0 px-3 py-0 text-xs" onClick={props.onAdd}>
          <Plus size={13} className="mr-1.5" />
          {t("settings.environment.add_button")}
        </Button>
      ) : null}
    </div>
  );
}

function EnvironmentPendingChanges(props: {
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason: string | null;
  applyBusy: boolean;
  applyError: string | null;
  onApplyBlocked: (message: string) => void;
  onOpenApplyConfirm: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-7/50 bg-amber-3/30 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-4/70 text-amber-11">
            <RefreshCw size={14} />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium text-gray-12">{t("settings.environment.apply_pending_title")}</div>
            <p className="mt-0.5 max-w-[54ch] text-xs text-gray-10">
              {props.onApplyChanges
                ? t("settings.environment.apply_pending_body")
                : t("settings.environment.apply_pending_body_manual")}
            </p>
            {props.applyBlockedReason ? (
              <div className="mt-2 rounded-lg border border-amber-7/50 bg-amber-3/30 px-3 py-2 text-xs text-amber-11">
                {props.applyBlockedReason}
              </div>
            ) : props.applyError ? (
              <div className="mt-2 rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
                {props.applyError}
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
                props.onApplyBlocked(props.applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks"));
                return;
              }
              props.onOpenApplyConfirm();
            }}
            disabled={props.applyBusy || props.applyBlocked}
            title={props.applyBlockedReason ?? undefined}
          >
            <RefreshCw size={13} className={props.applyBusy ? "animate-spin" : ""} />
            {props.applyBusy ? t("settings.environment.applying") : t("settings.environment.apply_button")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EnvironmentItemsList(props: {
  isRemoteWorkspace: boolean;
  loading: boolean;
  items: EnvItem[];
  revealed: Record<string, boolean>;
  canEdit: boolean;
  deletingKey: string | null;
  onEdit: (item: EnvItem) => void;
  onToggleReveal: (key: string) => void;
  onDeleteCandidate: (item: EnvItem) => void;
}) {
  if (props.isRemoteWorkspace) return null;
  if (props.loading && props.items.length === 0) {
    return <div className="py-6 text-center text-xs text-gray-10">{t("settings.environment.loading")}</div>;
  }
  if (props.items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-dls-border/60 px-4 py-8 text-center">
        <div className="text-sm text-gray-12">{t("settings.environment.empty_title")}</div>
        <p className="mx-auto mt-1 max-w-[42ch] text-xs text-gray-10">{t("settings.environment.empty_body")}</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-dls-border/60 overflow-hidden rounded-2xl border border-dls-border/60">
      {props.items.map((item) => (
        <EnvironmentItemRow
          key={item.key}
          item={item}
          isRevealed={Boolean(props.revealed[item.key])}
          canEdit={props.canEdit}
          deleting={props.deletingKey === item.key}
          onEdit={props.onEdit}
          onToggleReveal={props.onToggleReveal}
          onDeleteCandidate={props.onDeleteCandidate}
        />
      ))}
    </div>
  );
}

function EnvironmentItemRow(props: {
  item: EnvItem;
  isRevealed: boolean;
  canEdit: boolean;
  deleting: boolean;
  onEdit: (item: EnvItem) => void;
  onToggleReveal: (key: string) => void;
  onDeleteCandidate: (item: EnvItem) => void;
}) {
  const displayValue = props.isRevealed ? props.item.value : maskValue(props.item.value);
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => props.canEdit && props.onEdit(props.item)}
          disabled={!props.canEdit}
          className="font-mono text-[13px] text-gray-12 hover:underline disabled:cursor-default disabled:no-underline"
          title={props.canEdit ? t("settings.environment.click_to_edit") : ""}
        >
          {props.item.key}
        </button>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-8">
          <span className="font-mono">{displayValue || t("settings.environment.empty_value")}</span>
          <span>·</span>
          <span>{formatUpdatedAt(props.item.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={rowIconButtonClass}
          onClick={() => props.onToggleReveal(props.item.key)}
          title={props.isRevealed ? t("settings.environment.hide") : t("settings.environment.reveal")}
          aria-pressed={props.isRevealed}
          aria-label={(props.isRevealed
            ? t("settings.environment.hide_value")
            : t("settings.environment.reveal_value")
          ).replace("{key}", props.item.key)}
        >
          {props.isRevealed ? <EyeOff className="size-4" strokeWidth={2.1} /> : <Eye className="size-4" strokeWidth={2.1} />}
        </button>
        {props.canEdit ? (
          <button
            type="button"
            className={rowDangerIconButtonClass}
            onClick={() => props.onDeleteCandidate(props.item)}
            disabled={props.deleting}
            title={t("settings.environment.delete")}
            aria-label={t("settings.environment.delete_variable").replace("{key}", props.item.key)}
          >
            <Trash2 className="size-4" strokeWidth={2.1} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EnvironmentEditorModal(props: {
  editor: EnvironmentEditorState;
  titleId: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (value: SetStateAction<EnvironmentEditorState>) => void;
  onSubmit: () => Promise<void>;
}) {
  if (!props.editor) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-gray-1/60 backdrop-blur-sm" aria-label={t("settings.environment.close_editor")} onClick={props.onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-gray-6 bg-gray-2 p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={props.titleId}>
        <div className="flex items-center justify-between">
          <div id={props.titleId} className="text-sm font-medium text-gray-12">
            {props.editor.mode === "add" ? t("settings.environment.add_title") : t("settings.environment.edit_title")}
          </div>
          <Button variant="ghost" className="size-7 p-0" onClick={props.onClose} aria-label={t("settings.environment.close_editor")} title={t("settings.environment.close_editor")}>
            <X size={14} />
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          <TextInput
            label={t("settings.environment.key_label")}
            hint={t("settings.environment.key_hint")}
            value={props.editor.key}
            onChange={(event) => props.onChange((current) => (current ? { ...current, key: event.target.value } : current))}
            disabled={props.editor.mode === "edit" || props.saving}
            placeholder="ANTHROPIC_API_KEY"
          />
          <label className="block">
            <div className="mb-1 text-xs font-medium text-dls-secondary">{t("settings.environment.value_label")}</div>
            <textarea
              value={props.editor.value}
              onChange={(event) => props.onChange((current) => (current ? { ...current, value: event.target.value } : current))}
              disabled={props.saving}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-[13px] text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
            />
          </label>
          {props.error ? (
            <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
              {props.error}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={props.onClose} disabled={props.saving}>
            {t("settings.environment.cancel")}
          </Button>
          <Button variant="primary" className="h-8 px-3 text-xs" onClick={() => void props.onSubmit()} disabled={props.saving}>
            {props.saving ? t("settings.environment.saving") : t("settings.environment.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
