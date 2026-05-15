/** @jsxImportSource react */
import { useEffect, useReducer } from "react";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronRight, HelpCircle } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

export type QuestionModalProps = {
  open: boolean;
  questions: QuestionInfo[];
  busy: boolean;
  onReply: (answers: string[][]) => void;
};

type QuestionState = {
  currentIndex: number;
  answers: string[][];
  currentSelection: string[];
  customInput: string;
  focusedOptionIndex: number;
};

type QuestionAction =
  | { type: "reset"; questionCount: number }
  | { type: "setCustomInput"; value: string }
  | { type: "setFocusedOptionIndex"; value: number }
  | { type: "moveFocusedOption"; direction: 1 | -1; optionsCount: number }
  | { type: "toggleMultipleOption"; option: string }
  | { type: "selectOption"; option: string }
  | { type: "advance"; answers: string[][] }
  | { type: "setAnswers"; answers: string[][] };

const initialQuestionState: QuestionState = {
  currentIndex: 0,
  answers: [],
  currentSelection: [],
  customInput: "",
  focusedOptionIndex: 0,
};

function questionReducer(state: QuestionState, action: QuestionAction): QuestionState {
  switch (action.type) {
    case "reset":
      return {
        currentIndex: 0,
        answers: new Array(action.questionCount).fill([]),
        currentSelection: [],
        customInput: "",
        focusedOptionIndex: 0,
      };
    case "setCustomInput":
      return { ...state, customInput: action.value };
    case "setFocusedOptionIndex":
      return { ...state, focusedOptionIndex: action.value };
    case "moveFocusedOption":
      return {
        ...state,
        focusedOptionIndex:
          (state.focusedOptionIndex + action.direction + action.optionsCount) %
          action.optionsCount,
      };
    case "toggleMultipleOption": {
      const selected = state.currentSelection.includes(action.option)
        ? state.currentSelection.filter((option) => option !== action.option)
        : [...state.currentSelection, action.option];
      return { ...state, currentSelection: selected };
    }
    case "selectOption":
      return { ...state, currentSelection: [action.option] };
    case "advance":
      return {
        ...state,
        answers: action.answers,
        currentIndex: state.currentIndex + 1,
        currentSelection: [],
        customInput: "",
        focusedOptionIndex: 0,
      };
    case "setAnswers":
      return { ...state, answers: action.answers };
  }
}

export function QuestionModal(props: QuestionModalProps) {
  const [state, dispatch] = useReducer(questionReducer, initialQuestionState);

  useEffect(() => {
    if (!props.open) return;
    dispatch({ type: "reset", questionCount: props.questions.length });
  }, [props.open, props.questions.length]);

  const currentQuestion = props.questions[state.currentIndex];
  const isLastQuestion = state.currentIndex === props.questions.length - 1;
  const canProceed = (() => {
    if (!currentQuestion) return false;
    if (currentQuestion.custom && state.customInput.trim().length > 0) return true;
    return state.currentSelection.length > 0;
  })();

  const handleNext = () => {
    if (!canProceed || !currentQuestion) return;
    const nextAnswer = [...state.currentSelection];
    if (currentQuestion.custom && state.customInput.trim()) {
      nextAnswer.push(state.customInput.trim());
    }
    const newAnswers = [...state.answers];
    newAnswers[state.currentIndex] = nextAnswer;
    if (isLastQuestion) {
      dispatch({ type: "setAnswers", answers: newAnswers });
      props.onReply(newAnswers);
    } else {
      dispatch({ type: "advance", answers: newAnswers });
    }
  };

  const toggleOption = (option: string) => {
    if (!currentQuestion) return;
    if (currentQuestion.multiple) {
      dispatch({ type: "toggleMultipleOption", option });
      return;
    }
    dispatch({ type: "selectOption", option });
    if (!currentQuestion.custom) {
      setTimeout(() => {
        const newAnswers = [...state.answers];
        newAnswers[state.currentIndex] = [option];
        if (isLastQuestion) {
          dispatch({ type: "setAnswers", answers: newAnswers });
          props.onReply(newAnswers);
        } else {
          dispatch({ type: "advance", answers: newAnswers });
        }
      }, 150);
    }
  };

  useEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!currentQuestion) return;
      const optionsCount = currentQuestion.options.length;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        dispatch({ type: "moveFocusedOption", direction: 1, optionsCount });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        dispatch({ type: "moveFocusedOption", direction: -1, optionsCount });
      } else if (event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (
          currentQuestion.custom &&
          document.activeElement?.tagName === "INPUT"
        ) {
          handleNext();
          return;
        }
        const option = currentQuestion.options[state.focusedOptionIndex]?.description;
        if (option) toggleOption(option);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, currentQuestion, state.focusedOptionIndex]);

  if (!props.open || !currentQuestion) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="p-6 border-b border-gray-6/40 bg-gray-2/50">
          <div className="flex items-center gap-3 mb-2">
            <div className="size-8 rounded-full bg-blue-9/20 flex items-center justify-center text-blue-9">
              <HelpCircle size={18} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-12">
                {currentQuestion.header || t("common.question")}
              </h3>
              <div className="text-xs text-gray-11 font-medium">
                {t("question_modal.question_counter", undefined, {
                  current: state.currentIndex + 1,
                  total: props.questions.length,
                })}
              </div>
            </div>
          </div>
          <p className="text-sm text-gray-11 mt-2 leading-relaxed">
            {currentQuestion.question}
          </p>
        </div>

        <div className="p-6 overflow-y-auto min-h-0 flex-1">
          <div className="space-y-2">
            {currentQuestion.options.map((opt, idx) => {
              const isSelected = state.currentSelection.includes(opt.description);
              const isFocused = state.focusedOptionIndex === idx;
              return (
                <button
                  key={opt.description}
                  type="button"
                  className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all duration-200 flex items-center justify-between group
                        ${
                          isSelected
                            ? "bg-blue-9/10 border-blue-9/30 text-gray-12 shadow-sm"
                            : "bg-gray-1 border-gray-6 hover:border-gray-8 text-gray-11 hover:text-gray-12 hover:bg-gray-3"
                        }
                        ${isFocused ? "ring-2 ring-blue-9/20 border-blue-9/40 bg-gray-3" : ""}
                      `}
                  onClick={() => {
                    dispatch({ type: "setFocusedOptionIndex", value: idx });
                    toggleOption(opt.description);
                  }}
                >
                  <span className="font-medium">{opt.description}</span>
                  {isSelected ? (
                    <div className="size-5 rounded-full bg-blue-9 flex items-center justify-center shadow-sm">
                      <Check size={12} className="text-white" strokeWidth={3} />
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          {currentQuestion.custom ? (
            <div className="mt-4 pt-4 border-t border-dls-border">
              <label className="block text-xs font-semibold text-dls-secondary mb-2 uppercase tracking-wide">
                {t("question_modal.custom_answer_label")}
              </label>
              <input
                type="text"
                value={state.customInput}
                onChange={(event) =>
                  dispatch({
                    type: "setCustomInput",
                    value: event.currentTarget.value,
                  })
                }
                className="w-full px-4 py-3 rounded-xl bg-dls-surface border border-dls-border focus:border-dls-accent focus:ring-4 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:outline-none text-sm text-dls-text placeholder:text-dls-secondary transition-shadow"
                placeholder={t("question_modal.custom_answer_placeholder")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    if (event.nativeEvent.isComposing || event.keyCode === 229)
                      return;
                    event.stopPropagation();
                    handleNext();
                  }
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="p-6 border-t border-dls-border bg-dls-hover flex justify-between items-center">
          <div className="text-xs text-dls-secondary flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded border border-dls-border bg-dls-active font-mono">
              ↑↓
            </span>
            <span>{t("common.navigate")}</span>
            <span className="px-1.5 py-0.5 rounded border border-gray-6 bg-gray-3 font-mono ml-2">
              ↵
            </span>
            <span>{t("common.select")}</span>
          </div>

          <div className="flex gap-2">
            {currentQuestion.multiple || currentQuestion.custom ? (
              <Button
                onClick={handleNext}
                disabled={!canProceed || props.busy}
                className="!px-6"
              >
                {isLastQuestion ? t("common.submit") : t("common.next")}
                {!isLastQuestion ? (
                  <ChevronRight size={16} className="ml-1 -mr-1 opacity-60" />
                ) : null}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
