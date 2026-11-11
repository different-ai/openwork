"use client";

import { useState } from "react";
import type { RemoteSessionAnswerInput, RemoteSessionPending } from "@openwork/types/automations";
import { DenButton } from "../../../_components/ui/button";
import { DenInput } from "../../../_components/ui/input";
import { hairline, secondaryText } from "../computers/computer-parts";
import {
  EMPTY_QUESTION_DRAFT,
  dismissAnswer,
  permissionAnswer,
  questionAnswers,
  questionsAnswer,
  setQuestionCustom,
  toggleQuestionOption,
  type PendingQuestion,
  type PermissionPending,
  type QuestionDraft,
  type QuestionPending,
} from "./sessions-model";

/*
 * What a session waits on the member for. Titles, details, commands, questions
 * and options are text from the other computer and are shown as plain text.
 */

/** One card's answer in flight and how the last attempt ended. */
export type PendingCardState = {
  sending: RemoteSessionAnswerInput | null;
  error: string | null;
};
export const IDLE_CARD_STATE: PendingCardState = { sending: null, error: null };

const cardClass = `rounded-lg border ${hairline} p-4 text-[13px]`;

function CardError({ message, busy, onRetry }: { message: string; busy: boolean; onRetry: () => void }) {
  return <div role="alert" className="mt-3 flex flex-wrap items-center gap-3">
    <p className="min-w-0 break-words text-[var(--ow-danger)]">{message}</p>
    <DenButton variant="secondary" size="sm" disabled={busy} onClick={onRetry}>Try again</DenButton>
  </div>;
}

/** A permission the session asks for. Allow once or deny; "always" is only offered on the computer itself. */
export function PermissionCard({ item, state, onAnswer, onRetry }: {
  item: PermissionPending;
  state: PendingCardState;
  onAnswer: (answer: RemoteSessionAnswerInput) => void;
  onRetry: () => void;
}) {
  const busy = state.sending !== null;
  const sendingDecision = state.sending?.kind === "permission" ? state.sending.decision : null;
  return <section className={cardClass} aria-label="Permission request" data-testid={`session-pending-${item.requestId}`} data-pending-kind="permission">
    <h3 className="break-words font-medium">{item.title}</h3>
    {item.detail.trim() ? <p className={`mt-1 whitespace-pre-wrap break-words ${secondaryText}`}>{item.detail}</p> : null}
    {item.command ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--dls-hover)] px-3 py-2 font-mono text-[12px]">{item.command}</pre> : null}
    {state.error ? <CardError message={state.error} busy={busy} onRetry={onRetry} /> : null}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <DenButton size="sm" loading={sendingDecision === "once"} disabled={busy} onClick={() => onAnswer(permissionAnswer(item.requestId, "once"))}>Allow once</DenButton>
      <DenButton size="sm" variant="secondary" loading={sendingDecision === "reject"} disabled={busy} onClick={() => onAnswer(permissionAnswer(item.requestId, "reject"))}>Deny</DenButton>
      <p className={`text-xs ${secondaryText}`}>To always allow, answer on that computer.</p>
    </div>
  </section>;
}

const choiceInputClass = "mt-0.5 h-4 w-4 shrink-0 accent-gray-900";

function QuestionField({ question, name, draft, disabled, onDraft }: {
  question: PendingQuestion;
  /** Groups this question's radios. */
  name: string;
  draft: QuestionDraft;
  disabled: boolean;
  onDraft: (draft: QuestionDraft) => void;
}) {
  const heading = question.header.trim();
  return <fieldset className="min-w-0" disabled={disabled}>
    <legend className="break-words font-medium">{heading || question.question}</legend>
    {heading && question.question.trim() ? <p className={`mt-1 whitespace-pre-wrap break-words ${secondaryText}`}>{question.question}</p> : null}
    <div className="mt-2 space-y-1.5">
      {question.options.map((option) => <label key={option.label} className="flex cursor-pointer items-start gap-2">
        <input type={question.multiple ? "checkbox" : "radio"} name={name} value={option.label} className={choiceInputClass}
          checked={draft.selected.includes(option.label)} onChange={() => onDraft(toggleQuestionOption(question, draft, option.label))} />
        <span className="min-w-0">
          <span className="block break-words">{option.label}</span>
          {option.description.trim() ? <span className={`block break-words text-xs ${secondaryText}`}>{option.description}</span> : null}
        </span>
      </label>)}
      {question.custom ? <div className="max-w-md pt-1">
        <DenInput type="text" aria-label={`Other answer: ${heading || question.question}`} placeholder={question.options.length ? "Other" : "Your answer"} maxLength={2000}
          value={draft.custom} disabled={disabled} onChange={(event) => onDraft(setQuestionCustom(question, draft, event.target.value))} />
      </div> : null}
    </div>
  </fieldset>;
}

/** The questions of one request, with what is picked so far. Send answer needs an answer to every question. */
export function QuestionCardView({ item, drafts, state, onDraft, onAnswer, onRetry }: {
  item: QuestionPending;
  drafts: readonly (QuestionDraft | undefined)[];
  state: PendingCardState;
  onDraft: (index: number, draft: QuestionDraft) => void;
  onAnswer: (answer: RemoteSessionAnswerInput) => void;
  onRetry: () => void;
}) {
  const busy = state.sending !== null;
  const answers = questionAnswers(item.questions, drafts);
  return <section className={cardClass} aria-label={item.questions.length === 1 ? "Question" : "Questions"} data-testid={`session-pending-${item.requestId}`} data-pending-kind="question">
    <div className="space-y-4">
      {item.questions.map((question, index) => <QuestionField key={index} question={question} name={`${item.requestId}:${index}`}
        draft={drafts[index] ?? EMPTY_QUESTION_DRAFT} disabled={busy} onDraft={(draft) => onDraft(index, draft)} />)}
    </div>
    {state.error ? <CardError message={state.error} busy={busy} onRetry={onRetry} /> : null}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <DenButton size="sm" loading={state.sending?.kind === "question"} disabled={busy || !answers} onClick={() => { if (answers) onAnswer(questionsAnswer(item.requestId, answers)); }}>Send answer</DenButton>
      <DenButton size="sm" variant="secondary" loading={state.sending?.kind === "dismiss"} disabled={busy} onClick={() => onAnswer(dismissAnswer(item.requestId))}>Dismiss</DenButton>
    </div>
  </section>;
}

function QuestionCard(props: Omit<Parameters<typeof QuestionCardView>[0], "drafts" | "onDraft">) {
  const [drafts, setDrafts] = useState<readonly (QuestionDraft | undefined)[]>([]);
  return <QuestionCardView {...props} drafts={drafts} onDraft={(index, draft) => setDrafts((current) => {
    const next = [...current];
    next[index] = draft;
    return next;
  })} />;
}

/** One card per open permission or question, in the order the computer listed them. */
export function PendingCards({ items, stateFor, onAnswer, onRetry }: {
  items: readonly RemoteSessionPending[];
  stateFor: (requestId: string) => PendingCardState;
  onAnswer: (answer: RemoteSessionAnswerInput) => void;
  onRetry: (requestId: string) => void;
}) {
  if (items.length === 0) return null;
  return <div className="space-y-3" data-testid="session-pending">
    {items.map((item) => item.kind === "permission"
      ? <PermissionCard key={item.requestId} item={item} state={stateFor(item.requestId)} onAnswer={onAnswer} onRetry={() => onRetry(item.requestId)} />
      : <QuestionCard key={item.requestId} item={item} state={stateFor(item.requestId)} onAnswer={onAnswer} onRetry={() => onRetry(item.requestId)} />)}
  </div>;
}
