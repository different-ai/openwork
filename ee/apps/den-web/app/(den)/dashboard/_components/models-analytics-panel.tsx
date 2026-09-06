"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity as ActivityIcon, ArrowLeft, CheckCircle2, Clock3, Coins, Layers, Plug, RefreshCw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import { z } from "zod";
import { modelsAnalyticsSettingsSchema, modelsAnalyticsActivitySchema, modelsConsumptionSchema, type ModelsAnalyticsSettings } from "@openwork-ee/telemetry-contracts";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { AnalyticsAdoptionLink, AnalyticsEmptyState, analyticsSurfaceClass } from "../_features/analytics/analytics-layout";
import { StatCard } from "../_features/analytics/stat-card";
import { TrendChart } from "../_features/analytics/trend-chart";
import { DenNotice } from "../../_components/ui/notice";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTable } from "../../_components/ui/table";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type Activity = z.infer<typeof modelsAnalyticsActivitySchema>;
type Consumption = z.infer<typeof modelsConsumptionSchema>;
type Tab = "Activity" | "Consumption" | "Integrations";
function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) { const id = key(row); const group = groups.get(id); if (group) group.push(row); else groups.set(id, [row]); }
  return groups;
}
const formatCost = (value: number | null | undefined) => value === null || value === undefined ? "Unknown" : `$${value.toFixed(4)}`;

async function request(path: string, init?: RequestInit) {
  const { response, payload } = await requestJson(`/v1/inference/analytics/${path}`, init ?? { method: "GET" }, 12_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, "Could not load task analytics. Try again."));
  return payload;
}

function LangfuseSettings({ settings, refresh }: { settings: ModelsAnalyticsSettings; refresh: () => Promise<void> }) {
  const { runReauthableAction } = useOrgDashboard();
  const [host, setHost] = useState(settings.langfuseHost ?? "https://cloud.langfuse.com");
  const [region, setRegion] = useState(settings.langfuseHost === "https://us.cloud.langfuse.com" ? "us"
    : settings.langfuseHost && settings.langfuseHost !== "https://cloud.langfuse.com" ? "custom" : "eu");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function act(action: "test" | "connect" | "disconnect") {
    setBusy(true); setMessage(null);
    try {
      await runReauthableAction("models-analytics-export", async () => {
        await request(action === "disconnect" ? "langfuse" : `langfuse/${action}`, {
          method: action === "disconnect" ? "DELETE" : "POST",
          ...(action === "disconnect" ? {} : { body: JSON.stringify({ host, publicKey, secretKey }) }),
        });
      });
      setMessage(action === "test" ? "Connection verified." : action === "connect" ? "Connected. New task analytics will be sent to Langfuse." : "Langfuse disconnected.");
      if (action !== "test") { setPublicKey(""); setSecretKey(""); await refresh(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect to Langfuse."); }
    finally { setBusy(false); }
  }
  return <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
    <div>
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2ecff] text-[#6F3DFF]"><Plug className="h-5 w-5" aria-hidden="true" /></div>
      <DenSectionHeader title="Langfuse" description="Keep model activity alongside your team’s other traces. Connect an existing Langfuse project to export new task metadata." />
      <p className="mt-4 text-xs leading-5 text-[#637291]">Prompts, responses and file contents are excluded. Earlier activity is not exported. You can disconnect at any time.</p>
    </div>
    <div className="grid content-start gap-4 rounded-xl border border-[#edf0f5] bg-[#fafbfc] p-5">
      {settings.exportEnabled ? <>
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />Connected</p>
        <p className="break-all text-xs text-[#637291]">{settings.langfuseHost}</p>
        <DenButton variant="secondary" disabled={busy} onClick={() => void act("disconnect")}>Disconnect Langfuse</DenButton>
      </> : <>
        <div className="grid gap-1.5"><label htmlFor="langfuse-region" className="text-xs font-medium text-[#30405F]">Data region</label>
          <DenSelect id="langfuse-region" aria-label="Data region" value={region} onChange={(event) => {
            setRegion(event.target.value);
            if (event.target.value === "eu") setHost("https://cloud.langfuse.com");
            if (event.target.value === "us") setHost("https://us.cloud.langfuse.com");
            if (event.target.value === "custom") setHost("");
          }}><option value="eu">Europe</option><option value="us">United States</option><option value="custom">Self-hosted</option></DenSelect>
        </div>
        {region === "custom" ? <label className="grid gap-1.5 text-xs font-medium text-[#30405F]">Langfuse address<DenInput type="url" value={host} onChange={(event) => setHost(event.target.value)} placeholder="https://langfuse.example.com" /></label> : null}
        <label className="grid gap-1.5 text-xs font-medium text-[#30405F]">Public key<DenInput autoComplete="off" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="pk-lf-…" /></label>
        <label className="grid gap-1.5 text-xs font-medium text-[#30405F]">Secret key<DenInput type="password" autoComplete="new-password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} placeholder="sk-lf-…" /></label>
        <div className="flex flex-wrap gap-2"><DenButton variant="secondary" disabled={busy || !publicKey || !secretKey || !host} onClick={() => void act("test")}>Test connection</DenButton>
          <DenButton disabled={busy || !publicKey || !secretKey || !host} onClick={() => void act("connect")}>Connect Langfuse</DenButton></div>
      </>}
      {message ? <p role="status" className="text-sm leading-5 text-[#30405F]">{message}</p> : null}
    </div>
  </div>;
}

function modelName(value: string) {
  const model = Object.entries(INFERENCE_MODEL_ALIASES).find(([id, model]) => id === value || model.upstreamModel === value);
  return model ? model[1].displayName.replace(/^OpenWork:\s*/, "") : value;
}

function Outcome({ events }: { events: Activity["events"] }) {
  const status = events.find((event) => event.type.startsWith("task.") && event.status)?.status;
  const color = status === "completed" ? "bg-emerald-50 text-emerald-700" : status === "failed" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${color}`}>
    {status === "completed" ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <Clock3 className="h-3 w-3" aria-hidden="true" />}
    {status ?? "Model call recorded"}
  </span>;
}

export function ModelsAnalyticsPanel() {
  const { orgContext, activeOrg, runReauthableAction } = useOrgDashboard();
  const queryClient = useQueryClient();
  const key = ["models-analytics", orgContext?.organization.id];
  const settingsKey = [...key, "settings"];
  const settingsQuery = useQuery({
    queryKey: settingsKey, enabled: Boolean(orgContext?.organization.id), retry: false,
    queryFn: async () => modelsAnalyticsSettingsSchema.parse(await request("settings")),
  });
  const settings = settingsQuery.data;
  const [tab, setTab] = useState<Tab>("Activity");
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Activity | null>(null);
  const [extra, setExtra] = useState<Activity | null>(null);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState("model");
  const dataQuery = useQuery({
    queryKey: [...key, "data", days], enabled: settings?.enabled === true,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [events, usage] = await Promise.all([request(`activity?days=${days}`), request(`consumption?days=${days}`)]);
      return { activity: modelsAnalyticsActivitySchema.parse(events), consumption: modelsConsumptionSchema.parse(usage) };
    },
  });
  const activity = dataQuery.data?.activity;
  const consumption = dataQuery.data?.consumption;
  const busy = mutating || dataQuery.isFetching;
  const loading = !dataQuery.data && dataQuery.isPending;
  const memberName = (id: string) => orgContext?.members.find((member) => member.id === id)?.user.name ?? "Former member";
  async function refreshSettings() { await settingsQuery.refetch(); }
  async function choose(enabled: boolean) {
    setMutating(true); setError(null);
    try {
      await runReauthableAction("models-task-analytics", async () => {
        const updated = modelsAnalyticsSettingsSchema.parse(await request("settings", { method: "PATCH", body: JSON.stringify({ enabled, consentVersion: 1 }) }));
        // Cancel reads before clearing the consented view so late responses
        // cannot repopulate it after opting out.
        await queryClient.cancelQueries({ queryKey: [...key, "data"] });
        queryClient.removeQueries({ queryKey: [...key, "data"] });
        queryClient.setQueryData(settingsKey, updated);
        setSelected(null); setExtra(null);
      });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your choice."); }
    finally { setMutating(false); }
  }
  async function details(memberId: string, sessionId: string, taskId: string) {
    setError(null); setMutating(true);
    try { setSelected(modelsAnalyticsActivitySchema.parse(await request(`activity?${new URLSearchParams({ days: String(days), memberId, sessionId, taskId })}`))); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load this task."); }
    finally { setMutating(false); }
  }
  async function more() {
    const cursor = selected ? selected.next : extra ? extra.next : activity?.next;
    if (!cursor) return;
    setMutating(true); setError(null);
    try {
      const first = selected?.events[0];
      const query = new URLSearchParams({ days: String(days), ...cursor, ...(first ? { memberId: first.memberId, sessionId: first.sessionId, taskId: first.taskId } : {}) });
      const next = modelsAnalyticsActivitySchema.parse(await request(`activity?${query}`));
      if (selected) setSelected({ events: [...selected.events, ...next.events], next: next.next });
      else setExtra({ events: [...(extra?.events ?? []), ...next.events], next: next.next });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load more activity."); }
    finally { setMutating(false); }
  }
  if (settingsQuery.isError) return <DenNotice tone="error" message="Task analytics could not be loaded. Refresh this page to try again." />;
  if (!settings?.available || !settings.subscribed || !settings.modelsEnabled) return null;

  const unique = new Map([...(activity?.events ?? []), ...(extra?.events ?? [])].map((event) => [`${event.memberId}:${event.source}:${event.id}`, event]));
  const tasks = [...groupRows([...unique.values()], (event) => `${event.memberId}:${event.sessionId}:${event.taskId}`).values()];
  const usage = consumption?.groups ?? [];
  const groups = [...groupRows(usage, (group) => groupBy === "member" ? group.memberId : groupBy === "day" ? group.day : group.model ?? "Unknown model")].map(([id, rows]) => ({
    id, name: groupBy === "member" ? memberName(id) : groupBy === "model" ? modelName(id) : id,
    calls: rows.reduce((total, row) => total + row.calls, 0), incomplete: rows.reduce((total, row) => total + row.incompleteCalls, 0),
    tokens: rows.every((row) => row.inputTokens === null && row.outputTokens === null) ? null : rows.reduce((total, row) => total + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0),
    cost: rows.every((row) => row.costUsd === null) ? null : rows.reduce((total, row) => total + (row.costUsd ?? 0), 0),
  })).sort((a, b) => b.calls - a.calls);
  const calls = usage.reduce((total, row) => total + row.calls, 0);
  const incomplete = usage.reduce((total, row) => total + row.incompleteCalls, 0);
  const cost = usage.some((row) => row.costUsd !== null) ? usage.reduce((total, row) => total + (row.costUsd ?? 0), 0) : null;
  const tokens = usage.some((row) => row.inputTokens !== null || row.outputTokens !== null) ? usage.reduce((total, row) => total + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0) : null;
  const daysWithUsage = groupRows(usage, (row) => row.day);
  const daily = Array.from({ length: days + 1 }, (_, index) => {
    const day = new Date(Date.now() - (days - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, calls: (daysWithUsage.get(day) ?? []).reduce((sum, row) => sum + row.calls, 0) };
  });
  const message = error ?? (dataQuery.isError ? "Could not refresh analytics. Try again; any displayed data is from the last successful refresh." : null);
  const tabs: { value: Tab; label: string; icon: typeof ActivityIcon }[] = [
    { value: "Activity", label: "Activity", icon: ActivityIcon },
    { value: "Consumption", label: "Consumption", icon: Coins },
    { value: "Integrations", label: "Integrations", icon: Plug },
  ];
  return <section className="grid gap-5" data-testid="models-task-analytics" aria-label="Task analytics">
    {!settings.enabled ? <div className={`${analyticsSurfaceClass} grid gap-6 p-6 sm:grid-cols-[1fr_220px]`}>
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f2ecff] px-2.5 py-1 text-xs font-medium text-[#6F3DFF]"><Sparkles className="h-3 w-3" aria-hidden="true" />Included with OpenWork Models</span>
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-[#07192C]">Unlock custom insights</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[#637291]">See model usage, costs, task activity, and the skills and tools your team uses. Would you like to turn on analytics for your team’s tasks in OpenWork?</p>
        <p className="mt-2 text-xs leading-5 text-[#637291]">Prompts, responses and file contents are excluded. Workspace admins can view the analytics. Collection starts when you enable it, and you can turn it off at any time.</p>
        {settings.consentedAt ? <p className="mt-3 text-sm text-[#637291]">Task analytics is off. You can keep using OpenWork Models as usual.</p> : null}
        <div className="mt-5 flex flex-wrap gap-2"><DenButton disabled={mutating} onClick={() => void choose(true)}>Enable task analytics</DenButton>
          {!settings.consentedAt ? <DenButton variant="secondary" disabled={mutating} onClick={() => void choose(false)}>Not now</DenButton> : null}</div>
      </div>
      <div className="flex flex-col justify-center gap-4 rounded-xl bg-[#faf9fd] p-5 text-sm text-[#30405F]">
        <p className="flex items-center gap-2"><ActivityIcon className="h-4 w-4 text-[#6F3DFF]" />Task and tool activity</p>
        <p className="flex items-center gap-2"><Coins className="h-4 w-4 text-[#6F3DFF]" />Model consumption</p>
        <p className="flex items-center gap-2"><Plug className="h-4 w-4 text-[#6F3DFF]" />Optional Langfuse export</p>
      </div>
    </div> : <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold tracking-tight text-[#07192C]">Task analytics</h2>
          <p className="mt-1 text-xs text-[#637291]">OpenWork Models only · Included with your subscription</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Analytics on</span>
          <DenButton variant="ghost" size="sm" disabled={mutating} onClick={() => void choose(false)}>Turn off analytics</DenButton>
        </div>
      </div>
      <UnderlineTabs tabs={tabs} activeTab={tab} onChange={(value) => { setTab(value); setSelected(null); }} />
      {tab !== "Integrations" ? <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <DenSelect aria-label="Analytics period" className="h-9 w-40" value={String(days)} onChange={(event) => { setDays(Number(event.target.value)); setExtra(null); setSelected(null); }}>
              <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
            </DenSelect>
            {tab === "Consumption" ? <DenSelect aria-label="Group consumption by" className="h-9 w-40" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
              <option value="model">By model</option><option value="member">By member</option><option value="day">By day</option>
            </DenSelect> : null}
          </div>
          <div className="flex items-center gap-3"><span className="text-xs text-[#637291]">Updates automatically</span>
            <DenButton variant="secondary" size="sm" disabled={busy} onClick={() => { setExtra(null); void dataQuery.refetch(); }}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${dataQuery.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />Refresh analytics</DenButton>
          </div>
        </div>
        {!dataQuery.isError || dataQuery.data ? <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={<Zap className="text-[#6F3DFF]" />} title="Model calls" value={loading ? "…" : calls.toLocaleString()} sub={`Last ${days} days`} tone="violet" />
          <StatCard icon={<Coins className="text-[#1D63FF]" />} title="Reported cost" value={loading ? "…" : formatCost(cost)} sub={incomplete ? "Partial · some calls have no accounting" : "Provider-reported, not your invoice"} tone="blue" />
          <StatCard icon={<Layers className="text-[#B7791F]" />} title="Reported tokens" value={loading ? "…" : tokens?.toLocaleString() ?? "Unknown"} sub={incomplete ? "Partial · some calls have no accounting" : "Input and output tokens"} tone="amber" />
          <StatCard icon={<Sparkles className="text-[#18A34A]" />} title="Models used" value={loading ? "…" : new Set(usage.flatMap((row) => row.model ? [row.model] : [])).size.toLocaleString()} sub="Through OpenWork Models" tone="green" />
        </div> : null}
      </> : null}
      {tab === "Activity" ? <div className={`${analyticsSurfaceClass} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-[#edf0f5] px-5 py-4">
          <div><h3 className="text-sm font-semibold text-[#07192C]">{selected ? "Task details" : "Recent activity"}</h3><p className="mt-1 text-xs text-[#637291]">{selected ? "Model calls, skills and tools in this task" : "New tasks since analytics was enabled"}</p></div>
          {selected ? <DenButton variant="ghost" size="sm" onClick={() => setSelected(null)}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Back to activity</DenButton> : null}
        </div>
        {selected ? <DenTable headerTone="plain" rows={selected.events} getRowKey={(event) => `${event.source}:${event.memberId}:${event.id}`} columns={[
          { key: "event", header: "Activity", render: (event) => <span className="text-sm text-[#30405F]">{event.type.replaceAll(".", " ")}</span> },
          { key: "detail", header: "Details", render: (event) => <div className="max-w-sm break-words text-sm text-[#30405F]">{event.model ? modelName(event.model) : event.skill ?? event.tool ?? "Task"}{event.skillVersion ? ` (${event.skillVersion})` : ""}{event.mcp ? <p className="mt-1 text-xs text-[#637291]">{event.mcp}</p> : null}{event.metadata ? <p className="mt-1 text-xs text-[#637291]">{Object.entries(event.metadata).map(([key, value]) => `${key}: ${value}`).join(", ")}</p> : null}</div> },
          { key: "duration", header: "Duration", align: "right", render: (event) => <span className="whitespace-nowrap text-sm tabular-nums">{event.durationMs === undefined ? "—" : `${(event.durationMs / 1_000).toFixed(1)}s`}</span> },
          { key: "cost", header: "Cost", align: "right", render: (event) => <span className="text-sm tabular-nums">{event.type === "model.call" ? formatCost(event.costUsd) : "—"}</span> },
        ]} /> : loading ? <p role="status" className="px-5 py-12 text-center text-sm text-[#637291]">Loading activity…</p> : dataQuery.isError && !dataQuery.data ? null : tasks.length ? <DenTable headerTone="plain" rows={tasks} getRowKey={(events) => `${events[0].memberId}:${events[0].sessionId}:${events[0].taskId}`} columns={[
          { key: "task", header: "Task", render: (events) => <button className="text-left text-sm font-medium text-[#07192C] hover:text-[#6F3DFF]" onClick={() => void details(events[0].memberId, events[0].sessionId, events[0].taskId)}>
            {events.some((event) => event.type === "skill.loaded") ? "Task with skills" : "Model task"}<span className="mt-1 block text-xs font-normal text-[#637291]">{new Date(events[0].timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></button> },
          { key: "member", header: "Member", render: (events) => <span className="text-sm text-[#30405F]">{memberName(events[0].memberId)}</span> },
          { key: "status", header: "Outcome", render: (events) => <Outcome events={events} /> },
          { key: "models", header: "Models", render: (events) => <span className="text-sm text-[#637291]">{[...new Set(events.flatMap((event) => event.model ? [modelName(event.model)] : []))].join(", ") || "—"}</span> },
        ]} /> : <AnalyticsEmptyState title="Your next OpenWork Models task appears here" action={<AnalyticsAdoptionLink orgSlug={activeOrg?.slug} />}>
          <p>Choose a model from <strong className="font-medium text-[#30405F]">OpenWork Models</strong> in the desktop model picker, then run a new task. This page refreshes automatically.</p>
          <p className="mt-2">Tasks using your own provider connections are covered by Usage &amp; adoption. Model costs here cover OpenWork Models only.</p>
        </AnalyticsEmptyState>}
        {(selected ? selected.next : extra ? extra.next : activity?.next) ? <div className="border-t border-[#edf0f5] p-4"><DenButton variant="secondary" size="sm" disabled={busy} onClick={() => void more()}>{selected ? "Load more events" : "Load more activity"}</DenButton></div> : null}
      </div> : null}
      {tab === "Consumption" ? <>
        {loading ? <p role="status" className="py-12 text-center text-sm text-[#637291]">Loading consumption…</p> : dataQuery.isError && !dataQuery.data ? null : !usage.length ? <div className={analyticsSurfaceClass}><AnalyticsEmptyState title="No model usage recorded yet">Run a new task with OpenWork Models to see its model calls and provider-reported consumption. Usage from your own provider accounts is not included here.</AnalyticsEmptyState></div> : <>
          <TrendChart title="Model calls over time" subtitle={`Daily calls · Last ${days} days · UTC`} intervalLabel="" weeks={daily.map(({ day }) => ({ weekStart: day }))} series={[{ label: "Model calls", color: "#6F3DFF", values: daily.map((row) => row.calls) }]} />
          <div className={`${analyticsSurfaceClass} overflow-hidden`}>
            <div className="border-b border-[#edf0f5] px-5 py-4"><h3 className="text-sm font-semibold text-[#07192C]">Consumption by {groupBy}</h3><p className="mt-1 text-xs text-[#637291]">Reported usage for OpenWork Models</p></div>
            <DenTable headerTone="plain" rows={groups} getRowKey={(group) => group.id} emptyLabel={loading ? "Loading consumption…" : "Consumption is unavailable."} columns={[
              { key: "name", header: groupBy, render: (group) => <span className="text-sm font-medium text-[#30405F]">{group.name}</span> },
              { key: "calls", header: "Calls", align: "right", render: (group) => <span className="text-sm tabular-nums">{group.calls.toLocaleString()}</span> },
              { key: "tokens", header: "Reported tokens", align: "right", render: (group) => <span className="text-sm tabular-nums">{group.tokens?.toLocaleString() ?? "Unknown"}</span> },
              { key: "cost", header: "Reported cost", align: "right", render: (group) => <span className="text-sm font-medium tabular-nums">{formatCost(group.cost)}</span> },
              { key: "incomplete", header: "Incomplete usage", align: "right", render: (group) => <span className={group.incomplete ? "text-xs text-amber-700" : "text-xs text-[#637291]"}>{group.incomplete ? `${group.incomplete} calls` : "Complete"}</span> },
            ]} />
          </div>
        </>}
        <p className="text-xs leading-5 text-[#637291]">Missing accounting stays unknown. Reported totals may be partial when a call is interrupted. Your subscription’s shared usage limits are shown above.</p>
      </> : null}
      {tab === "Integrations" ? <div className={`${analyticsSurfaceClass} p-5 sm:p-6`}><LangfuseSettings settings={settings} refresh={refreshSettings} /></div> : null}
      <p className="flex items-start gap-2 text-xs leading-5 text-[#637291]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />Activity metadata only. Prompts, responses and file contents are excluded. Earlier tasks are not imported.</p>
    </>}
    {message ? <DenNotice tone="error" message={message} /> : null}
  </section>;
}
