/** @jsxImportSource react */
import { Check, ChevronRight, RefreshCcw, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { RemoteSessionPending } from "@openwork/types/automations";

import { ComposerApprovalActions, ComposerApprovalHeader, ComposerApprovalPanel } from "@/react-app/design-system/composer-approval-panel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { PendingPermission } from "@/app/types";

type PermissionPresentation = {
  title: string;
  message: string;
  permissionLabel: string;
  scopeLabel: string;
  scopeValue: string;
  isDoomLoop: boolean;
  note: string | null;
};

type PermissionDetail = {
  label: string;
  value: string;
  multiline?: boolean;
};

type PermissionApprovalModalProps = {
  busy?: boolean;
} & ({
  permission: PendingPermission;
  sourceTitle?: string;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject", remember?: "always") => void;
  safeStringify?: (value: unknown) => string;
} | {
  remotePermission: Extract<RemoteSessionPending, { kind: "permission" }>;
  computer: string;
  onDecision: (decision: "once" | "reject") => void;
});

const metadataDetailKeys: Array<{ key: string; labelKey: string; multiline?: boolean }> = [
  { key: "command", labelKey: "session.permission_detail_command", multiline: true },
  { key: "description", labelKey: "session.permission_detail_description" },
  { key: "cwd", labelKey: "session.permission_detail_cwd" },
  { key: "filepath", labelKey: "session.permission_detail_file" },
  { key: "filePath", labelKey: "session.permission_detail_file" },
  { key: "path", labelKey: "session.permission_detail_path" },
  { key: "target", labelKey: "session.permission_detail_target" },
  { key: "parentDir", labelKey: "session.permission_detail_parent_directory" },
  { key: "url", labelKey: "session.permission_detail_url" },
  { key: "query", labelKey: "session.permission_detail_query", multiline: true },
  { key: "subagent_type", labelKey: "session.permission_detail_agent" },
  { key: "tool", labelKey: "session.permission_detail_tool" },
  { key: "files", labelKey: "session.permission_detail_files", multiline: true },
  { key: "diff", labelKey: "session.permission_detail_diff", multiline: true },
];

export type FileSendPrompt = { kind: string; remember: Array<"session" | "always"> };

export function permissionFileSend(permission: PendingPermission): FileSendPrompt | null {
  const value = permission.metadata?.fileSend;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = "kind" in value && typeof value.kind === "string" ? value.kind : null;
  const remember = "remember" in value && Array.isArray(value.remember) ? value.remember : null;
  if (!kind || !remember) return null;
  return { kind, remember: remember.flatMap(item => item === "session" || item === "always" ? [item] : []) };
}

const fileSendTitleKeys: Record<string, string> = {
  drive_upload_file: "session.file_send_title_drive_upload",
  drive_push_file: "session.file_send_title_drive_push",
  gmail_create_draft_with_attachments: "session.file_send_title_gmail_draft",
  outlook_create_draft_with_attachments: "session.file_send_title_outlook_draft",
};

function fileSendScope(metadata: Record<string, unknown>): string {
  const paths = Array.isArray(metadata.paths) ? metadata.paths.filter(path => typeof path === "string") : [];
  const files = paths.length ? paths.join(", ") : typeof metadata.path === "string" ? metadata.path : "";
  return [files, metadata.target, metadata.connectionId].filter(value => typeof value === "string" && value.length > 0).join(" → ");
}

function readablePermissionLabel(permission: string): string {
  if (permission === "bash") return "Bash";
  if (permission === "drive_upload_file") return t("session.permission_kind_drive_upload");
  if (permission === "edit") return t("session.permission_kind_edit");
  if (permission === "read") return t("session.permission_kind_read");
  if (permission === "external_directory") return t("session.permission_kind_external_directory");
  if (permission === "task") return t("session.permission_kind_task");
  if (permission === "todowrite") return t("session.permission_kind_todowrite");
  if (permission === "question") return t("session.permission_kind_question");
  if (permission === "skill") return t("session.permission_kind_skill");
  return permission;
}

function permissionCopy(permission: string): Pick<PermissionPresentation, "title" | "message"> {
  if (permission === "drive_upload_file") {
    return { title: t("session.permission_title_drive_upload"), message: t("session.permission_message_drive_upload") };
  }
  if (permission === "bash") {
    return {
      title: t("session.permission_title_bash"),
      message: t("session.permission_message_bash"),
    };
  }
  if (permission === "edit") {
    return {
      title: t("session.permission_title_edit"),
      message: t("session.permission_message_edit"),
    };
  }
  if (permission === "read") {
    return {
      title: t("session.permission_title_read"),
      message: t("session.permission_message_read"),
    };
  }
  if (permission === "external_directory") {
    return {
      title: t("session.permission_title_external_directory"),
      message: t("session.permission_message_external_directory"),
    };
  }
  if (permission === "task") {
    return {
      title: t("session.permission_title_task"),
      message: t("session.permission_message_task"),
    };
  }
  return {
    title: t("session.permission_title_generic", undefined, { permission: readablePermissionLabel(permission) }),
    message: t("session.permission_message"),
  };
}

function fileChangeLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path =
    (typeof record.relativePath === "string" && record.relativePath.trim()) ||
    (typeof record.filePath === "string" && record.filePath.trim()) ||
    (typeof record.path === "string" && record.path.trim()) ||
    null;
  if (!path) return null;
  const type = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "change";
  return `${type}: ${path}`;
}

function metadataValue(key: string, value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (key === "files" && Array.isArray(value)) {
    const lines = value.flatMap((item) => {
      const line = fileChangeLine(item);
      return line ? [line] : [];
    });
    return lines.length ? lines.join("\n") : null;
  }
  return null;
}

export function permissionDetailRows(metadata: Record<string, unknown>): PermissionDetail[] {
  const seen = new Set<string>();
  const rows: PermissionDetail[] = [];
  for (const item of metadataDetailKeys) {
    if (seen.has(item.labelKey)) continue;
    const value = metadataValue(item.key, metadata[item.key]);
    if (!value) continue;
    seen.add(item.labelKey);
    rows.push({
      label: t(item.labelKey),
      value,
      multiline: item.multiline,
    });
  }
  return rows;
}

function stringifyMetadata(metadata: Record<string, unknown>, safeStringify?: (value: unknown) => string) {
  try {
    return safeStringify ? safeStringify(metadata) : JSON.stringify(metadata, null, 2);
  } catch {
    return t("session.permission_metadata_unavailable");
  }
}

function describePermissionRequest(permission: PendingPermission): PermissionPresentation {
  const patterns = permission.patterns.filter((pattern) => pattern.trim().length > 0);
  if (permission.permission === "doom_loop") {
    const tool =
      permission.metadata && typeof permission.metadata === "object" && typeof permission.metadata.tool === "string"
        ? permission.metadata.tool
        : null;

    return {
      title: t("session.doom_loop_title"),
      message: t("session.doom_loop_message"),
      permissionLabel: t("session.doom_loop_label"),
      scopeLabel: tool ? t("session.doom_loop_tool_label") : t("session.doom_loop_repeated_call_label"),
      scopeValue: tool ?? (patterns.length ? patterns.join(", ") : t("session.doom_loop_repeated_tool_call")),
      isDoomLoop: true,
      note: t("session.doom_loop_note"),
    };
  }

  const fileSend = permissionFileSend(permission);
  if (fileSend) {
    const titleKey = fileSendTitleKeys[fileSend.kind];
    return {
      title: titleKey ? t(titleKey) : t("session.file_send_title"),
      message: t("session.file_send_message"),
      permissionLabel: t("session.file_send_label"),
      scopeLabel: t("session.scope_label"),
      scopeValue: fileSendScope(permission.metadata ?? {}) || patterns[0] || t("session.permission_scope_empty"),
      isDoomLoop: false,
      note: fileSend.remember.includes("always") ? t("session.file_send_note_always")
        : fileSend.remember.includes("session") ? t("session.file_send_note_session")
        : t("session.file_send_note_once"),
    };
  }
  const copy = permissionCopy(permission.permission);
  const uploadPath = permission.permission === "drive_upload_file" && typeof permission.metadata?.path === "string"
    ? permission.metadata.path : null;
  return {
    title: copy.title,
    message: copy.message,
    permissionLabel: readablePermissionLabel(permission.permission),
    scopeLabel: t("session.scope_label"),
    scopeValue: uploadPath
      ? [uploadPath, permission.metadata?.target, permission.metadata?.connectionId].filter(value => typeof value === "string" && value.length > 0).join(" → ")
      : (patterns.join(", ") || t("session.permission_scope_empty")),
    isDoomLoop: false,
    note: uploadPath
      ? permissionCanRemember(permission) ? t("session.permission_drive_session_scope")
        : typeof permission.metadata?.connectionId !== "string" ? t("session.permission_drive_default_account") : null
      : null,
  };
}

export function permissionCanRemember(permission: PendingPermission): boolean {
  return Array.isArray(permission.always) && permission.always.some(value => typeof value === "string" && value.length > 0);
}

export function PermissionApprovalPanel(props: PermissionApprovalModalProps) {
  const local = "permission" in props ? props : null;
  const remote = "remotePermission" in props ? props : null;
  const permission = local?.permission;
  const fileSend = permission ? permissionFileSend(permission) : null;
  const canRemember = fileSend ? fileSend.remember.includes("session") : Boolean(permission && permissionCanRemember(permission));
  const canAlways = fileSend?.remember.includes("always") === true;
  const presentation = useMemo(() => permission ? describePermissionRequest(permission) : null, [permission]);
  const metadata = permission?.metadata ?? {};
  const hasMetadata = Object.keys(metadata).length > 0;
  const Icon = presentation?.isDoomLoop ? RefreshCcw : ShieldCheck;
  const respond = (decision: "once" | "reject") => {
    if (remote) remote.onDecision(decision);
    else if (local) local.respondPermission?.(local.permission.id, decision);
  };

  return (
    <ComposerApprovalPanel data-permission-approval="">
      <ComposerApprovalHeader stacked={canAlways} icon={<Icon size={16} strokeWidth={1.9} />}
        title={presentation?.title ?? remote?.remotePermission.title}
        actions={<ComposerApprovalActions disabled={props.busy || !(remote || local?.respondPermission)}
          onDeny={() => respond("reject")} onAllowOnce={() => respond("once")}>
            {canRemember ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => local?.respondPermission?.(local.permission.id, "always")}
                disabled={props.busy || !(remote || local?.respondPermission)}
              >
                <Check data-icon="inline-start" />
                {fileSend ? t("session.file_send_allow_chat") : t("session.allow_for_session")}
              </Button>
            ) : null}
            {canAlways ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => local?.respondPermission?.(local.permission.id, "always", "always")}
                disabled={props.busy || !(remote || local?.respondPermission)}
              >
                <ShieldCheck data-icon="inline-start" />
                {t("session.file_send_allow_always")}
              </Button>
            ) : null}
        </ComposerApprovalActions>}>
        <div>{presentation?.message ?? remote?.remotePermission.detail}</div>
              {local?.sourceTitle ? (
                <div
                  data-permission-source="child-session"
                  className="mt-1 text-[12px] font-medium leading-5 text-amber-11"
                >
                  {t("session.permission_requested_by", { session: local.sourceTitle })}
                </div>
              ) : null}
              {remote ? (
                <div className="mt-1 text-[12px] leading-5 text-dls-secondary">
                  {t("session.remote_answer_permission_on", { computer: remote.computer })}
                </div>
              ) : null}
              {presentation?.note ? (
                <div className="mt-1 text-[12px] leading-5 text-dls-secondary">{presentation.note}</div>
              ) : null}
      </ComposerApprovalHeader>

        {remote?.remotePermission.command ? (
          <pre className="mx-4 mb-3 max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-lg bg-dls-hover/45 px-3 py-2 text-[12px] leading-5 text-dls-text">{remote.remotePermission.command}</pre>
        ) : null}
        {presentation ? (
        <div className="border-t border-dls-border px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {t("session.permission_label")}
              </div>
              <div className="mt-1 font-mono text-[12px] leading-5 text-dls-text">
                {presentation.permissionLabel}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {presentation.scopeLabel}
              </div>
              <div title={presentation.scopeValue} className="mt-1 truncate rounded-lg border border-dls-border bg-dls-hover/55 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-dls-text">
                {presentation.scopeValue}
              </div>
            </div>
          </div>

          {hasMetadata ? (
            <details className="group mt-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12px] font-medium text-dls-text">
                <span>{t("session.details_label")}</span>
                <ChevronRight size={14} className="text-dls-secondary transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-dls-hover/45 px-3 py-2 text-[11px] leading-5 text-dls-secondary">
                {stringifyMetadata(metadata, local?.safeStringify)}
              </pre>
            </details>
          ) : null}
        </div>
        ) : null}
    </ComposerApprovalPanel>
  );
}
