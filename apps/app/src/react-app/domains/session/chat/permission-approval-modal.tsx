/** @jsxImportSource react */
import { Check, ChevronRight, Clock3, HardDrive, RefreshCcw, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import { t } from "../../../../i18n";
import type { PendingPermission } from "../../../../app/types";
import { Button } from "../../../design-system/button";

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
  permission: PendingPermission;
  busy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  safeStringify?: (value: unknown) => string;
};

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

function readablePermissionLabel(permission: string): string {
  if (permission === "bash") return "Bash";
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

function isFocusableElement(element: HTMLElement) {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
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

  const copy = permissionCopy(permission.permission);
  return {
    title: copy.title,
    message: copy.message,
    permissionLabel: readablePermissionLabel(permission.permission),
    scopeLabel: t("session.scope_label"),
    scopeValue: patterns.join(", ") || t("session.permission_scope_empty"),
    isDoomLoop: false,
    note: null,
  };
}

export function PermissionApprovalModal(props: PermissionApprovalModalProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const presentation = useMemo(() => describePermissionRequest(props.permission), [props.permission]);
  const metadata =
    props.permission.metadata && typeof props.permission.metadata === "object"
      ? props.permission.metadata
      : {};
  const hasMetadata = Object.keys(metadata).length > 0;
  const detailRows = permissionDetailRows(metadata);
  const Icon = presentation.isDoomLoop ? RefreshCcw : ShieldCheck;
  const iconClass = presentation.isDoomLoop
    ? "bg-amber-3/30 text-amber-11"
    : "bg-[rgba(var(--dls-accent-rgb),0.1)] text-dls-accent";

  useEffect(() => {
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      previousActiveElementRef.current?.focus({ preventScroll: true });
    };
  }, [props.permission.id]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.respondPermission?.(props.permission.id, "reject");
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(isFocusableElement);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[6px]">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-approval-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-[560px] overflow-hidden rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)] animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="border-b border-dls-border px-6 py-5">
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${iconClass}`}>
              <Icon size={23} strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="permission-approval-title" className="text-[20px] font-semibold tracking-[-0.3px] text-dls-text">
                {presentation.title}
              </h3>
              <p className="mt-1.5 text-[14px] leading-6 text-dls-secondary">
                {presentation.message}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div className="rounded-[20px] border border-dls-border bg-dls-hover/45 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
              {t("session.permission_label")}
            </div>
            <div className="mt-2 font-mono text-[14px] leading-6 text-dls-text">
              {presentation.permissionLabel}
            </div>
            {presentation.note ? (
              <p className="mt-2 text-[13px] leading-5 text-dls-secondary">
                {presentation.note}
              </p>
            ) : null}
          </div>

          <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
              <HardDrive size={13} />
              {presentation.scopeLabel}
            </div>
            <div className="mt-3 rounded-2xl border border-dls-border bg-dls-hover/55 px-3.5 py-3 font-mono text-[13px] leading-6 text-dls-text">
              <span className="block break-all">{presentation.scopeValue}</span>
            </div>
          </div>

          {detailRows.length > 0 ? (
            <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {t("session.permission_review_label")}
              </div>
              <div className="mt-3 space-y-3">
                {detailRows.map((row) => (
                  <div key={row.label}>
                    <div className="text-[12px] font-medium text-dls-secondary">{row.label}</div>
                    <div
                      className={`mt-1 rounded-xl border border-dls-border bg-dls-hover/55 px-3 py-2 font-mono text-[12px] leading-5 text-dls-text ${
                        row.multiline ? "max-h-44 overflow-auto whitespace-pre-wrap" : "break-all"
                      }`}
                    >
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {hasMetadata ? (
            <details className="group rounded-[18px] border border-dls-border bg-dls-surface px-4 py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-dls-text">
                <span>{t("session.details_label")}</span>
                <ChevronRight size={15} className="text-dls-secondary transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover/45 px-3 py-2.5 text-[12px] leading-5 text-dls-secondary">
                {stringifyMetadata(metadata, props.safeStringify)}
              </pre>
            </details>
          ) : null}
        </div>

        <div className="border-t border-dls-border bg-dls-hover/30 px-6 py-5">
          <p className="mb-4 text-[12px] leading-5 text-dls-secondary">
            {t("session.permission_decision_hint")}
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_auto_auto]">
            <Button
              variant="outline"
              className="justify-center rounded-full border-red-6/35 bg-red-2/20 text-red-11 hover:bg-red-3/30 sm:justify-self-start"
              onClick={() => props.respondPermission?.(props.permission.id, "reject")}
              disabled={props.busy || !props.respondPermission}
            >
              <XCircle size={16} />
              {t("session.deny")}
            </Button>
            <Button
              variant="primary"
              className="rounded-full"
              onClick={() => props.respondPermission?.(props.permission.id, "once")}
              disabled={props.busy || !props.respondPermission}
            >
              <Clock3 size={16} />
              {t("session.allow_once")}
            </Button>
            <Button
              variant="outline"
              className="rounded-full bg-dls-surface"
              onClick={() => props.respondPermission?.(props.permission.id, "always")}
              disabled={props.busy || !props.respondPermission}
            >
              <Check size={16} />
              {t("session.allow_for_session")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
