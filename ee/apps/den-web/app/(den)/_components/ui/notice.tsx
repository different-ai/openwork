import { CircleAlert, Info } from "lucide-react";

type DenNoticeTone = "error" | "info";

const ROUTINE_SECURITY_MESSAGES = new Set([
  "For security, confirm it's you before changing workspace settings.",
  "Confirm it's you before continuing.",
]);

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
  const Icon = resolvedTone === "info" ? Info : CircleAlert;

  return (
    <div
      role={resolvedTone === "error" ? "alert" : "status"}
      data-notice-tone={resolvedTone}
      className={[
        "flex items-start gap-3 rounded-[24px] border px-5 py-4 text-[14px]",
        resolvedTone === "info"
          ? "border-sky-200 bg-sky-50 text-slate-700"
          : "border-red-200 bg-red-50 text-red-700",
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
