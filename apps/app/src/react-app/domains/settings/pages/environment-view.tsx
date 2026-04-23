/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Plus, Trash2, X } from "lucide-react";

import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"] as const;

type EnvItem = { key: string; value: string; updatedAt: number };

export type EnvironmentViewProps = {
  client: OpenworkServerClient | null;
  isRemoteWorkspace: boolean;
  onStatusMessage: (message: string) => void;
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

  const [items, setItems] = useState<EnvItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<{ mode: "add" | "edit"; key: string; value: string } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await client.listUserEnv();
      setItems(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const existingKeys = useMemo(() => new Set(items.map((item) => item.key)), [items]);

  const openAdd = () => {
    setEditorError(null);
    setEditor({ mode: "add", key: "", value: "" });
  };

  const openEdit = (item: EnvItem) => {
    setEditorError(null);
    setEditor({ mode: "edit", key: item.key, value: item.value });
  };

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
  };

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
      onStatusMessage(t("settings.environment.restart_required"));
      closeEditor();
      await refresh();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: EnvItem) => {
    if (!client) return;
    const confirmed = window.confirm(t("settings.environment.confirm_delete").replace("{key}", item.key));
    if (!confirmed) return;
    setDeletingKey(item.key);
    try {
      await client.deleteUserEnv(item.key);
      onStatusMessage(t("settings.environment.restart_required"));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setDeletingKey(null);
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

        {loading && items.length === 0 ? (
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
                    <Button
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() =>
                        setRevealed((current) => ({ ...current, [item.key]: !current[item.key] }))
                      }
                      title={isRevealed ? t("settings.environment.hide") : t("settings.environment.reveal")}
                    >
                      {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                    </Button>
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        className="h-7 w-7 p-0 text-red-10 hover:text-red-11"
                        onClick={() => void handleDelete(item)}
                        disabled={deletingKey === item.key}
                        title={t("settings.environment.delete")}
                      >
                        <Trash2 size={13} />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="text-[11px] text-gray-8">
          {t("settings.environment.footer_hint")}
        </div>
      </div>

      {editor ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeEditor}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-dls-border bg-dls-surface p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-gray-12">
                {editor.mode === "add"
                  ? t("settings.environment.add_title")
                  : t("settings.environment.edit_title")}
              </div>
              <Button variant="ghost" className="h-7 w-7 p-0" onClick={closeEditor}>
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
    </div>
  );
}
