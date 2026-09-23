/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Minus, X } from "lucide-react";

import type { McpServerCheck, McpServerCheckId, McpServerCheckStatus } from "../../../../app/lib/den-mcp-discovery";
import { t } from "../../../../i18n";
import { cn } from "@/lib/utils";

const PENDING_ROWS: McpServerCheckId[] = ["reach", "protocol", "sign-in", "registration", "tools"];
const TICK_MS = 160;

function checkTitle(id: McpServerCheckId) {
  switch (id) {
    case "reach":
      return t("extensions.mcp_check_reach");
    case "protocol":
      return t("extensions.mcp_check_protocol");
    case "sign-in":
      return t("extensions.mcp_check_sign_in");
    case "registration":
      return t("extensions.mcp_check_registration");
    case "tools":
      return t("extensions.mcp_check_tools");
  }
}

function StatusMark(props: { status: McpServerCheckStatus | "pending" }) {
  const base = "flex size-5 shrink-0 items-center justify-center rounded-full transition-colors duration-200";
  switch (props.status) {
    case "pending":
      return <span className={cn(base, "text-dls-secondary")}><Loader2 size={14} className="animate-spin" /></span>;
    case "pass":
      return <span className={cn(base, "bg-emerald-600 text-white motion-safe:animate-in motion-safe:zoom-in-50")}><Check size={12} strokeWidth={3} /></span>;
    case "warn":
      return <span className={cn(base, "bg-dls-hover text-dls-text")}><AlertTriangle size={11} strokeWidth={2.5} /></span>;
    case "fail":
      return <span className={cn(base, "bg-red-3 text-red-11")}><X size={12} strokeWidth={3} /></span>;
    case "skip":
      return <span className={cn(base, "bg-dls-hover text-dls-secondary")}><Minus size={12} strokeWidth={3} /></span>;
  }
}

/**
 * The checks Den runs on an MCP server before it is added, ticked off one at
 * a time. `checks` is null while Den is still looking.
 */
export function McpServerCheckList(props: { checks: McpServerCheck[] | null; onSettled?: () => void }) {
  const [shown, setShown] = useState(0);
  const checks = props.checks;
  const onSettled = useRef(props.onSettled);
  onSettled.current = props.onSettled;

  useEffect(() => {
    setShown(0);
    if (!checks) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      setShown(count);
      if (count >= checks.length) {
        window.clearInterval(timer);
        onSettled.current?.();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [checks]);

  const rows = checks
    ? checks.map((check, index) => ({ id: check.id, check: index < shown ? check : null }))
    : PENDING_ROWS.map((id) => ({ id, check: null }));

  return (
    <ul className="flex flex-col" data-testid="mcp-server-checks" aria-live="polite">
      {rows.map(({ id, check }) => (
        <li
          key={id}
          data-mcp-check={id}
          data-mcp-check-status={check?.status ?? "pending"}
          className="flex items-start gap-3 border-t border-dls-border py-3 first:border-t-0"
        >
          <StatusMark status={check?.status ?? "pending"} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-dls-text">{checkTitle(id)}</span>
            <span className={cn("block text-[13px] leading-[18px]", check?.status === "fail" ? "text-red-11" : "text-dls-secondary")}>
              {check ? check.detail : t("extensions.mcp_check_pending")}
            </span>
          </span>
          {check?.term ? (
            <span className="shrink-0 text-[12px] leading-5 text-dls-secondary">{check.term}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
