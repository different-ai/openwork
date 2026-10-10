import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { WORKSPACE_REAUTH_SECURITY_MESSAGE } from "../../_lib/den-flow";

export type DenNoticeTone = "error" | "info" | "warning" | "neutral";

const ROUTINE_SECURITY_MESSAGES = new Set([
  WORKSPACE_REAUTH_SECURITY_MESSAGE,
]);

const toneClasses: Record<DenNoticeTone, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  info: "border-sky-200 bg-sky-50 text-slate-700",
  warning: "border-[var(--dls-border)] bg-[var(--dls-hover)] text-[var(--dls-text-primary)]",
  neutral: "border-gray-200 bg-gray-50 text-gray-600",
};

const toneIcons: Record<DenNoticeTone, LucideIcon> = {
  error: CircleAlert,
  info: Info,
  warning: TriangleAlert,
  neutral: Info,
};

export function DenNotice({
  message,
  tone,
  className,
  icon,
  presentation = "panel",
  action,
}: {
  message: ReactNode;
  action?: ReactNode;
  /** Inline notices share their containing surface instead of adding a tinted panel. */
  presentation?: "panel" | "inline";
  tone?: DenNoticeTone;
  className?: string;
  icon?: LucideIcon | null;
}) {
  const resolvedTone =
    tone ?? (typeof message === "string" && ROUTINE_SECURITY_MESSAGES.has(message) ? "info" : "error");
  const Icon = icon === null ? null : icon ?? toneIcons[resolvedTone];

  return (
    <div
      role={resolvedTone === "error" ? "alert" : "status"}
      data-notice-tone={resolvedTone}
      className={[
        presentation === "inline"
          ? "flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] leading-4.5 text-gray-600"
          : `flex items-start gap-3 rounded-[24px] border px-5 py-4 text-[14px] ${toneClasses[resolvedTone]}`,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon ? <Icon className={`mt-0.5 size-4 shrink-0 ${resolvedTone === "warning" ? "text-[var(--ow-warning)]" : ""}`} aria-hidden="true" /> : null}
      <span className={action ? "min-w-0 flex-1" : undefined}>{message}</span>
      {/* Inline actions keep their hit area without increasing the text row's height. */}
      {action ? <span className={`flex shrink-0 items-center ${presentation === "inline" ? "-my-2" : ""}`}>{action}</span> : null}
    </div>
  );
}
