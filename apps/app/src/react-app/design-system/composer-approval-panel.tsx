import type { ReactNode } from "react";
import { Clock3, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function ComposerApprovalPanel({ children, ...props }: { children: ReactNode } & React.ComponentProps<"div">) {
  return <div className="overflow-hidden border-b border-dls-border bg-transparent" {...props}>{children}</div>;
}

export function ComposerApprovalHeader({ icon, title, children, actions, stacked }: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  stacked?: boolean;
}) {
  return <div className={`flex flex-col gap-3 px-4 py-3 ${stacked ? "" : "sm:flex-row sm:items-center sm:justify-between"}`}>
    <div className="flex min-w-0 items-start gap-3">
      <div aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5 text-dls-text">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-dls-secondary">{children}</div>
      </div>
    </div>
    <div className={`flex shrink-0 flex-wrap items-center gap-2 ${stacked ? "" : "sm:justify-end"}`}>{actions}</div>
  </div>;
}

export function ComposerApprovalActions({ disabled, onDeny, onAllowOnce, children }: {
  disabled?: boolean;
  onDeny: () => void;
  onAllowOnce: () => void;
  children?: ReactNode;
}) {
  return <>
    <Button type="button" variant="outline" size="sm" className="border-red-7/25 text-red-11 hover:bg-red-1/40" onClick={onDeny} disabled={disabled}>
      <XCircle data-icon="inline-start" strokeWidth={1.5} />
      {t("session.deny")}
    </Button>
    <Button type="button" size="sm" onClick={onAllowOnce} disabled={disabled}>
      <Clock3 data-icon="inline-start" strokeWidth={1.5} />
      {t("session.allow_once")}
    </Button>
    {children}
  </>;
}
