import { useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import {
  describePermission,
  type PendingInteractions,
  type PendingPermission,
  type PendingQuestion,
  type PermissionReply,
} from "@/lib/threads";
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
}: {
  coworker: CoworkerSummary;
  pending: PendingInteractions;
  onPermission: (permission: PendingPermission, decision: PermissionReply) => Promise<void>;
  onAnswer: (question: PendingQuestion, answers: string[][]) => Promise<void>;
  onSkip: (question: PendingQuestion) => Promise<void>;
}) {
  if (pending.permissions.length === 0 && pending.questions.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {pending.permissions.map((permission) => (
        <PermissionCard key={permission.id} coworker={coworker} permission={permission} onDecide={onPermission} />
      ))}
      {pending.questions.map((question) => (
        <QuestionCard key={question.id} coworker={coworker} question={question} onAnswer={onAnswer} onSkip={onSkip} />
      ))}
    </div>
  );
}

function PermissionCard({
  coworker,
  permission,
  onDecide,
}: {
  coworker: CoworkerSummary;
  permission: PendingPermission;
  onDecide: (permission: PendingPermission, decision: PermissionReply) => Promise<void>;
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

  return (
    <section role="group" aria-label={`${coworker.name} needs permission`} className="rounded-2xl border border-amber/30 bg-amber/6 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber">Needs you</p>
      <h3 className="mt-1 text-sm font-semibold text-snow">
        {coworker.name} wants to {describePermission({ action: permission.action, resources: [] })}
      </h3>
      {permission.resources.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {permission.resources.slice(0, 6).map((resource) => (
            <li key={resource} className="truncate rounded-lg bg-ink/70 px-2.5 py-1.5 font-mono text-[11px] text-snow" title={resource}>
              {resource}
            </li>
          ))}
          {permission.resources.length > 6 ? (
            <li className="px-1 text-[11px] text-mist">+{permission.resources.length - 6} more</li>
          ) : null}
        </ul>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-mist">Nothing happens until you choose. Denying ends this step; the coworker will explain and continue.</p>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant="primary" className="text-xs" disabled={busy !== ""} onClick={() => void decide("once")}>
          {busy === "once" ? "Allowing…" : "Allow once"}
        </Button>
        {permission.canAlways ? (
          <Button variant="default" className="text-xs" disabled={busy !== ""} onClick={() => void decide("always")}>
            {busy === "always" ? "Saving…" : "Always allow"}
          </Button>
        ) : null}
        <Button variant="ghost" className="text-xs text-rose" disabled={busy !== ""} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Denying…" : "Deny"}
        </Button>
      </div>
    </section>
  );
}

function QuestionCard({
  coworker,
  question,
  onAnswer,
  onSkip,
}: {
  coworker: CoworkerSummary;
  question: PendingQuestion;
  onAnswer: (question: PendingQuestion, answers: string[][]) => Promise<void>;
  onSkip: (question: PendingQuestion) => Promise<void>;
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

  return (
    <section role="group" aria-label={`${coworker.name} has a question`} className="rounded-2xl border border-amber/30 bg-amber/6 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber">Needs you</p>
      <div className="mt-1 space-y-4">
        {question.questions.map((item, index) => (
          <fieldset key={`${question.id}-${index}`}>
            <legend className="text-sm font-semibold text-snow">{item.header || `Question ${index + 1}`}</legend>
            <p className="mt-1 text-xs leading-relaxed text-mist">{item.question}</p>
            {item.options.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {item.options.map((option) => {
                  const active = (selected[index] ?? []).includes(option.label);
                  return (
                    <button
                      type="button"
                      key={option.label}
                      aria-pressed={active}
                      className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                        active ? "border-spark/50 bg-spark/10" : "border-line bg-ink/60 hover:bg-ink"
                      }`}
                      onClick={() => toggle(index, option.label, item.multiple)}
                    >
                      <span className={`mt-1 size-2 shrink-0 rounded-full ${active ? "bg-spark" : "bg-mist/50"}`} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-snow">{option.label}</span>
                        {option.description ? <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{option.description}</span> : null}
                      </span>
                    </button>
                  );
                })}
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
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant="primary" className="text-xs" disabled={busy || !complete} onClick={() => void submit()}>
          {busy ? "Sending…" : "Answer"}
        </Button>
        <Button variant="ghost" className="text-xs" disabled={busy} onClick={() => void skip()}>
          Skip
        </Button>
      </div>
    </section>
  );
}
