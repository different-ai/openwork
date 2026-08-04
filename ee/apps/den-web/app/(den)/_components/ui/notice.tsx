import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { WORKSPACE_REAUTH_SECURITY_MESSAGE } from "../../_lib/den-flow";

export type DenNoticeTone = "error" | "info" | "warning" | "neutral";

const ROUTINE_SECURITY_MESSAGES = new Set([
  WORKSPACE_REAUTH_SECURITY_MESSAGE,
]);

const toneClasses: Record<DenNoticeTone, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  info: "border-sky-200 bg-sky-50 text-slate-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
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
}: {
  message: string;
  tone?: DenNoticeTone;
  className?: string;
}) {
  const resolvedTone =
    tone ?? (ROUTINE_SECURITY_MESSAGES.has(message) ? "info" : "error");
  const Icon = toneIcons[resolvedTone];

  return (
    <div
      role={resolvedTone === "error" ? "alert" : "status"}
      data-notice-tone={resolvedTone}
      className={[
        "flex items-start gap-3 rounded-[24px] border px-5 py-4 text-[14px]",
        toneClasses[resolvedTone],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
