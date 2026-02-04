import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";

import { Check, ChevronRight, HelpCircle } from "lucide-solid";

import Button from "./button";

export type QuestionModalProps = {
    open: boolean;
    questions: QuestionInfo[];
    busy: boolean;
    onClose: () => void;
    onReply: (answers: string[][]) => void;
};

export default function QuestionModal(props: QuestionModalProps) {
    const [currentIndex, setCurrentIndex] = createSignal(0);
    const [answers, setAnswers] = createSignal<string[][]>([]);
    const [currentSelection, setCurrentSelection] = createSignal<string[]>([]);
    const [customInput, setCustomInput] = createSignal("");
    const [focusedOptionIndex, setFocusedOptionIndex] = createSignal(0);

    createEffect(() => {
        if (props.open) {
            setCurrentIndex(0);
            setAnswers(new Array(props.questions.length).fill([]));
            setCurrentSelection([]);
            setCustomInput("");
            setFocusedOptionIndex(0);
        }
    });

    const currentQuestion = createMemo(() => props.questions[currentIndex()]);
    const isLastQuestion = createMemo(() => currentIndex() === props.questions.length - 1);
    const canProceed = createMemo(() => {
        const q = currentQuestion();
        if (!q) return false;
        if (q.custom && customInput().trim().length > 0) return true;
        return currentSelection().length > 0;
    });

    const handleNext = () => {
        if (!canProceed()) return;

        const q = currentQuestion();
        if (!q) return;

        let answer: string[] = [...currentSelection()];
        if (q.custom && customInput().trim()) {
            answer.push(customInput().trim());
        }

        const newAnswers = [...answers()];
        newAnswers[currentIndex()] = answer;
        setAnswers(newAnswers);

        if (isLastQuestion()) {
            props.onReply(newAnswers);
        } else {
            setCurrentIndex((i) => i + 1);
            setCurrentSelection([]);
            setCustomInput("");
            setFocusedOptionIndex(0);
        }
    };

    const toggleOption = (option: string) => {
        const q = currentQuestion();
        if (!q) return;

        if (q.multiple) {
            setCurrentSelection((prev) =>
                prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]
            );
        } else {
            setCurrentSelection([option]);
            if (!q.custom) {
                setTimeout(() => {
                    const newAnswers = [...answers()];
                    newAnswers[currentIndex()] = [option];
                    setAnswers(newAnswers);

                    if (isLastQuestion()) {
                        props.onReply(newAnswers);
                    } else {
                        setCurrentIndex((i) => i + 1);
                        setCurrentSelection([]);
                        setCustomInput("");
                        setFocusedOptionIndex(0);
                    }
                }, 150);
            }
        }
    };

    createEffect(() => {
        if (!props.open) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const q = currentQuestion();
            if (!q) return;

            const optionsCount = q.options.length;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                setFocusedOptionIndex((prev) => (prev + 1) % optionsCount);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setFocusedOptionIndex((prev) => (prev - 1 + optionsCount) % optionsCount);
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (q.custom && document.activeElement?.tagName === "INPUT") {
                    handleNext();
                    return;
                }

                const option = q.options[focusedOptionIndex()]?.description;
                if (option) {
                    toggleOption(option);
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
    });

    return (
        <Show when={props.open && currentQuestion()}>
            <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
                <div class="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                    <div class="p-6 border-b border-gray-6/40 bg-gray-2/50">
                        <div class="flex items-center gap-3 mb-2">
                            <div class="w-8 h-8 rounded-full bg-blue-9/20 flex items-center justify-center text-blue-9">
                                <HelpCircle size={18} />
                            </div>
                            <div>
                                <h3 class="text-lg font-semibold text-gray-12">
                                    {currentQuestion()!.header || "Question"}
                                </h3>
                                <div class="text-xs text-gray-11 font-medium">
                                    Question {currentIndex() + 1} of {props.questions.length}
                                </div>
                            </div>
                        </div>
                        <p class="text-sm text-gray-11 mt-2 leading-relaxed">
                            {currentQuestion()!.question}
                        </p>
                    </div>

                    <div class="p-6 overflow-y-auto min-h-0 flex-1">
                        <div class="space-y-2">
                            <For each={currentQuestion()!.options}>
                                {(opt, idx) => {
                                    const isSelected = () => currentSelection().includes(opt.description);
                                    const isFocused = () => focusedOptionIndex() === idx();

                                    return (
                                        <button
                                            class={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all duration-200 flex items-center justify-between group
                        ${isSelected()
                                                    ? "bg-blue-9/10 border-blue-9/30 text-gray-12 shadow-sm"
                                                    : "bg-gray-1 border-gray-6 hover:border-gray-8 text-gray-11 hover:text-gray-12 hover:bg-gray-3"
                                                }
                        ${isFocused() ? "ring-2 ring-blue-9/20 border-blue-9/40 bg-gray-3" : ""}
                      `}
                                            onClick={() => {
                                                setFocusedOptionIndex(idx());
                                                toggleOption(opt.description);
                                            }}
                                        >
                                            <span class="font-medium">{opt.description}</span>
                                            <Show when={isSelected()}>
                                                <div class="w-5 h-5 rounded-full bg-blue-9 flex items-center justify-center shadow-sm">
                                                    <Check size={12} class="text-white" strokeWidth={3} />
                                                </div>
                                            </Show>
                                        </button>
                                    );
                                }}
                            </For>
                        </div>

                        <Show when={currentQuestion()!.custom}>
                            <div class="mt-4 pt-4 border-t border-gray-6/30">
                                <label class="block text-xs font-semibold text-gray-11 mb-2 uppercase tracking-wide">
                                    Or type a custom answer
                                </label>
                                <input
                                    type="text"
                                    value={customInput()}
                                    onInput={(e) => setCustomInput(e.currentTarget.value)}
                                    class="w-full px-4 py-3 rounded-xl bg-gray-1 border border-gray-6 focus:border-blue-9/50 focus:ring-4 focus:ring-blue-9/10 focus:outline-none text-sm text-gray-12 placeholder-gray-9 transition-shadow"
                                    placeholder="Type your answer here..."
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.stopPropagation();
                                            handleNext();
                                        }
                                    }}
                                />
                            </div>
                        </Show>
                    </div>

                    <div class="p-6 border-t border-gray-6/40 bg-gray-2/50 flex justify-between items-center">
                        <div class="text-xs text-gray-10 flex items-center gap-2">
                            <span class="px-1.5 py-0.5 rounded border border-gray-6 bg-gray-3 font-mono">↑↓</span>
                            <span>navigate</span>
                            <span class="px-1.5 py-0.5 rounded border border-gray-6 bg-gray-3 font-mono ml-2">↵</span>
                            <span>select</span>
                        </div>

                        <div class="flex gap-2">
                            <Show when={currentQuestion()?.multiple || currentQuestion()?.custom}>
                                <Button onClick={handleNext} disabled={!canProceed() || props.busy} class="!px-6">
                                    {isLastQuestion() ? "Submit" : "Next"}
                                    <Show when={!isLastQuestion()}>
                                        <ChevronRight size={16} class="ml-1 -mr-1 opacity-60" />
                                    </Show>
                                </Button>
                            </Show>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    );
}
