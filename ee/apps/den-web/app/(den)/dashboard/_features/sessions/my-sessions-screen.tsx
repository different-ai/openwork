"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { MemberSession, MemberSessionComputer } from "@openwork/types/den/remote-sessions";
import { DenBadge } from "../../../_components/ui/badge";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../_components/ui/table";
import { orgFeatureEnabled, type DenOrgContext } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { StatusDot, TimeAgo, focusRing, secondaryText } from "../computers/computer-parts";
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
  sessionStateBadge,
  sessionTitle,
  settleAttachAttempts,
  startedOnComputer,
  type AttachAttempt,
  type AttachAttempts,
} from "./sessions-model";

const SKELETON_ROWS = ["1", "2", "3"].map((id) => ({ id }));
const SESSION_PARAM = "session";

/**
 * The member's computers and what other devices can reach on each. Read-only:
 * the owner makes that choice on the computer, and this page never changes it.
 */
export function SessionComputers({ computers, ceiling }: { computers: readonly MemberSessionComputer[]; ceiling: RemoteSessionAccessMode }) {
  const columns: DenTableColumn<MemberSessionComputer>[] = [
    { key: "computer", header: "Computer", render: (computer) => <span className="block min-w-40 max-w-xs break-words font-medium">{computer.label}</span> },
    { key: "status", header: "Status", render: (computer) => <span className="inline-flex items-center gap-2 whitespace-nowrap"><StatusDot tone={computer.online ? "success" : "neutral"} />{computer.online ? "Online" : "Offline"}</span> },
    { key: "access", header: "Other devices can reach", render: (computer) => {
      const note = computerAccessNote(computer, ceiling);
      return <div className="min-w-48 max-w-md">
        <span className="block">{ACCESS_LABELS[computer.effectiveAccess]}</span>
        {note ? <span className={`mt-0.5 block text-xs ${secondaryText}`}>{note}</span> : null}
      </div>;
    } },
  ];
  return <section className="mb-8 min-w-0" aria-labelledby="my-sessions-computers-heading" data-testid="my-sessions-computers">
    <h2 id="my-sessions-computers-heading" className="mb-3 text-sm font-medium">Your computers</h2>
    {computers.length ? <DenTable columns={columns} rows={computers} getRowKey={(computer) => computer.computerId} density="compact" />
      : <p className={`text-sm ${secondaryText}`}>No computers yet. Sign in to OpenWork Desktop with this organization and that computer appears here.</p>}
  </section>;
}

type SessionRowsProps = {
  now: number;
  /** A Connect the member pressed on this session, if any. */
  attemptFor: (session: MemberSession) => AttachAttempt | undefined;
  onConnect: (session: MemberSession) => void;
  /** Where a reachable session opens. */
  hrefFor: (commandId: string) => string;
};

function SessionConnection({ session, attempt, onConnect }: { session: MemberSession; attempt: AttachAttempt | undefined; onConnect: () => void }) {
  if (session.reach === "reachable") return null;
  if (session.reach === "connecting" || attempt?.phase === "queued") return <span className={`whitespace-nowrap ${secondaryText}`} role="status">Connecting…</span>;
  return <div className="flex flex-col items-end gap-1">
    <DenButton variant="secondary" size="sm" loading={attempt?.phase === "requesting"} onClick={onConnect}
      aria-label={`Connect to ${sessionTitle(session.title)}`} data-testid={`session-connect-${session.key}`}>Connect</DenButton>
    {attempt?.phase === "failed" ? <p role="alert" className="max-w-56 break-words text-right text-xs">{attempt.message}</p> : null}
  </div>;
}

/**
 * Sessions as rows. Titles, steps and questions are text from the member's computers, shown as text.
 * The columns after the first keep fixed lanes so the two lists on the page line up.
 */
export function SessionsTable({ sessions, now, attemptFor, onConnect, hrefFor }: SessionRowsProps & { sessions: readonly MemberSession[] }) {
  const columns: DenTableColumn<MemberSession>[] = [
    { key: "session", header: "Session", render: (session) => {
      const title = sessionTitle(session.title);
      const waitsFor = session.state === "waiting" ? pendingSummaryLine(session.pending) : null;
      return <div className="min-w-48 max-w-md" data-testid={`session-row-${session.key}`} data-reach={session.reach}>
        {session.reach === "reachable" && session.commandId
          ? <Link href={hrefFor(session.commandId)} scroll={false} className={`break-words rounded-sm font-medium underline-offset-2 hover:underline ${focusRing}`}>{title}</Link>
          : <span className="break-words font-medium">{title}</span>}
        {startedOnComputer(session) ? <span className={`mt-0.5 block text-xs ${secondaryText}`}>Started on this computer</span> : null}
        {waitsFor ? <span className="mt-0.5 line-clamp-2 break-words text-xs">{waitsFor}</span> : null}
        {session.latestStep?.trim() ? <span className={`mt-0.5 line-clamp-2 break-words text-xs ${secondaryText}`}>{session.latestStep}</span> : null}
      </div>;
    } },
    { key: "computer", header: "Computer", width: "22%", render: (session) => <div className="min-w-32 max-w-xs">
      <span className="block break-words">{session.computerLabel?.trim() || "Not reported"}</span>
      {session.workspaceName?.trim() ? <span className={`mt-0.5 block break-words text-xs ${secondaryText}`}>{session.workspaceName}</span> : null}
    </div> },
    { key: "state", header: "State", width: "13%", render: (session) => {
      const badge = sessionStateBadge(session.state);
      if (badge) return <DenBadge tone={badge.tone} size="sm">{badge.label}</DenBadge>;
      return session.reach === "attachable" ? <span className={`whitespace-nowrap ${secondaryText}`}>Not connected</span> : null;
    } },
    { key: "updated", header: "Updated", width: "13%", render: (session) => session.updatedAt === null ? <span className={secondaryText}>Not reported</span>
      : <TimeAgo iso={new Date(session.updatedAt).toISOString()} now={now} className="whitespace-nowrap tabular-nums" /> },
    { key: "connection", header: "Connection", align: "right", width: "18%", render: (session) => <SessionConnection session={session} attempt={attemptFor(session)} onConnect={() => onConnect(session)} /> },
  ];
  return <DenTable columns={columns} rows={sessions} getRowKey={(session) => session.key} density="compact" />;
}

/** Sessions that wait on the member first, then the rest, newest first. */
export function SessionsList({ sessions, ...rows }: SessionRowsProps & { sessions: readonly MemberSession[] }) {
  const { needsYou, rest } = groupSessions(sessions);
  if (sessions.length === 0) return <p className={`max-w-2xl py-6 text-sm ${secondaryText}`} data-testid="my-sessions-empty">
    No sessions yet. Tasks you start on another computer show up here. Sessions started on a computer appear once that computer allows all sessions.
  </p>;
  return <div className="min-w-0 space-y-8" data-testid="my-sessions-list">
    {needsYou.length ? <section aria-labelledby="my-sessions-needs-you-heading" data-testid="my-sessions-needs-you">
      <h2 id="my-sessions-needs-you-heading" className="mb-3 text-sm font-medium">Needs you</h2>
      <SessionsTable sessions={needsYou} {...rows} />
    </section> : null}
    {rest.length ? <section aria-labelledby="my-sessions-rest-heading" data-testid="my-sessions-rest">
      <h2 id="my-sessions-rest-heading" className="mb-3 text-sm font-medium">{needsYou.length ? "Other sessions" : "Sessions"}</h2>
      <SessionsTable sessions={rest} {...rows} />
    </section> : null}
  </div>;
}

function Heading() {
  return <div className="mb-6">
    <h1 className="text-base font-medium">My Sessions</h1>
    <p className={`mt-1 max-w-2xl text-sm ${secondaryText}`}>Sessions on your computers that you can follow and answer from here.</p>
  </div>;
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
  if (!orgId || !orgContext) return <div aria-busy="true" aria-label="My Sessions"><DenSkeleton className="mb-6 h-5 w-32" />{SKELETON_ROWS.map(({ id }) => <DenSkeleton key={id} className="mb-3 h-10 w-full" />)}</div>;
  if (!orgFeatureEnabled(orgContext, "remoteSessionAccess")) return <section className="space-y-4" data-testid="my-sessions-locked">
    <h1 className="text-base font-medium">My Sessions</h1>
    <p className={`flex items-start gap-2 text-sm ${secondaryText}`}><LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
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

  if (openCommandId) {
    const session = findSessionByCommand(sessions, openCommandId);
    const reachable = session && session.reach === "reachable" && session.commandId && session.sessionId && session.workspaceId
      ? { ...session, commandId: session.commandId, sessionId: session.sessionId, workspaceId: session.workspaceId }
      : null;
    return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-sessions">
      <Heading />
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
  const skeletonColumns: DenTableColumn<{ id: string }>[] = ["Session", "Computer", "State", "Updated", "Connection"].map((header) => ({ key: header, header, render: () => <DenSkeleton className="h-4 w-24" /> }));
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-sessions" aria-busy={query.isPending}>
    <Heading />
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><p>{query.error.message}{data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    {data ? <SessionComputers computers={data.computers} ceiling={data.ceiling} /> : null}
    {lost ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <p>{lost.message}</p>
      <DenButton variant="ghost" size="sm" onClick={() => setAttempts((current) => attachDismissed(current, lost.identity))}>Dismiss</DenButton>
    </div> : null}
    <FeatureIntroGate introKey="my-sessions" facts={data ? { sessions: data.sessions.length } : null}>
      {!data ? query.isPending ? <div aria-hidden="true"><DenTable columns={skeletonColumns} rows={SKELETON_ROWS} getRowKey={(row) => row.id} density="compact" /></div> : null
        : <SessionsList sessions={sessions} now={now} hrefFor={hrefFor} onConnect={(session) => void connect(session)} attemptFor={(session) => attempts[sessionIdentity(session)]} />}
    </FeatureIntroGate>
  </section>;
}
