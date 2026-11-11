import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapFeatures } from "@openwork/features";
import type { MemberSession, MemberSessionComputer } from "@openwork/types/den/remote-sessions";
import { parseOrgContextPayload, type DenOrgContext } from "../../../_lib/den-org";
import { MySessions, MySessionsPage, SessionComputers, SessionRows, SessionsList } from "./my-sessions-screen";
import { attachAnswered, attachRequested, sessionIdentity, sessionsStateLine, settleAttachAttempts, type AttachAttempt, type AttachAttempts } from "./sessions-model";

const now = Date.parse("2026-11-10T12:10:00Z");
const base: MemberSession = {
  key: "remote-1", computerId: "cmp_1", computerLabel: "Work laptop", workspaceId: "ws_1", workspaceName: "Docs", sessionId: "ses_1",
  title: "Update the release notes", origin: "remote", reach: "reachable", commandId: "cmd_1", state: "running", waitingFor: null, pending: null,
  latestStep: "Ran List the release notes", updatedAt: new Date(now - 2 * 60_000).toISOString(),
};
const local: MemberSession = {
  ...base, key: "local-1", sessionId: "ses_2", title: "Refactor the importer", origin: "local", reach: "attachable", commandId: null, state: "unknown", latestStep: null, updatedAt: new Date(now - 3 * 3_600_000).toISOString(),
};
const computer: MemberSessionComputer = {
  computerId: "cmp_1", label: "Work laptop", platform: "darwin", online: true, lastSeenAt: new Date(now).toISOString(), supportsAccess: true, access: "created", effectiveAccess: "created", sessionsUpdatedAt: null,
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const rows = { now, attemptFor: (): AttachAttempt | undefined => undefined, onConnect: () => {}, hrefFor: (commandId: string) => `/dashboard/my-sessions?session=${commandId}` };
/** One session's row: everything from its `role="row"` to the next. */
const row = (html: string, key: string) => html.split('role="row"').find((part) => part.includes(`session-row-${key}"`)) ?? "";
const list = (sessions: MemberSession[], overrides: Partial<typeof rows> = {}) => renderToStaticMarkup(<SessionRows label="Sessions" sessions={sessions} {...rows} {...overrides} />);

type AnyElement = ReactElement<Record<string, unknown>>;
/** Every element a hook-free component renders, with the plain components inside it rendered too. */
function elements(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as AnyElement;
  const own = [element, ...Object.values(element.props).flatMap((value) => elements(value as ReactNode))];
  if (typeof element.type !== "function") return own;
  try {
    return [...own, ...elements((element.type as (props: unknown) => ReactNode)(element.props))];
  } catch {
    return own;
  }
}

test("a reachable session opens from its row and shows where it runs, its last step, its state and when it changed", () => {
  const html = list([base]);
  assert.match(text(row(html, "remote-1")), /Update the release notes Work laptop Docs Ran List the release notes Working 2 min ago/);
  // The title is the link, and it covers the row.
  assert.match(html, /<a[^>]*href="\/dashboard\/my-sessions\?session=cmd_1"[^>]*>Update the release notes<\/a>/);
  assert.match(row(html, "remote-1"), /data-reach="reachable"/);
  assert.doesNotMatch(html, /Connect<|Connecting|Started on this computer|Not connected|<button/);
  // Ids stay out of the page: the member reads names.
  assert.doesNotMatch(text(html), /cmp_1|ws_1|ses_1/);
  assert.doesNotMatch(html, /<table|<td/);
});

test("every state reads as a dot and a word, not a pill, and an untitled session still has a name", () => {
  const states: Array<[MemberSession["state"], string, string]> = [["starting", "Starting", "opacity-50"], ["running", "Working", "ow-success"], ["waiting", "Needs you", "ow-warning"], ["idle", "Idle", "opacity-50"], ["error", "Error", "ow-danger"]];
  for (const [state, label, dot] of states) {
    const html = row(list([{ ...base, state }]), "remote-1");
    assert.match(html, new RegExp(`rounded-full[^"]*${dot}[^>]*></span><span[^>]*>${label}<`), state);
    assert.doesNotMatch(html, /px-2 py-0\.5|bg-amber-50|bg-blue-50/, state);
  }
  // A reachable session whose computer has not reported yet shows no state rather than a guess.
  const unknown = list([{ ...base, state: "unknown", title: null, updatedAt: null, computerLabel: null, workspaceName: null, latestStep: null }]);
  assert.match(text(row(unknown, "remote-1")), /Untitled session Computer not reported Not reported/);
  assert.doesNotMatch(row(unknown, "remote-1"), /rounded-full|Not connected/);
});

test("a session being connected says so and cannot be opened yet", () => {
  const html = list([{ ...local, reach: "connecting", commandId: "cmd_2" }]);
  assert.match(text(html), /Refactor the importer Work laptop Docs Started on this computer .*Connecting…/);
  assert.doesNotMatch(html, /<a |<button|Not connected/);
});

test("a session started on its computer is labelled and offers Connect, through each step of connecting", () => {
  const render = (attempt: AttachAttempt | undefined) => list([local], { attemptFor: () => attempt });
  const idle = render(undefined);
  assert.match(text(row(idle, "local-1")), /Refactor the importer Work laptop Docs Started on this computer Not connected 3 hours ago Connect/);
  assert.match(idle, /<button[^>]*data-testid="session-connect-local-1"[^>]*>/);
  assert.match(idle, /aria-label="Connect to Refactor the importer"/);
  assert.doesNotMatch(idle, /<a |disabled=""/);

  const requesting = render({ phase: "requesting" });
  assert.match(requesting, /<button[^>]*disabled=""[^>]*data-testid="session-connect-local-1"|<button[^>]*data-testid="session-connect-local-1"[^>]*disabled=""/);

  const queued = render({ phase: "queued", since: now });
  assert.match(text(queued), /Connecting…/);
  assert.doesNotMatch(queued, /<button/);

  const failed = render({ phase: "failed", message: "Couldn't connect. Try again." });
  assert.match(failed, /role="alert"[^>]*>Couldn(&#x27;|')t connect\. Try again\.</);
  assert.match(failed, /<button[^>]*data-testid="session-connect-local-1"/);
  const refused = render({ phase: "failed", message: "That computer only allows sessions started remotely." });
  assert.match(text(refused), /That computer only allows sessions started remotely\./);
});

test("Connect hands back the session it was pressed on, and a session keeps one identity while it connects", () => {
  const pressed: MemberSession[] = [];
  const tree = SessionRows({ label: "Sessions", sessions: [local], ...rows, onConnect: (session) => pressed.push(session) });
  const connect = elements(tree).find((element) => element.props["data-testid"] === "session-connect-local-1");
  assert.ok(connect, "No Connect button");
  (connect.props.onClick as () => void)();
  assert.deepEqual(pressed, [local]);
  assert.equal(sessionIdentity(local), sessionIdentity({ ...local, key: "cmd_2" }));
  assert.notEqual(sessionIdentity(local), sessionIdentity(base));
  assert.equal(sessionIdentity({ key: "starting-1", computerId: null, workspaceId: null, sessionId: null }), "starting-1");
});

test("sessions that wait come first under Needs you, each with what it waits for", () => {
  const permission: MemberSession = { ...base, key: "waits-permission", state: "waiting", waitingFor: "permission", updatedAt: new Date(now - 60 * 60_000).toISOString(), latestStep: null,
    pending: { kind: "permission", requestId: "per_1", title: "Run pnpm test in ~/work" } };
  const question: MemberSession = { ...base, key: "waits-question", state: "waiting", waitingFor: "question", updatedAt: new Date(now - 60_000).toISOString(), latestStep: null,
    pending: { kind: "question", requestId: "que_1", question: "Which branch should I use?", options: ["main", "dev"], multiple: false, custom: false, questionCount: 1 } };
  const html = renderToStaticMarkup(<SessionsList sessions={[base, permission, local, question]} {...rows} />);
  const page = text(html);
  assert.match(page, /Needs you 2 .*Which branch should I use\?.*Run pnpm test in ~\/work.*Other sessions 2 .*Update the release notes.*Refactor the importer/);
  const needsYou = html.split('data-testid="my-sessions-rest"')[0] ?? "";
  assert.equal(needsYou.match(/data-testid="session-row-/g)?.length, 2);
  assert.doesNotMatch(needsYou, /session-row-remote-1|session-row-local-1/);
  assert.match(html, /data-testid="my-sessions-list"/);
  assert.match(html, /data-testid="my-sessions-needs-you"/);

  const calm = text(renderToStaticMarkup(<SessionsList sessions={[base, local]} {...rows} />));
  assert.doesNotMatch(calm, /Needs you|Other sessions/);
  assert.match(calm, /Sessions 2 /);
});

test("the line under the title counts what waits and what works, or says that nothing waits", () => {
  const waiting: MemberSession = { ...base, state: "waiting" };
  assert.equal(sessionsStateLine([waiting, base, { ...base, state: "starting" }, { ...base, state: "idle" }]), "1 needs you, 2 working");
  assert.equal(sessionsStateLine([waiting, waiting]), "2 need you");
  assert.equal(sessionsStateLine([base]), "1 working");
  assert.equal(sessionsStateLine([{ ...base, state: "idle" }, local]), "No sessions waiting");
  assert.equal(sessionsStateLine([]), "No sessions yet");
});

test("with no sessions the page says where they come from, without promising access", () => {
  const page = text(renderToStaticMarkup(<SessionsList sessions={[]} {...rows} />));
  assert.match(page, /No sessions yet\. Tasks you start on another computer show up here\. Sessions started on a computer appear once that computer allows all sessions\./);
  assert.doesNotMatch(page, /grant|gives? (you )?access/i);
});

test("the computers rows say what other devices can reach on each computer, and why", () => {
  const html = renderToStaticMarkup(<SessionComputers ceiling="created" computers={[
    computer,
    { ...computer, computerId: "cmp_2", label: "Mac mini", online: false, access: "all" },
    { ...computer, computerId: "cmp_3", label: "Old PC", supportsAccess: false },
  ]} />);
  const page = text(html);
  assert.match(page, /Your computers /);
  assert.match(html, /data-testid="my-sessions-computers"/);
  assert.match(page, /Work laptop Other devices can reach: Only sessions started remotely Your organization only allows sessions started remotely\. Online/);
  const widened = text(renderToStaticMarkup(<SessionComputers ceiling="all" computers={[computer]} />));
  assert.match(widened, /Work laptop Other devices can reach: Only sessions started remotely Change this in Settings › Devices on that computer\. Online/);
  assert.match(page, /Mac mini Other devices can reach: Only sessions started remotely Your organization only allows sessions started remotely\. Offline/);
  assert.match(page, /Old PC Other devices can reach: Only sessions started remotely Update OpenWork on this computer to choose\. Online/);
  // Read-only here: the choice is made on the computer.
  assert.doesNotMatch(html, /<button|<input|<select|<a |<table/);

  const open = text(renderToStaticMarkup(<SessionComputers ceiling="all" computers={[{ ...computer, access: "all", effectiveAccess: "all" }]} />));
  assert.match(open, /Work laptop Other devices can reach: All sessions Online/);
  assert.doesNotMatch(open, /Change this|only allows|Update OpenWork/);
  assert.match(text(renderToStaticMarkup(<SessionComputers ceiling="created" computers={[]} />)), /No computers yet\./);
});

function orgContext(features: DenOrgContext["features"]): DenOrgContext {
  const parsed = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "om_1", userId: "user_1", role: "member", isOwner: false },
  });
  assert.ok(parsed);
  return { ...parsed, features };
}

test("with remoteSessionAccess off the page is a locked notice and nothing that reads sessions is mounted", () => {
  // Every other feature on, Computers included: My Sessions has its own switch.
  const off = orgContext(mapFeatures((key) => key !== "remoteSessionAccess"));
  // Rendered with no router and no query client: anything that fetched or navigated would throw here.
  const html = renderToStaticMarkup(<MySessionsPage orgId="org_1" orgContext={off} />);
  assert.match(html, /data-testid="my-sessions-locked"/);
  assert.match(text(html), /My Sessions My Sessions is not enabled for this organization\. Ask an organization owner or admin about availability\./);
  assert.doesNotMatch(html, /role="table"|<a |<button|Your computers|data-testid="my-sessions"/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  const locked = MySessionsPage({ orgId: "org_1", orgContext: off });
  assert.ok(isValidElement(locked));
  assert.notEqual(locked.type, MySessions);

  // While the organization is still loading there is a skeleton, not a lock and not a list.
  for (const loading of [{ orgId: null, orgContext: off }, { orgId: "org_1", orgContext: null }]) {
    const skeleton = renderToStaticMarkup(<MySessionsPage {...loading} />);
    assert.match(skeleton, /aria-busy="true" aria-label="My Sessions"/);
    assert.doesNotMatch(skeleton, /my-sessions-locked|not enabled/);
  }
});

test("with remoteSessionAccess on the page reads the member's own sessions, for the organization on screen only", () => {
  const on = orgContext(mapFeatures((key) => key === "remoteSessionAccess"));
  const page = MySessionsPage({ orgId: "org_1", orgContext: on });
  assert.ok(isValidElement(page));
  assert.equal(page.type, MySessions);
  assert.deepEqual(page.props, { orgId: "org_1", memberId: "om_1", ready: true });
  // That component needs the dashboard's router and query client, which is why the locked page above could render without them.
  assert.throws(() => renderToStaticMarkup(<MySessionsPage orgId="org_1" orgContext={on} />));
  // Mid-switch, the organization on screen is not yet the one that was loaded: nothing is read for it.
  const switching = MySessionsPage({ orgId: "org_2", orgContext: on });
  assert.ok(isValidElement(switching));
  assert.deepEqual(switching.props, { orgId: "org_2", memberId: "om_1", ready: false });
  assert.equal(switching.key, "org_2");
});

/** The list as the page draws it for a set of Connects in flight. */
const listWith = (sessions: MemberSession[], attempts: AttachAttempts) =>
  renderToStaticMarkup(<SessionsList sessions={sessions} {...rows} attemptFor={(session) => attempts[sessionIdentity(session)]} />);

test("a queued Connect that becomes reachable opens that session and leaves a plain, openable row", () => {
  const identity = sessionIdentity(local);
  const queued = attachAnswered(attachRequested({}, identity), identity, { state: "queued", commandId: "cmd_2" }, 1_000);
  assert.equal(queued.open, null);
  assert.match(text(listWith([local], queued.attempts)), /Connecting…/);

  // The next list shows it connecting under the command's key, then reachable.
  const connecting: MemberSession = { ...local, key: "command:cmd_2", reach: "connecting", commandId: "cmd_2", state: "starting" };
  const waiting = settleAttachAttempts(queued.attempts, [connecting], 2_000, false);
  assert.equal(waiting.attempts, queued.attempts);
  assert.equal(waiting.open, null);

  const reachable: MemberSession = { ...connecting, reach: "reachable", state: "idle" };
  const settled = settleAttachAttempts(queued.attempts, [reachable], 3_000, false);
  assert.equal(settled.open, "cmd_2");
  assert.deepEqual(settled.attempts, {});
  assert.equal(rows.hrefFor(settled.open ?? ""), "/dashboard/my-sessions?session=cmd_2");
  const html = listWith([reachable], settled.attempts);
  assert.match(html, /<a[^>]*href="\/dashboard\/my-sessions\?session=cmd_2"[^>]*>Refactor the importer<\/a>/);
  assert.doesNotMatch(html, /Connecting|<button|role="alert"/);
});

test("a queued Connect whose session needs a Connect again says it could not connect, on its row", () => {
  const identity = sessionIdentity(local);
  const queued = attachAnswered({}, identity, { state: "queued", commandId: "cmd_2" }, 1_000).attempts;
  const settled = settleAttachAttempts(queued, [local], 2_000, false);
  assert.equal(settled.open, null);
  assert.deepEqual(settled.attempts, { [identity]: { phase: "failed", message: "Couldn't connect. Try again." } });
  const html = listWith([local], settled.attempts);
  assert.match(row(html, "local-1"), /role="alert"[^>]*>Couldn(&#x27;|')t connect\. Try again\.</);
  // Connect is offered again on the same row.
  assert.match(row(html, "local-1"), /<button[^>]*data-testid="session-connect-local-1"/);
  assert.doesNotMatch(row(html, "local-1"), /Connecting|disabled=""/);
});
