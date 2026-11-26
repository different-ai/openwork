import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type Decision = "deny" | "allow_once" | "always_allow";

const ORDER: readonly Decision[] = ["deny", "always_allow", "allow_once"];

export function ToolApprovalCard({ title, line, decisions, busy, onDecide, children, turnOn, variant = "card", ...hooks }: {
  variant?: "card" | "inline" | "placeholder";
  title: string;
  line: string;
  decisions: readonly Decision[];
  busy: boolean;
  onDecide: (decision: Decision) => void;
  children?: ReactNode;
  turnOn?: { label: string; run: () => void };
  "data-agent-ask"?: string;
  "data-tool-approval"?: string;
}) {
  const agent = hooks["data-agent-ask"] !== undefined;
  const placeholder = variant === "placeholder";
  return (
    <div {...hooks} aria-busy={busy} inert={placeholder} className={variant === "card"
      ? "w-full max-w-xl rounded-2xl border border-dls-border bg-dls-surface p-4"
      : `w-full border-t border-dls-border py-3 ${placeholder ? "invisible" : ""}`}>
      <p className="wrap-anywhere text-sm font-medium text-dls-text">{title}</p>
      <p className="mt-1 text-xs text-dls-secondary">{line}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {ORDER.filter((choice) => decisions.includes(choice)).map((choice) => (
          <Button key={choice} type="button" size="sm"
            variant={choice === "deny" ? "ghost" : choice === "always_allow" ? "outline" : "default"}
            data-agent-ask-decision={agent ? choice : undefined}
            data-tool-approval-decision={agent || placeholder ? undefined : choice}
            disabled={busy} onClick={() => onDecide(choice)}>
            {choice === "deny" ? t("agents.permission_ask_deny") : choice === "always_allow" ? t("agents.permission_ask_always") : t("agents.permission_ask_once")}
          </Button>
        ))}
        {turnOn && <Button type="button" size="sm" variant="outline" data-agent-ask-decision="turn_on" disabled={busy} onClick={turnOn.run}>{turnOn.label}</Button>}
      </div>
      {children}
    </div>
  );
}
