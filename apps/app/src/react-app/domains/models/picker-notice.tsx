import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one notice row under the model list (Paper "Availability and recovery"): an alert icon, one or two
 * sentences, and at most one action. `error` is for a failed catalog load; everything else stays neutral (C5).
 */
export function PickerNotice({ tone = "neutral", role = "status", action, children, testId }: {
  tone?: "neutral" | "error";
  role?: "status" | "alert";
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return <div role={role} data-testid={testId} className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-sm">
    <CircleAlert aria-hidden="true" strokeWidth={1.5} className={cn("size-4 shrink-0", tone === "error" ? "text-red-9" : "text-muted-foreground")} />
    <span className="min-w-0 flex-1 text-pretty text-muted-foreground">{children}</span>
    {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
  </div>;
}
