"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { modelsAnalyticsSettingsSchema, modelsAnalyticsActivitySchema, modelsConsumptionSchema, type ModelsAnalyticsSettings } from "@openwork-ee/telemetry-contracts";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
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
  const inputClass = "mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm";
  return <div className="grid gap-4">
    <DenSectionHeader title="Langfuse" description="Send new task activity and model usage to your Langfuse project. Prompts, responses and file contents are excluded." />
    {settings.exportEnabled ? <>
      <p className="text-sm text-gray-600">Connected to {settings.langfuseHost}</p>
      <DenButton variant="secondary" disabled={busy} onClick={() => void act("disconnect")}>Disconnect Langfuse</DenButton>
    </> : <>
      <label className="text-sm">Data region<select className={inputClass} value={region} onChange={(event) => {
        setRegion(event.target.value);
        if (event.target.value === "eu") setHost("https://cloud.langfuse.com");
        if (event.target.value === "us") setHost("https://us.cloud.langfuse.com");
        if (event.target.value === "custom") setHost("");
      }}><option value="eu">Europe</option><option value="us">United States</option><option value="custom">Self-hosted</option></select></label>
      {region === "custom" ? <label className="text-sm">Langfuse address<input className={inputClass} type="url" value={host} onChange={(event) => setHost(event.target.value)} placeholder="https://langfuse.example.com" /></label> : null}
      <label className="text-sm">Public key<input className={inputClass} autoComplete="off" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} /></label>
      <label className="text-sm">Secret key<input className={inputClass} type="password" autoComplete="new-password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} /></label>
      <div className="flex gap-2"><DenButton variant="secondary" disabled={busy || !publicKey || !secretKey || !host} onClick={() => void act("test")}>Test connection</DenButton>
        <DenButton disabled={busy || !publicKey || !secretKey || !host} onClick={() => void act("connect")}>Connect Langfuse</DenButton></div>
    </>}
    {message ? <p role="status" className="text-sm text-gray-600">{message}</p> : null}
  </div>;
}

export function ModelsAnalyticsPanel() {
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const [settings, setSettings] = useState<ModelsAnalyticsSettings | null>(null);
  const [tab, setTab] = useState<Tab>("Activity");
  const [days, setDays] = useState(30);
  const [activity, setActivity] = useState<Activity>({ events: [], next: null });
  const [consumption, setConsumption] = useState<Consumption>({ groups: [] });
  const [selected, setSelected] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState("model");
  const memberName = (id: string) => orgContext?.members.find((member) => member.id === id)?.user.name ?? "Former member";
  async function refreshSettings() { setSettings(modelsAnalyticsSettingsSchema.parse(await request("settings"))); }
  useEffect(() => {
    let mounted = true;
    void request("settings").then((payload) => { if (mounted) setSettings(modelsAnalyticsSettingsSchema.parse(payload)); }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  async function load() {
    setBusy(true); setError(null); setSelected(null);
    try {
      const [events, usage] = await Promise.all([request(`activity?days=${days}`), request(`consumption?days=${days}`)]);
      setActivity(modelsAnalyticsActivitySchema.parse(events)); setConsumption(modelsConsumptionSchema.parse(usage));
    } catch (error) { setActivity({ events: [], next: null }); setConsumption({ groups: [] }); setError(error instanceof Error ? error.message : "Could not load analytics."); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (settings?.enabled) void load(); }, [settings?.enabled, days]);

  async function choose(enabled: boolean) {
    setBusy(true); setError(null);
    try {
      await runReauthableAction("models-task-analytics", async () => {
        const updated = modelsAnalyticsSettingsSchema.parse(await request("settings", { method: "PATCH", body: JSON.stringify({ enabled, consentVersion: 1 }) }));
        setSettings(updated); setSelected(null); setActivity({ events: [], next: null }); setConsumption({ groups: [] });
      });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your choice."); }
    finally { setBusy(false); }
  }
  async function details(memberId: string, sessionId: string, taskId: string) {
    setError(null);
    try { setSelected(modelsAnalyticsActivitySchema.parse(await request(`activity?${new URLSearchParams({ days: String(days), memberId, sessionId, taskId })}`))); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load this task."); }
  }
  async function more() {
    const cursor = selected?.next ?? activity.next;
    if (!cursor) return;
    setBusy(true);
    try {
      const first = selected?.events[0];
      const query = new URLSearchParams({ days: String(days), ...cursor, ...(first ? { memberId: first.memberId, sessionId: first.sessionId, taskId: first.taskId } : {}) });
      const next = modelsAnalyticsActivitySchema.parse(await request(`activity?${query}`));
      if (selected) setSelected({ events: [...selected.events, ...next.events], next: next.next });
      else setActivity({ events: [...activity.events, ...next.events], next: next.next });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load more activity."); }
    finally { setBusy(false); }
  }
  if (!settings?.available || !settings.subscribed || !settings.modelsEnabled) return null;

  const tasks = [...groupRows(activity.events, (event) => `${event.memberId}:${event.sessionId}:${event.taskId}`).values()];
  const groups = [...groupRows(consumption.groups, (group) => groupBy === "member" ? group.memberId : groupBy === "day" ? group.day : group.model ?? "Unknown model")].map(([id, rows]) => ({
    id, name: groupBy === "member" ? memberName(id) : id, calls: rows.reduce((total, row) => total + row.calls, 0), incomplete: rows.reduce((total, row) => total + row.incompleteCalls, 0),
    tokens: rows.every((row) => row.inputTokens === null && row.outputTokens === null) ? null : rows.reduce((total, row) => total + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0),
    cost: rows.every((row) => row.costUsd === null) ? null : rows.reduce((total, row) => total + (row.costUsd ?? 0), 0),
  }));
  return <DenCard className="grid gap-5" data-testid="models-task-analytics">
    <DenSectionHeader title="Task analytics" description="Included with OpenWork Models" />
    {error ? <DenNotice tone="error" message={error} /> : null}
    {!settings.enabled ? <>
      <div><h3 className="text-lg font-medium text-gray-950">Unlock custom insights</h3>
        <p className="mt-2 text-sm leading-6 text-gray-600">Would you like to turn on analytics for your team’s tasks in OpenWork? See model usage, costs, task activity, and the skills and tools your team uses.</p>
        <p className="mt-2 text-sm leading-6 text-gray-600">This collects activity metadata for OpenWork Models from the moment you enable it. Prompts, responses and file contents are excluded. Workspace admins can view the analytics. You can turn it off at any time.</p>
      </div>
      {settings.consentedAt ? <p className="text-sm text-gray-500">Task analytics is off. You can keep using OpenWork Models as usual.</p> : null}
      <div className="flex gap-2"><DenButton disabled={busy} onClick={() => void choose(true)}>Enable task analytics</DenButton>
        {!settings.consentedAt ? <DenButton variant="secondary" disabled={busy} onClick={() => void choose(false)}>Not now</DenButton> : null}</div>
    </> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label="Task analytics">
          {(["Activity", "Consumption", "Integrations"] satisfies Tab[]).map((name) => <DenButton key={name} role="tab" aria-selected={tab === name} variant={tab === name ? "primary" : "ghost"} size="sm" onClick={() => { setTab(name); setSelected(null); }}>{name}</DenButton>)}
        </div>
        <DenButton variant="ghost" size="sm" disabled={busy} onClick={() => void choose(false)}>Turn off analytics</DenButton>
      </div>
      {tab !== "Integrations" ? <div className="flex gap-3">
        <label className="text-sm text-gray-600">Period <select aria-label="Analytics period" value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-lg border border-gray-200 p-2"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label>
        <DenButton variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Refresh analytics</DenButton>
      </div> : null}
      {tab === "Activity" ? selected ? <>
        <DenButton variant="ghost" onClick={() => setSelected(null)}>Back to activity</DenButton>
        <DenTable rows={selected.events} getRowKey={(event) => `${event.source}:${event.memberId}:${event.id}`} columns={[
          { key: "event", header: "Activity", render: (event) => event.type.replaceAll(".", " ") },
          { key: "detail", header: "Details", render: (event) => <span>{event.model ?? event.skill ?? event.tool ?? "Task"}{event.skillVersion ? ` (${event.skillVersion})` : ""}{event.mcp ? ` · ${event.mcp}` : ""}{event.metadata ? ` · ${Object.entries(event.metadata).map(([key, value]) => `${key}: ${value}`).join(", ")}` : ""}</span> },
          { key: "duration", header: "Duration", render: (event) => event.durationMs === undefined ? "—" : `${(event.durationMs / 1_000).toFixed(1)}s` },
          { key: "cost", header: "Cost", render: (event) => event.type === "model.call" ? formatCost(event.costUsd) : "—" },
        ]} />
        {selected.next ? <DenButton variant="secondary" disabled={busy} onClick={() => void more()}>Load more events</DenButton> : null}
      </> : <>
        <DenTable rows={tasks} getRowKey={(events) => `${events[0].memberId}:${events[0].sessionId}:${events[0].taskId}`} emptyLabel={busy ? "Loading activity…" : "No task activity yet. New tasks using OpenWork Models will appear here."} columns={[
          { key: "task", header: "Task", render: (events) => <button className="text-left text-gray-950 underline" onClick={() => void details(events[0].memberId, events[0].sessionId, events[0].taskId)}>Task · {new Date(events[0].timestamp).toLocaleString()}</button> },
          { key: "member", header: "Member", render: (events) => memberName(events[0].memberId) },
          { key: "status", header: "Outcome", render: (events) => events.find((event) => ["task.completed", "task.failed", "task.cancelled"].includes(event.type))?.status ?? "Not reported" },
          { key: "models", header: "Models", render: (events) => [...new Set(events.flatMap((event) => event.model ? [event.model] : []))].join(", ") || "—" },
        ]} />
        {activity.next ? <DenButton variant="secondary" disabled={busy} onClick={() => void more()}>Load more activity</DenButton> : null}
      </> : null}
      {tab === "Consumption" ? <>
        <label className="text-sm">Group by <select aria-label="Group consumption by" className="rounded-lg border border-gray-200 p-2" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="model">Model</option><option value="member">Member</option><option value="day">Day</option></select></label>
        <DenTable rows={groups} getRowKey={(group) => group.id} emptyLabel="No model usage recorded yet." columns={[
          { key: "name", header: groupBy, render: (group) => group.name }, { key: "calls", header: "Calls", render: (group) => group.calls },
          { key: "tokens", header: "Reported tokens", render: (group) => group.tokens?.toLocaleString() ?? "Unknown" },
          { key: "cost", header: "Reported cost", render: (group) => formatCost(group.cost) },
          { key: "incomplete", header: "Incomplete usage", render: (group) => group.incomplete },
        ]} />
        <p className="text-xs text-gray-500">Provider-reported usage for OpenWork Models. Interrupted calls may have incomplete usage. These analytics are separate from your subscription’s usage limits.</p>
      </> : null}
      {tab === "Integrations" ? <LangfuseSettings settings={settings} refresh={refreshSettings} /> : null}
    </>}
  </DenCard>;
}
