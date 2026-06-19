/** @jsxImportSource react */
import { useEffect, useId, useState, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import {
  EnvironmentVariableProvider,
  environmentUserEnvQueryKey,
  type ApplyEnvironmentChangesResult,
  type EnvironmentEditorDraft,
  useEnvironmentVariableApplyChanges,
  useEnvironmentVariableList,
  useEnvironmentVariableModify,
  useEnvironmentVariableRemove,
  useIsEnvironmentVariableChangesPending,
} from "./environment-variable-provider";
import { SettingsNotice, Spinner } from "@/react-app/domains/settings/settings-section";
import {
  EnvironmentVariableTableItem,
  EnvironmentVariableTable,
  EnvironmentVariableTableBody,
  EnvironmentVariableTableEmpty,
  EnvironmentVariableTableHeader,
  EnvironmentVariableTableLoading,
  type EnvironmentVariableItem,
} from "./environment-variable-table";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItemFootnote,
  LayoutSectionTitle,
  LayoutStack,
} from "@/react-app/domains/settings/settings-layout";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

type EnvItem = EnvironmentVariableItem;
type EnvironmentEditorState = EnvironmentEditorDraft | null;

export type EnvironmentViewProps = {
  client: OpenworkServerClient | null;
  isRemoteWorkspace: boolean;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason?: string | null;
  runtimeKey?: string | null;
};

export function EnvironmentView(props: EnvironmentViewProps) {
  return (
    <EnvironmentVariableProvider
      client={props.client}
      runtimeKey={props.runtimeKey}
      onApplyChanges={props.onApplyChanges}
    >
      <EnvironmentViewContent {...props} />
    </EnvironmentVariableProvider>
  );
}

function EnvironmentViewContent(props: EnvironmentViewProps) {
  const { client, isRemoteWorkspace } = props;
  const canEdit = !isRemoteWorkspace && client !== null;
  const applyBlockedReason = props.applyBlocked
    ? props.applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks")
    : null;

  const [editor, setEditor] = useState<EnvironmentEditorState>(null);

  useEffect(() => {
    if (canEdit) {
      return;
    }
    setEditor(null);
  }, [canEdit]);

  return (
    <LayoutStack>
      <EnvironmentSettingsPanel
        client={client}
        isRemoteWorkspace={isRemoteWorkspace}
        canEdit={canEdit}
        runtimeKey={props.runtimeKey}
        onApplyChanges={props.onApplyChanges}
        applyBlocked={props.applyBlocked}
        applyBlockedReason={applyBlockedReason}
        editor={editor}
        onEditorChange={setEditor}
      />
    </LayoutStack>
  );
}

type EnvironmentSettingsPanelProps = {
  client: OpenworkServerClient | null;
  isRemoteWorkspace: boolean;
  canEdit: boolean;
  runtimeKey?: string | null;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason: string | null;
  editor: EnvironmentEditorState;
  onEditorChange: (value: SetStateAction<EnvironmentEditorState>) => void;
};

function EnvironmentSettingsPanel(props: EnvironmentSettingsPanelProps) {
  const isPendingChanges = useIsEnvironmentVariableChangesPending();
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useEnvironmentVariableList({
    client: props.client,
    isRemoteWorkspace: props.isRemoteWorkspace,
    runtimeKey: props.runtimeKey,
  });

  const readEnvironmentValue = async (item: EnvItem) => {
    if (typeof item.value === "string") return item.value;
    if (!item.hasValue) {
      queryClient.setQueryData<{ items: EnvItem[] }>(
        environmentUserEnvQueryKey(props.runtimeKey),
        (current) => {
          if (!current) return current;
          return {
            items: current.items.map((entry) =>
              entry.key === item.key ? { ...entry, value: "" } : entry,
            ),
          };
        },
      );
      return "";
    }
    if (!props.client) throw new Error(t("app.unknown_error"));

    const response = await props.client.getUserEnv(item.key);
    queryClient.setQueryData<{ items: EnvItem[] }>(
      environmentUserEnvQueryKey(props.runtimeKey),
      (current) => {
        if (!current) return current;
        return {
          items: current.items.map((entry) =>
            entry.key === item.key
              ? {
                  ...entry,
                  value: response.item.value,
                  hasValue: response.item.hasValue,
                  updatedAt: response.item.updatedAt,
                }
              : entry,
          ),
        };
      },
    );
    return response.item.value;
  };

  const openAdd = () => {
    if (!props.canEdit) {
      return;
    }
    props.onEditorChange({ mode: "add", key: "", value: "" });
  };

  const openEdit = (item: EnvItem) => {
    if (!props.canEdit) {
      return;
    }
    void readEnvironmentValue(item)
      .then((value) => props.onEditorChange({ mode: "edit", key: item.key, value }))
      .catch((readError) => {
        toast.error(readError instanceof Error ? readError.message : t("app.unknown_error"));
      });
  };

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <LayoutSectionTitle>{t("settings.environment.title")}</LayoutSectionTitle>
            <LayoutSectionDescription className="max-w-[52ch]">
              {t("settings.environment.description")}
            </LayoutSectionDescription>
          </div>
          {props.canEdit ? (
            <Button className="shrink-0" onClick={openAdd}>
              <Plus className="size-4" />
              {t("settings.environment.add_button")}
            </Button>
          ) : null}
        </div>
      </LayoutSectionHeader>

      {props.isRemoteWorkspace ? (
        <SettingsNotice>{t("settings.environment.remote_workspace_hint")}</SettingsNotice>
      ) : null}

      {error ? <SettingsNotice tone="error">{error.message}</SettingsNotice> : null}

      {isPendingChanges && !props.isRemoteWorkspace ? (
        <EnvironmentPendingChanges
          onApplyChanges={props.onApplyChanges}
          applyBlocked={props.applyBlocked}
          applyBlockedReason={props.applyBlockedReason}
        />
      ) : null}

      {!props.isRemoteWorkspace ? (
        <EnvironmentItemsTable
          loading={isLoading}
          items={data?.items ?? []}
          canEdit={props.canEdit}
          onAdd={openAdd}
          onEdit={openEdit}
          onRevealValue={readEnvironmentValue}
        />
      ) : null}

      {!props.isRemoteWorkspace ? (
        <>
          <LayoutSectionItemFootnote>{t("settings.environment.footer_hint")}</LayoutSectionItemFootnote>
          <LayoutSectionItemFootnote>{t("settings.environment.override_hint")}</LayoutSectionItemFootnote>
        </>
      ) : null}

      {props.editor ? (
        <EnvironmentEditorModal
          editor={props.editor}
          onClose={() => props.onEditorChange(null)}
          onChange={props.onEditorChange}
        />
      ) : null}
    </LayoutSection>
  );
}

type EnvironmentPendingChangesProps = {
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason: string | null;
};

function EnvironmentPendingChanges(props: EnvironmentPendingChangesProps) {
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const { isApplying, error } = useEnvironmentVariableApplyChanges();

  return (
    <>
      <Alert variant="warning">
        <RefreshCw />
        <AlertTitle>{t("settings.environment.apply_pending_title")}</AlertTitle>
        <AlertDescription className="max-w-[54ch]">
          {props.onApplyChanges
            ? t("settings.environment.apply_pending_body")
            : t("settings.environment.apply_pending_body_manual")}
        </AlertDescription>
        {props.applyBlockedReason ? (
          <AlertDescription>{props.applyBlockedReason}</AlertDescription>
        ) : error ? (
          <SettingsNotice tone="error">{error.message}</SettingsNotice>
        ) : null}
        {props.onApplyChanges ? (
          <AlertAction>
            <Button
              size="sm"
              onClick={() => {
                if (props.applyBlocked) {
                  toast.warning(props.applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks"));
                  return;
                }
                setApplyConfirmOpen(true);
              }}
              disabled={isApplying || props.applyBlocked}
              title={props.applyBlockedReason ?? undefined}
            >
              <Spinner spinning={isApplying} />
              {isApplying ? t("settings.environment.applying") : t("settings.environment.apply_button")}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>

      <EnvironmentApplyModal
        open={applyConfirmOpen}
        onCancel={() => setApplyConfirmOpen(false)}
        onSuccess={() => setApplyConfirmOpen(false)}
      />
    </>
  );
}

type EnvironmentItemsTableProps = {
  loading: boolean;
  items: EnvItem[];
  canEdit: boolean;
  onAdd: () => void;
  onEdit: (item: EnvItem) => void;
  onRevealValue: (item: EnvItem) => Promise<string>;
};

function EnvironmentItemsTable(props: EnvironmentItemsTableProps) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [revealing, setRevealing] = useState<Record<string, boolean>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<EnvItem | null>(null);
  const { isRemoving } = useEnvironmentVariableRemove();

  const toggleReveal = async (key: string) => {
    const item = props.items.find((entry) => entry.key === key);
    if (revealed[key] && typeof item?.value === "string") {
      setRevealed((current) => ({ ...current, [key]: false }));
      return;
    }
    if (!item) return;
    setRevealing((current) => ({ ...current, [key]: true }));
    try {
      await props.onRevealValue(item);
      setRevealed((current) => ({ ...current, [key]: true }));
    } catch (readError) {
      toast.error(readError instanceof Error ? readError.message : t("app.unknown_error"));
    } finally {
      setRevealing((current) => ({ ...current, [key]: false }));
    }
  };

  if (props.loading && props.items.length === 0) {
    return <EnvironmentVariableTableLoading />;
  }
  if (props.items.length === 0) {
    return <EnvironmentVariableTableEmpty canAdd={props.canEdit} onAdd={props.onAdd} />;
  }
  return (
    <>
      <EnvironmentVariableTable>
        <EnvironmentVariableTableHeader />
        <EnvironmentVariableTableBody>
          {props.items.map((item) => (
            <EnvironmentVariableTableItem
              key={item.key}
              item={item}
              isRevealed={Boolean(revealed[item.key]) && typeof item.value === "string"}
              canEdit={props.canEdit}
              deleting={isRemoving && deleteCandidate?.key === item.key}
              revealing={Boolean(revealing[item.key])}
              onEdit={props.onEdit}
              onToggleReveal={(key) => void toggleReveal(key)}
              onDelete={setDeleteCandidate}
            />
          ))}
        </EnvironmentVariableTableBody>
      </EnvironmentVariableTable>

      <EnvironmentDeleteModal
        candidate={deleteCandidate}
        onCancel={() => setDeleteCandidate(null)}
        onSuccess={() => setDeleteCandidate(null)}
      />
    </>
  );
}

type EnvironmentEditorModalProps = {
  editor: EnvironmentEditorDraft;
  onClose: () => void;
  onChange: (value: SetStateAction<EnvironmentEditorState>) => void;
};

type EnvironmentEditorFieldsProps = {
  editor: EnvironmentEditorDraft;
  onChange: (value: SetStateAction<EnvironmentEditorDraft>) => void;
  disabled?: boolean;
  error?: Error | null;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
};

export function EnvironmentEditorFields(props: EnvironmentEditorFieldsProps) {
  const keyFieldId = useId();
  const valueFieldId = useId();

  return (
    <FieldGroup>
      <Field data-invalid={props.error ? true : undefined}>
        <FieldLabel htmlFor={keyFieldId}>{t("settings.environment.key_label")}</FieldLabel>
        <Input
          id={keyFieldId}
          value={props.editor.key}
          onChange={(event) =>
            props.onChange((current) => ({ ...current, key: event.target.value }))
          }
          disabled={props.editor.mode === "edit" || props.disabled}
          placeholder={props.keyPlaceholder ?? "ANTHROPIC_API_KEY"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={props.error ? true : undefined}
        />
        <FieldDescription>{t("settings.environment.key_hint")}</FieldDescription>
      </Field>
      <Field data-invalid={props.error ? true : undefined}>
        <FieldLabel htmlFor={valueFieldId}>{t("settings.environment.value_label")}</FieldLabel>
        <Textarea
          id={valueFieldId}
          value={props.editor.value}
          onChange={(event) =>
            props.onChange((current) => ({ ...current, value: event.target.value }))
          }
          disabled={props.disabled}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder={props.valuePlaceholder}
          className="font-mono"
          aria-invalid={props.error ? true : undefined}
        />
        {props.error ? <FieldError>{props.error.message}</FieldError> : null}
      </Field>
    </FieldGroup>
  );
}

function EnvironmentEditorModal(props: EnvironmentEditorModalProps) {
  const { modifyAsync, isModifying, error } = useEnvironmentVariableModify();
  const titleId = useId();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isModifying) {
        props.onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModifying, props.onClose]);

  const submitEditor = () => {
    if (isModifying) {
      return;
    }

    void modifyAsync(props.editor, { onSuccess: props.onClose });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isModifying) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle id={titleId}>
            {props.editor.mode === "add" ? t("settings.environment.add_title") : t("settings.environment.edit_title")}
          </DialogTitle>
        </DialogHeader>

        <EnvironmentEditorFields
          editor={props.editor}
          onChange={(value) => {
            props.onChange((current) => {
              if (!current) return current;
              return typeof value === "function" ? value(current) : value;
            });
          }}
          disabled={isModifying}
          error={error}
        />

        <DialogFooter>
          <DialogClose
            disabled={isModifying}
            render={<Button variant="outline" size="sm" disabled={isModifying} />}
          >
            {t("settings.environment.cancel")}
          </DialogClose>
          <Button size="sm" onClick={submitEditor} disabled={isModifying}>
            {isModifying ? t("settings.environment.saving") : t("settings.environment.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type EnvironmentDeleteModalProps = {
  candidate: EnvironmentVariableItem | null;
  onCancel: () => void;
  onSuccess: () => void;
};

export function EnvironmentDeleteModal(props: EnvironmentDeleteModalProps) {
  const { removeAsync, isRemoving } = useEnvironmentVariableRemove();

  return (
    <ConfirmModal
      open={props.candidate !== null}
      title={t("settings.environment.delete_title")}
      message={
        props.candidate
          ? t("settings.environment.confirm_delete").replace("{key}", props.candidate.key)
          : ""
      }
      confirmLabel={
        isRemoving ? t("settings.environment.deleting") : t("settings.environment.delete")
      }
      cancelLabel={t("settings.environment.cancel")}
      variant="danger"
      confirmButtonVariant="destructive"
      onConfirm={() => {
        if (!props.candidate) {
          return;
        }
        
        void removeAsync(props.candidate.key, { onSuccess: props.onSuccess });
      }}
      onCancel={() => {
        if (!isRemoving) {
          props.onCancel();
        }
      }}
    />
  );
}

type EnvironmentApplyModalProps = {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
};

export function EnvironmentApplyModal(props: EnvironmentApplyModalProps) {
  const { applyAsync, isApplying } = useEnvironmentVariableApplyChanges();

  return (
    <ConfirmModal
      open={props.open}
      title={t("settings.environment.apply_title")}
      message={t("settings.environment.apply_confirm_body")}
      confirmLabel={
        isApplying ? t("settings.environment.applying") : t("settings.environment.apply_button")
      }
      cancelLabel={t("settings.environment.cancel")}
      variant="warning"
      onConfirm={() => {
        void applyAsync(undefined, { onSuccess: props.onSuccess });
      }}
      onCancel={() => {
        if (!isApplying) {
          props.onCancel();
        }
      }}
    />
  );
}
