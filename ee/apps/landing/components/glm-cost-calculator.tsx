"use client";

import { useMemo, useState } from "react";
import { TrendingDown, Users, Zap, Calendar } from "lucide-react";

type ModelKey = "glm" | "sonnet" | "opus";

type Model = {
  key: ModelKey;
  name: string;
  inPrice: number;
  outPrice: number;
  color: string;
  accent: string;
  chip: string;
};

const MODELS: Model[] = [
  { key: "glm",    name: "GLM 5.2",     inPrice: 0.95, outPrice: 3,  color: "#2563EB", accent: "#1D4ED8", chip: "bg-blue-50 text-blue-700 border-blue-200" },
  { key: "sonnet", name: "Sonnet 4.6",   inPrice: 3,    outPrice: 15, color: "#8B5CF6", accent: "#7C3AED", chip: "bg-violet-50 text-violet-700 border-violet-200" },
  { key: "opus",   name: "Opus 4.8",     inPrice: 5,    outPrice: 25, color: "#F97316", accent: "#EA580C", chip: "bg-orange-50 text-orange-700 border-orange-200" },
];

type Tier = {
  key: string;
  label: string;
  inM: number;
  outM: number;
  blurb: string;
};

const TIERS: Tier[] = [
  { key: "light",    label: "Light",    inM: 1,  outM: 0.25, blurb: "Occasional tasks, 1–2/day" },
  { key: "moderate", label: "Moderate", inM: 4,  outM: 1,    blurb: "Daily coworker, ~160 tasks/mo" },
  { key: "heavy",    label: "Heavy",    inM: 12, outM: 3,    blurb: "Power user, always-on agent" },
];

const RAMP = [
  { month: "Month 1", tierKey: "light" },
  { month: "Month 3", tierKey: "moderate" },
  { month: "Month 6", tierKey: "heavy" },
];

const RAMP_LINE_KEYS: ReadonlyArray<ModelKey> = ["opus", "sonnet", "glm"];
const HORIZONS: ReadonlyArray<"month" | "year"> = ["month", "year"];

function costFor(model: Model, tier: Tier, employees: number): number {
  const inCost = (tier.inM * 1_000_000 * model.inPrice) / 1_000_000;
  const outCost = (tier.outM * 1_000_000 * model.outPrice) / 1_000_000;
  return (inCost + outCost) * employees;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

function fmtShort(n: number): string {
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  icon,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  icon: React.ReactNode;
  suffix: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-[13px] font-medium text-gray-700">
          {icon}
          {label}
        </label>
        <span className="mono text-[13px] font-semibold text-[#011627]">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-input"
        aria-label={label}
      />
    </div>
  );
}

function BarChart({
  data,
  height = 260,
}: {
  data: Array<{ label: string; values: Array<{ model: Model; cost: number }> }>;
  height?: number;
}) {
  const maxCost = useMemo(() => {
    const m = Math.max(...data.flatMap((d) => d.values.map((v) => v.cost)), 1);
    return m * 1.12;
  }, [data]);

  const barW = 26;
  const groupGap = 56;
  const groupW = MODELS.length * (barW + 4) + 8;
  const chartW = data.length * groupW + (data.length - 1) * groupGap + 48;
  const leftPad = 44;
  const bottomPad = 44;
  const topPad = 16;

  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (maxCost / yTicks) * i);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${chartW} ${height}`}
        className="w-full"
        style={{ minWidth: chartW > 560 ? chartW : "100%" }}
        role="img"
        aria-label="Cost comparison bar chart"
      >
        {ticks.map((t, i) => {
          const y = height - bottomPad - ((height - bottomPad - topPad) * (t / maxCost));
          return (
            <g key={i}>
              <line
                x1={leftPad}
                x2={chartW - 8}
                y1={y}
                y2={y}
                stroke="rgba(148,163,184,0.18)"
                strokeWidth={1}
                strokeDasharray={i === 0 ? "0" : "3 4"}
              />
              <text x={leftPad - 8} y={y + 4} textAnchor="end" className="fill-gray-400" style={{ fontSize: 10, fontWeight: 600 }}>
                {fmtShort(t)}
              </text>
            </g>
          );
        })}

        {data.map((group, gi) => {
          const gx = leftPad + gi * (groupW + groupGap) + 8;
          return (
            <g key={group.label}>
              {group.values.map((v, mi) => {
                const bh = ((height - bottomPad - topPad) * (v.cost / maxCost));
                const bx = gx + mi * (barW + 4);
                const by = height - bottomPad - bh;
                const isGlm = v.model.key === "glm";
                return (
                  <g key={v.model.key}>
                    <rect
                      x={bx}
                      y={by}
                      width={barW}
                      height={Math.max(bh, 1)}
                      rx={4}
                      fill={v.model.color}
                      opacity={isGlm ? 1 : 0.85}
                    />
                    {bh > 22 ? (
                      <text x={bx + barW / 2} y={by - 6} textAnchor="middle" className="fill-gray-700" style={{ fontSize: 10, fontWeight: 700 }}>
                        {fmtShort(v.cost)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              <text
                x={gx + (groupW - 8) / 2}
                y={height - bottomPad + 20}
                textAnchor="middle"
                className="fill-gray-600"
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {group.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LineChart({
  points,
  height = 220,
}: {
  points: Array<{ x: string; glm: number; opus: number; sonnet: number }>;
  height?: number;
}) {
  const width = 560;
  const leftPad = 48;
  const rightPad = 16;
  const topPad = 16;
  const bottomPad = 36;
  const maxCost = Math.max(...points.flatMap((p) => [p.glm, p.opus, p.sonnet]), 1) * 1.1;
  const innerW = width - leftPad - rightPad;
  const innerH = height - topPad - bottomPad;

  const xStep = points.length > 1 ? innerW / (points.length - 1) : 0;

  const path = (key: "glm" | "opus" | "sonnet") =>
    points
      .map((p, i) => {
        const x = leftPad + i * xStep;
        const y = height - bottomPad - (innerH * (p[key] / maxCost));
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (maxCost / yTicks) * i);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Adoption ramp cost curve">
      {ticks.map((t, i) => {
        const y = height - bottomPad - (innerH * (t / maxCost));
        return (
          <g key={i}>
            <line x1={leftPad} x2={width - rightPad} y1={y} y2={y} stroke="rgba(148,163,184,0.18)" strokeWidth={1} strokeDasharray={i === 0 ? "0" : "3 4"} />
            <text x={leftPad - 8} y={y + 4} textAnchor="end" className="fill-gray-400" style={{ fontSize: 10, fontWeight: 600 }}>
              {fmtShort(t)}
            </text>
          </g>
        );
      })}

      {points.map((p, i) => {
        const x = leftPad + i * xStep;
        return (
          <text key={p.x} x={x} y={height - bottomPad + 18} textAnchor="middle" className="fill-gray-600" style={{ fontSize: 11, fontWeight: 600 }}>
            {p.x}
          </text>
        );
      })}

      <path d={path("opus")} fill="none" stroke="#F97316" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={path("sonnet")} fill="none" stroke="#8B5CF6" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={path("glm")} fill="none" stroke="#2563EB" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

      {points.map((p, i) => {
        const x = leftPad + i * xStep;
        return (
          <g key={i}>
            {RAMP_LINE_KEYS.map((k) => {
              const m = MODELS.find((mm) => mm.key === k)!;
              const y = height - bottomPad - (innerH * (p[k] / maxCost));
              return <circle key={k} cx={x} cy={y} r={3.5} fill={m.color} stroke="white" strokeWidth={1.5} />;
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function GlmCostCalculator() {
  const [employees, setEmployees] = useState(50);
  const [tierIdx, setTierIdx] = useState(1);
  const [horizon, setHorizon] = useState<"month" | "year">("year");

  const tier = TIERS[tierIdx];
  const glm = MODELS[0];
  const sonnet = MODELS[1];
  const opus = MODELS[2];

  const perTier = useMemo(() => {
    return TIERS.map((t) => ({
      label: t.label,
      values: MODELS.map((m) => ({ model: m, cost: costFor(m, t, 1) })),
    }));
  }, []);

  const company = useMemo(() => {
    const mult = horizon === "year" ? 12 : 1;
    return MODELS.map((m) => ({
      model: m,
      cost: costFor(m, tier, employees) * mult,
    }));
  }, [tier, employees, horizon]);

  const glmCost = company.find((c) => c.model.key === "glm")!.cost;
  const opusCost = company.find((c) => c.model.key === "opus")!.cost;
  const saved = opusCost - glmCost;
  const ratio = opusCost / Math.max(glmCost, 0.01);

  const rampData = useMemo(
    () =>
      RAMP.map((r) => {
        const t = TIERS.find((tt) => tt.key === r.tierKey)!;
        return {
          x: r.month,
          glm: costFor(glm, t, employees),
          sonnet: costFor(sonnet, t, employees),
          opus: costFor(opus, t, employees),
        };
      }),
    [employees]
  );

  return (
    <div className="flex flex-col gap-10">
      <style>{`
        .slider-input {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 6px;
          border-radius: 9999px;
          background: linear-gradient(to right, #2563EB 0%, #2563EB var(--pct,50%), #E2E8F0 var(--pct,50%), #E2E8F0 100%);
          outline: none;
        }
        .slider-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #fff;
          border: 2px solid #2563EB;
          box-shadow: 0 2px 6px rgba(37,99,235,0.35);
          cursor: pointer;
          transition: transform 0.15s ease;
        }
        .slider-input::-webkit-slider-thumb:hover { transform: scale(1.12); }
        .slider-input::-moz-range-thumb {
          width: 20px; height: 20px; border-radius: 50%;
          background: #fff; border: 2px solid #2563EB;
          box-shadow: 0 2px 6px rgba(37,99,235,0.35); cursor: pointer;
        }
      `}</style>

      <section className="landing-shell rounded-3xl p-6 md:p-8">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-blue-700 border border-blue-200">
            Live model
          </span>
        </div>
        <h2 className="mb-1 text-2xl font-bold tracking-tight text-[#011627]">
          The same coworker, a fraction of the bill
        </h2>
        <p className="mb-6 max-w-2xl text-[15px] leading-relaxed text-gray-600">
          Drag the sliders. AI coworkers don&apos;t reduce token spend — they multiply it.
          The more your team adopts, the bigger the Anthropic-only bill gets. Route the same
          work to GLM 5.2 and the curve stays flat.
        </p>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <Slider
            label="Equipped employees"
            value={employees}
            min={1}
            max={300}
            step={1}
            onChange={setEmployees}
            icon={<Users size={14} className="text-gray-500" />}
            suffix=""
          />
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-[13px] font-medium text-gray-700">
              <Zap size={14} className="text-gray-500" />
              Usage tier
            </label>
            <div className="flex flex-col gap-1.5">
              {TIERS.map((t, i) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTierIdx(i)}
                  className={`flex items-center justify-between rounded-xl border px-3 py-1.5 text-left text-[12px] transition-colors ${
                    tierIdx === i
                      ? "border-blue-300 bg-blue-50/70 text-[#011627]"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <span className="font-semibold">{t.label}</span>
                  <span className="mono text-[11px] text-gray-500">
                    {t.inM}M / {t.outM}M
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-[13px] font-medium text-gray-700">
              <Calendar size={14} className="text-gray-500" />
              Horizon
            </label>
            <div className="flex gap-2">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  className={`flex-1 rounded-xl border px-3 py-2 text-[13px] font-semibold capitalize transition-colors ${
                    horizon === h
                      ? "border-blue-300 bg-blue-50/70 text-[#011627]"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-gray-500">{tier.blurb}</p>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {company.map((c) => {
            const isGlm = c.model.key === "glm";
            return (
              <div
                key={c.model.key}
                className={`rounded-2xl border p-5 ${
                  isGlm ? "border-blue-200 bg-blue-50/50" : "border-gray-200 bg-white"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full`} style={{ background: c.model.color }} />
                  <span className="text-[13px] font-semibold text-gray-700">{c.model.name}</span>
                  <span className="mono ml-auto text-[11px] text-gray-400">
                    ${c.model.inPrice}/${c.model.outPrice}
                  </span>
                </div>
                <div className="text-[28px] font-bold tracking-tight text-[#011627]">
                  {fmt(c.cost)}
                </div>
                <div className="text-[12px] text-gray-500">
                  {horizon === "year" ? "per year" : "per month"} · {employees} {employees === 1 ? "seat" : "seats"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-[#011627] px-5 py-4 text-white">
          <TrendingDown size={18} className="text-emerald-300" />
          <span className="text-[14px] font-medium">
            GLM 5.2 saves <span className="font-bold text-emerald-300">{fmt(saved)}</span> vs Opus 4.8 —{" "}
            <span className="font-bold text-emerald-300">{ratio.toFixed(1)}×</span> cheaper, same coworker.
          </span>
        </div>
      </section>

      <section className="landing-shell rounded-3xl p-6 md:p-8">
        <div className="mb-1 text-[12px] font-bold uppercase tracking-wider text-gray-500">
          Per employee / month
        </div>
        <h3 className="mb-5 text-xl font-bold tracking-tight text-[#011627]">
          Cost per employee by usage tier
        </h3>
        <BarChart data={perTier} />
        <div className="mt-4 flex flex-wrap gap-4">
          {MODELS.map((m) => (
            <div key={m.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
              <span className="text-[12px] font-medium text-gray-700">{m.name}</span>
              <span className="mono text-[11px] text-gray-400">
                ${m.inPrice}/M in · ${m.outPrice}/M out
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-shell rounded-3xl p-6 md:p-8">
        <div className="mb-1 text-[12px] font-bold uppercase tracking-wider text-gray-500">
          The adoption ramp
        </div>
        <h3 className="mb-1 text-xl font-bold tracking-tight text-[#011627]">
          As adoption climbs, the gap explodes
        </h3>
        <p className="mb-5 max-w-2xl text-[14px] leading-relaxed text-gray-600">
          Month 1 your team barely uses it. By Month 6 the coworker is running all day.
          On Anthropic-only pricing the bill compounds at $25/M output. On GLM 5.2 it stays flat.
        </p>
        <LineChart points={rampData} />
        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
          {rampData.map((r) => (
            <div key={r.x} className="rounded-xl border border-gray-200 bg-white p-3">
              <div className="text-[11px] font-semibold text-gray-500">{r.x}</div>
              <div className="mono mt-1 text-[13px] font-bold text-blue-600">{fmt(r.glm)}</div>
              <div className="mono text-[11px] text-orange-500 line-through opacity-70">{fmt(r.opus)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
