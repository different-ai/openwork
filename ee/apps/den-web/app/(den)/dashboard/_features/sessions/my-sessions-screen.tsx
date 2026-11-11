"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, Laptop, LockKeyhole, MessageSquare } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { MemberSession, MemberSessionComputer } from "@openwork/types/den/remote-sessions";
import { DenButton } from "../../../_components/ui/button";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { orgFeatureEnabled, type DenOrgContext } from "../../../_lib/den-org";
import { ItemSection } from "../../_components/item-list";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { StatusDot, TimeAgo, hairline, secondaryText } from "../computers/computer-parts";
import { LANE, ListRow, RowLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton, StatusLane } from "../computers/computer-rows";
import { FeatureIntroGate } from "../feature-intros/feature-intro-gate";
import { SessionPanel } from "./session-panel";
import { attachRemoteSession, useMySessions } from "./sessions-data";
import {
  ACCESS_LABELS,
  attachAnswered,
  attachDismissed,
  attachRefused,
  attachRequested,
  computerAccessNote,
  findSessionByCommand,
  groupSessions,
  lostAttachFailure,
  pendingSummaryLine,
  sessionIdentity,
  sessionStateDot,
  sessionTitle,
  sessionsStateLine,
  settleAttachAttempts,
  startedOnComputer,
  type AttachAttempt,
  type AttachAttempts,
} from "./sessions-model";

const SESSION_PARAM = "session";
const spaced = "mr-2 last:mr-0";

/**
 * The member's computers and what other devices can reach on each. Read-only:
 * the owner makes that choice on the computer, and this page never changes it.
 */
export function SessionComputers({ computers, ceiling }: { computers: readonly MemberSessionComputer[]; ceiling: RemoteSessionAccessMode }) {
  return <div className="mb-8">
    <ItemSection variant="rule" title="Your computers" testId="my-sessions-computers">
      {computers.length ? <RowList label="Your computers" header={<RowListHeader lead="Computer" visuallyHidden><RowLaneLabel lane={LANE.sessionStatus}>Status</RowLaneLabel></RowListHeader>}>
        {computers.map((computer) => {
          const note = computerAccessNote(computer, ceiling);
          return <ListRow key={computer.computerId} icon={Laptop} name={computer.label} secondLineWrap="all"
            secondLine={<>
              <span>Other devices can reach: </span><span className={`${spaced} text-[color:var(--dls-text-primary)]`}>{ACCESS_LABELS[computer.effectiveAccess]}</span>
              {note ? <span className={spaced}>{note}</span> : null}
            </>}
            lanes={<StatusLane lane={LANE.sessionStatus} label={computer.online ? "Online" : "Offline"} tone={computer.online ? "success" : "neutral"} />} />;
        })}
      </RowList> : <p className={`py-4 text-[13px] ${secondaryText}`}>No computers yet. Sign in to OpenWork on a computer with this organization and it appears here.</p>}
    </ItemSection>
  </div>;
}

type SessionRowsProps = {
  now: number;
  /** A Connect the member pressed on this session, if any. */
  attemptFor: (session: MemberSession) => AttachAttempt | undefined;
  onConnect: (session: MemberSession) => void;
  /** Where a reachable session opens. */
  hrefFor: (commandId: string) => string;
};

/** The right end of a session's row: a chevron when it opens, Connect when it has to be connected first, or that it is connecting. */
function SessionConnection({ session, attempt, onConnect }: { session: MemberSession; attempt: AttachAttempt | undefined; onConnect: () => void }) {
  if (session.reach === "reachable") return <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className={`${secondaryText} transition-colors duration-150 group-hover:text-[color:var(--dls-text-primary)]`} />;
  if (session.reach === "connecting" || attempt?.phase === "queued") return <span className={`whitespace-nowrap ${secondaryText}`} role="status">Connecting…</span>;
  return <DenButton variant="secondary" size="sm" loading={attempt?.phase === "requesting"} onClick={onConnect}
    aria-label={`Connect to ${sessionTitle(session.title)}`} data-testid={`session-connect-${session.key}`}>Connect</DenButton>;
}

/**
 * Sessions as rows. Titles, steps and questions are text from the member's computers, shown as text.
 * The lanes keep fixed widths so the two lists on the page line up.
 */
export function SessionRows({ sessions, label, now, attemptFor, onConnect, hrefFor }: SessionRowsProps & { sessions: readonly MemberSession[]; label: string }) {
  return <RowList label={label} header={<RowListHeader lead="Session" visuallyHidden>
    <RowLaneLabel lane={LANE.state}>State</RowLaneLabel>
    <RowLaneLabel lane={LANE.time}>Updated</RowLaneLabel>
    <RowLaneLabel lane={LANE.connection}>Connection</RowLaneLabel>
  </RowListHeader>}>
    {sessions.map((session) => {
      const attempt = attemptFor(session);
      const state = sessionStateDot(session.state);
      const waitsFor = session.state === "waiting" ? pendingSummaryLine(session.pending) : null;
      const step = session.latestStep?.trim();
      return <ListRow key={session.key} icon={MessageSquare} name={sessionTitle(session.title)} wrapName secondLineWrap="two"
        rowTestId={`session-row-${session.key}`} rowData={{ "data-reach": session.reach }}
        href={session.reach === "reachable" && session.commandId ? hrefFor(session.commandId) : undefined}
        secondLine={<>
          <span className={spaced}>{session.computerLabel?.trim() || "Computer not reported"}</span>
          {session.workspaceName?.trim() ? <span className={spaced}>{session.workspaceName}</span> : null}
          {startedOnComputer(session) ? <span className={spaced}>Started on this computer</span> : null}
          {waitsFor ? <span className={`${spaced} text-[color:var(--dls-text-primary)]`}>{waitsFor}</span> : step ? <span className={spaced}>{step}</span> : null}
        </>}
        note={attempt?.phase === "failed" ? <p role="alert" className="relative mt-0.5 break-words text-[12px] leading-4 text-[var(--ow-danger)]">{attempt.message}</p> : null}
        lanes={<>
          <RowLane lane={LANE.state} className="items-center gap-2">
            {state ? <><StatusDot tone={state.tone} /><span className="truncate">{state.label}</span></>
              : session.reach === "attachable" ? <span className={`truncate ${secondaryText}`}>Not connected</span> : null}
          </RowLane>
          <RowLane lane={LANE.time} className={`truncate tabular-nums ${secondaryText}`}>
            {session.updatedAt === null ? "Not reported" : <TimeAgo iso={new Date(session.updatedAt).toISOString()} now={now} />}
          </RowLane>
          <RowLane lane={LANE.connection} className="relative items-center">
            <SessionConnection session={session} attempt={attempt} onConnect={() => onConnect(session)} />
          </RowLane>
        </>} />;
    })}
  </RowList>;
}

/** Sessions that wait on the member first, then the rest, newest first. */
export function SessionsList({ sessions, ...rows }: SessionRowsProps & { sessions: readonly MemberSession[] }) {
  const { needsYou, rest } = groupSessions(sessions);
  if (sessions.length === 0) return <p className={`max-w-2xl border-y ${hairline} py-6 text-[13px] ${secondaryText}`} data-testid="my-sessions-empty">
    No sessions yet. Tasks you start on another computer show up here. Sessions started on a computer appear once that computer allows all sessions.
  </p>;
  return <div className="min-w-0 space-y-8" data-testid="my-sessions-list">
    {needsYou.length ? <ItemSection variant="rule" title="Needs you" meta={needsYou.length} testId="my-sessions-needs-you">
      <SessionRows label="Sessions that need you" sessions={needsYou} {...rows} />
    </ItemSection> : null}
    {rest.length ? <ItemSection variant="rule" title={needsYou.length ? "Other sessions" : "Sessions"} meta={rest.length} testId="my-sessions-rest">
      <SessionRows label={needsYou.length ? "Other sessions" : "Sessions"} sessions={rest} {...rows} />
    </ItemSection> : null}
  </div>;
}

/** The page title with one line of state under it. `state` is null while the list loads. */
function Heading({ state }: { state: string | null }) {
  return <DenPageHeader size="compact" title="My Sessions" className="mb-6" state={state ?? <DenSkeleton className="mt-1 h-3 w-24" />} />;
}

/**
 * My Sessions: a member's own sessions across their computers. Den lists only
 * what each computer already lets this account's other devices reach; being
 * listed here changes nothing on a computer. The choice is made on each
 * computer in Settings › Devices, within what the organization allows.
 */
export function MySessionsScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  return <MySessionsPage orgId={orgId} orgContext={orgContext} />;
}

/**
 * What the page is before anything is fetched: a skeleton while the
 * organization loads, a locked notice while it has remoteSessionAccess off,
 * and only otherwise the sessions themselves.
 */
export function MySessionsPage({ orgId, orgContext }: {
  orgId: string | null;
  orgContext: Pick<DenOrgContext, "features" | "organization" | "currentMember"> | null;
}) {
  if (!orgId || !orgContext) return <div aria-busy="true" aria-label="My Sessions"><DenSkeleton className="mb-8 h-6 w-36" /><RowListSkeleton rows={3} /></div>;
  if (!orgFeatureEnabled(orgContext, "remoteSessionAccess")) return <section className="space-y-4" data-testid="my-sessions-locked">
    <DenPageHeader size="compact" title="My Sessions" />
    <p className={`flex items-start gap-2 text-[13px] ${secondaryText}`}><LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
      My Sessions is not enabled for this organization. Ask an organization owner or admin about availability.
    </p>
  </section>;
  // Nothing is read until the organization on screen is the one that was loaded.
  return <MySessions key={orgId} orgId={orgId} memberId={orgContext.currentMember.id} ready={orgContext.organization.id === orgId} />;
}

/** The list, or one open session at `?session=<commandId>`, with the Connects in flight. */
export function MySessions({ orgId, memberId, ready }: { orgId: string; memberId: string; ready: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openCommandId = params.get(SESSION_PARAM)?.trim() ?? "";
  const query = useMySessions(orgId, memberId, ready);
  const [attempts, setAttempts] = useState<AttachAttempts>({});
  const data = query.data;
  const listFetchedAt = query.dataUpdatedAt;
  const hrefFor = (commandId: string) => `${pathname}?${SESSION_PARAM}=${encodeURIComponent(commandId)}`;

  // A queued Connect is settled by the next list: reachable opens it, gone or still unconnected means it failed.
  useEffect(() => {
    if (!data) return;
    const reading = Boolean(openCommandId);
    const step = settleAttachAttempts(attempts, data.sessions, listFetchedAt, reading);
    if (step.attempts !== attempts) setAttempts((current) => settleAttachAttempts(current, data.sessions, listFetchedAt, reading).attempts);
    if (step.open) router.push(`${pathname}?${SESSION_PARAM}=${encodeURIComponent(step.open)}`, { scroll: false });
  }, [attempts, data, listFetchedAt, openCommandId, pathname, router]);

  async function connect(session: MemberSession) {
    if (!session.computerId || !session.workspaceId || !session.sessionId) return;
    const identity = sessionIdentity(session);
    setAttempts((current) => attachRequested(current, identity));
    try {
      const answer = await attachRemoteSession(orgId, { computerId: session.computerId, workspaceId: session.workspaceId, sessionId: session.sessionId });
      const answeredAt = Date.now();
      setAttempts((current) => attachAnswered(current, identity, answer, answeredAt).attempts);
      const { open } = attachAnswered({}, identity, answer, answeredAt);
      if (open) router.push(hrefFor(open), { scroll: false });
      void query.refetch();
    } catch (failure) {
      setAttempts((current) => attachRefused(current, identity, failure instanceof Error ? failure.message : null));
    }
  }

  const sessions = data?.sessions ?? [];
  const now = Date.now();
  const close = () => router.push(pathname, { scroll: false });
  const stateLine = data ? sessionsStateLine(sessions) : null;

  if (openCommandId) {
    const session = findSessionByCommand(sessions, openCommandId);
    const reachable = session && session.reach === "reachable" && session.commandId && session.sessionId && session.workspaceId
      ? { ...session, commandId: session.commandId, sessionId: session.sessionId, workspaceId: session.workspaceId }
      : null;
    return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-sessions">
      <Heading state={stateLine} />
      {reachable ? <SessionPanel key={reachable.commandId} orgId={orgId} memberId={memberId} session={reachable} onClose={close}
        computer={data?.computers.find((computer) => computer.computerId === reachable.computerId) ?? null} />
        : !data && query.isPending ? <div aria-hidden="true" className="max-w-3xl space-y-3"><DenSkeleton className="h-5 w-64" /><DenSkeleton className="h-4 w-2/3" /><DenSkeleton className="h-4 w-1/2" /></div>
          : <div className="max-w-3xl text-[13px]" data-testid="session-unavailable">
            <DenButton variant="ghost" size="inline" icon={ArrowLeft} onClick={close}>Back to My Sessions</DenButton>
            <p role="status" className="mt-2">{query.error && !data ? query.error.message : session?.reach === "connecting" ? "Connecting…" : "This session is no longer in your list."}</p>
          </div>}
    </section>;
  }

  // A Connect whose session left the list has no row to report on.
  const lost = lostAttachFailure(attempts, sessions);
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-sessions" aria-busy={query.isPending}>
    <Heading state={stateLine} />
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-[13px]"><p>{query.error.message}{data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    {data ? <SessionComputers computers={data.computers} ceiling={data.ceiling} /> : null}
    {lost ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
      <p>{lost.message}</p>
      <DenButton variant="ghost" size="sm" onClick={() => setAttempts((current) => attachDismissed(current, lost.identity))}>Dismiss</DenButton>
    </div> : null}
    <FeatureIntroGate introKey="my-sessions" facts={data ? { sessions: data.sessions.length } : null}>
      {!data ? query.isPending ? <RowListSkeleton rows={3} /> : null
        : <SessionsList sessions={sessions} now={now} hrefFor={hrefFor} onConnect={(session) => void connect(session)} attemptFor={(session) => attempts[sessionIdentity(session)]} />}
    </FeatureIntroGate>
  </section>;
}
