import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSessionAnswerInput, RemoteSessionReadResult, RemoteSessionTranscriptMessage } from "@openwork/types/automations";
import { DenButton } from "../../../_components/ui/button";
import { IDLE_CARD_STATE, PendingCards, PermissionCard, QuestionCardView, type PendingCardState } from "./session-pending-cards";
import { SessionMessages, SessionPanelView, offlineLine, sessionErrorLine, type SessionPanelViewProps } from "./session-panel";
import { RemoteSessionError } from "./sessions-data";
import { mergeLatestPage, type PermissionPending, type QuestionDraft, type QuestionPending } from "./sessions-model";

const now = Date.parse("2026-11-10T12:10:00Z");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element a hook-free component renders, with the plain components inside it rendered too. */
function elements(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as AnyElement;
  const own = [element, ...elements(element.props.children as ReactNode)];
  if (typeof element.type !== "function") return own;
  try {
    return [...own, ...elements((element.type as (props: unknown) => ReactNode)(element.props))];
  } catch {
    // A component with state is checked through its rendered markup instead.
    return own;
  }
}

function button(tree: ReactNode, label: string): { disabled: boolean; press: () => void } {
  const found = elements(tree).find((element) => element.type === DenButton && element.props.children === label);
  assert.ok(found, `No "${label}" button`);
  return { disabled: found.props.disabled === true, press: () => (found.props.onClick as () => void)() };
}

function choice(tree: ReactNode, value: string): { type: unknown; checked: boolean; pick: () => void } {
  const found = elements(tree).find((element) => element.type === "input" && element.props.value === value && element.props.type !== "text");
  assert.ok(found, `No "${value}" option`);
  return { type: found.props.type, checked: found.props.checked === true, pick: () => (found.props.onChange as () => void)() };
}

function typeOther(tree: ReactNode, label: RegExp, value: string) {
  const found = elements(tree).find((element) => element.type === "input" && element.props.type === "text" && label.test(String(element.props["aria-label"])));
  assert.ok(found, `No text answer matching ${label}`);
  (found.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

const message = (overrides: Partial<RemoteSessionTranscriptMessage>): RemoteSessionTranscriptMessage => ({
  id: "msg_1", role: "assistant", createdAt: now - 60_000, text: "", truncated: false, toolCalls: [], error: null, ...overrides,
});
const read = (overrides: Partial<RemoteSessionReadResult> = {}): RemoteSessionReadResult => ({
  title: "Update the release notes", status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: "end", nextCursor: null,
  messages: [message({ id: "msg_1", role: "user", text: "Update the release notes" }), message({ id: "msg_2", text: "Done. The notes are updated." })],
  ...overrides,
});

test("remote text is shown as text: no links, no markdown, no markup", () => {
  const hostile = "See [the docs](https://example.com/docs) or https://evil.example/login <a href=\"https://evil.example\">click</a> <img src=x onerror=alert(1)> **bold**";
  const html = renderToStaticMarkup(<SessionMessages now={now} messages={[
    message({ id: "msg_1", role: "user", text: hostile }),
    message({ id: "msg_2", text: hostile, parts: [
      { type: "tool", id: "t1", name: "bash", status: "completed", title: "Open https://evil.example", input: null, output: "<script>alert(1)</script>", error: null, truncated: false },
      { type: "text", text: hostile },
    ], error: { code: "failed", message: "Visit https://evil.example/fix" } }),
  ]} />);
  // Nothing in the messages became an element or an attribute; the markup they carried is escaped text.
  assert.doesNotMatch(html, /<a[\s>]|href="|<img|<script|<strong|<b>|onerror="/);
  assert.equal(text(html).split("See [the docs](https://example.com/docs) or https://evil.example/login").length, 3);
  assert.match(html, /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt;/);
  assert.match(text(html), /\*\*bold\*\*/);
  // A tool step is one line: what it did and how it ended, never its input or output.
  assert.match(text(html), /Open https:\/\/evil\.example Done/);
  assert.doesNotMatch(html, /alert\(1\)&lt;\/script|secret/);
  assert.match(text(html), /You 1 min ago/);
  assert.match(text(html), /OpenWork 1 min ago/);
});

function panel(overrides: Partial<SessionPanelViewProps> = {}): SessionPanelViewProps {
  return {
    title: "Update the release notes", computerLabel: "Work laptop", workspaceName: "Docs", state: "idle", offline: false,
    view: mergeLatestPage(undefined, read()), loading: false, error: null, retrying: false, onRetry: () => {},
    earlier: { available: false, loading: false, error: null, onLoad: () => {} },
    pending: { items: [], stateFor: () => IDLE_CARD_STATE, onAnswer: () => {}, onRetry: () => {} },
    notice: null,
    followUp: { draft: "", sending: false, error: null, onDraft: () => {}, onSend: () => {} },
    stop: { stopping: false, error: null, onStop: () => {} },
    onClose: () => {}, now, ...overrides,
  };
}

test("an open session shows where it runs, the conversation and a follow-up box", () => {
  const html = renderToStaticMarkup(<SessionPanelView {...panel()} />);
  const page = text(html);
  assert.match(page, /Back to My Sessions Update the release notes Work laptop Docs Idle/);
  assert.match(page, /You 1 min ago Update the release notes OpenWork 1 min ago Done\. The notes are updated\./);
  assert.match(html, /<textarea[^>]*aria-label="Follow-up message"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>|<button[^>]*disabled=""[^>]*type="submit"[^>]*>/);
  assert.doesNotMatch(page, /Stop|Load earlier|offline/);
  // With something typed, Send is ready.
  const typed = renderToStaticMarkup(<SessionPanelView {...panel({ followUp: { draft: "Also the changelog", sending: false, error: null, onDraft: () => {}, onSend: () => {} } })} />);
  assert.doesNotMatch(typed, /<button[^>]*type="submit"[^>]*disabled=""|<button[^>]*disabled=""[^>]*type="submit"/);
});

test("Stop is offered only while the session is running, and earlier messages only when there are some", () => {
  const running = text(renderToStaticMarkup(<SessionPanelView {...panel({ state: "running", view: mergeLatestPage(undefined, read({ status: "running", nextCursor: "msg_1" })), earlier: { available: true, loading: false, error: null, onLoad: () => {} } })} />));
  assert.match(running, /Working/);
  assert.match(running, /Load earlier/);
  assert.match(running, /Stop Send/);
  const failed = text(renderToStaticMarkup(<SessionPanelView {...panel({ state: "error", view: mergeLatestPage(undefined, read({ status: "error", lastError: { code: "provider_error", message: "The model stopped answering." } })) })} />));
  assert.match(failed, /Error/);
  assert.match(failed, /The model stopped answering\./);
  assert.doesNotMatch(failed, /Stop/);
});

test("an offline computer keeps the last conversation and says it resumes on reconnect", () => {
  const html = renderToStaticMarkup(<SessionPanelView {...panel({ offline: true, followUp: { draft: "Keep going", sending: false, error: null, onDraft: () => {}, onSend: () => {} } })} />);
  const page = text(html);
  assert.match(page, /Work laptop is offline\. This resumes when it reconnects\./);
  assert.match(page, /Done\. The notes are updated\./);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""|<button[^>]*disabled=""[^>]*type="submit"/);
  assert.equal(offlineLine(null), "This computer is offline. This resumes when it reconnects.");
});

test("loading shows a skeleton, and a failed read says why with a way to retry", () => {
  const loading = renderToStaticMarkup(<SessionPanelView {...panel({ view: undefined, loading: true })} />);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(text(loading), /Loading|No messages/);
  const failed = text(renderToStaticMarkup(<SessionPanelView {...panel({ error: "Update OpenWork on that computer to follow this session from here." })} />));
  assert.match(failed, /Update OpenWork on that computer to follow this session from here\. Showing what was last read\. Try again/);
  const never = text(renderToStaticMarkup(<SessionPanelView {...panel({ view: undefined, error: "Couldn't load this session. Try again." })} />));
  assert.doesNotMatch(never, /Showing what was last read/);

  assert.equal(sessionErrorLine(new RemoteSessionError("desktop_update_required", "remote-session:read with its commandId still reports status."), "x"), "Update OpenWork on that computer to follow this session from here.");
  assert.equal(sessionErrorLine(new RemoteSessionError("unknown_session", "No remote session"), "x"), "This session is no longer on that computer.");
  assert.equal(sessionErrorLine(new RemoteSessionError("stale_request", "That request is no longer pending."), "x"), "This was already answered.");
  assert.equal(sessionErrorLine(new RemoteSessionError("answer_unsupported", "Update OpenWork there, or answer it on that computer."), "x"), "Update OpenWork there, or answer it on that computer.");
  assert.equal(sessionErrorLine(new RemoteSessionError("session_access_denied", "That computer only allows sessions started remotely."), "x"), "That computer only allows sessions started remotely.");
  assert.equal(sessionErrorLine(null, "Couldn't send your answer. Try again."), "Couldn't send your answer. Try again.");
});

const permission: PermissionPending = { kind: "permission", requestId: "per_1", title: "Run a command", detail: "In ~/work/notes. See https://example.com/why", command: "pnpm test --filter notes" };

test("a permission offers Allow once and Deny, and nothing that allows always", () => {
  const sent: RemoteSessionAnswerInput[] = [];
  const props = { item: permission, state: IDLE_CARD_STATE, onAnswer: (answer: RemoteSessionAnswerInput) => { sent.push(answer); }, onRetry: () => {} };
  const html = renderToStaticMarkup(<PermissionCard {...props} />);
  const card = text(html);
  assert.match(card, /Run a command In ~\/work\/notes\. See https:\/\/example\.com\/why pnpm test --filter notes Allow once Deny To always allow, answer on that computer\./);
  assert.match(html, /<pre[^>]*font-mono[^>]*>pnpm test --filter notes<\/pre>/);
  assert.doesNotMatch(html, /<a[\s>]|href=/);
  assert.deepEqual([...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1] ?? "").trim()), ["Allow once", "Deny"]);

  button(PermissionCard(props), "Allow once").press();
  button(PermissionCard(props), "Deny").press();
  assert.deepEqual(sent, [
    { kind: "permission", requestId: "per_1", decision: "once" },
    { kind: "permission", requestId: "per_1", decision: "reject" },
  ]);
  const bare = renderToStaticMarkup(<PermissionCard {...props} item={{ kind: "permission", requestId: "per_2", title: "Edit notes.md", detail: "" }} />);
  assert.doesNotMatch(bare, /<pre/);
});

test("a failed answer shows the server's message with a retry, and nothing can be pressed while one is sending", () => {
  let retried = 0;
  const failed: PendingCardState = { sending: null, error: "The computer that runs this task can't take answers from here." };
  const props = { item: permission, state: failed, onAnswer: () => {}, onRetry: () => { retried += 1; } };
  assert.match(renderToStaticMarkup(<PermissionCard {...props} />), /role="alert"[^>]*>.*can(&#x27;|')t take answers from here\./);
  button(PermissionCard(props), "Try again").press();
  assert.equal(retried, 1);
  const sending = PermissionCard({ ...props, state: { sending: { kind: "permission", requestId: "per_1", decision: "once" }, error: null } });
  assert.ok(button(sending, "Allow once").disabled);
  assert.ok(button(sending, "Deny").disabled);
});

const question: QuestionPending = { kind: "question", requestId: "que_1", questions: [
  { header: "Branch", question: "Which branch should I use?", options: [{ label: "main", description: "The default branch" }, { label: "dev", description: "" }], multiple: false, custom: false },
  { header: "Checks", question: "Which checks should run?", options: [{ label: "tests", description: "Unit tests" }, { label: "lint", description: "" }], multiple: true, custom: true },
  { header: "", question: "What should the release be called?", options: [], multiple: false, custom: true },
] };

function questionCard(item: QuestionPending) {
  const sent: RemoteSessionAnswerInput[] = [];
  let drafts: (QuestionDraft | undefined)[] = [];
  const render = () => QuestionCardView({
    item, drafts, state: IDLE_CARD_STATE, onRetry: () => {}, onAnswer: (answer) => { sent.push(answer); },
    onDraft: (index, draft) => { drafts = [...drafts]; drafts[index] = draft; },
  });
  return { sent, render };
}

test("a question shows every question with its options, and sends only once each has an answer", () => {
  const card = questionCard(question);
  const html = renderToStaticMarkup(card.render());
  const page = text(html);
  assert.match(page, /Branch Which branch should I use\? main The default branch dev Checks Which checks should run\? tests Unit tests lint What should the release be called\? Send answer Dismiss/);
  assert.equal(html.match(/type="radio"/g)?.length, 2);
  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.equal(html.match(/type="text"/g)?.length, 2);
  assert.match(html, /placeholder="Other"/);
  assert.match(html, /placeholder="Your answer"/);
  assert.doesNotMatch(html, /<a[\s>]|href=/);
  assert.ok(button(card.render(), "Send answer").disabled);

  // Single choice: the last pick stands.
  assert.equal(choice(card.render(), "main").type, "radio");
  choice(card.render(), "main").pick();
  choice(card.render(), "dev").pick();
  assert.ok(choice(card.render(), "dev").checked);
  assert.ok(!choice(card.render(), "main").checked);
  assert.ok(button(card.render(), "Send answer").disabled);

  // Multiple choice: picks add up, and "Other" adds a typed answer.
  assert.equal(choice(card.render(), "lint").type, "checkbox");
  choice(card.render(), "lint").pick();
  choice(card.render(), "tests").pick();
  typeOther(card.render(), /Checks/, "typecheck");
  assert.ok(button(card.render(), "Send answer").disabled, "the third question has no answer yet");

  typeOther(card.render(), /What should the release be called/, "  Atlas  ");
  const send = button(card.render(), "Send answer");
  assert.ok(!send.disabled);
  send.press();
  assert.deepEqual(card.sent, [{ kind: "question", requestId: "que_1", answers: [["dev"], ["tests", "lint", "typecheck"], ["Atlas"]] }]);

  // Unpicking everything in a question takes the answer away again.
  choice(card.render(), "lint").pick();
  choice(card.render(), "tests").pick();
  typeOther(card.render(), /Checks/, "");
  assert.ok(button(card.render(), "Send answer").disabled);
});

test("a question can be dismissed without answering it", () => {
  const card = questionCard(question);
  const dismiss = button(card.render(), "Dismiss");
  assert.ok(!dismiss.disabled);
  dismiss.press();
  assert.deepEqual(card.sent, [{ kind: "dismiss", requestId: "que_1" }]);
  // Pressing Send answer early sends nothing.
  button(card.render(), "Send answer").press();
  assert.equal(card.sent.length, 1);
});

test("every open item gets its own card above the follow-up box, in the computer's order", () => {
  const second: PermissionPending = { kind: "permission", requestId: "per_2", title: "Edit notes.md", detail: "" };
  const html = renderToStaticMarkup(<SessionPanelView {...panel({ state: "waiting", notice: "This was already answered.",
    pending: { items: [permission, question, second], stateFor: () => IDLE_CARD_STATE, onAnswer: () => {}, onRetry: () => {} } })} />);
  assert.deepEqual([...html.matchAll(/data-testid="session-pending-([a-z0-9_]+)"/g)].map((match) => match[1]), ["per_1", "que_1", "per_2"]);
  assert.ok(html.indexOf('data-testid="session-pending-per_2"') < html.indexOf("<textarea"));
  assert.ok(html.indexOf('role="log"') < html.indexOf('data-testid="session-pending-per_1"'));
  assert.match(text(html), /Needs you/);
  assert.match(text(html), /This was already answered\./);
  assert.equal(renderToStaticMarkup(<PendingCards items={[]} stateFor={() => IDLE_CARD_STATE} onAnswer={() => {}} onRetry={() => {}} />), "");
});
