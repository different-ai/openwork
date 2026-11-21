import type {
  AdminComputerDetail,
  AdminComputerFleet,
  ComputerFleetAttention,
  ComputerFleetEvent,
  ComputerFleetHistoryBucket,
  ComputerFleetHistoryRange,
  ComputerFleetSandbox,
  ComputerFleetSource,
  ComputerFleetState,
  ComputerFleetTotals,
} from "@openwork/types/den/admin-computer-fleet";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TEN_MINUTES_MS = 10 * MINUTE_MS;

export const STATE_LABEL: Record<ComputerFleetState, string> = {
  starting: "Starting",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  stopped: "Stopped",
  stopping: "Stopping",
  failed: "Failed",
  unknown: "Unknown",
};

export const ATTENTION_LABEL: Record<ComputerFleetAttention, string> = {
  failed: "Failed in the last day",
  stuck_starting: "Stuck starting",
  stuck_pausing: "Stuck pausing",
  stuck_stopping: "Stuck stopping",
  expired: "Past its expiry",
  idle_running: "Running unused",
  long_running: "Awake most of its life",
};

const count = (value: number) => value.toLocaleString("en-US");

export function formatAge(iso: string | null, now: number): string {
  if (iso === null) return "Not reported";
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "Not reported";
  if (elapsed < MINUTE_MS) return "Just now";
  if (elapsed < HOUR_MS) return `${count(Math.floor(elapsed / MINUTE_MS))} min ago`;
  if (elapsed < 48 * HOUR_MS) return `${count(Math.floor(elapsed / HOUR_MS))} h ago`;
  return `${count(Math.floor(elapsed / (24 * HOUR_MS)))} d ago`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "Not known";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${count(days)} d` : `${count(days)} d ${hours % 24} h`;
}

export function formatSpan(seconds: number): string {
  const unit = (value: number, name: string) => `${count(value)} ${name}${value === 1 ? "" : "s"}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return unit(seconds / 86_400, "day");
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, "minute");
  if (seconds < 120) return unit(seconds, "second");
  if (seconds < 2 * 3600) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 2 * 86_400) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
}

export function stateDuration(sandbox: Pick<ComputerFleetSandbox, "lastChangedAt" | "state" | "pausedAt" | "source">, now: number): string | null {
  if (sandbox.source === "direct" && sandbox.state === "running") return null;
  const since = Date.parse((sandbox.state === "paused" ? sandbox.pausedAt : null) ?? sandbox.lastChangedAt ?? "");
  return Number.isFinite(since) && now >= since ? formatDuration(now - since) : null;
}

export function imageLabel(sandbox: Pick<ComputerFleetSandbox, "image" | "imageCurrent">): "Current" | "Older" | "Not known" {
  if (sandbox.imageCurrent === true) return "Current";
  if (sandbox.imageCurrent === false) return "Older";
  return "Not known";
}

export function formatSize(sandbox: Pick<ComputerFleetSandbox, "cpu" | "memoryMb">): string {
  const parts = [
    sandbox.cpu === null ? null : `${count(sandbox.cpu)} CPU`,
    sandbox.memoryMb === null ? null : `${(sandbox.memoryMb / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "Not reported";
}

export const SOURCE_NAME: Record<ComputerFleetSource["source"], string> = { gateway: "Sandbox gateway", direct: "Direct provider" };

export function formatPlace(sandbox: Pick<ComputerFleetSandbox, "source" | "provider" | "pool" | "backend" | "region">): string {
  if (sandbox.source === "direct") return sandbox.provider;
  const pool = sandbox.pool ?? sandbox.backend ?? sandbox.provider;
  return sandbox.region ? `${pool}, ${sandbox.region}` : pool;
}

export type ListFilter = "attention" | "running" | "all";

export function filterSandboxes(sandboxes: readonly ComputerFleetSandbox[], filter: ListFilter): ComputerFleetSandbox[] {
  if (filter === "attention") return sandboxes.filter((sandbox) => sandbox.attention !== null);
  if (filter === "running") return sandboxes.filter((sandbox) => sandbox.state === "running" || sandbox.state === "starting" || sandbox.state === "pausing" || sandbox.state === "stopping");
  return [...sandboxes];
}

export const defaultFilter = (listed: readonly Pick<ComputerFleetSandbox, "attention">[]): ListFilter => (listed.some((sandbox) => sandbox.attention !== null) ? "attention" : "all");

export type StateShare = { state: ComputerFleetState; count: number; share: number };
const BAR_STATES: Array<Exclude<ComputerFleetState, "unknown">> = ["running", "starting", "pausing", "stopping", "paused", "stopped", "failed"];

export function stateShares(totals: ComputerFleetTotals): StateShare[] {
  if (totals.total === 0) return [];
  return BAR_STATES.flatMap((state) => (totals[state] > 0 ? [{ state, count: totals[state], share: totals[state] / totals.total }] : []));
}

export type HistoryMetric = "running" | "total" | "attention";
export const bucketValue = (bucket: ComputerFleetHistoryBucket, metric: HistoryMetric) => bucket[metric];

export type GridLevel = 0 | 1 | 2 | 3 | 4 | "down";
export function bucketLevel(bucket: ComputerFleetHistoryBucket | null, metric: HistoryMetric, max: number): GridLevel {
  if (!bucket) return 0;
  const value = bucketValue(bucket, metric);
  if (bucket.sourceDown && value === 0) return "down";
  if (value <= 0 || max <= 0) return 0;
  if (metric === "attention") return 4;
  const share = value / max;
  return share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
}

export function bucketTitle(bucket: ComputerFleetHistoryBucket | null, start: number, minutes: number): string {
  const from = new Date(start);
  const time = `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${from.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const span = minutes >= 60 ? `${time} (1 hour)` : `${time} (${minutes} min)`;
  if (!bucket) return `${span}: nothing recorded`;
  const parts = [`${count(bucket.total)} computers`, `${count(bucket.running)} running`, `${count(bucket.paused)} paused`];
  if (bucket.attention > 0) parts.push(`${count(bucket.attention)} needing a look`);
  if (bucket.sourceDown) parts.push("a provider was not answering");
  return `${span}: ${parts.join(", ")}`;
}

export type GridColumn = { key: string; label: string; cells: Array<{ start: number; bucket: ComputerFleetHistoryBucket | null }> };
export type HistoryGrid = { columns: GridColumn[]; rows: number; rowLabels: string[]; bucketMinutes: number };

export function historyGrid(buckets: readonly ComputerFleetHistoryBucket[], range: ComputerFleetHistoryRange, now: number): HistoryGrid {
  const byStart = new Map(buckets.map((bucket) => [bucket.at, bucket]));
  if (range === "24h") {
    const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const columns: GridColumn[] = [];
    for (let hour = lastHour - 23 * HOUR_MS; hour <= lastHour; hour += HOUR_MS) {
      const local = new Date(hour).getHours();
      columns.push({
        key: String(hour),
        label: local % 3 === 0 ? String(local).padStart(2, "0") : "",
        cells: Array.from({ length: 6 }, (_, slot) => ({ start: hour + slot * TEN_MINUTES_MS, bucket: byStart.get(hour + slot * TEN_MINUTES_MS) ?? null })),
      });
    }
    return { columns, rows: 6, rowLabels: [":00", "", "", ":30", "", ""], bucketMinutes: 10 };
  }
  const days = range === "7d" ? 7 : 30;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const columns: GridColumn[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    columns.push({
      key: String(day.getTime()),
      label: back % (days === 7 ? 3 : 7) === 0 ? day.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
      cells: Array.from({ length: 24 }, (_, hour) => {
        const start = new Date(day);
        start.setHours(hour);
        const stored = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS;
        return { start: start.getTime(), bucket: byStart.get(stored) ?? null };
      }),
    });
  }
  return { columns, rows: 24, rowLabels: Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? `${String(hour).padStart(2, "0")}:00` : "")), bucketMinutes: 60 };
}

export type FleetNotice = { tone: "error" | "warning" | "info"; message: string };
export const plainCode = (code: string) => code.replaceAll("_", " ");

export function fleetNotice(fleet: AdminComputerFleet): FleetNotice | null {
  if (fleet.runnerError === "http_404") {
    return { tone: "info", message: "The headless runner in use is from before it could list its computers. This page fills in once a current runner is deployed." };
  }
  if (fleet.runnerError !== null) {
    return { tone: "error", message: `The headless runner's list of computers could not be read (${plainCode(fleet.runnerError)}). Nothing is known about any computer until it answers.` };
  }
  if (fleet.status === "not_configured") {
    return { tone: "info", message: "This deployment has no headless runner, or its runner has no computers: neither a sandbox gateway nor a direct provider is configured on it." };
  }
  const silent = fleet.sources.filter((source) => source.status === "unreachable");
  if (silent.length > 0) {
    const names = silent.map((source) => `${SOURCE_NAME[source.source].toLowerCase()} (${source.provider}${source.error ? `, ${plainCode(source.error)}` : ""})`).join(" and ");
    return { tone: "error", message: `The ${names} did not answer the runner. ${fleet.status === "unreachable" ? "Nothing is known about any computer until it does." : "Its computers are missing from this page until it does."}` };
  }
  const pools = fleet.sources.flatMap((source) => source.pools.filter((pool) => pool.enabled && pool.health !== "healthy"));
  if (pools.length > 0) {
    return { tone: "error", message: `${pools.length === 1 ? `The gateway's pool ${pools[0]?.name} is` : `${count(pools.length)} of the gateway's pools are`} not healthy (${pools.map((pool) => pool.health).join(", ")}). New computers may not start there.` };
  }
  const kinds = attentionCounts(fleet);
  const stuck = kinds.stuck_starting + kinds.stuck_pausing + kinds.stuck_stopping;
  if (stuck > 0) return { tone: "error", message: `${stuck === 1 ? "1 computer has" : `${count(stuck)} computers have`} been starting, pausing or stopping far longer than that takes. The person waiting on ${stuck === 1 ? "it" : "them"} sees a computer that does not come back.` };
  if (kinds.failed > 0) return { tone: "warning", message: `${kinds.failed === 1 ? "1 computer" : `${count(kinds.failed)} computers`} failed in the last day. Each one's reason is in the list.` };
  if (kinds.idle_running > 0) return { tone: "warning", message: `${kinds.idle_running === 1 ? "1 computer is" : `${count(kinds.idle_running)} computers are`} running with nothing using ${kinds.idle_running === 1 ? "it" : "them"}, long after the runner should have paused ${kinds.idle_running === 1 ? "it" : "them"}.` };
  if (kinds.long_running > 0) return { tone: "warning", message: `${kinds.long_running === 1 ? "1 computer has" : `${count(kinds.long_running)} computers have`} been awake for most of ${kinds.long_running === 1 ? "its" : "their"} life. Something never lets ${kinds.long_running === 1 ? "it" : "them"} sleep.` };
  if (kinds.expired > 0) return { tone: "warning", message: `${kinds.expired === 1 ? "1 computer is" : `${count(kinds.expired)} computers are`} past ${kinds.expired === 1 ? "its" : "their"} expiry and still held by the provider.` };
  if (fleet.listTruncated || fleet.sources.some((source) => source.truncated)) return { tone: "warning", message: "There are more computers than this page lists. The totals count the ones the runner read." };
  return null;
}

type AttentionCounts = Record<ComputerFleetAttention, number>;
export function attentionCounts(fleet: Pick<AdminComputerFleet, "attentionCounts" | "sandboxes">): AttentionCounts {
  if (fleet.attentionCounts) return fleet.attentionCounts;
  const counts: AttentionCounts = { failed: 0, stuck_starting: 0, stuck_pausing: 0, stuck_stopping: 0, expired: 0, idle_running: 0, long_running: 0 };
  for (const sandbox of fleet.sandboxes) if (sandbox.attention) counts[sandbox.attention] += 1;
  return counts;
}

export const ALL_ORGANIZATIONS = "";
export const UNKNOWN_ORGANIZATION = "unknown";
export type OrganizationOption = { value: string; label: string };

export function organizationOptions(fleet: Pick<AdminComputerFleet, "organizations" | "unknownOrganization" | "totals">): OrganizationOption[] {
  return [
    { value: ALL_ORGANIZATIONS, label: `All organizations (${count(fleet.totals.total)})` },
    ...fleet.organizations.map((organization) => ({ value: organization.id, label: `${organization.name || organization.id} (${count(organization.computers)})` })),
    ...(fleet.unknownOrganization > 0 ? [{ value: UNKNOWN_ORGANIZATION, label: `Organization not known (${count(fleet.unknownOrganization)})` }] : []),
  ];
}

export const computerHref = (sandbox: Pick<ComputerFleetSandbox, "source" | "id">) => `/admin/computer-fleet/${sandbox.source}/${encodeURIComponent(sandbox.id)}`;

const EVENT_TITLE: Record<string, string> = {
  create: "Created",
  placed: "Placed on a pool",
  running: "Started running",
  provision_retry: "Start failed, trying again",
  failed: "Failed",
  rejected: "Refused by the gateway",
  idled: "Put to rest for being idle",
  woke: "Woken by use",
  pause: "Pause asked for",
  paused: "Paused",
  resume: "Resume asked for",
  resumed: "Resumed",
  resume_queued: "Resume waiting for room",
  stop: "Stop asked for",
  stopped: "Stopped",
  start: "Start asked for",
  update: "Labels or expiry changed",
  delete: "Removal asked for",
  terminated: "Removed",
  expired: "Expired",
  preempted: "Moved out for another computer",
};

export function eventTitle(event: Pick<ComputerFleetEvent, "origin" | "type" | "message">): string {
  if (event.origin === "den") return event.message || event.type.replaceAll("_", " ");
  return EVENT_TITLE[event.type] ?? event.type.replaceAll("_", " ");
}

const QUIET_MS = 2 * 60 * 60_000;

export type Explanation = { tone: "neutral" | "good" | "warning" | "danger"; headline: string; points: string[] };

export function explainComputer(detail: AdminComputerDetail, now: number): Explanation {
  const { computer, settings, conversation } = detail;
  const since = (iso: string | null) => {
    const at = Date.parse(iso ?? "");
    return Number.isFinite(at) && now >= at ? formatDuration(now - at) : null;
  };
  const inState = stateDuration(computer, now);
  const pause = settings ? formatSpan(settings.idlePauseSeconds) : null;
  const points: string[] = [];
  let tone: Explanation["tone"] = "neutral";
  let headline: string;

  if (computer.state === "running") {
    const idle = since(computer.lastActivityAt);
    const idleMs = computer.lastActivityAt ? now - Date.parse(computer.lastActivityAt) : null;
    const turn = since(conversation?.activeTurnSince ?? null);
    const life = since(computer.createdAt);
    const quietAt = Math.max(Date.parse(conversation?.lastActiveAt ?? "") || 0, Date.parse(detail.reported?.at ?? "") || 0);
    const quietMs = conversation && quietAt > 0 ? now - quietAt : null;
    if (computer.attention === "long_running" && computer.runSeconds !== null) {
      tone = "warning";
      headline = `Running, and awake for ${formatDuration(computer.runSeconds * 1000)} of the ${life ?? "time"} since it was made.`;
      points.push("A computer sleeps between uses. One awake most of its life is being kept awake: a background job that never ends, a view left open in a browser, turns that arrive faster than it can pause, or a pause the runner never made.");
      if (turn !== null) points.push(`Its conversation has had a turn under way for ${turn}.`);
      else if (idle !== null) points.push(`Its provider last saw activity ${idle} ago. A desktop is never quite silent, so that alone does not mean someone is using it.`);
    } else if (turn !== null) {
      tone = "good";
      headline = `Running: its conversation has had a turn under way for ${turn}.`;
    } else if (computer.attention === "idle_running" && quietMs !== null && quietMs > QUIET_MS) {
      tone = "warning";
      headline = `Running, but its conversation has been quiet for ${formatDuration(quietMs)}.`;
      points.push(`The runner pauses a computer ${pause ?? "minutes"} after its last use. One still running hours after its conversation went quiet is either running a long background job, or the runner has lost track of it.`);
      if (idle !== null) points.push(`Its provider last saw activity ${idle} ago. A desktop's browser keeps connections open, so that alone does not mean someone is using it.`);
    } else if (computer.attention === "idle_running") {
      tone = "warning";
      headline = `Running with nothing using it for ${idle ?? "a long time"}.`;
      points.push(`The runner pauses a computer ${pause ?? "minutes"} after its last use, so something is holding this one. Most likely a pause that failed, or a runner that lost track of it. A background job or an open view normally shows as recent use.`);
    } else if (idle === null) {
      headline = "Running. Its provider does not say when it was last used.";
    } else if (settings && idleMs !== null && idleMs > (settings.idlePauseSeconds + 120) * 1000) {
      headline = `Running, unused for ${idle}.`;
      points.push(`That is past the runner's ${pause} pause. A background job on the computer, or a pause that is being retried, keeps one running; it is flagged if this goes on.`);
    } else {
      tone = "good";
      headline = `Running: last used ${idle} ago.`;
      if (pause) points.push(`The runner pauses it ${pause} after its last use, unless a background job is still running on it.`);
    }
    if (detail.limits.idleTimeoutSeconds) points.push(`Its provider stops it by itself after ${formatSpan(detail.limits.idleTimeoutSeconds)} idle.`);
  } else if (computer.state === "starting") {
    const stuck = computer.attention === "stuck_starting";
    tone = stuck ? "danger" : "neutral";
    const waiting = since(detail.resumeRequestedAt);
    if (waiting !== null) headline = `Resuming: it has waited ${waiting} for a free slot, or for a pause to finish.`;
    else if (detail.placement?.outcome === "waiting") headline = `Waiting for room${inState ? ` for ${inState}` : ""}.`;
    else headline = `Starting${inState ? ` for ${inState}` : ""}${stuck ? ", far longer than a start takes" : ""}.`;
    if (detail.placement?.outcome === "waiting" && detail.placement.reason) points.push(`The gateway's reason: ${detail.placement.reason}`);
    if (detail.attempts !== null && detail.attempts > 1) points.push(`The gateway has tried to start it ${count(detail.attempts)} times.`);
    if (stuck) points.push("The person waiting on it sees a computer that does not come up.");
  } else if (computer.state === "pausing") {
    const stuck = computer.attention === "stuck_pausing";
    tone = stuck ? "danger" : "neutral";
    headline = `Pausing${inState ? ` for ${inState}` : ""}${stuck ? ", far longer than a pause takes" : ""}.`;
    points.push("A pause saves the computer's memory, which can take minutes. Its next use waits for the pause to finish.");
  } else if (computer.state === "paused") {
    const idled = since(detail.idledAt);
    headline = idled !== null ? `Paused by its provider for being idle, ${idled} ago.` : `Paused${inState ? ` for ${inState}` : ""}, after it went unused.`;
    points.push("It wakes on its next use, with its files and open apps as they were.");
    if (detail.slotReleased) points.push("It holds no slot on its pool while it is paused.");
  } else if (computer.state === "stopped") {
    headline = `Stopped${inState ? ` for ${inState}` : ""}.`;
    points.push("Its next use starts it from its disk; what was in memory is gone.");
  } else if (computer.state === "stopping") {
    const stuck = computer.attention === "stuck_stopping";
    tone = stuck ? "danger" : "neutral";
    headline = `Being removed${inState ? ` for ${inState}` : ""}${stuck ? ", far longer than that takes" : ""}.`;
  } else if (computer.state === "failed") {
    tone = "danger";
    const ago = since(computer.endedAt ?? computer.lastChangedAt);
    headline = `Failed${ago ? ` ${ago} ago` : ""}.`;
    if (detail.attempts !== null && detail.attempts > 1) points.push(`The gateway tried to start it ${count(detail.attempts)} times.`);
    points.push("The conversation gets a new computer on its next use.");
  } else {
    headline = `In a state this page does not know: ${computer.status}.`;
  }

  if (computer.statusReason) points.unshift(`Its provider's reason: ${computer.statusReason}`);
  if (computer.attention === "expired") {
    if (tone === "neutral" || tone === "good") tone = "warning";
    points.push("It is past its expiry and its provider still holds it.");
  } else if (computer.expiresAt && (computer.state === "running" || computer.state === "paused" || computer.state === "stopped")) {
    const left = Date.parse(computer.expiresAt) - now;
    if (left > 0) points.push(`Its provider deletes it in ${formatDuration(left)} unless it is used; each use pushes that back.`);
  }
  if (computer.imageCurrent === false) points.push(`It was built from an older image (${computer.image ?? "not named"}); new computers are built from ${settings?.image ?? "the current one"}. The runner moves a desktop computer to the current image when it is idle.`);
  if (detail.reported?.detail) points.push(`Workbot last reported: ${detail.reported.detail}.`);
  return { tone, headline, points };
}
