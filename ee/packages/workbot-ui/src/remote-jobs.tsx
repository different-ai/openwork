"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, Lock, Monitor } from "lucide-react";
import { workbotRemoteJobsSchema, workbotRemoteJobDetailSchema, workbotRemoteJobStopSchema, type WorkbotRemoteJob, type WorkbotRemoteJobs } from "@openwork/types/workbot-remote-jobs";
import { inChat, useWorkbotChat } from "./data";
import { errorMessage, workbotHost } from "./host";

export type { WorkbotRemoteJob, WorkbotRemoteJobs } from "@openwork/types/workbot-remote-jobs";

/** Keep the last verified state through a failed status read, explicitly marked unverified. */
export function retainRemoteStatuses(next: WorkbotRemoteJobs, previous?: WorkbotRemoteJobs): WorkbotRemoteJobs {
  return { ...next, jobs: next.jobs.map(job => {
    if (!job.stale || job.status) return job;
    const before = previous?.jobs.find(entry => entry.key === job.key);
    return before?.status ? { ...job, status: before.status, stale: true } : job;
  }) };
}

/** One member-scoped read, shared by header and profile. Off unless its host feature is enabled. */
export function useWorkbotRemoteJobs(enabled: boolean) {
  const chat = useWorkbotChat();
  const queryClient = useQueryClient();
  const allowed = enabled && workbotHost().remoteTasks === true;
  const key = ["workbot", "remote-jobs", workbotHost().identity, chat ?? "main"];
  const query = useQuery({
    queryKey: key,
    enabled: allowed,
    queryFn: async () => {
      if (workbotHost().remoteTasks !== true) return { jobs: [], hasEarlier: false };
      const { response, payload } = await workbotHost().requestJson(inChat("/v1/workbot/remote-jobs", chat), { method: "GET" }, 30_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't check remote tasks. Try again."));
      return retainRemoteStatuses(workbotRemoteJobsSchema.parse(payload), queryClient.getQueryData<WorkbotRemoteJobs>(key));
    },
    staleTime: 5_000,
    refetchInterval: allowed ? 15_000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const unverified = query.isError || Date.now() - query.dataUpdatedAt > 45_000;
  const data = query.data && unverified ? { ...query.data, jobs: query.data.jobs.map(job => ({ ...job, stale: true })) } : query.data;
  return { ...query, data: allowed ? data : undefined };
}

/** Unknown/stale work never holds the header at “working”; waiting stays distinct from running. */
export function remoteJobActive(job: WorkbotRemoteJob) {
  return !job.stale && (job.status?.state === "starting" || job.status?.state === "running" || job.status?.state === "waiting");
}

/** Header integration: choose the latest live remote job when there is no foreground answer. */
export function remoteJobActivity(jobs: WorkbotRemoteJob[]) {
  const job = jobs.find(remoteJobActive);
  if (!job) return null;
  return { key: job.key, title: job.title, label: job.status?.state === "waiting" ? `${job.title} · needs you` : job.title, since: job.startedAt, waiting: job.status?.state === "waiting" };
}

/** Only explicit pure-watcher ids, from stored calls, may be suppressed. Never compare job titles. */
export function remoteWatcherTaskIds(jobs: WorkbotRemoteJob[]) {
  return new Set(jobs.flatMap(job => job.watcherTaskIds));
}

export function remoteJobStateLabel(job: WorkbotRemoteJob) {
  if (job.stale) return job.status ? "Couldn't verify now" : "Not checked";
  switch (job.status?.state) {
    case "starting": return "Waiting for computer";
    case "running": return "Working";
    case "waiting": return job.status.waitingFor === "permission" ? "Needs approval" : "Needs your answer";
    case "idle": return "Finished";
    case "error": return "Couldn't finish";
    default: return "Not checked";
  }
}

function remoteElapsed(startedAt: number | null) {
  if (startedAt === null) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  return minutes < 1 ? "Just started" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function RemoteJobTranscript({ job }: { job: WorkbotRemoteJob }) {
  const chat = useWorkbotChat();
  const queryClient = useQueryClient();
  const path = `/v1/workbot/remote-jobs/${encodeURIComponent(job.key)}`;
  const detail = useQuery({
    queryKey: ["workbot", "remote-job-detail", workbotHost().identity, chat ?? "main", job.key],
    enabled: workbotHost().remoteTasks === true,
    queryFn: async () => {
      const { response, payload } = await workbotHost().requestJson(inChat(path, chat), { method: "GET" }, 55_000);
      if (!response.ok) throw new Error("Couldn't read this task. Check the remote session or try again.");
      return workbotRemoteJobDetailSchema.parse(payload);
    },
    retry: false,
    staleTime: 10_000,
  });
  const stop = useMutation({
    mutationFn: async (messageId: string) => {
      const { response, payload } = await workbotHost().requestJson(inChat(`${path}/stop`, chat), { method: "POST", body: JSON.stringify({ messageId }) }, 55_000);
      if (!response.ok) throw new Error("Couldn't confirm the stop. Check the remote session before trying again.");
      return workbotRemoteJobStopSchema.parse(payload);
    },
    retry: false,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["workbot", "remote-jobs"] }); void detail.refetch(); },
  });
  const button = "w-fit rounded-full px-3 py-1.5 text-[12px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-50";
  return <>
    <h3 className="font-medium text-[var(--wb-text)]">Latest messages</h3>
    {detail.isPending ? <div aria-busy="true" aria-label="Reading latest messages" className="flex flex-col gap-2"><span className="h-8 rounded bg-[var(--wb-chip)]" /><span className="h-8 rounded bg-[var(--wb-chip)]" /></div>
      : detail.isError ? <p role="status">{detail.error.message} <button type="button" className="underline" onClick={() => void detail.refetch()}>Try again</button></p>
      : detail.data?.state === "pending" ? <p>The computer hasn&apos;t sent the messages yet. <button type="button" className="underline" onClick={() => void detail.refetch()}>Check again</button></p>
      : detail.data?.state === "unavailable" ? <p>Messages aren&apos;t available here. Open the remote session to read them.</p>
      : detail.data?.messages.length ? <ol className="flex flex-col gap-3">{detail.data.messages.map(message => <li key={message.id}><span className="text-[12px] font-medium">{message.role === "user" ? "You" : "Workbot"}</span><p className="whitespace-pre-wrap break-words text-[var(--wb-text)]">{message.text || "No text in this message."}</p></li>)}</ol>
      : <p>No messages have arrived yet.</p>}
    {stop.isError ? <p role="status">{stop.error.message}</p>
      : stop.data ? <p role="status">{stop.data.state === "stopped" ? "Stopped." : stop.data.state === "pending" ? "Stop requested. The computer hasn't confirmed yet." : stop.data.reason === "different_turn" ? "A newer request is running. It wasn't stopped. Read the latest messages first." : "The stop wasn't confirmed. Check the remote session."}</p>
      : detail.data?.canStop && detail.data.messageId && remoteJobActive(job) && job.status?.state !== "starting" ? <button type="button" className={button} disabled={stop.isPending || job.stale} onClick={() => { if (detail.data?.messageId) stop.mutate(detail.data.messageId); }}>{stop.isPending ? "Stopping…" : "Stop task"}</button> : null}
  </>;
}

function RemoteJobRow({ job }: { job: WorkbotRemoteJob }) {
  const [open, setOpen] = useState(false);
  const state = job.status?.state;
  const Icon = job.stale ? CircleAlert : state === "waiting" ? Lock : state === "idle" ? Check : state === "error" ? CircleAlert : state === "starting" ? Clock3 : Monitor;
  const pending = job.status?.pending;
  const checkedAt = job.status?.observedAt;
  return <li className="border-b border-[var(--wb-row-line)] last:border-b-0" data-workbot-remote-job={job.key}>
    <details className="group" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex min-h-12 cursor-pointer list-none items-start gap-3 py-2 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] [&::-webkit-details-marker]:hidden">
        <Icon size={15} strokeWidth={1.6} className="mt-0.5 shrink-0 text-[var(--wb-muted)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2"><span className="truncate text-[13.5px] text-[var(--wb-text)]">{job.title}</span><span className="shrink-0 text-[12px] text-[var(--wb-muted)]">{remoteJobStateLabel(job)}</span></span>
          <span className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-[var(--wb-muted)]"><span className="truncate">{job.status?.computerLabel ?? (job.target === "cloud" ? "Cloud computer" : "Your computer")}</span>{remoteJobActive(job) ? <span className="shrink-0">{remoteElapsed(job.startedAt)}</span> : null}</span>
          {job.status?.latestStep ? <span className="mt-0.5 block truncate text-[12px] text-[var(--wb-muted)]">{job.status.latestStep}</span> : null}
        </span>
        <ChevronRight size={13} aria-hidden className="mt-1 shrink-0 text-[var(--wb-muted)] transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <div className="flex flex-col gap-2 pb-3 pl-7 text-[13px] leading-[19px] text-[var(--wb-muted)]">
        {job.status?.latestStep ? <><h3 className="font-medium text-[var(--wb-text)]">Latest reported step</h3><ul><li className="flex items-start gap-2">{state === "idle" ? <Check size={13} aria-label="Finished" className="mt-0.5 shrink-0" /> : <Monitor size={13} aria-label={job.stale ? "Last reported" : "In progress"} className="mt-0.5 shrink-0" />}<span className="whitespace-pre-wrap break-words">{job.status.latestStep}</span></li></ul></> : null}
        {job.stale && job.status ? <p>Last checked: {checkedAt ? new Date(checkedAt).toLocaleString() : "Time unavailable"}. Last known state: {job.status.state === "idle" ? "finished" : job.status.state === "error" ? "couldn't finish" : job.status.state === "waiting" ? "waiting for you" : job.status.state === "starting" ? "waiting for computer" : "working"}.</p> : null}
        {state === "waiting" ? <>
          {pending ? <p className="whitespace-pre-wrap break-words text-[var(--wb-text)]">{pending.kind === "permission" ? pending.title : pending.question}</p> : null}
          <p>Open {job.target === "cloud" ? "the remote session in OpenWork Web" : "the session on your computer"} to review and answer. Nothing has been approved here.</p>
        </> : null}
        {state === "idle" && job.status?.preview ? <p className="whitespace-pre-wrap break-words text-[var(--wb-text)]">{job.status.preview}</p> : null}
        {state === "error" ? <p>Open the remote session to check what happened before trying again.</p> : null}
        {job.stale && !job.status ? <p>Couldn&apos;t verify this task. Open the remote session to check its progress.</p> : null}
        {open ? <RemoteJobTranscript job={job} /> : null}
      </div>
    </details>
  </li>;
}

/** Task introspection on disclosure; Stop is an explicit, guarded user action. No approval or automatic navigation. */
export function RemoteJobs({ jobs }: { jobs: WorkbotRemoteJob[] }) {
  if (workbotHost().remoteTasks !== true || !jobs.length) return null;
  return <section className="px-5 pt-3" aria-label="Remote tasks">
    <h2 className="pb-1 text-[13px] font-medium text-[var(--wb-text)]">Remote tasks</h2>
    <ul>{jobs.map(job => <RemoteJobRow key={job.key} job={job} />)}</ul>
  </section>;
}
