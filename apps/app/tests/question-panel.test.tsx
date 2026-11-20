/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import type { RemoteSessionAnswerInput, RemoteSessionPending } from "@openwork/types/automations";
import { clearQuestionDrafts, QuestionPanel } from "../src/react-app/domains/session/modals/question-modal";
import { RemoteThreadAnswerCard } from "../src/react-app/domains/session/remote-threads/remote-thread-answer-card";

const questions: QuestionInfo[] = [{
  header: "Settle sessions",
  question: "Organize, archive, or wrap up?",
  options: [{ label: "Archive sessions", description: "Clear them from the sidebar." }],
}];

const multiSelect: QuestionInfo[] = [{
  header: "Checks",
  question: "Which checks should run?",
  multiple: true,
  options: [
    { label: "Typecheck", description: "Types only" },
    { label: "Unit tests", description: "Fast tests" },
    { label: "End to end", description: "Slow tests" },
  ],
}];

const twoQuestions: QuestionInfo[] = [
  { header: "Branch", question: "Which branch?", options: [{ label: "dev", description: "Default" }, { label: "main", description: "Stable" }] },
  { header: "Checks", question: "Which checks should run?", multiple: true, options: [{ label: "Typecheck", description: "Types only" }, { label: "Unit tests", description: "Fast tests" }] },
];

type Mounted = { container: HTMLElement; rerender: (node: ReactNode) => Promise<void>; remount: (node: ReactNode) => Promise<void> };

async function render(node: ReactNode, check: (mounted: Mounted) => Promise<void> | void) {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  try {
    await act(async () => { root.render(node); });
    await check({
      container,
      rerender: async (next) => { await act(async () => { root.render(next); }); },
      // Leaving the chat and coming back unmounts the panel and mounts a new one.
      remount: async (next) => {
        await act(async () => { root.unmount(); });
        root = createRoot(container);
        await act(async () => { root.render(next); });
      },
    });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`No button with "${text}" in: ${container.textContent}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  // react-dom loads before the DOM is registered here, so it reads text
  // changes from focus and key events rather than `input`; send both.
  await act(async () => { input.focus(); });
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}

async function settle(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function customInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("No custom answer input");
  return input;
}

function selectedOptions(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .filter((item) => item.className.includes("bg-blue-9/10"))
    .map((item) => item.querySelector("span span")?.textContent ?? "");
}

const collapsed = (container: HTMLElement) => container.querySelector("[data-question-collapsed]")?.getAttribute("data-question-collapsed");

describe("question panel dismissal", () => {
  test("offers Dismiss when the question can be declined", () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("Dismiss");
    expect(html).toContain("Archive sessions");
  });
  test("hides Dismiss when nothing can decline the question", () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} />);
    expect(html).not.toContain("Dismiss");
  });
});

describe("a long question leaves room for the chat", () => {
  const long: QuestionInfo[] = [{
    header: "Plan",
    question: "Which plan should I follow? ".repeat(200),
    options: Array.from({ length: 30 }, (_, index) => ({ label: `Plan ${index + 1}`, description: "Details ".repeat(40) })),
  }];

  for (const collapsible of [false, true]) {
    test(`the question text and the options each scroll in a bounded area (minimize ${collapsible ? "on" : "off"})`, async () => {
      await render(<QuestionPanel questions={long} busy={false} collapsible={collapsible} requestId="long" onReply={() => {}} />, ({ container }) => {
        const text = container.querySelector("[data-question-text]");
        const body = container.querySelector("[data-question-body]");
        expect(text?.className).toContain("max-h-[min(9rem,22vh)]");
        expect(text?.className).toContain("overflow-y-auto");
        expect(body?.className).toContain("max-h-[min(18rem,40vh)]");
        expect(body?.className).toContain("overflow-auto");
      });
    });
  }
});

describe("minimizing a pending question (questionMinimize)", () => {
  beforeEach(() => clearQuestionDrafts());

  test("off: the panel has no Minimize control and renders as before", () => {
    const off = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} onDismiss={() => {}} />);
    const offWithId = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} requestId="que_off" shortcutActive onReply={() => {}} onDismiss={() => {}} />);
    expect(off).not.toContain("Minimize");
    expect(off).not.toContain("data-question-collapsed");
    expect(offWithId).toBe(off);
  });

  test("on: opens expanded with Minimize beside Dismiss", () => {
    const html = renderToStaticMarkup(<QuestionPanel collapsible requestId="que_1" questions={questions} busy={false} onReply={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('data-question-collapsed="false"');
    expect(html).toContain("Minimize");
    expect(html).toContain("Dismiss");
    expect(html).toContain("Archive sessions");
  });

  test("multi-select picks and a typed answer survive minimizing and reopening", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel collapsible requestId="que_multi" questions={multiSelect} busy={false} onReply={(answers) => replies.push(answers)} onDismiss={() => {}} />, async ({ container }) => {
      await click(button(container, "Typecheck"));
      await click(button(container, "End to end"));
      await type(customInput(container), "also lint");

      await click(button(container, "Minimize"));
      await settle(250);
      expect(collapsed(container)).toBe("true");
      expect(container.textContent).toContain("Checks");
      expect(container.textContent).toContain("Waiting for your answer");
      expect(container.textContent).not.toContain("Which checks should run?");
      expect(container.textContent).not.toContain("Dismiss");
      expect(container.querySelector("input")).toBeNull();
      expect(replies).toEqual([]);

      await click(button(container, "Show question"));
      expect(collapsed(container)).toBe("false");
      expect(selectedOptions(container)).toEqual(["Typecheck", "End to end"]);
      expect(customInput(container).value).toBe("also lint");

      await click(button(container, "Submit"));
      expect(replies).toEqual([[["Typecheck", "End to end", "also lint"]]]);
    });
  });

  test("a typed answer to a single-choice question survives minimizing and reopening", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel collapsible requestId="que_single" questions={questions} busy={false} onReply={(answers) => replies.push(answers)} />, async ({ container }) => {
      await type(customInput(container), "wrap up instead");
      await click(button(container, "Minimize"));
      await settle(250);
      expect(container.querySelector("input")).toBeNull();
      await click(button(container, "Show question"));
      expect(customInput(container).value).toBe("wrap up instead");
      await click(button(container, "Send"));
      expect(replies).toEqual([[["wrap up instead"]]]);
    });
  });

  test("the second of two questions stays current, with the first answer kept", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel collapsible requestId="que_two" questions={twoQuestions} busy={false} onReply={(answers) => replies.push(answers)} />, async ({ container }) => {
      await click(button(container, "main"));
      await settle(200);
      expect(container.textContent).toContain("Question 2 of 2");
      await click(button(container, "Unit tests"));

      await click(button(container, "Minimize"));
      await settle(250);
      expect(container.textContent).toContain("Waiting for your answer");
      await click(button(container, "Show question"));

      expect(container.textContent).toContain("Question 2 of 2");
      expect(selectedOptions(container)).toEqual(["Unit tests"]);
      await click(button(container, "Submit"));
      expect(replies).toEqual([[["main"], ["Unit tests"]]]);
    });
  });

  test("the chord minimizes and reopens, only for the active pane", async () => {
    const chord = () => act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "M", shiftKey: true, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    });
    await render(<QuestionPanel collapsible shortcutActive requestId="que_chord" questions={multiSelect} busy={false} onReply={() => {}} />, async ({ container, rerender }) => {
      await chord();
      expect(collapsed(container)).toBe("true");
      await chord();
      expect(collapsed(container)).toBe("false");
      await rerender(<QuestionPanel collapsible shortcutActive={false} requestId="que_chord" questions={multiSelect} busy={false} onReply={() => {}} />);
      await chord();
      expect(collapsed(container)).toBe("false");
    });
  });

  test("leaving the chat and coming back restores it; a new question opens expanded", async () => {
    const panel = (requestId: string, asked: QuestionInfo[]) => <QuestionPanel collapsible requestId={requestId} questions={asked} busy={false} onReply={() => {}} />;
    await render(panel("que_a", multiSelect), async ({ container, rerender, remount }) => {
      await click(button(container, "Unit tests"));
      await click(button(container, "Minimize"));
      await settle(250);

      await remount(panel("que_a", multiSelect));
      expect(collapsed(container)).toBe("true");
      await click(button(container, "Show question"));
      expect(selectedOptions(container)).toEqual(["Unit tests"]);

      await click(button(container, "Minimize"));
      await settle(250);
      await rerender(panel("que_b", twoQuestions));
      expect(collapsed(container)).toBe("false");
      expect(container.textContent).toContain("Which branch?");
      expect(selectedOptions(container)).toEqual([]);

      await rerender(panel("que_a", multiSelect));
      expect(collapsed(container)).toBe("true");
    });
  });
});

describe("minimizing a question from another computer (questionMinimize)", () => {
  const pending: RemoteSessionPending = {
    kind: "question", requestId: "que_remote", questions: [{
      header: "Checks", question: "Which checks should run?", multiple: true, custom: true,
      options: [{ label: "Typecheck", description: "" }, { label: "Unit tests", description: "" }],
    }],
  };

  test("off: no Minimize control", async () => {
    await render(<RemoteThreadAnswerCard pending={pending} computer="Studio Mac" onAnswer={async () => null} />, ({ container }) => {
      expect(container.textContent).not.toContain("Minimize");
      expect(container.querySelector("[data-question-collapsed]")).toBeNull();
    });
  });

  test("on: picks and typed text survive minimizing and reopening", async () => {
    const sent: RemoteSessionAnswerInput[] = [];
    await render(<RemoteThreadAnswerCard collapsible pending={pending} computer="Studio Mac" onAnswer={async (answer) => { sent.push(answer); return null; }} />, async ({ container }) => {
      await click(button(container, "Unit tests"));
      await type(customInput(container), "also lint");
      await click(button(container, "Minimize"));
      await settle(250);
      expect(collapsed(container)).toBe("true");
      expect(container.textContent).toContain("Waiting for your answer");
      expect(container.querySelector("[data-remote-answer-option]")).toBeNull();

      await click(button(container, "Show question"));
      expect(container.querySelector('[data-remote-answer-option="Unit tests"]')?.getAttribute("aria-checked")).toBe("true");
      expect(customInput(container).value).toBe("also lint");
      await click(button(container, "Send"));
      expect(sent).toEqual([{ kind: "question", requestId: "que_remote", answers: [["Unit tests", "also lint"]] }]);
    });
  });
});

describe("a question in the conversation (questionInThread)", () => {
  beforeEach(() => clearQuestionDrafts());

  test("single choice waits for Submit instead of answering on click", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel variant="thread" questions={twoQuestions.slice(0, 1)} busy={false} onReply={(a) => replies.push(a)} />, async ({ container }) => {
      expect(container.querySelector("[data-question-variant='thread']")).not.toBeNull();
      await click(button(container, "main"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(replies).toEqual([]);
      await click(button(container, "Submit"));
      expect(replies).toEqual([[["main"]]]);
    });
  });

  test("Other takes a typed answer in place of a picked option", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel variant="thread" questions={twoQuestions.slice(0, 1)} busy={false} onReply={(a) => replies.push(a)} />, async ({ container }) => {
      await click(button(container, "dev"));
      await click(button(container, "Other"));
      const input = container.querySelector("input[type='text']") as HTMLInputElement;
      await type(input, "release");
      await click(button(container, "Submit"));
      expect(replies).toEqual([[["release"]]]);
    });
  });

  test("Skip at the bottom dismisses the question", async () => {
    let dismissed = 0;
    await render(<QuestionPanel variant="thread" questions={questions} busy={false} onReply={() => {}} onDismiss={() => { dismissed += 1; }} />, async ({ container }) => {
      expect(container.textContent).toContain("Sending a message skips this question");
      await click(button(container, "Skip"));
      expect(dismissed).toBe(1);
    });
  });
});

describe("several questions in a row", () => {
  beforeEach(() => clearQuestionDrafts());

  async function doubleClick(element: HTMLElement) {
    await act(async () => { element.click(); element.click(); });
  }

  test("a double click on a single choice answers it once and opens the next question", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel questions={twoQuestions} busy={false} onReply={(answers) => replies.push(answers)} />, async ({ container }) => {
      await doubleClick(button(container, "main"));
      await settle(200);
      expect(container.textContent).toContain("Question 2 of 2");
      expect(container.textContent).toContain("Which checks should run?");
      await click(button(container, "Unit tests"));
      await click(button(container, "Submit"));
      expect(replies).toEqual([[["main"], ["Unit tests"]]]);
    });
  });

  test("a double click on the last question sends the answers once", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel questions={questions} busy={false} onReply={(answers) => replies.push(answers)} />, async ({ container }) => {
      await doubleClick(button(container, "Archive sessions"));
      await settle(200);
      expect(replies).toEqual([[["Archive sessions"]]]);
    });
  });

  test("a double click on Next in the conversation does not skip a question", async () => {
    const three: QuestionInfo[] = [...twoQuestions, { header: "Ship", question: "Open the PR?", options: [{ label: "Yes", description: "" }] }];
    await render(<QuestionPanel variant="thread" questions={three} busy={false} onReply={() => {}} />, async ({ container }) => {
      await click(button(container, "dev"));
      await doubleClick(button(container, "Next"));
      expect(container.textContent).toContain("Question 2 of 3");
    });
  });

  test("Back reopens the previous question with its answer, and the later answer is kept", async () => {
    const replies: string[][][] = [];
    await render(<QuestionPanel questions={twoQuestions} busy={false} onReply={(answers) => replies.push(answers)} />, async ({ container }) => {
      expect(container.querySelector("[data-question-back]")).toBeNull();
      await click(button(container, "main"));
      await settle(200);
      await click(button(container, "Typecheck"));
      await click(button(container, "Back"));
      expect(container.textContent).toContain("Question 1 of 2");
      expect(selectedOptions(container)).toEqual(["main"]);

      await click(button(container, "dev"));
      await settle(200);
      expect(selectedOptions(container)).toEqual(["Typecheck"]);
      await click(button(container, "Submit"));
      expect(replies).toEqual([[["dev"], ["Typecheck"]]]);
    });
  });

  test("Back in the conversation restores a typed answer", async () => {
    await render(<QuestionPanel variant="thread" questions={twoQuestions} busy={false} onReply={() => {}} />, async ({ container }) => {
      await click(button(container, "Other"));
      await type(container.querySelector("input[type='text']") as HTMLInputElement, "release");
      await click(button(container, "Next"));
      await click(button(container, "Back"));
      expect((container.querySelector("input[type='text']") as HTMLInputElement).value).toBe("release");
    });
  });

  test("a reply that fails can be sent again; one in flight cannot", async () => {
    let calls = 0;
    let fail = true;
    const onReply = () => {
      calls += 1;
      return fail ? Promise.reject(new Error("offline")) : new Promise(() => {});
    };
    await render(<QuestionPanel variant="thread" questions={questions} busy={false} onReply={onReply} />, async ({ container }) => {
      await click(button(container, "Archive sessions"));
      await click(button(container, "Submit"));
      await settle(0);
      fail = false;
      await doubleClick(button(container, "Submit"));
      expect(calls).toBe(2);
    });
  });

  test("a refetch of the same request keeps the question in progress", async () => {
    const panel = (asked: QuestionInfo[]) => <QuestionPanel requestId="que_refetch" questions={asked} busy={false} onReply={() => {}} />;
    await render(panel(twoQuestions), async ({ container, rerender }) => {
      await click(button(container, "main"));
      await settle(200);
      await rerender(panel(twoQuestions.map((question) => ({ ...question }))));
      expect(container.textContent).toContain("Question 2 of 2");
    });
  });
});
