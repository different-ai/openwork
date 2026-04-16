import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, HelpCircle, X } from "lucide-react";

import type { PendingQuestion } from "../../app/types";

type QuestionSheetProps = {
  question: PendingQuestion | null;
  busy: boolean;
  onReply: (answers: string[][]) => Promise<void> | void;
  onReject: () => Promise<void> | void;
};

type QuestionOption = {
  description: string;
};

type QuestionInfo = {
  header?: string;
  question?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export function QuestionSheet({ question, busy, onReply, onReject }: QuestionSheetProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<string[][]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState("");

  useEffect(() => {
    if (!question) return;
    const list = Array.isArray((question as { questions?: unknown }).questions)
      ? ((question as { questions?: unknown[] }).questions as QuestionInfo[])
      : [];
    setCurrentIndex(0);
    setAnswers(new Array(list.length).fill([]));
    setSelection([]);
    setCustomInput("");
  }, [question?.id]);

  const questions = useMemo(() => {
    if (!question) return [] as QuestionInfo[];
    return Array.isArray((question as { questions?: unknown }).questions)
      ? (((question as { questions?: unknown[] }).questions as QuestionInfo[]) ?? [])
      : [];
  }, [question]);

  const current = questions[currentIndex] ?? null;
  const canProceed = Boolean(
    current && ((current.custom && customInput.trim().length > 0) || selection.length > 0),
  );
  const isLast = currentIndex === questions.length - 1;

  if (!question || !current) return null;

  const toggleOption = (option: string) => {
    if (current.multiple) {
      setSelection((existing) =>
        existing.includes(option) ? existing.filter((item) => item !== option) : [...existing, option],
      );
      return;
    }
    setSelection([option]);
  };

  const submitCurrent = async () => {
    if (!canProceed || busy) return;
    const merged = [...selection];
    if (current.custom && customInput.trim()) {
      merged.push(customInput.trim());
    }

    const nextAnswers = [...answers];
    nextAnswers[currentIndex] = merged;
    setAnswers(nextAnswers);

    if (isLast) {
      await onReply(nextAnswers);
      return;
    }

    setCurrentIndex((value) => value + 1);
    setSelection([]);
    setCustomInput("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/12 px-4 py-6 backdrop-blur-[2px]">
      <div className="w-full max-w-2xl rounded-[32px] border border-slate-200 bg-white p-5 shadow-[0_25px_70px_rgba(15,23,42,0.12)] lg:p-6">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
              <HelpCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                Interactive question
              </div>
              <h3 className="mt-2 text-xl font-semibold text-slate-900">
                {current.header?.trim() || "OpenWork needs an answer"}
              </h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">{current.question?.trim() || "Choose an option to continue."}</p>
            </div>
          </div>
          <button className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-slate-300 hover:text-slate-900" onClick={() => void onReject()} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 py-5">
          {questions.length > 1 ? (
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              Question {currentIndex + 1} of {questions.length}
            </div>
          ) : null}

          <div className="space-y-2">
            {(current.options ?? []).map((option) => {
              const selected = selection.includes(option.description);
              return (
                <button
                  className={[
                    "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition",
                    selected
                      ? "border-slate-900 bg-slate-50 text-slate-950"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
                  ].join(" ")}
                  key={option.description}
                  onClick={() => toggleOption(option.description)}
                  type="button"
                >
                  <span className="font-medium">{option.description}</span>
                  {selected ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-white">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {current.custom ? (
            <div className="space-y-2 border-t border-slate-200 pt-4">
              <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="openwork-question-custom-answer">
                Custom answer
              </label>
              <input
                className="ow-input"
                id="openwork-question-custom-answer"
                name="openworkQuestionCustomAnswer"
                onChange={(event) => setCustomInput(event.target.value)}
                placeholder="Write a short answer"
                value={customInput}
              />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
            Choose an answer to continue the session
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ow-button-secondary" disabled={busy} onClick={() => void onReject()} type="button">
              Reject
            </button>
            <button className="ow-button" disabled={!canProceed || busy} onClick={() => void submitCurrent()} type="button">
              {isLast ? "Submit answers" : "Next question"}
              {!isLast ? <ChevronRight className="h-4 w-4" /> : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
