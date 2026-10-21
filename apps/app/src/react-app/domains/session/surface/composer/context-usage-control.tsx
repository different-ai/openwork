import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { readContextBasis, writeContextBasis } from "./context-basis-memory";
import {
  formatShare,
  rowShare,
  rowsForBasis,
  type BasisMode,
  type BreakdownRow,
  type BreakdownRowId,
  type ContextBreakdown,
} from "./context-breakdown";
import { formatTokens, type ContextTone, type ContextUsage } from "./context-usage";

const TONE_CLASSES: Record<ContextTone, { label: string; ring: string }> = {
  neutral: { label: "text-muted-foreground hover:text-foreground", ring: "text-muted-foreground" },
  warning: { label: "text-amber-11", ring: "text-amber-10" },
  strong: { label: "font-medium text-amber-12", ring: "text-amber-11" },
};

// Category colours stay clear of amber, which belongs to the fill-level indicator.
const ROW_COLORS: Record<BreakdownRowId, string> = {
  messages: "bg-blue-9",
  activeSkills: "bg-cyan-9",
  skills: "bg-violet-9",
  tools: "bg-green-9",
  mcpTools: "bg-green-9",
  system: "bg-slate-9",
  buffer: "bg-slate-6",
  free: "bg-slate-3",
};

const ROW_LABEL_KEYS: Record<BreakdownRowId, string> = {
  messages: "composer.context_row_messages",
  activeSkills: "composer.context_row_active_skills",
  skills: "composer.context_row_skills",
  tools: "composer.context_row_tools",
  mcpTools: "composer.context_row_mcp_tools",
  system: "composer.context_row_system",
  buffer: "composer.context_row_buffer",
  free: "composer.context_row_free",
};

const RING_RADIUS = 5.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function UsageRing(props: { percent: number | null; className: string }) {
  const filled = props.percent === null ? 0 : (RING_LENGTH * props.percent) / 100;
  return (
    <svg viewBox="0 0 14 14" className={`size-3.5 shrink-0 -rotate-90 ${props.className}`} aria-hidden="true">
      <circle cx="7" cy="7" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      {filled > 0 ? (
        <circle cx="7" cy="7" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${filled} ${RING_LENGTH}`} />
      ) : null}
    </svg>
  );
}

export type ContextBreakdownSource = {
  /** Identifies the inputs of the breakdown, so a new reply or model reloads it. */
  queryKey: readonly unknown[];
  load: () => Promise<ContextBreakdown>;
};

function BasisSwitch(props: { basis: BasisMode; onChange: (basis: BasisMode) => void }) {
  const option = (value: BasisMode, label: string) => (
    <button
      type="button"
      aria-pressed={props.basis === value}
      data-basis={value}
      onClick={() => props.onChange(value)}
      className={`rounded-md px-2 py-0.5 text-xs ${props.basis === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("composer.context_basis_label")} className="flex items-center gap-0.5">
      {option("window", t("composer.context_basis_window"))}
      {option("occupied", t("composer.context_basis_occupied"))}
    </div>
  );
}

function BreakdownRows(props: { breakdown: ContextBreakdown; basis: BasisMode }) {
  const { breakdown } = props;
  const basis: BasisMode = breakdown.window === null ? "occupied" : props.basis;
  const rows = rowsForBasis(breakdown, basis);
  const base = basis === "occupied" ? breakdown.used : breakdown.window ?? breakdown.used;
  const share = (row: BreakdownRow) => rowShare(row, breakdown, basis);
  return (
    <>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted" aria-hidden="true" data-testid="composer-context-bar">
        {rows.filter((row) => row.tokens > 0).map((row) => (
          <span key={row.id} className={`h-full ${ROW_COLORS[row.id]}`} style={{ width: `${base > 0 ? (row.tokens / base) * 100 : 0}%` }} />
        ))}
      </div>
      <ul className="flex flex-col gap-1" data-testid="composer-context-rows" data-basis={basis}>
        {rows.map((row) => {
          const value = share(row);
          return (
            <li key={row.id} data-row={row.id} className="flex items-center gap-2 text-sm">
              {/* Free space is the colour of the empty track; a hairline keeps its dot visible in the dark theme. */}
              <span className={`size-2 shrink-0 rounded-full ${ROW_COLORS[row.id]}${row.id === "free" ? " ring-1 ring-border" : ""}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {t(ROW_LABEL_KEYS[row.id])}
                {row.partial ? <span className="ml-1 text-xs text-muted-foreground">{t("composer.context_row_partial")}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{row.estimated ? "≈" : ""}{formatTokens(row.tokens)}</span>
              <span className="w-14 shrink-0 text-right tabular-nums text-foreground">{value === null ? "" : formatShare(value)}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function BreakdownSection(props: { source: ContextBreakdownSource; basis: BasisMode }) {
  const query = useQuery({
    queryKey: props.source.queryKey,
    queryFn: props.source.load,
    staleTime: 0,
    retry: false,
  });
  if (query.data) return <BreakdownRows breakdown={query.data} basis={props.basis} />;
  if (query.isError) return <p className="text-sm text-muted-foreground">{t("composer.context_breakdown_unavailable")}</p>;
  // Keep the layout of the loaded state while it loads.
  return (
    <div className="flex flex-col gap-2" aria-busy="true" data-testid="composer-context-loading">
      <div className="h-2 w-full animate-pulse rounded-full bg-muted" />
      {[0, 1, 2].map((index) => <div key={index} className="h-4 w-full animate-pulse rounded bg-muted" />)}
    </div>
  );
}

/**
 * Context indicator of the composer: how full the model's context window is.
 * Neutral while there is room, amber as it fills (DESIGN.md V2: colour marks
 * the part that needs attention; C5: a limit is not an error, so no red). The
 * colour never stands alone: the ring fills with it, and the numbers and the
 * compaction hint are text. The popover breaks the measured total down by
 * category; those rows are estimates, and the rest stays in "system and other".
 */
export function ContextUsageControl(props: { usage: ContextUsage; breakdown?: ContextBreakdownSource }) {
  const { usage } = props;
  const [basis, setBasis] = useState<BasisMode>(readContextBasis);
  const tone = TONE_CLASSES[usage.tone];
  const label = usage.percent === null
    ? t("composer.context_usage_tokens", { tokens: formatTokens(usage.used) })
    : t("composer.context_usage_percent", { percent: usage.percent });
  // A narrow composer keeps the ring and the number, without the word.
  const shortLabel = usage.percent === null ? formatTokens(usage.used) : `${usage.percent}%`;
  const detail = usage.window === null
    ? t("composer.context_usage_detail_unknown_window", { used: formatTokens(usage.used) })
    : t("composer.context_usage_detail", { used: formatTokens(usage.used), window: formatTokens(usage.window) });
  const hint = usage.hint === "soon" ? t("composer.context_hint_soon") : null;
  const changeBasis = (next: BasisMode) => {
    setBasis(next);
    writeContextBasis(next);
  };

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        data-testid="composer-context-trigger"
        data-tone={usage.tone}
        aria-label={`${label}, ${detail}`}
        className={`inline-flex h-9 shrink-0 items-center gap-1.5 px-1.5 text-sm @min-[480px]/composer:px-2.5 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring ${tone.label}`}
      >
        <UsageRing percent={usage.percent} className={tone.ring} />
        <span>
          <span className="hidden @min-[480px]/composer:inline">{label}</span>
          <span className="@min-[480px]/composer:hidden">{shortLabel}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        data-testid="composer-context-details"
        className="max-h-[min(var(--available-height),28rem)] w-80 max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3"
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{detail}</p>
          {hint ? <p className="text-sm font-medium text-amber-11">{hint}</p> : null}
        </div>
        {props.breakdown ? <BreakdownSection source={props.breakdown} basis={basis} /> : null}
        {props.breakdown && usage.window !== null ? <BasisSwitch basis={basis} onChange={changeBasis} /> : null}
        <p className="text-xs text-muted-foreground">{t("composer.context_footer")}</p>
      </PopoverContent>
    </Popover>
  );
}
