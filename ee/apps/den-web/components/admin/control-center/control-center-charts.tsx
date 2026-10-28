"use client";

import type { ReactElement } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ControlCenterLifecycle, ControlCenterPulse, ControlCenterRevenue, ControlCenterSharing } from "@openwork/types/den/admin-control-center";
import { SERIES_PALETTE } from "../../../app/(den)/dashboard/_features/analytics/series-colors";
import { compact, count, decimal, percent, shortDate, weekLabel } from "./control-center-model";

// Fixed slots from the analytics series palette, checked for color-vision separation.
const blue = SERIES_PALETTE[0] ?? "currentColor";
const orange = SERIES_PALETTE[1] ?? "currentColor";
const violet = SERIES_PALETTE[3] ?? "currentColor";
const teal = SERIES_PALETTE[8] ?? "currentColor";
const muted = "var(--dls-text-secondary)";
const border = "var(--dls-border)";
const ink = "var(--dls-text-primary)";
const tick = { fill: muted, fontSize: 11 };
const legendStyle = { fontSize: 12, color: muted };

type Line = { label: string; value: string; color?: string };

function TipBox({ active, title, lines }: { active: boolean | undefined; title: string; lines: Line[] }) {
  if (!active || lines.length === 0) return null;
  return <div className="min-w-40 rounded border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
    <p className="mb-1 font-medium text-slate-950">{title}</p>
    {lines.map((line) => <p key={line.label} className="flex items-center justify-between gap-4 py-0.5 text-slate-600">
      <span className="flex items-center gap-1.5">{line.color ? <span aria-hidden="true" className="size-2 rounded-sm" style={{ backgroundColor: line.color }} /> : null}{line.label}</span>
      <span className="font-medium tabular-nums text-slate-950">{line.value}</span>
    </p>)}
  </div>;
}

function Frame({ label, height, children }: { label: string; height: string; children: ReactElement }) {
  return <div role="group" aria-label={label} className={`${height} min-w-0 max-w-full overflow-hidden text-xs`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>{children}</ResponsiveContainer>
  </div>;
}

export function Sparkline({ points, label, format }: { points: { date: string; value: number | null }[]; label: string; format: (value: number) => string }) {
  const byDate = new Map(points.map((point) => [point.date, point.value]));
  return <Frame label={label} height="h-9">
    <LineChart accessibilityLayer data={points} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
      <Tooltip cursor={false} isAnimationActive={false} content={({ active, label: date }) => {
        const value = byDate.get(String(date));
        return <TipBox active={active} title={`${shortDate(String(date))} UTC`} lines={value == null ? [] : [{ label: "Value", value: format(value) }]} />;
      }} />
      <XAxis dataKey="date" hide />
      <YAxis hide domain={["auto", "auto"]} />
      <Line dataKey="value" stroke={ink} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
    </LineChart>
  </Frame>;
}

export function LifecycleChart({ weeks }: { weeks: ControlCenterLifecycle["weeks"] }) {
  const data = weeks.map((week) => ({ week: week.week, stillActive: week.stillActive, new: week.new, returned: week.returned, lost: -week.lost }));
  const byWeek = new Map(weeks.map((week) => [week.week, week]));
  const latest = weeks.at(-1);
  const summary = latest ? `Week of ${weekLabel(latest.week)}: ${count(latest.new)} new, ${count(latest.stillActive)} still active, ${count(latest.returned)} back after a skipped week, ${count(latest.lost)} lost.` : "No complete weeks yet.";
  return <Frame label={`Weekly active people by lifecycle group. ${summary}`} height="h-64">
    <BarChart accessibilityLayer data={data} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="week" tickFormatter={shortDate} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={(value: number) => compact(Math.abs(value))} width={44} tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
      <ReferenceLine y={0} stroke={muted} />
      <Tooltip cursor={{ fill: "var(--dls-hover)" }} isAnimationActive={false} content={({ active, label }) => {
        const week = byWeek.get(String(label));
        return <TipBox active={active} title={week ? weekLabel(week.week) : ""} lines={week ? [
          { label: "New", value: count(week.new), color: teal },
          { label: "Still active", value: count(week.stillActive), color: blue },
          { label: "Back after a skipped week", value: count(week.returned), color: violet },
          { label: "Lost", value: count(week.lost), color: orange },
          { label: "Gained per person lost", value: decimal(week.gainsVsLosses, 2) },
        ] : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} itemSorter={null} />
      <Bar dataKey="stillActive" name="Still active" stackId="people" fill={blue} maxBarSize={48} isAnimationActive={false} />
      <Bar dataKey="new" name="New" stackId="people" fill={teal} maxBarSize={48} isAnimationActive={false} />
      <Bar dataKey="returned" name="Back after a skipped week" stackId="people" fill={violet} maxBarSize={48} isAnimationActive={false} radius={[3, 3, 0, 0]} />
      <Bar dataKey="lost" name="Lost" stackId="people" fill={orange} maxBarSize={48} isAnimationActive={false} radius={[3, 3, 0, 0]} />
    </BarChart>
  </Frame>;
}

export function GainsChart({ weeks }: { weeks: ControlCenterLifecycle["weeks"] }) {
  const data = weeks.map((week) => ({ week: week.week, ratio: week.gainsVsLosses }));
  const latest = weeks.at(-1);
  return <Frame label={`People gained per person lost each week; above 1 means growth. Latest: ${decimal(latest?.gainsVsLosses ?? null, 2)}.`} height="h-24">
    <LineChart accessibilityLayer data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="week" tickFormatter={shortDate} tick={tick} axisLine={false} tickLine={false} />
      <YAxis width={44} tick={tick} axisLine={false} tickLine={false} domain={[0, (max: number) => Math.max(2, Math.ceil(max))]} />
      <ReferenceLine y={1} stroke={muted} strokeDasharray="4 3" />
      <Tooltip isAnimationActive={false} content={({ active, label }) => {
        const week = weeks.find((entry) => entry.week === label);
        return <TipBox active={active} title={week ? weekLabel(week.week) : ""} lines={week ? [{ label: "Gained per person lost", value: decimal(week.gainsVsLosses, 2) }] : []} />;
      }} />
      <Line dataKey="ratio" name="Gained per person lost" stroke={ink} strokeWidth={2} dot={{ r: 3, fill: ink }} connectNulls isAnimationActive={false} />
    </LineChart>
  </Frame>;
}

export function SignupsChart({ daily }: { daily: ControlCenterPulse["daily"] }) {
  const data = daily.map((day) => ({ date: day.date, work: day.workEmailSignups, other: day.signups - day.workEmailSignups }));
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const total = daily.reduce((sum, day) => sum + day.signups, 0);
  const work = daily.reduce((sum, day) => sum + day.workEmailSignups, 0);
  return <Frame label={`Daily sign-ups: ${count(total)} in this range, ${percent(total ? work / total : null)} with a work email.`} height="h-56">
    <AreaChart accessibilityLayer data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={compact} width={40} tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
      <Tooltip isAnimationActive={false} content={({ active, label }) => {
        const day = byDate.get(String(label));
        return <TipBox active={active} title={day ? `${shortDate(day.date)} UTC` : ""} lines={day ? [
          { label: "Work email", value: count(day.workEmailSignups), color: blue },
          { label: "Other email", value: count(day.signups - day.workEmailSignups), color: teal },
          { label: "Work email share", value: percent(day.signups ? day.workEmailSignups / day.signups : null) },
        ] : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} itemSorter={null} />
      <Area dataKey="work" name="Work email" stackId="signups" stroke={blue} fill={blue} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
      <Area dataKey="other" name="Other email" stackId="signups" stroke={teal} fill={teal} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
    </AreaChart>
  </Frame>;
}

export function OrganizationsChart({ weeks }: { weeks: ControlCenterLifecycle["organizations"] }) {
  const total = weeks.reduce((sum, week) => sum + week.team, 0);
  return <Frame label={`New organizations per week, split into personal workspaces and teams; ${count(total)} new teams in this range.`} height="h-56">
    <BarChart accessibilityLayer data={weeks} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="week" tickFormatter={shortDate} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={compact} width={40} tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
      <Tooltip cursor={{ fill: "var(--dls-hover)" }} isAnimationActive={false} content={({ active, label }) => {
        const week = weeks.find((entry) => entry.week === label);
        return <TipBox active={active} title={week ? weekLabel(week.week) : ""} lines={week ? [
          { label: "Personal (one person)", value: count(week.personal), color: teal },
          { label: "Team (2+ people)", value: count(week.team), color: blue },
        ] : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} itemSorter={null} />
      <Bar dataKey="team" name="Team" stackId="orgs" fill={blue} maxBarSize={48} isAnimationActive={false} />
      <Bar dataKey="personal" name="Personal" stackId="orgs" fill={teal} maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
    </BarChart>
  </Frame>;
}

export function FunnelChart({ steps }: { steps: { label: string; people: number }[] }) {
  const first = steps[0]?.people ?? 0;
  const data = steps.map((step) => ({ ...step, share: first ? step.people / first : null }));
  return <Frame label={`Activation funnel: ${data.map((step) => `${step.label} ${count(step.people)}`).join(", ")}.`} height="h-48">
    <BarChart accessibilityLayer data={data} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap="22%">
      <XAxis type="number" hide allowDecimals={false} />
      <YAxis type="category" dataKey="label" width={136} tick={tick} axisLine={false} tickLine={false} />
      <Tooltip cursor={{ fill: "var(--dls-hover)" }} isAnimationActive={false} content={({ active, label }) => {
        const step = data.find((entry) => entry.label === label);
        return <TipBox active={active} title={String(label ?? "")} lines={step ? [{ label: "People", value: count(step.people) }, { label: "Of sign-ups", value: percent(step.share) }] : []} />;
      }} />
      <Bar dataKey="people" name="People" fill={blue} maxBarSize={48} radius={[0, 3, 3, 0]} isAnimationActive={false}
        label={{ position: "right", fill: muted, fontSize: 11, formatter: (value: unknown) => typeof value === "number" && first ? percent(value / first) : "" }} />
    </BarChart>
  </Frame>;
}

export function FailureChart({ daily }: { daily: ControlCenterPulse["daily"] }) {
  const data = daily.map((day) => ({
    date: day.date,
    failed: day.started ? day.failed / day.started : null,
    abandoned: day.started ? Math.max(0, day.started - day.completed - day.failed) / day.started : null,
  }));
  const started = daily.reduce((sum, day) => sum + day.started, 0);
  const failed = daily.reduce((sum, day) => sum + day.failed, 0);
  return <Frame label={`Daily task failure rate; ${percent(started ? failed / started : null, 1)} of ${count(started)} tasks failed in this range.`} height="h-56">
    <LineChart accessibilityLayer data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={(value: number) => percent(value)} width={40} tick={tick} axisLine={false} tickLine={false} />
      <Tooltip isAnimationActive={false} content={({ active, label }) => {
        const day = daily.find((entry) => entry.date === label);
        const point = data.find((entry) => entry.date === label);
        return <TipBox active={active} title={day ? `${shortDate(day.date)} UTC` : ""} lines={day && point ? [
          { label: "Failed", value: percent(point.failed, 1), color: orange },
          { label: "Abandoned", value: percent(point.abandoned, 1), color: violet },
          { label: "Tasks started", value: count(day.started) },
        ] : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="plainline" itemSorter={null} />
      <Line dataKey="failed" name="Failed" stroke={orange} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
      <Line dataKey="abandoned" name="Abandoned" stroke={violet} strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
    </LineChart>
  </Frame>;
}

export function CapabilityUsageChart({ weekly }: { weekly: ControlCenterSharing["weekly"] }) {
  const latest = weekly.at(-1);
  return <Frame label={`People using skills and MCP connections each week. Latest week: ${count(latest?.skillUsers ?? 0)} skill users, ${count(latest?.mcpUsers ?? 0)} MCP users.`} height="h-56">
    <BarChart accessibilityLayer data={weekly} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%" barGap={2}>
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="week" tickFormatter={shortDate} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={compact} width={40} tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
      <Tooltip cursor={{ fill: "var(--dls-hover)" }} isAnimationActive={false} content={({ active, label }) => {
        const week = weekly.find((entry) => entry.week === label);
        return <TipBox active={active} title={week ? weekLabel(week.week) : ""} lines={week ? [
          { label: "Skill users", value: count(week.skillUsers), color: blue },
          { label: "Skill uses", value: count(week.skillUses) },
          { label: "MCP users", value: count(week.mcpUsers), color: teal },
          { label: "MCP tool calls", value: count(week.mcpCalls) },
        ] : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} itemSorter={null} />
      <Bar dataKey="skillUsers" name="Skill users" fill={blue} maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      <Bar dataKey="mcpUsers" name="MCP users" fill={teal} maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
    </BarChart>
  </Frame>;
}

const PLAN_TYPES = { seat: "Seats", web: "Web", inference: "Inference", enterprise: "Enterprise" } as const;

export function RevenueChart({ monthly }: { monthly: ControlCenterRevenue["monthly"] }) {
  const months = [...new Set(monthly.map((row) => row.month))].sort();
  const data = months.map((month) => {
    const rows = monthly.filter((row) => row.month === month);
    return { month, started: rows.reduce((sum, row) => sum + row.started, 0), canceled: -rows.reduce((sum, row) => sum + row.canceled, 0), rows };
  });
  const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  return <Frame label={`Paid plans started and canceled per month: ${data.map((row) => `${monthName(row.month)} ${row.started} started, ${-row.canceled} canceled`).join("; ")}.`} height="h-52">
    <BarChart accessibilityLayer data={data} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="32%">
      <CartesianGrid stroke={border} vertical={false} />
      <XAxis dataKey="month" tickFormatter={monthName} tick={tick} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={(value: number) => compact(Math.abs(value))} width={36} tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
      <ReferenceLine y={0} stroke={muted} />
      <Tooltip cursor={{ fill: "var(--dls-hover)" }} isAnimationActive={false} content={({ active, label }) => {
        const month = data.find((entry) => entry.month === label);
        return <TipBox active={active} title={month ? monthName(month.month) : ""} lines={month ? month.rows.flatMap((row) => [
          ...(row.started ? [{ label: `${PLAN_TYPES[row.type]} started`, value: count(row.started), color: blue }] : []),
          ...(row.canceled ? [{ label: `${PLAN_TYPES[row.type]} canceled`, value: count(row.canceled), color: orange }] : []),
        ]) : []} />;
      }} />
      <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} itemSorter={null} />
      <Bar dataKey="started" name="Started" stackId="plans" fill={blue} maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      <Bar dataKey="canceled" name="Canceled" stackId="plans" fill={orange} maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
    </BarChart>
  </Frame>;
}
