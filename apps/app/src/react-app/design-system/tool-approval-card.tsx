import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type Decision = "deny" | "allow_once" | "always_allow";

const ORDER: readonly Decision[] = ["deny", "always_allow", "allow_once"];

export function ToolApprovalCard({ title, line, decisions, busy, onDecide, children, turnOn, chooseTools, icon, eyebrow, tag, details, variant = "card", ...hooks }: {
  variant?: "card" | "inline" | "placeholder" | "dock" | "composer";
  title: string;
  line?: string;
  decisions: readonly Decision[];
  busy: boolean;
  onDecide: (decision: Decision) => void;
  children?: ReactNode;
  turnOn?: { label: string; run: () => void };
  chooseTools?: { label: string; run: () => void };
  icon?: ReactNode;
  eyebrow?: string;
  tag?: string;
  details?: { label: string; run: () => void };
  "data-agent-ask"?: string;
  "data-tool-approval"?: string;
}) {
  const agent = hooks["data-agent-ask"] !== undefined;
  const placeholder = variant === "placeholder";
  const dock = variant === "dock";
  const actions = <>
    {ORDER.filter((choice) => decisions.includes(choice)).map((choice) => (
      <Button key={choice} type="button" size="sm"
        variant={choice === "deny" ? "ghost" : choice === "always_allow" ? "outline" : "default"}
        data-agent-ask-decision={agent ? choice : undefined}
        data-tool-approval-decision={agent || placeholder ? undefined : choice}
        disabled={busy} onClick={() => onDecide(choice)}>
        {choice === "deny" ? t("agents.permission_ask_deny") : choice === "always_allow" ? t("agents.permission_ask_always") : t("agents.permission_ask_once")}
      </Button>
    ))}
    {chooseTools && <Button type="button" size="sm" variant="default" data-agent-ask-choose-tools disabled={busy} onClick={chooseTools.run}>{chooseTools.label}</Button>}
  </>;
  if (variant === "composer") return (
    <div {...hooks} aria-busy={busy} className="flex flex-col gap-3 border-b border-dls-border py-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon ?? <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-secondary">
          <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.9} />
        </div>}
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="text-[12px] leading-4 text-dls-secondary">{eyebrow}</p>}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="wrap-anywhere text-[14px] font-medium leading-5 text-dls-text">{title}</span>
            {tag && <span data-tool-approval-tag className="rounded-full border border-dls-border px-1.5 text-[11px] leading-4 text-dls-secondary">{tag}</span>}
          </p>
          {line && <p className="mt-1 text-[12px] leading-5 text-dls-secondary">{line}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
        <div className="me-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {details && <Button type="button" size="sm" variant="link" className="h-auto p-0 text-[12px] text-dls-secondary" data-agent-ask-details disabled={busy} onClick={details.run}>{details.label}</Button>}
          {turnOn && <Button type="button" size="sm" variant="link" className="h-auto p-0 text-[12px] text-dls-secondary" data-agent-ask-decision="turn_on" disabled={busy} onClick={turnOn.run}>{turnOn.label}</Button>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
  return (
    <div {...hooks} aria-busy={busy} inert={placeholder} className={variant === "card"
      ? "w-full max-w-xl rounded-2xl border border-dls-border bg-dls-surface p-4"
      : dock ? "flex flex-wrap items-center justify-between gap-3 border-b border-dls-border px-4 py-3"
        : `w-full border-t border-dls-border py-3 ${placeholder ? "invisible" : ""}`}>
      <p className={dock ? "min-w-0 flex-[1_1_16rem] wrap-anywhere text-sm text-dls-text" : "wrap-anywhere text-sm font-medium text-dls-text"}>{title}</p>
      {line && <p className="mt-1 text-xs text-dls-secondary">{line}</p>}
      <div className={dock ? "ml-auto flex flex-wrap justify-end gap-2" : "mt-3 flex flex-wrap justify-end gap-2"}>
        {actions}
        {turnOn && <Button type="button" size="sm" variant="outline" data-agent-ask-decision="turn_on" disabled={busy} onClick={turnOn.run}>{turnOn.label}</Button>}
      </div>
      {children}
    </div>
  );
}
