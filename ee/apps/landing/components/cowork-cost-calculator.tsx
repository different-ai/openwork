"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import {
  anthropicPricingCheckedAt,
  cumulativeCosts,
  defaultMixShare,
  describeEnterpriseVolumeTiers,
  mixShares,
  perPersonMonthly,
  planPrices,
  pricingSources,
  usageProfileIds,
  usageProfiles,
  type CostSeries,
  type MixShare,
  type Tier,
  type UsageProfileId
} from "../lib/cowork-cost";
import { modelPrices, modelPricesFetchedAt, type ModelPrice } from "../lib/model-prices";
import { BrandLogo } from "./lp-brand-logos";
import { LpSectionHeader } from "./lp-primitives";

type Props = {
  defaultUsers?: number;
  defaultTier?: Tier;
  heading?: string;
};

type Years = 1 | 3;

const claudeModels = modelPrices.filter((model) => model.claude);
const openModels = modelPrices.filter((model) => !model.claude);
const fallbackModel = modelPrices[0];
const sliderMax = 1000;

const profileLabels: Record<UsageProfileId, string> = { light: "Light", typical: "Typical", heavy: "Heavy" };

function findModel(models: ModelPrice[], id: string): ModelPrice {
  return models.find((model) => model.id === id) ?? models[0] ?? fallbackModel;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1
});
const count = new Intl.NumberFormat("en-US");

function shortDollars(value: number): string {
  return value >= 10_000 ? compactDollars.format(value) : dollars.format(value);
}

function periodLabel(years: Years): string {
  return years === 1 ? "1 year" : "3 years";
}

const brandByProvider: Record<string, "claude" | "openai" | "gemini" | "mistral"> = {
  anthropic: "claude",
  openai: "openai",
  google: "gemini",
  mistral: "mistral"
};

function ProviderMark({ model }: { model: ModelPrice }) {
  const brand = brandByProvider[model.provider];
  if (brand) return <BrandLogo name={brand} className="h-4 w-4 text-[var(--lp-ink)]" />;
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--lp-ink)] text-[9px] font-semibold text-[var(--lp-page)]"
    >
      {model.providerName.charAt(0)}
    </span>
  );
}

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)]";

function ModelSelect({
  id,
  label,
  models,
  value,
  onChange,
  compact = false,
  muted = false
}: {
  id: string;
  label: string;
  models: ModelPrice[];
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  muted?: boolean;
}) {
  const providers = Array.from(new Set(models.map((model) => model.providerName)));
  const select = (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
        <ProviderMark model={findModel(models, value)} />
      </span>
      <select
        id={id}
        value={value}
        aria-label={compact ? label : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full appearance-none bg-[var(--lp-page)] pl-9 pr-9 text-[var(--lp-ink)] shadow-[0_0_0_1px_var(--lp-border)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--lp-muted)] ${focusRing} ${
          compact ? "h-9 rounded-[10px] text-[13px]" : "h-11 rounded-[12px] text-[14px] font-medium"
        } ${muted ? "opacity-60" : ""}`}
      >
        {providers.map((provider) => (
          <optgroup key={provider} label={provider}>
            {models
              .filter((model) => model.providerName === provider)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.5}
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--lp-muted)]"
      />
    </div>
  );
  if (compact) return select;
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] text-[var(--lp-muted)]">
        {label}
      </label>
      <div className="mt-2">{select}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  name,
  legend,
  options,
  value,
  onChange,
  hideLegend = false
}: {
  name: string;
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  hideLegend?: boolean;
}) {
  return (
    <fieldset>
      <legend className={hideLegend ? "sr-only" : "text-[13px] text-[var(--lp-muted)]"}>{legend}</legend>
      <div
        className={`grid h-11 rounded-[12px] bg-[var(--lp-page)] p-1 shadow-[0_0_0_1px_var(--lp-border)] ${hideLegend ? "" : "mt-2"}`}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <label
            key={String(option.value)}
            className="flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[8px] px-3 text-[13px] text-[var(--lp-body)] transition-colors duration-150 has-[:checked]:bg-[var(--lp-ink)] has-[:checked]:font-medium has-[:checked]:text-[var(--lp-page)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--lp-ink)]"
          >
            <input
              type="radio"
              name={name}
              value={String(option.value)}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type LinePattern = "solid" | "dashed" | "dotted";

type ChartLine = {
  key: string;
  /** Vendor and model, e.g. "OpenWork · Claude Sonnet 5". */
  label: string;
  series: CostSeries;
  stroke: string;
  width: number;
  pattern: LinePattern;
  /** Stroke opacity; lighter lines stay at or above 3:1 against the panel. */
  opacity: number;
};

const dashArray: Record<LinePattern, string | undefined> = { solid: undefined, dashed: "7 5", dotted: "1.5 4.5" };

// OpenWork is drawn in the landing accent, Claude in neutral gray (DESIGN.md V2).
const accent = "var(--lp-blue)";
const claudeGray = "var(--lp-muted)";

function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(Math.round(next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function monthLabel(month: number): string {
  if (month === 0) return "Today";
  if (month % 12 === 0) return month === 12 ? "Year 1" : `Year ${month / 12}`;
  return `Month ${month}`;
}

function CostChart({
  lines,
  months,
  shade,
  label
}: {
  lines: ChartLine[];
  months: number;
  shade: { from: CostSeries; to: CostSeries };
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(880);
  const [active, setActive] = useState<number | null>(null);
  const wide = width >= 720;
  const height = wide ? 320 : 220;
  const labelGap = 12;
  const pad = { left: 2, right: wide ? 250 : 6, top: 16, bottom: 26 };
  const plotWidth = Math.max(10, width - pad.left - pad.right);
  const plotHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...lines.map((line) => line.series.total)) * 1.06;
  const x = (month: number) => pad.left + (plotWidth * month) / months;
  const y = (value: number) => pad.top + plotHeight - (plotHeight * value) / max;
  const path = (series: CostSeries) =>
    series.points.map((value, month) => `${month === 0 ? "M" : "L"}${x(month).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const shadePath = `${path(shade.from)} ${shade.to.points
    .map((value, month) => ({ value, month }))
    .reverse()
    .map(({ value, month }) => `L${x(month).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ")} Z`;
  const shadeSaving = shade.to.total <= shade.from.total;
  const tickStep = months >= 24 ? 12 : 3;
  const ticks = Array.from({ length: Math.floor(months / tickStep) + 1 }, (_, index) => index * tickStep);

  // End labels are two lines (value, then vendor and model). Nudge them apart so they never overlap.
  const labelHeight = 40;
  const endLabels = [...lines]
    .map((line) => ({ line, y: y(line.series.total) }))
    .sort((a, b) => a.y - b.y);
  for (let index = 1; index < endLabels.length; index += 1) {
    const previous = endLabels[index - 1];
    if (endLabels[index].y - previous.y < labelHeight) endLabels[index].y = previous.y + labelHeight;
  }
  const lowest = height - pad.bottom - 14;
  const overflow = (endLabels[endLabels.length - 1]?.y ?? 0) - lowest;
  if (overflow > 0) for (const entry of endLabels) entry.y -= overflow;
  const topOverflow = pad.top + 2 - (endLabels[0]?.y ?? pad.top);
  if (topOverflow > 0) for (const entry of endLabels) entry.y += topOverflow;

  const monthAt = (clientX: number, rect: DOMRect) =>
    Math.round(Math.min(1, Math.max(0, (clientX - rect.left - pad.left) / plotWidth)) * months);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    setActive(monthAt(event.clientX, event.currentTarget.getBoundingClientRect()));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? months;
    const steps: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      PageUp: current + 12,
      PageDown: current - 12,
      Home: 0,
      End: months
    };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.min(months, Math.max(0, next)));
  };
  const shown = active === null ? null : Math.min(active, months);
  const valueText =
    shown === null
      ? undefined
      : `${monthLabel(shown)}: ${lines.map((line) => `${line.label} ${dollars.format(line.series.points[shown] ?? 0)}`).join(", ")}`;
  const tooltipWidth = 280;
  const tooltipLeft =
    shown === null
      ? 0
      : x(shown) > width / 2
        ? Math.max(0, x(shown) - tooltipWidth - 12)
        : Math.min(Math.max(0, width - tooltipWidth), x(shown) + 12);

  return (
    <div ref={ref} className="relative">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={months}
        aria-valuenow={shown ?? months}
        aria-valuetext={valueText ?? `${monthLabel(months)}: ${lines.map((line) => `${line.label} ${dollars.format(line.series.total)}`).join(", ")}`}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerMove}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(months)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        className={`relative touch-pan-y rounded-[8px] ${focusRing}`}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block overflow-visible">
          {ticks.map((month) => (
            <g key={month}>
              <line x1={x(month)} x2={x(month)} y1={pad.top} y2={height - pad.bottom} stroke="var(--lp-border)" strokeWidth={1} />
              <text
                x={x(month)}
                y={height - 8}
                fontSize={11}
                fill="var(--lp-muted)"
                textAnchor={month === 0 ? "start" : month === months ? "end" : "middle"}
              >
                {months >= 24 ? monthLabel(month) : month === 0 ? "Today" : `Month ${month}`}
              </text>
            </g>
          ))}
          <path
            d={shadePath}
            fill={shadeSaving ? accent : claudeGray}
            fillOpacity={shadeSaving ? 0.1 : 0.06}
            className="[transition:d_200ms_cubic-bezier(.2,.8,.2,1)] motion-reduce:[transition:none]"
          />
          {lines.map((line) => (
            <path
              key={line.key}
              d={path(line.series)}
              fill="none"
              stroke={line.stroke}
              strokeWidth={line.width}
              strokeOpacity={line.opacity}
              strokeDasharray={dashArray[line.pattern]}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="[transition:d_200ms_cubic-bezier(.2,.8,.2,1)] motion-reduce:[transition:none]"
            />
          ))}
          {lines.map((line) => (
            <circle
              key={line.key}
              cx={x(months)}
              cy={y(line.series.total)}
              r={line.pattern === "dotted" ? 3 : 4}
              fill={line.stroke}
              fillOpacity={line.opacity}
            />
          ))}
          {wide
            ? endLabels.map(({ line, y: labelY }) => (
                <g key={line.key}>
                  <line
                    x1={x(months) + 5}
                    x2={x(months) + labelGap - 2}
                    y1={y(line.series.total)}
                    y2={labelY + 4}
                    stroke={line.stroke}
                    strokeOpacity={Math.abs(labelY + 4 - y(line.series.total)) > 3 ? 0.6 : 0}
                    strokeWidth={1}
                  />
                  <text
                    x={x(months) + labelGap}
                    y={labelY + 4}
                    fontSize={13.5}
                    fontWeight={600}
                    fill={line.series.vendor === "openwork" ? accent : "var(--lp-ink)"}
                    className="tabular-nums"
                  >
                    {shortDollars(line.series.total)}
                  </text>
                  <text x={x(months) + labelGap} y={labelY + 20} fontSize={12} fill="var(--lp-body)">
                    {line.label}
                  </text>
                </g>
              ))
            : null}
          {shown !== null ? (
            <g>
              <line x1={x(shown)} x2={x(shown)} y1={pad.top} y2={height - pad.bottom} stroke="var(--lp-ink)" strokeOpacity={0.35} />
              {lines.map((line) => (
                <circle
                  key={line.key}
                  cx={x(shown)}
                  cy={y(line.series.points[shown] ?? 0)}
                  r={4}
                  fill="var(--lp-page)"
                  stroke={line.stroke}
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
        </svg>
        {shown !== null ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 w-[280px] max-w-full rounded-[12px] bg-[var(--lp-page)] px-3 py-2.5 shadow-[0_0_0_1px_var(--lp-border),0_8px_24px_-12px_rgba(1,22,39,0.25)]"
            style={{ left: tooltipLeft }}
          >
            <div className="text-[12px] font-medium text-[var(--lp-ink)]">{monthLabel(shown)}</div>
            <ul className="mt-1.5 space-y-1">
              {lines.map((line) => (
                <li key={line.key} className="flex items-center justify-between gap-3 text-[12px] text-[var(--lp-body)]">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <LineSwatch line={line} />
                    <span className="truncate">{line.label}</span>
                  </span>
                  <span className="tabular-nums text-[var(--lp-ink)]">{shortDollars(line.series.points[shown] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {wide ? (
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-[var(--lp-body)]" aria-label="Chart colors">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--lp-blue)]" />
            OpenWork
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--lp-muted)]" />
            Claude
          </li>
          {shadeSaving ? (
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-[3px] bg-[var(--lp-blue)] opacity-20" />
              What you keep with the same model
            </li>
          ) : null}
        </ul>
      ) : (
        <ul className="mt-3 space-y-1.5" aria-label="Chart lines">
          {[...lines]
            .sort((a, b) => b.series.total - a.series.total)
            .map((line) => (
              <li key={line.key} className="flex items-center justify-between gap-3 text-[12.5px] text-[var(--lp-body)]">
                <span className="flex min-w-0 items-center gap-2">
                  <LineSwatch line={line} />
                  <span className="min-w-0">{line.label}</span>
                </span>
                <span
                  className={`shrink-0 font-semibold tabular-nums ${line.series.vendor === "openwork" ? "text-[var(--lp-blue)]" : "text-[var(--lp-ink)]"}`}
                >
                  {shortDollars(line.series.total)}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function LineSwatch({ line }: { line: ChartLine }) {
  return (
    <svg aria-hidden="true" width={18} height={6} viewBox="0 0 18 6" className="shrink-0">
      <line
        x1={1.5}
        x2={16.5}
        y1={3}
        y2={3}
        stroke={line.stroke}
        strokeOpacity={line.opacity}
        strokeWidth={Math.max(1.75, line.width)}
        strokeDasharray={line.pattern === "dashed" ? "4 3" : line.pattern === "dotted" ? "1 3" : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

type ResultCard = {
  key: string;
  title: string;
  headline: string;
  perPerson: string;
  detail: string;
  line: ChartLine | undefined;
};

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Plain verdict for Claude total minus OpenWork total. Says so when Claude is cheaper. */
function verdict(delta: number): string {
  if (Math.abs(delta) < 0.5) return "Same price";
  return delta > 0 ? `You keep ${dollars.format(delta)}` : `Claude costs ${dollars.format(-delta)} less`;
}

/** "Claude Sonnet 5" -> "Sonnet 5" when the vendor already says Claude. */
function shortClaudeModel(label: string): string {
  return label.replace(/^Claude\s+/, "");
}

export function CoworkCostCalculator({
  defaultUsers = 50,
  defaultTier = "team",
  heading = "What will your team spend?"
}: Props) {
  const id = useId();
  const [usersText, setUsersText] = useState(String(defaultUsers));
  const [profile, setProfile] = useState<UsageProfileId>("typical");
  const [tier, setTier] = useState<Tier>(defaultTier);
  const [modelId, setModelId] = useState("claude-sonnet-5");
  const [mixShare, setMixShare] = useState<MixShare>(defaultMixShare);
  const [openModelId, setOpenModelId] = useState("deepseek-v4-pro");
  const [years, setYears] = useState<Years>(3);

  const parsedUsers = Number(usersText);
  const users = Number.isFinite(parsedUsers) && parsedUsers >= 1 ? Math.round(parsedUsers) : defaultUsers;
  const model = findModel(claudeModels, modelId);
  const openModel = findModel(openModels, openModelId);

  const result = cumulativeCosts({
    users,
    usage: usageProfiles[profile].usage,
    tier,
    model,
    mix: { openModel, openShare: mixShare },
    months: years * 12
  });

  const claudeLine = result.claude;
  const period = periodLabel(years);
  // "Claude Team, Premium seats" -> vendor "Claude Team", seat "Premium seats".
  const [claudePlanVendor = claudeLine.name, claudeSeat] = result.claude.name.split(", ");
  const claudeVendor = claudePlanVendor;
  const claudeModelShort = shortClaudeModel(model.label);
  const claudePlanLabel = `${claudePlanVendor} · ${claudeModelShort}${claudeSeat ? ` (${claudeSeat})` : ""}`;
  const claudeLabel = claudePlanLabel;
  const openworkLabel = `OpenWork · ${model.label}`;
  const openPercent = Math.round(mixShare * 100);
  const claudePercent = 100 - openPercent;
  // "DeepSeek V4 Pro" -> "DeepSeek"; the end label stays short enough for the chart gutter.
  const openModelShort = openModel.label.split(" ")[0] ?? openModel.label;
  const mixLineLabel = `OpenWork · ${openPercent}/${claudePercent} ${openModelShort} + ${claudeModelShort.split(" ")[0] ?? claudeModelShort}`;

  const lines: ChartLine[] = [
    { key: "claude", label: claudeLabel, series: claudeLine, stroke: claudeGray, width: 2.25, pattern: "solid", opacity: 1 },
    { key: "openwork", label: openworkLabel, series: result.openwork, stroke: accent, width: 2.75, pattern: "solid", opacity: 1 },
    ...(result.mix
      ? [
          {
            key: "mix",
            label: mixLineLabel,
            series: result.mix,
            stroke: accent,
            width: 2.25,
            pattern: "dashed" as const,
            opacity: 1
          }
        ]
      : [])
  ];

  const notices = [
    ...(result.claudeTeamUnavailable
      ? [`Claude Team stops at ${planPrices.claudeTeamMaxSeats} seats, so this compares Claude Enterprise.`]
      : []),
    ...(tier === "enterprise" && users > planPrices.openworkEnterpriseVolumeAbove
      ? [`Includes OpenWork Enterprise volume pricing above ${planPrices.openworkEnterpriseVolumeAbove} people.`]
      : [])
  ];

  const delta = claudeLine.total - result.openwork.total;
  const claudePerPerson = dollars.format(perPersonMonthly(claudeLine, users));
  const perPersonText = (series: CostSeries) =>
    `${claudePerPerson} vs ${dollars.format(perPersonMonthly(series, users))} per person / month`;
  const results: ResultCard[] = [
    {
      key: "same",
      title: `Same model on both (${model.label})`,
      headline: verdict(delta),
      perPerson: perPersonText(result.openwork),
      detail: `${claudeVendor} ${dollars.format(claudeLine.total)} vs OpenWork ${dollars.format(result.openwork.total)}`,
      line: lines.find((line) => line.key === "openwork")
    },
    ...(result.mix
      ? [
          {
            key: "mix",
            title: `OpenWork with a ${openPercent}/${claudePercent} mix (${openPercent}% ${openModel.label}, ${claudePercent}% ${claudeModelShort})`,
            headline: verdict(claudeLine.total - result.mix.total),
            perPerson: perPersonText(result.mix),
            detail: `${claudeVendor} ${dollars.format(claudeLine.total)} vs OpenWork ${dollars.format(result.mix.total)}`,
            line: lines.find((line) => line.key === "mix")
          }
        ]
      : [])
  ];
  const reasonLine =
    delta >= 0.5
      ? null
      : delta > -0.5
        ? tier === "enterprise"
          ? "Seats and tokens cost the same on both."
          : null
        : claudeLine.tokensIncluded
          ? "Claude Team includes usage up to plan limits. OpenWork pays for tokens at API rates."
          : null;

  const rows: { key: string; series: CostSeries; detail: string; strong: boolean }[] = [
    {
      key: "claude",
      series: claudeLine,
      detail: claudeLine.tokensIncluded
        ? "Usage included up to plan limits"
        : model.label,
      strong: true
    },
    { key: "openwork", series: result.openwork, detail: model.label, strong: true },
    ...(result.mix ? [{ key: "mix", series: result.mix, detail: result.mix.modelLabel, strong: true }] : [])
  ];

  return (
    <section aria-labelledby={`${id}-heading`}>
      <div id={`${id}-heading`}>
        <LpSectionHeader label="Cost calculator" heading={heading} size="small" />
      </div>

      <div className="mt-9 rounded-[24px] bg-[var(--lp-tonal)] p-5 md:p-8">
        <form onSubmit={(event) => event.preventDefault()} aria-label="Cost calculator inputs">
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1fr]">
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor={`${id}-users`} className="text-[13px] text-[var(--lp-muted)]">
                  Team size
                </label>
                <input
                  id={`${id}-users`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100000}
                  step={1}
                  value={usersText}
                  onChange={(event) => setUsersText(event.target.value)}
                  className={`h-8 w-[84px] rounded-[8px] bg-[var(--lp-page)] px-2 text-right text-[14px] font-medium tabular-nums text-[var(--lp-ink)] shadow-[0_0_0_1px_var(--lp-border)] ${focusRing}`}
                />
              </div>
              <input
                type="range"
                min={1}
                max={sliderMax}
                step={1}
                value={Math.min(users, sliderMax)}
                onChange={(event) => setUsersText(event.target.value)}
                aria-label="Team size, slider"
                className="mt-2 h-11 w-full cursor-pointer accent-[var(--lp-ink)]"
              />
            </div>

            <Segmented
              name={`${id}-profile`}
              legend="Usage per person"
              options={usageProfileIds.map((key) => ({ value: key, label: profileLabels[key] }))}
              value={profile}
              onChange={setProfile}
            />

            <Segmented
              name={`${id}-tier`}
              legend="SCIM, audit log, desktop policies"
              options={[
                { value: "team", label: "Not needed" },
                { value: "enterprise", label: "Needed" }
              ]}
              value={tier}
              onChange={setTier}
            />
          </div>

          <fieldset className="mt-6">
            <legend className="text-[14px] font-medium text-[var(--lp-ink)]">Model mix on OpenWork</legend>
            <div className="mt-3 grid gap-6 md:grid-cols-2 lg:grid-cols-[2.2fr_1fr_1fr]">
              <div className="md:col-span-2 lg:col-span-1">
                <Segmented
                  name={`${id}-mix`}
                  legend="Share of work on an open model"
                  options={mixShares.map((share) => ({ value: share, label: percent(share) }))}
                  value={mixShare}
                  onChange={setMixShare}
                />
                {mixShare > 0 ? (
                  <div className="mt-3" aria-hidden="true">
                    <div className="flex h-1.5 gap-0.5">
                      <div className="h-full rounded-full bg-[var(--lp-ink)]" style={{ width: `${openPercent}%` }} />
                      <div className="h-full flex-1 rounded-full bg-[var(--lp-border)]" />
                    </div>
                    <div className="mt-1.5 flex justify-between gap-3 text-[12px] text-[var(--lp-body)]">
                      <span>
                        {openPercent}% {openModel.label}
                      </span>
                      <span className="text-right">
                        {claudePercent}% {model.label}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              <ModelSelect
                id={`${id}-open-model`}
                label="Open model"
                models={openModels}
                value={openModel.id}
                onChange={setOpenModelId}
                muted={mixShare === 0}
              />

              <ModelSelect
                id={`${id}-model`}
                label="Claude model (both sides)"
                models={claudeModels}
                value={model.id}
                onChange={setModelId}
              />
            </div>
          </fieldset>
        </form>

        <div className="mt-8 border-t border-[var(--lp-border)] pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[14px] text-[var(--lp-body)]">
              {count.format(users)} people, over {period}
            </p>
            <div className="w-[180px] shrink-0">
              <Segmented
                name={`${id}-years`}
                legend="Period"
                hideLegend
                options={[
                  { value: 1, label: "1 year" },
                  { value: 3, label: "3 years" }
                ]}
                value={years}
                onChange={setYears}
              />
            </div>
          </div>

          <div
            aria-live="polite"
            className={`mt-5 grid gap-5 ${results.length > 1 ? "md:grid-cols-2 md:gap-0 md:divide-x md:divide-[var(--lp-border)]" : ""}`}
          >
            {results.map((card, index) => (
              <div
                key={card.key}
                className={`min-w-0 ${index > 0 ? "border-t border-[var(--lp-border)] pt-5 md:border-t-0 md:pl-8 md:pt-0" : "md:pr-8"}`}
              >
                <h3 className="flex items-center gap-2 text-[14px] font-medium text-[var(--lp-ink)]">
                  {card.line ? <LineSwatch line={card.line} /> : null}
                  {card.title}
                </h3>
                <p className="mt-1.5 text-[30px] font-light leading-[1.1] tracking-[-0.03em] tabular-nums text-[var(--lp-ink)] sm:text-[34px]">
                  {card.headline}
                </p>
                <p className="mt-2 text-[14px] font-medium tabular-nums text-[var(--lp-ink)]">{card.perPerson}</p>
                <p className="mt-1.5 text-[13px] tabular-nums text-[var(--lp-body)]">{card.detail}</p>
                {card.key === "same" && reasonLine ? (
                  <p className="mt-2 text-[13px] text-[var(--lp-body)]">{reasonLine}</p>
                ) : null}
              </div>
            ))}
          </div>
          {notices.map((notice) => (
            <p key={notice} className="mt-5 text-[13px] text-[var(--lp-muted)]">
              {notice}
            </p>
          ))}

          <div className="mt-8">
            <CostChart
              lines={lines}
              months={years * 12}
              shade={{ from: claudeLine, to: result.openwork }}
              label={`Cumulative cost over ${period}. Use arrow keys to move by month.`}
            />
          </div>

          <table className="mt-8 w-full border-collapse text-left text-[13px]">
            <caption className="sr-only">
              Cost breakdown for {count.format(users)} people over {period}
            </caption>
            <thead>
              <tr className="text-[12px] text-[var(--lp-muted)]">
                <th scope="col" className="h-8 font-normal">
                  <span className="sr-only">Plan</span>
                </th>
                <th scope="col" className="hidden h-8 text-right font-normal sm:table-cell">
                  Seats a year
                </th>
                <th scope="col" className="hidden h-8 text-right font-normal sm:table-cell">
                  Tokens a year
                </th>
                <th scope="col" className="h-8 text-right font-normal">
                  {period}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-[var(--lp-border)]">
                  <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                    <span className={row.strong ? "font-medium text-[var(--lp-ink)]" : "text-[var(--lp-body)]"}>
                      {row.series.name}
                    </span>
                    <span className="block text-[12px] text-[var(--lp-muted)]">{row.detail}</span>
                  </th>
                  <td className="hidden py-2.5 text-right tabular-nums text-[var(--lp-body)] sm:table-cell">
                    {dollars.format(row.series.seatsMonthly * 12)}
                  </td>
                  <td className="hidden py-2.5 text-right tabular-nums text-[var(--lp-body)] sm:table-cell">
                    {row.series.tokensIncluded ? "Included" : dollars.format(row.series.tokensMonthly * 12)}
                  </td>
                  <td className="py-2.5 text-right font-medium tabular-nums text-[var(--lp-ink)]">
                    {dollars.format(row.series.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details className="group mt-6 border-t border-[var(--lp-border)] pt-4">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-[var(--lp-ink)] [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              strokeWidth={2}
              className="h-3.5 w-3.5 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
            />
            How we calculate
          </summary>
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-[19px] text-[var(--lp-body)]">
            <li>
              Both sides use the same Claude model; the first result compares them. The model mix result assumes that share of
              each person&apos;s tokens runs on the open model you pick and the rest on the Claude model. Per person figures are the monthly cost divided by team size, rounded to whole dollars.
              Tokens per person = input × (uncached × input price + cached × cache
              price) + output × output price. Light, Typical, and Heavy assume 5M, 25M, or 100M input tokens a month, 70%
              cached.
            </li>
            <li>
              SSO is included on both Team plans (Claude Team lists single sign-on on claude.com/pricing and in its Team
              plan article). Needing SCIM, an audit log, or desktop policies compares Claude Enterprise with OpenWork
              Enterprise. Claude Team: ${planPrices.claudeTeamStandard.annual}/seat billed annually (${planPrices.claudeTeamStandard.monthly} monthly),{" "}
              {planPrices.claudeTeamMinSeats} to {planPrices.claudeTeamMaxSeats} seats, usage included up to plan limits.
              Typical and Heavy use reach Standard seat limits, so they are priced on Premium seats ($
              {planPrices.claudeTeamPremium.annual} annual, ${planPrices.claudeTeamPremium.monthly} monthly), which Anthropic
              positions for heavy and agentic use. Light use is priced on Standard seats. Team usage beyond limits is billed
              at API rates; we don&apos;t add it, so this still favours Claude.
            </li>
            <li>
              Claude Enterprise: ${planPrices.claudeEnterpriseSeat}/seat billed annually, {planPrices.claudeEnterpriseMinSeats}{" "}
              seats minimum, all usage at API rates.
            </li>
            <li>
              OpenWork Team on OpenWork Cloud: first {planPrices.openworkFreeSeats} seats free, then $
              {planPrices.openworkTeamSeat}/seat. OpenWork Enterprise: {describeEnterpriseVolumeTiers()}, billed annually.
              Tokens billed by your own provider or gateway.
            </li>
            <li>
              Costs accrue monthly. List prices from models.dev ({modelPricesFetchedAt}); Anthropic plans checked{" "}
              {anthropicPricingCheckedAt}. Committed-spend discounts are not included.
            </li>
            <li className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
              {pricingSources.map((source) => (
                <a
                  key={source.href}
                  href={source.href}
                  className="text-[var(--lp-muted)] underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
                  {...(source.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {source.label}
                </a>
              ))}
            </li>
          </ul>
        </details>
      </div>
    </section>
  );
}
