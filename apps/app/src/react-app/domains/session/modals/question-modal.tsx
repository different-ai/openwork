/** @jsxImportSource react */
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, ChevronRight, ChevronUp, HelpCircle, X } from "lucide-react";

import { markFeatureUsed } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/i18n";
import {
  isQuestionCollapseChord,
  QUESTION_COLLAPSE_PANEL_CLASS,
  questionCollapseChordLabel,
} from "@/react-app/domains/session/modals/question-collapse";

export type QuestionPanelProps = {
  questions: QuestionInfo[];
  busy: boolean;
  onReply: (answers: string[][]) => void;
  /** Declines the whole request without answering. Hidden when omitted. */
  onDismiss?: () => void;
  /**
   * Feature `questionMinimize`: the person can collapse the pending question
   * to one line above the composer and reopen it with everything they picked
   * or typed. Off, the panel is unchanged.
   */
  collapsible?: boolean;
  /** Identifies the pending request, so its draft survives leaving the chat and coming back. */
  requestId?: string;
  /** Whether this panel answers the collapse chord; one pane at a time. */
  shortcutActive?: boolean;
};

type QuestionState = {
  currentIndex: number;
  answers: string[][];
  currentSelection: string[];
  customInput: string;
  customAnswerActive: boolean;
  focusedOptionIndex: number;
};

type QuestionAction =
  | { type: "reset"; questionCount: number }
  | { type: "restore"; state: QuestionState }
  | { type: "setCustomInput"; value: string }
  | { type: "setCustomAnswerActive"; value: boolean }
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
  customAnswerActive: false,
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
        customAnswerActive: false,
        focusedOptionIndex: 0,
      };
    case "restore":
      return action.state;
    case "setCustomInput":
      return { ...state, customInput: action.value };
    case "setCustomAnswerActive":
      return { ...state, customAnswerActive: action.value };
    case "setFocusedOptionIndex":
      return { ...state, focusedOptionIndex: action.value };
    case "moveFocusedOption":
      if (action.optionsCount <= 0) return state;
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
        customAnswerActive: false,
        focusedOptionIndex: 0,
      };
    case "setAnswers":
      return { ...state, answers: action.answers };
  }
}

type QuestionDraft = { state: QuestionState; collapsed: boolean };

/**
 * What the person picked or typed for a question still pending, by request,
 * kept while the app runs so leaving the chat and coming back restores it.
 * Only written while the panel is collapsible.
 */
const questionDrafts = new Map<string, QuestionDraft>();
const QUESTION_DRAFT_LIMIT = 50;

function saveQuestionDraft(requestId: string, draft: QuestionDraft) {
  questionDrafts.delete(requestId);
  questionDrafts.set(requestId, draft);
  if (questionDrafts.size <= QUESTION_DRAFT_LIMIT) return;
  const oldest = questionDrafts.keys().next();
  if (!oldest.done) questionDrafts.delete(oldest.value);
}

/** Test seam: forget every kept draft. */
export function clearQuestionDrafts() {
  questionDrafts.clear();
}

export function QuestionPanel(props: QuestionPanelProps) {
  const draftKey = props.collapsible ? props.requestId : undefined;
  const [state, dispatch] = useReducer(
    questionReducer,
    draftKey,
    (key) => (key ? questionDrafts.get(key)?.state : undefined) ?? initialQuestionState,
  );
  const [collapsed, setCollapsed] = useState(() => (draftKey ? questionDrafts.get(draftKey)?.collapsed === true : false));
  const loadedDraftKey = useRef(draftKey && questionDrafts.has(draftKey) ? draftKey : undefined);
  const loadingDraft = useRef(false);
  // An answered or dismissed request must not be saved again by a late state change.
  const settledDraftKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!draftKey) {
      dispatch({ type: "reset", questionCount: props.questions.length });
      return;
    }
    // A request already on screen keeps its answers; a new one opens expanded.
    if (loadedDraftKey.current === draftKey) return;
    loadedDraftKey.current = draftKey;
    // The state still on screen belongs to the previous request; save after it is replaced.
    loadingDraft.current = true;
    const draft = questionDrafts.get(draftKey);
    if (draft) dispatch({ type: "restore", state: draft.state });
    else dispatch({ type: "reset", questionCount: props.questions.length });
    setCollapsed(draft?.collapsed === true);
  }, [draftKey, props.questions]);

  useEffect(() => {
    if (!draftKey || loadedDraftKey.current !== draftKey || settledDraftKey.current === draftKey) return;
    if (loadingDraft.current) {
      loadingDraft.current = false;
      return;
    }
    saveQuestionDraft(draftKey, { state, collapsed });
  }, [draftKey, state, collapsed]);

  const changeCollapsed = (next: boolean) => {
    if (next) markFeatureUsed("questionMinimize");
    setCollapsed(next);
  };
  const handleCollapseChord = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || !isQuestionCollapseChord(event)) return;
    event.preventDefault();
    changeCollapsed(!collapsed);
  });
  const chordListening = Boolean(props.collapsible && props.shortcutActive);
  useEffect(() => {
    if (!chordListening) return;
    const handler = (event: KeyboardEvent) => handleCollapseChord(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chordListening]);

  const reply = (answers: string[][]) => {
    settledDraftKey.current = draftKey;
    if (draftKey) questionDrafts.delete(draftKey);
    props.onReply(answers);
  };
  const dismiss = () => {
    settledDraftKey.current = draftKey;
    if (draftKey) questionDrafts.delete(draftKey);
    props.onDismiss?.();
  };

  const currentQuestion = props.questions[state.currentIndex];
  const options = currentQuestion?.options ?? [];
  const isLastQuestion = state.currentIndex === props.questions.length - 1;
  const customAnswerEnabled = currentQuestion?.custom !== false;
  const customAnswerVisible =
    customAnswerEnabled &&
    (state.customAnswerActive || state.customInput.trim().length > 0);
  const canProceed = (() => {
    if (!currentQuestion) return false;
    if (customAnswerEnabled && state.customInput.trim().length > 0) return true;
    return state.currentSelection.length > 0;
  })();

  const handleNext = () => {
    if (!canProceed || !currentQuestion) return;
    const nextAnswer = [...state.currentSelection];
    if (customAnswerEnabled && state.customInput.trim()) {
      nextAnswer.push(state.customInput.trim());
    }
    const newAnswers = [...state.answers];
    newAnswers[state.currentIndex] = nextAnswer;
    if (isLastQuestion) {
      dispatch({ type: "setAnswers", answers: newAnswers });
      reply(newAnswers);
    } else {
      dispatch({ type: "advance", answers: newAnswers });
    }
  };

  const toggleOption = (option: string) => {
    if (!currentQuestion || props.busy) return;
    if (currentQuestion.multiple) {
      dispatch({ type: "toggleMultipleOption", option });
      return;
    }
    dispatch({ type: "selectOption", option });
    setTimeout(() => {
      const newAnswers = [...state.answers];
      newAnswers[state.currentIndex] = [option];
      if (isLastQuestion) {
        dispatch({ type: "setAnswers", answers: newAnswers });
        reply(newAnswers);
      } else {
        dispatch({ type: "advance", answers: newAnswers });
      }
    }, 150);
  };

  if (!currentQuestion) return null;

  const body = (
      <div className="max-h-72 space-y-3 overflow-auto px-4 py-3">
        {options.length > 0 ? (
          <div className="space-y-2">
            {options.map((opt, idx) => {
              const isSelected = state.currentSelection.includes(opt.label);
              const isFocused = state.focusedOptionIndex === idx;
              return (
                <button
                  key={`${opt.label}:${idx}`}
                  type="button"
                  disabled={props.busy}
                  className={`flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60
                        ${
                          isSelected
                            ? "bg-blue-9/10 border-blue-9/30 text-gray-12 shadow-sm"
                            : "bg-gray-1 border-gray-6 hover:border-gray-8 text-gray-11 hover:text-gray-12 hover:bg-gray-3"
                        }
                        ${isFocused ? "ring-2 ring-blue-9/20 border-blue-9/40 bg-gray-3" : ""}
                      `}
                  onClick={() => {
                    dispatch({ type: "setFocusedOptionIndex", value: idx });
                    toggleOption(opt.label);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-gray-12">{opt.label}</span>
                    {opt.description && opt.description !== opt.label ? (
                      <span className="mt-1 block text-xs leading-5 text-gray-11">{opt.description}</span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <div className="size-5 rounded-full bg-blue-9 flex items-center justify-center shadow-sm">
                      <Check size={12} className="text-white" strokeWidth={3} />
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {customAnswerEnabled ? (
          <div className="border-t border-dls-border pt-3">
            <label className="block text-xs font-semibold text-dls-secondary mb-2 uppercase tracking-wide">
              {t("question_modal.custom_answer_label")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={state.customInput}
                onFocus={() => dispatch({ type: "setCustomAnswerActive", value: true })}
                onClick={() => dispatch({ type: "setCustomAnswerActive", value: true })}
                onChange={(event) =>
                  dispatch({
                    type: "setCustomInput",
                    value: event.currentTarget.value,
                  })
                }
                className="w-full px-4 py-3 rounded-xl bg-dls-surface border border-dls-border focus:border-dls-accent focus:ring-4 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:outline-none text-sm text-dls-text placeholder:text-dls-secondary transition-shadow"
                placeholder={t("question_modal.custom_answer_placeholder")}
                disabled={props.busy}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    if (event.nativeEvent.isComposing || event.keyCode === 229)
                      return;
                    event.stopPropagation();
                    handleNext();
                  }
                }}
              />
              {customAnswerVisible ? (
                <Button
                  onClick={handleNext}
                  disabled={!state.customInput.trim() || props.busy}
                >
                  {t("question_modal.custom_answer_send")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-dls-secondary flex items-center gap-2">
            {props.busy ? "Submitting..." : null}
          </div>

          <div className="flex gap-2">
            {currentQuestion.multiple ? (
              <Button
                onClick={handleNext}
                disabled={!canProceed || props.busy}
              >
                {isLastQuestion ? t("common.submit") : t("common.next")}
                {!isLastQuestion ? (
                  <ChevronRight data-icon="inline-end" />
                ) : null}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
  );

  if (props.collapsible) {
    const heading = currentQuestion.header || t("common.question");
    return (
      <Collapsible
        open={!collapsed}
        onOpenChange={(open) => changeCollapsed(!open)}
        className="overflow-hidden border-b border-dls-border bg-transparent"
        data-question-collapsed={collapsed ? "true" : "false"}
      >
        <div className={`px-4 ${collapsed ? "py-2" : "border-b border-dls-border py-3"}`}>
          <div className={`flex gap-2.5 ${collapsed ? "items-center" : "items-start"}`}>
            <div className={`flex size-5 shrink-0 items-center justify-center rounded-full border border-blue-7/30 bg-blue-3/20 text-blue-11 ${collapsed ? "" : "mt-0.5"}`}>
              <HelpCircle size={12} />
            </div>
            {collapsed ? (
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <div className="min-w-0 truncate text-sm font-medium leading-5 text-gray-12">{heading}</div>
                <div className="shrink-0 text-xs leading-4 text-gray-10" role="status">
                  {t("question_modal.collapsed_status")}
                </div>
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="text-sm font-medium leading-5 text-gray-12">{heading}</div>
                  <div className="text-[11px] font-medium leading-4 text-gray-9">
                    {t("question_modal.question_counter", undefined, {
                      current: state.currentIndex + 1,
                      total: props.questions.length,
                    })}
                  </div>
                </div>
                <div className="mt-1 text-sm leading-6 text-gray-11">{currentQuestion.question}</div>
              </div>
            )}
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className={`shrink-0 text-gray-10 ${collapsed ? "-mr-2" : "-mt-1"}`}
                />
              }
              data-question-collapse-toggle=""
            >
              {collapsed ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
              {collapsed ? t("question_modal.expand") : t("question_modal.collapse")}
              <span className="text-[11px] text-gray-9" aria-hidden="true">{questionCollapseChordLabel()}</span>
            </CollapsibleTrigger>
            {props.onDismiss && !collapsed ? (
              <Button
                variant="ghost"
                size="sm"
                className="-mr-2 -mt-1 shrink-0 text-gray-10"
                disabled={props.busy}
                title={t("question_modal.dismiss_hint")}
                onClick={dismiss}
              >
                <X data-icon="inline-start" />
                {t("question_modal.dismiss")}
              </Button>
            ) : null}
          </div>
        </div>
        <CollapsibleContent className={QUESTION_COLLAPSE_PANEL_CLASS}>{body}</CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
      <div className="border-b border-dls-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-blue-7/30 bg-blue-3/20 text-blue-11">
            <HelpCircle size={12} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-sm font-medium leading-5 text-gray-12">
                {currentQuestion.header || t("common.question")}
              </div>
              <div className="text-[11px] font-medium leading-4 text-gray-9">
                {t("question_modal.question_counter", undefined, {
                  current: state.currentIndex + 1,
                  total: props.questions.length,
                })}
              </div>
            </div>
            <div className="mt-1 text-sm leading-6 text-gray-11">
              {currentQuestion.question}
            </div>
          </div>
          {props.onDismiss ? (
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 -mt-1 shrink-0 text-gray-10"
              disabled={props.busy}
              title={t("question_modal.dismiss_hint")}
              onClick={props.onDismiss}
            >
              <X data-icon="inline-start" />
              {t("question_modal.dismiss")}
            </Button>
          ) : null}
        </div>
      </div>

      {body}
    </div>
  );
}
