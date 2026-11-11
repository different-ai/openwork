import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapFeatures } from "@openwork/features";
import type { MemberSession, MemberSessionComputer } from "@openwork/types/den/remote-sessions";
import { parseOrgContextPayload, type DenOrgContext } from "../../../_lib/den-org";
import { MySessions, MySessionsPage, SessionComputers, SessionsList, SessionsTable } from "./my-sessions-screen";
import { attachAnswered, attachRequested, sessionIdentity, settleAttachAttempts, type AttachAttempt, type AttachAttempts } from "./sessions-model";

const now = Date.parse("2026-11-10T12:10:00Z");
const base: MemberSession = {
  key: "remote-1", computerId: "cmp_1", computerLabel: "Work laptop", workspaceId: "ws_1", workspaceName: "Docs", sessionId: "ses_1",
  title: "Update the release notes", origin: "remote", reach: "reachable", commandId: "cmd_1", state: "running", waitingFor: null, pending: null,
  latestStep: "Ran List the release notes", updatedAt: now - 2 * 60_000,
};
const local: MemberSession = {
  ...base, key: "local-1", sessionId: "ses_2", title: "Refactor the importer", origin: "local", reach: "attachable", commandId: null, state: "unknown", latestStep: null, updatedAt: now - 3 * 3_600_000,
};
const computer: MemberSessionComputer = {
  computerId: "cmp_1", label: "Work laptop", platform: "darwin", online: true, lastSeenAt: now, supportsAccess: true, access: "created", effectiveAccess: "created", sessionsUpdatedAt: null,
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const rows = { now, attemptFor: () => undefined, onConnect: () => {}, hrefFor: (commandId: string) => `/dashboard/my-sessions?session=${commandId}` };
const row = (html: string, key: string) => html.split("<tr").find((part) => part.includes(`session-row-${key}"`)) ?? "";

test("a reachable session opens from its row and shows where it runs, its state, when it changed and its last step", () => {
  const html = renderToStaticMarkup(<SessionsTable sessions={[base]} {...rows} />);
  assert.match(text(html), /Session.*Computer.*State.*Updated.*Connection/);
  assert.match(text(html), /Update the release notes Ran List the release notes Work laptop Docs Working 2 min ago/);
  assert.match(html, /<a[^>]*href="\/dashboard\/my-sessions\?session=cmd_1"[^>]*>Update the release notes<\/a>/);
  assert.doesNotMatch(html, /Connect<|Connecting|Started on this computer|Not connected/);
  // Ids stay out of the page: the member reads names.
  assert.doesNotMatch(text(html), /cmp_1|ws_1|ses_1/);
});

test("every state reads as its badge, and an untitled session still has a name", () => {
  const states: Array<[MemberSession["state"], string]> = [["starting", "Starting"], ["running", "Working"], ["waiting", "Needs you"], ["idle", "Idle"], ["error", "Error"]];
  for (const [state, label] of states) {
    const html = renderToStaticMarkup(<SessionsTable sessions={[{ ...base, state }]} {...rows} />);
    assert.match(row(html, "remote-1"), new RegExp(`rounded-full[^>]*>${label}<`), state);
  }
  // A reachable session whose computer has not reported yet shows no state rather than a guess.
  const unknown = renderToStaticMarkup(<SessionsTable sessions={[{ ...base, state: "unknown", title: null, updatedAt: null, computerLabel: null, workspaceName: null, latestStep: null }]} {...rows} />);
  assert.match(text(unknown), /Untitled session Not reported Not reported/);
  assert.doesNotMatch(unknown, /rounded-full|Not connected/);
});

test("a session being connected says so and cannot be opened yet", () => {
  const html = renderToStaticMarkup(<SessionsTable sessions={[{ ...local, reach: "connecting", commandId: "cmd_2" }]} {...rows} />);
  assert.match(text(html), /Refactor the importer Started on this computer .*Connecting…/);
  assert.doesNotMatch(html, /<a |<button|Not connected/);
});

test("a session started on its computer is labelled and offers Connect, through each step of connecting", () => {
  const render = (attempt: AttachAttempt | undefined) => renderToStaticMarkup(<SessionsTable sessions={[local]} {...rows} attemptFor={() => attempt} />);
  const idle = render(undefined);
  assert.match(text(idle), /Refactor the importer Started on this computer Work laptop Docs Not connected 3 hours ago Connect/);
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
  const table = SessionsTable({ sessions: [local], ...rows, onConnect: (session) => pressed.push(session) });
  const columns: Array<{ key: string; render: (session: MemberSession) => unknown }> = table.props.columns;
  const cell = columns.find((column) => column.key === "connection")?.render(local) as { props: { onConnect: () => void } };
  cell.props.onConnect();
  assert.deepEqual(pressed, [local]);
  assert.equal(sessionIdentity(local), sessionIdentity({ ...local, key: "cmd_2" }));
  assert.notEqual(sessionIdentity(local), sessionIdentity(base));
  assert.equal(sessionIdentity({ key: "starting-1", computerId: null, workspaceId: null, sessionId: null }), "starting-1");
});

test("sessions that wait come first under Needs you, each with what it waits for", () => {
  const permission: MemberSession = { ...base, key: "waits-permission", state: "waiting", waitingFor: "permission", updatedAt: now - 60 * 60_000, latestStep: null,
    pending: { kind: "permission", requestId: "per_1", title: "Run pnpm test in ~/work" } };
  const question: MemberSession = { ...base, key: "waits-question", state: "waiting", waitingFor: "question", updatedAt: now - 60_000, latestStep: null,
    pending: { kind: "question", requestId: "que_1", question: "Which branch should I use?", options: ["main", "dev"], multiple: false, custom: false, questionCount: 1 } };
  const html = renderToStaticMarkup(<SessionsList sessions={[base, permission, local, question]} {...rows} />);
  const page = text(html);
  assert.match(page, /Needs you .*Which branch should I use\?.*Run pnpm test in ~\/work.*Other sessions .*Update the release notes.*Refactor the importer/);
  const needsYou = html.split('data-testid="my-sessions-rest"')[0] ?? "";
  assert.equal(needsYou.match(/data-testid="session-row-/g)?.length, 2);
  assert.doesNotMatch(needsYou, /session-row-remote-1|session-row-local-1/);

  const calm = text(renderToStaticMarkup(<SessionsList sessions={[base, local]} {...rows} />));
  assert.doesNotMatch(calm, /Needs you|Other sessions/);
  assert.match(calm, /Sessions /);
});

test("with no sessions the page says where they come from, without promising access", () => {
  const page = text(renderToStaticMarkup(<SessionsList sessions={[]} {...rows} />));
  assert.match(page, /No sessions yet\. Tasks you start on another computer show up here\. Sessions started on a computer appear once that computer allows all sessions\./);
  assert.doesNotMatch(page, /grant|gives? (you )?access/i);
});

test("the computers strip says what other devices can reach on each computer, and why", () => {
  const html = renderToStaticMarkup(<SessionComputers ceiling="created" computers={[
    computer,
    { ...computer, computerId: "cmp_2", label: "Mac mini", online: false, access: "all" },
    { ...computer, computerId: "cmp_3", label: "Old PC", supportsAccess: false },
  ]} />);
  const page = text(html);
  assert.match(page, /Your computers Computer Status Other devices can reach/);
  assert.match(page, /Work laptop Online Only sessions started remotely Your organization only allows sessions started remotely\./);
  const widened = text(renderToStaticMarkup(<SessionComputers ceiling="all" computers={[computer]} />));
  assert.match(widened, /Work laptop Online Only sessions started remotely Change this in Settings › Devices on that computer\./);
  assert.match(page, /Mac mini Offline Only sessions started remotely Your organization only allows sessions started remotely\./);
  assert.match(page, /Old PC Online Only sessions started remotely Update OpenWork on this computer to choose\./);
  // Read-only here: the choice is made on the computer.
  assert.doesNotMatch(html, /<button|<input|<select|<a /);

  const open = text(renderToStaticMarkup(<SessionComputers ceiling="all" computers={[{ ...computer, access: "all", effectiveAccess: "all" }]} />));
  assert.match(open, /Work laptop Online All sessions/);
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
  assert.doesNotMatch(html, /<table|<a |<button|Your computers|data-testid="my-sessions"/);
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
