"use client";

import type { AdminComputerDetail, ComputerFleetEvent, ComputerFleetSourceKind } from "@openwork/types/den/admin-computer-fleet";
import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { DenBadge, type DenBadgeTone } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { AdminAccessScreen } from "../admin-access-screen";
import { useComputer } from "./computer-fleet-data";
import {
  ATTENTION_LABEL,
  eventTitle,
  explainComputer,
  formatAge,
  formatDuration,
  formatSize,
  formatSpan,
  imageLabel,
  plainCode,
  SOURCE_NAME,
  STATE_LABEL,
  type Explanation,
} from "./computer-fleet-model";
import { STATE_TONE } from "./computer-fleet-page";

const count = (value: number) => value.toLocaleString("en-US");
const EXPLANATION_STYLE: Record<Explanation["tone"], string> = {
  neutral: "border-gray-200 bg-white",
  good: "border-emerald-200 bg-emerald-50/50",
  warning: "border-amber-200 bg-amber-50/60",
  danger: "border-red-200 bg-red-50/60",
};
const LEVEL_TONE: Record<ComputerFleetEvent["level"], DenBadgeTone> = { info: "neutral", warning: "warning", error: "danger" };

/** A moment as the viewer's own date and time, with how long ago it was (or how far off it is). */
function Moment({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-gray-600">Not reported</span>;
  const at = new Date(iso);
  const ahead = at.getTime() - now;
  return (
    <span className="tabular-nums">
      <time dateTime={iso} title={iso}>{at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</time>
      <span className="text-gray-600"> ({ahead > 0 ? `in ${formatDuration(ahead)}` : formatAge(iso, now).toLowerCase()})</span>
    </span>
  );
}

function Facts({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <DenCard className="flex min-w-0 flex-col gap-3 !rounded-lg" data-testid={testId}>
      <h2 className="text-[14px] font-medium text-gray-900">{title}</h2>
      <dl className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] leading-5">{children}</dl>
    </DenCard>
  );
}

/** One fact. Left out when it has nothing to say, so a provider that reports little gives a short card. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return (
    <>
      <dt className="text-gray-600">{name}</dt>
      <dd className="min-w-0 break-words text-gray-900">{children}</dd>
    </>
  );
}

function Events({ detail, now }: { detail: AdminComputerDetail; now: number }) {
  const missing = detail.providerEventsError === null ? null
    : detail.providerEventsError === "unsupported" ? "This provider keeps no record of what happened to a computer, so only what Workbot reported is here."
    : detail.providerEventsError === "http_403" ? "The runner's key at the sandbox gateway may not read its event log, so only what Workbot reported is here. The gateway's own record (placed, idled, woken, retried) appears once that key may read audit events."
    : `The sandbox gateway's event log could not be read (${plainCode(detail.providerEventsError)}), so only what Workbot reported is here.`;
  return (
    <section aria-labelledby="computer-events" className="flex flex-col gap-3">
      <div>
        <h2 id="computer-events" className="text-[16px] font-medium text-gray-950">What happened to it</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">Newest first: what its provider recorded, and what Workbot reported to Den. Starts, pauses, views and failures only, never what a conversation ran or read on it.</p>
      </div>
      {missing ? <DenNotice tone="info" message={missing} /> : null}
      <DenCard className="!rounded-lg !p-0" data-testid="computer-events">
        {detail.events.length === 0 ? <p className="px-4 py-3 text-[13px] text-gray-600">Nothing has been recorded for this computer.</p> : (
          <ol className="divide-y divide-gray-100">
            {detail.events.map((event, index) => (
              <li key={`${event.at}-${event.origin}-${event.type}-${index}`} className="grid gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] leading-5 sm:grid-cols-[190px_minmax(0,1fr)_auto]">
                <span className="text-gray-700"><Moment iso={event.at} now={now} /></span>
                <span className="min-w-0">
                  <span className="text-gray-900">{eventTitle(event)}</span>
                  {event.origin === "provider" && event.message ? <span className="block break-words text-[12px] text-gray-600">{event.message}</span> : null}
                </span>
                <span className="flex items-start gap-1.5">
                  {event.level === "info" ? null : <DenBadge size="sm" tone={LEVEL_TONE[event.level]}>{event.level === "error" ? "Failure" : "Warning"}</DenBadge>}
                  <DenBadge size="sm" tone="neutral">{event.origin === "provider" ? "Provider" : "Workbot"}</DenBadge>
                </span>
              </li>
            ))}
          </ol>
        )}
      </DenCard>
    </section>
  );
}

function Placement({ detail }: { detail: AdminComputerDetail }) {
  const placement = detail.placement;
  if (!placement) return null;
  return (
    <section aria-labelledby="computer-placement" className="flex flex-col gap-3">
      <div>
        <h2 id="computer-placement" className="text-[16px] font-medium text-gray-950">Why it runs where it does</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">
          The sandbox gateway {placement.outcome === "placed" ? "placed it" : placement.outcome === "waiting" ? "is holding it" : placement.outcome === "rejected" ? "refused it" : "decided"}
          {placement.pool ? <> on <span className="font-mono text-gray-900">{placement.pool}</span></> : null}
          {placement.strategy ? `, by its ${placement.strategy} rule` : ""}.{placement.reason ? ` Its reason: ${placement.reason}.` : ""}
        </p>
      </div>
      {placement.candidates.length > 0 ? (
        <DenCard className="!rounded-lg !p-0" data-testid="computer-placement">
          <ul className="divide-y divide-gray-100">
            {placement.candidates.map((candidate) => (
              <li key={candidate.pool} className="grid gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] leading-5 sm:grid-cols-[220px_auto_minmax(0,1fr)]">
                <span className="min-w-0 break-words font-mono text-gray-900">{candidate.pool}{candidate.trust ? <span className="font-sans text-gray-600">, {candidate.trust}</span> : null}</span>
                <span className="flex flex-wrap items-start gap-1.5">
                  {candidate.pool === placement.pool ? <DenBadge size="sm" tone="success">Chosen</DenBadge> : null}
                  {candidate.eligible === null ? null : <DenBadge size="sm" tone={candidate.eligible ? "neutral" : "warning"}>{candidate.eligible ? "Allowed" : "Not allowed"}</DenBadge>}
                  {candidate.hasCapacity === false ? <DenBadge size="sm" tone="warning">No room</DenBadge> : null}
                </span>
                <span className="min-w-0 break-words text-gray-600">{candidate.reasons.length > 0 ? candidate.reasons.join("; ") : candidate.eligible === false ? "No reason given" : ""}</span>
              </li>
            ))}
          </ul>
        </DenCard>
      ) : null}
    </section>
  );
}

function Detail({ detail, now }: { detail: AdminComputerDetail; now: number }) {
  const { computer, conversation, settings, limits } = detail;
  const explanation = explainComputer(detail, now);
  const image = imageLabel(computer);
  return (
    <>
      <DenCard className={`flex flex-col gap-3 !rounded-lg border ${EXPLANATION_STYLE[explanation.tone]}`} data-testid="computer-explanation" data-tone={explanation.tone}>
        <div className="flex flex-wrap items-center gap-2">
          <DenBadge tone={STATE_TONE[computer.state]}>{STATE_LABEL[computer.state]}</DenBadge>
          {computer.attention ? <DenBadge tone={computer.attention === "idle_running" || computer.attention === "long_running" || computer.attention === "expired" ? "warning" : "danger"}>{ATTENTION_LABEL[computer.attention]}</DenBadge> : null}
          {computer.status.toLowerCase() === STATE_LABEL[computer.state].toLowerCase() ? null : <span className="text-[12px] text-gray-600">Its provider calls this &quot;{computer.status}&quot;.</span>}
        </div>
        <p className="text-[16px] font-medium leading-6 text-gray-950">{explanation.headline}</p>
        {explanation.points.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 text-gray-700">
            {explanation.points.map((point) => <li key={point}>{point}</li>)}
          </ul>
        ) : null}
      </DenCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <Facts title="Whose it is" testId="computer-owner">
          <Fact name="Organization">{computer.organization
            ? <Link href={`/admin/organizations/${encodeURIComponent(computer.organization.id)}`} className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700">{computer.organization.name || computer.organization.id}</Link>
            : <span className="text-gray-600">Not known: Den has no conversation for this computer&apos;s key.</span>}</Fact>
          <Fact name="Member">{conversation?.member ? <>{conversation.member.name || "No name"} <span className="text-gray-600">{conversation.member.email}</span></> : conversation ? <span className="text-gray-600">Not known</span> : null}</Fact>
          <Fact name="Conversation">{conversation ? <><span>{conversation.chat === "main" ? "Workbot, main chat" : conversation.chat === "side" ? "Workbot, a side chat" : "Workbot"}</span> <span className="break-all font-mono text-[12px] text-gray-600">{conversation.sessionId}</span></> : null}</Fact>
          <Fact name="Turn under way">{conversation ? (conversation.activeTurnSince ? <>Since <Moment iso={conversation.activeTurnSince} now={now} /></> : "None") : null}</Fact>
          <Fact name="Conversation last active">{conversation ? <Moment iso={conversation.lastActiveAt} now={now} /> : null}</Fact>
          <Fact name="Conversation started">{conversation ? <Moment iso={conversation.createdAt} now={now} /> : null}</Fact>
          <Fact name="Workbot last reported">{detail.reported ? <>{detail.reported.state.replaceAll("_", " ")}{detail.reported.detail ? `: ${detail.reported.detail}` : ""}{detail.reported.at ? <> <span className="text-gray-600">({formatAge(detail.reported.at, now).toLowerCase()})</span></> : null}</> : null}</Fact>
        </Facts>

        <Facts title="Where it runs" testId="computer-place">
          <Fact name="Through">{SOURCE_NAME[computer.source]} <span className="text-gray-600">({computer.provider})</span></Fact>
          <Fact name="Pool">{computer.pool ? <span className="font-mono">{computer.pool}</span> : null}</Fact>
          <Fact name="Runs on">{computer.backend}</Fact>
          <Fact name="Region">{computer.region}</Fact>
          <Fact name="Kind of pool">{detail.trust === "private" ? "Private: our own" : detail.trust === "external" ? "External: a provider's" : detail.trust}</Fact>
          <Fact name="Size">{formatSize(computer)}{computer.diskGb !== null ? `, ${count(computer.diskGb)} GB disk` : ""}</Fact>
          <Fact name="Profile">{detail.profile}</Fact>
          <Fact name="Data class">{detail.classification}</Fact>
          <Fact name="Provider id"><span className="break-all font-mono text-[12px]">{computer.id}</span></Fact>
          <Fact name="Key"><span className="break-all font-mono text-[12px]">{detail.key}</span></Fact>
        </Facts>

        <Facts title="What it was built from" testId="computer-image">
          <Fact name="Image">{computer.image ? <span className="break-all font-mono text-[12px]">{computer.image}</span> : <span className="text-gray-600">Its provider does not say</span>}</Fact>
          <Fact name="Against new ones">{image === "Current" ? "Current: the same image new computers are built from" : image === "Older" ? <span className="font-medium text-amber-800">Older than what new computers are built from</span> : <span className="text-gray-600">Not known</span>}</Fact>
          <Fact name="New computers use">{settings?.image ? <span className="break-all font-mono text-[12px]">{settings.image}</span> : null}</Fact>
          <Fact name="Inside it"><span className="text-gray-600">What is installed inside can only be read by running a command on the computer, which would wake it or keep it awake. It is not read here.</span></Fact>
        </Facts>

        <Facts title="Times" testId="computer-times">
          <Fact name="Created"><Moment iso={computer.createdAt} now={now} /></Fact>
          <Fact name="First started">{computer.startedAt ? <Moment iso={computer.startedAt} now={now} /> : null}</Fact>
          <Fact name={computer.source === "direct" ? "Record last changed" : "In this state since"}><Moment iso={computer.lastChangedAt} now={now} /></Fact>
          <Fact name="Last active"><Moment iso={computer.lastActivityAt} now={now} /></Fact>
          <Fact name="Paused">{computer.pausedAt ? <Moment iso={computer.pausedAt} now={now} /> : null}</Fact>
          <Fact name="Put to rest for idling">{detail.idledAt ? <Moment iso={detail.idledAt} now={now} /> : null}</Fact>
          <Fact name="Resume asked for">{detail.resumeRequestedAt ? <Moment iso={detail.resumeRequestedAt} now={now} /> : null}</Fact>
          <Fact name="Expires">{computer.expiresAt ? <Moment iso={computer.expiresAt} now={now} /> : null}</Fact>
          <Fact name="Ended">{computer.endedAt ? <Moment iso={computer.endedAt} now={now} /> : null}</Fact>
          <Fact name="Run time in all">{limits.totalRunSeconds !== null ? formatDuration(limits.totalRunSeconds * 1000) : null}</Fact>
        </Facts>

        <Facts title="Rules that pause and remove it" testId="computer-rules">
          <Fact name="Runner pauses it">{settings ? `${formatSpan(settings.idlePauseSeconds)} after its last use, unless a background job is running on it` : <span className="text-gray-600">The runner in use does not say</span>}</Fact>
          <Fact name="Runner deletes it">{settings ? (settings.persistent ? "Never: computers are kept" : `After ${count(settings.keepDays)} days unused, or with its conversation`) : null}</Fact>
          <Fact name="Provider stops it">{limits.idleTimeoutSeconds !== null ? `After ${formatSpan(limits.idleTimeoutSeconds)} idle` : null}</Fact>
          <Fact name="Provider keeps it">{limits.ttlSeconds !== null ? `${formatSpan(limits.ttlSeconds)} after each use` : null}</Fact>
          <Fact name="Provider deletes it">{limits.autoDeleteSeconds !== null ? `After ${formatSpan(limits.autoDeleteSeconds)} stopped` : null}</Fact>
          <Fact name="Longest run">{limits.maxRunSeconds !== null ? formatSpan(limits.maxRunSeconds) : null}</Fact>
          <Fact name="Longest pause">{limits.maxPausedSeconds !== null ? formatSpan(limits.maxPausedSeconds) : null}</Fact>
          <Fact name="Can be moved out">{detail.preemptible === null ? null : detail.preemptible ? "Yes, to make room for another computer" : "No"}</Fact>
          <Fact name="Pool slot">{detail.slotReleased === null ? null : detail.slotReleased ? "Released while it is paused" : "Held"}</Fact>
          <Fact name="Start attempts">{detail.attempts !== null ? count(detail.attempts) : null}</Fact>
        </Facts>
      </div>

      <Placement detail={detail} />
      <Events detail={detail} now={now} />
    </>
  );
}

export function ComputerDetailPage({ source, id }: { source: ComputerFleetSourceKind; id: string }) {
  const { state, receivedAt, retry } = useComputer(source, id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (state.status === "signed-out" || state.status === "forbidden") return <AdminAccessScreen state={state.status} message={state.message} onRetry={retry} />;
  if (!state.computer && state.status === "loading") return <AdminAccessScreen state="checking" />;

  const seconds = receivedAt === null ? null : Math.max(0, Math.round((now - receivedAt) / 1000));
  // Ages follow the minute; only "read N s ago" follows the second.
  const minute = Math.floor(now / 60_000) * 60_000;
  return (
    <div className="flex flex-col gap-8" data-testid="computer-detail-page" data-status={state.status}>
      <div className="flex flex-col gap-3">
        <Link href="/admin/computer-fleet" className="inline-flex w-fit items-center gap-1.5 text-[13px] text-gray-700 hover:text-gray-950"><ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />Computer fleet</Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-[28px] font-medium leading-[34px] tracking-[-0.5px] text-gray-950">Computer</h1>
            <p className="mt-1 break-all font-mono text-[13px] text-gray-700">{id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {seconds === null ? null : <p className="text-[13px] tabular-nums text-gray-700" data-testid="computer-read">Read {seconds < 2 ? "just now" : `${count(seconds)} s ago`}</p>}
            <DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={retry}>Refresh</DenButton>
          </div>
        </div>
      </div>

      {state.status === "missing" ? <DenNotice tone="info" message="Its provider has no computer by this id any more, or it is not one of this deployment's. A computer is deleted with its conversation, after it has gone unused for long enough, or when it is replaced by one from a newer image." /> : null}
      {state.status === "error" ? <DenNotice tone={state.computer ? "warning" : "error"} message={<span>{state.computer ? "The last reading did not load. " : ""}{state.message} <button type="button" className="underline underline-offset-2" onClick={retry}>Try again</button></span>} /> : null}
      {state.computer ? <Detail detail={state.computer} now={minute} /> : null}
    </div>
  );
}
