import { OptionRow } from "@openwork/ui/coworker-option";
export { OptionRow } from "@openwork/ui/coworker-option";
import { useEffect, useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import {
  describePermission,
  type PendingInteractions,
  type PendingPermission,
  type PendingQuestion,
  type PendingQuestionItem,
  type PermissionReply,
} from "@/lib/threads";
import type { ReactNode } from "react";
import { Button, ErrorNote, inputClass } from "@/ui/kit";

/**
 * Human intervention is a resumable step inside the thread, not a dead end.
 * Each pending permission or question renders as one bounded card that says
 * what the coworker wants, does nothing until a choice is made, and disappears
 * once the engine has the answer.
 */
export function InteractionCards({
  coworker,
  pending,
  onPermission,
  onAnswer,
  onSkip,
  keyboardShortcuts = true,
}: {
  coworker: CoworkerSummary;
  pending: PendingInteractions;
  onPermission: (permission: PendingPermission, decision: PermissionReply) => Promise<void>;
  onAnswer: (question: PendingQuestion, answers: string[][]) => Promise<void>;
  onSkip: (question: PendingQuestion) => Promise<void>;
  keyboardShortcuts?: boolean;
}) {
  if (pending.permissions.length === 0 && pending.questions.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {pending.permissions.map((permission) => (
        <PermissionCard key={permission.id} coworker={coworker} permission={permission} onDecide={onPermission} keyboardShortcuts={keyboardShortcuts} />
      ))}
      {pending.questions.map((question) => (
        <QuestionCard key={question.id} coworker={coworker} question={question} onAnswer={onAnswer} onSkip={onSkip} keyboardShortcuts={keyboardShortcuts} />
      ))}
    </div>
  );
}

export const LETTERS = "ABCDEFGHIJ";

/** True when a key press belongs to a text field, so a letter shortcut must not steal it. */
export function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

/**
 * The card itself: a coworker-side message with a title, a line of context, and
 * a close control. `needsYou` adds the small amber dot that says the coworker is
 * waiting on the person — never a rose border.
 */
export function InteractionCard({ label, title, titleTestId, detail, needsYou = false, onClose, children, testId }: { label: string; title: string; titleTestId?: string; detail?: string; needsYou?: boolean; onClose?: () => void; children: ReactNode; testId: string }) {
  return (
    <section role="group" aria-label={label} className="max-w-[76%] min-w-[280px] rounded-2xl bg-panel-2 p-4 text-snow" data-testid={testId} data-needs-you={needsYou ? "true" : "false"}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-start gap-2 text-sm font-semibold leading-snug">
            {needsYou ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber" aria-hidden="true" title="Needs you" /> : null}
            <span data-testid={titleTestId}>{title}</span>
          </h3>
          {detail ? <p className="mt-1 text-xs leading-relaxed text-mist">{detail}</p> : null}
        </div>
        {onClose ? (
          <button type="button" className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-mist transition-colors hover:bg-white/8 hover:text-snow" aria-label="Skip this" title="Skip this" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PermissionCard({
  coworker,
  permission,
  onDecide,
  keyboardShortcuts,
}: {
  coworker: CoworkerSummary;
  permission: PendingPermission;
  onDecide: (permission: PendingPermission, decision: PermissionReply) => Promise<void>;
  keyboardShortcuts: boolean;
}) {
  const [busy, setBusy] = useState<PermissionReply | "">("");
  const [error, setError] = useState("");

  async function decide(decision: PermissionReply) {
    setBusy(decision);
    setError("");
    try {
      await onDecide(permission, decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy("");
    }
  }

  const choices: { letter: string; label: string; description: string; decision: PermissionReply; tone?: "danger" }[] = [
    { letter: "A", label: "Allow once", description: "Just this step.", decision: "once" },
    ...(permission.canAlways ? [{ letter: "B", label: "Always allow", description: "Remember this for the coworker.", decision: "always" as PermissionReply }] : []),
    { letter: permission.canAlways ? "C" : "B", label: "Don't allow", description: "Ends this step; the coworker explains and continues.", decision: "reject", tone: "danger" as const },
  ];

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const choice = choices.find((item) => item.letter === event.key.toUpperCase());
      if (!choice) return;
      event.preventDefault();
      void decide(choice.decision);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <InteractionCard
      label={`${coworker.name} needs permission`}
      testId="permission-card"
      title={`${coworker.name} wants to ${describePermission({ action: permission.action, resources: [] })}`}
      detail="Nothing happens until you choose."
    >
      {permission.resources.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {permission.resources.slice(0, 6).map((resource) => (
            <li key={resource} className="truncate rounded-lg bg-ink/60 px-2.5 py-1.5 font-mono text-[11px] text-snow" title={resource}>
              {resource}
            </li>
          ))}
          {permission.resources.length > 6 ? <li className="px-1 text-[11px] text-mist">+{permission.resources.length - 6} more</li> : null}
        </ul>
      ) : null}
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 divide-y divide-line/70 rounded-xl border border-line/70" role="listbox" aria-label="Choices">
        {choices.map((choice) => (
          <OptionRow
            key={choice.decision}
            letter={choice.letter}
            label={busy === choice.decision ? `${choice.label}…` : choice.label}
            description={choice.description}
            tone={choice.tone}
            disabled={busy !== ""}
            onChoose={() => void decide(choice.decision)}
          />
        ))}
      </div>
    </InteractionCard>
  );
}

function QuestionCard({
  coworker,
  question,
  onAnswer,
  onSkip,
  keyboardShortcuts,
}: {
  coworker: CoworkerSummary;
  question: PendingQuestion;
  onAnswer: (question: PendingQuestion, answers: string[][]) => Promise<void>;
  onSkip: (question: PendingQuestion) => Promise<void>;
  keyboardShortcuts: boolean;
}) {
  const [selected, setSelected] = useState<string[][]>(() => question.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => question.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(index: number, label: string, multiple: boolean) {
    setSelected((current) =>
      current.map((answers, position) => {
        if (position !== index) return answers;
        if (!multiple) return [label];
        return answers.includes(label) ? answers.filter((value) => value !== label) : [...answers, label];
      }),
    );
  }

  const answers = question.questions.map((item, index) => {
    const typed = custom[index]?.trim() ?? "";
    const chosen = selected[index] ?? [];
    return typed && item.custom ? [...chosen, typed] : chosen;
  });
  const complete = answers.every((value) => value.length > 0);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await onAnswer(question, answers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    setError("");
    try {
      await onSkip(question);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  // A single question with one answer sends as soon as a choice is made; anything richer
  // (several questions, pick-many, or a typed answer) shows the choices and one Send.
  const instant = question.questions.length === 1 && !question.questions[0]?.multiple;

  async function choose(index: number, item: PendingQuestionItem, label: string) {
    if (busy) return;
    if (instant) {
      setSelected([[label]]);
      setBusy(true);
      setError("");
      try {
        await onAnswer(question, [[label]]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
      return;
    }
    toggle(index, label, item.multiple);
  }

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      // Letters answer the first question still waiting for a choice.
      const index = question.questions.findIndex((item, position) => item.options.length > 0 && (selected[position] ?? []).length === 0);
      const item = question.questions[index === -1 ? 0 : index];
      if (!item) return;
      const option = item.options[LETTERS.indexOf(event.key.toUpperCase())];
      if (!option) return;
      event.preventDefault();
      void choose(index === -1 ? 0 : index, item, option.label);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const first = question.questions[0];
  return (
    <InteractionCard
      label={`${coworker.name} has a question`}
      testId="question-card"
      title={question.questions.length === 1 && first ? first.header || first.question : `${coworker.name} has ${question.questions.length} questions`}
      detail={question.questions.length === 1 && first && first.header ? first.question : undefined}
      onClose={busy ? undefined : () => void skip()}
    >
      <div className="mt-3 space-y-4">
        {question.questions.map((item, index) => (
          <fieldset key={`${question.id}-${index}`}>
            {question.questions.length > 1 ? (
              <>
                <legend className="text-sm font-semibold text-snow">{item.header || `Question ${index + 1}`}</legend>
                <p className="mt-1 text-xs leading-relaxed text-mist">{item.question}</p>
              </>
            ) : null}
            {item.options.length > 0 ? (
              <div className={`divide-y divide-line/70 rounded-xl border border-line/70 ${question.questions.length > 1 ? "mt-2" : ""}`} role="listbox" aria-multiselectable={item.multiple} aria-label={item.header || "Choices"}>
                {item.options.map((option, optionIndex) => (
                  <OptionRow
                    key={option.label}
                    letter={LETTERS[optionIndex] ?? String(optionIndex + 1)}
                    label={option.label}
                    description={option.description}
                    active={(selected[index] ?? []).includes(option.label)}
                    disabled={busy}
                    onChoose={() => void choose(index, item, option.label)}
                  />
                ))}
              </div>
            ) : null}
            {item.custom ? (
              <input
                className={`${inputClass} mt-2 bg-ink/60`}
                aria-label={`Your own answer for ${item.header || `question ${index + 1}`}`}
                placeholder={item.options.length > 0 ? "Or type your own answer" : "Type your answer"}
                value={custom[index] ?? ""}
                onChange={(event) =>
                  setCustom((current) => current.map((value, position) => (position === index ? event.target.value : value)))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && complete && !busy) void submit();
                }}
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      {!instant || question.questions.some((item) => item.custom) ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-[11px] text-mist">{instant ? "Choose an option, or type your own and press Send." : keyboardShortcuts ? "Press a letter to choose." : "Choose your answers, then press Send."}</p>
          <Button variant="primary" className="text-xs" disabled={busy || !complete} onClick={() => void submit()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      ) : (
        <p className="mt-2 px-1 text-[11px] text-mist">{busy ? "Sending…" : keyboardShortcuts ? "Click or press a letter to answer." : "Choose an answer."}</p>
      )}
    </InteractionCard>
  );
}
