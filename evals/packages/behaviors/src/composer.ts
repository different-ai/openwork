import type { Surface } from "@openwork/cdp";
import { control, evalIn, waitFor } from "./desktop.ts";

export interface ComposerState {
  draftText: string;
  route: string;
  runTaskVisible: boolean;
  runTaskEnabled: boolean;
  userMessageCount: number;
  assistantMessageCount: number;
  selectedModelLabel: string;
  modelUnavailable: boolean;
}

export interface AssistantReplyFacts {
  text: string;
  assistantMessageCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function readComposerState(app: Surface): Promise<ComposerState> {
  const value = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('[contenteditable="true"]');
    const run = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Run task");
    const model = document.querySelector('button[aria-label="Change model"]');
    return {
      draftText: editor?.innerText ?? "",
      route: location.hash,
      runTaskVisible: Boolean(run),
      runTaskEnabled: Boolean(run && !run.disabled),
      userMessageCount: document.querySelectorAll('[data-message-role="user"]').length,
      assistantMessageCount: document.querySelectorAll('[data-message-role="assistant"]').length,
      selectedModelLabel: model?.textContent?.trim() ?? "",
      modelUnavailable: document.body.innerText.includes("Model no longer available")
        || document.body.innerText.includes("The model you were using is no longer available"),
    };
  })()`);
  if (!isRecord(value)) throw new Error("Composer state was not an object.");
  return {
    draftText: stringField(value.draftText),
    route: stringField(value.route),
    runTaskVisible: value.runTaskVisible === true,
    runTaskEnabled: value.runTaskEnabled === true,
    userMessageCount: numberField(value.userMessageCount),
    assistantMessageCount: numberField(value.assistantMessageCount),
    selectedModelLabel: stringField(value.selectedModelLabel),
    modelUnavailable: value.modelUnavailable === true,
  };
}

export async function writeComposerText(app: Surface, text: string): Promise<void> {
  // The product ships a control action for exactly this ("Type into the composer",
  // registered by the session surface, so it only appears once a composer is
  // mounted). Prefer it: it types visibly the way a user does. The direct
  // contenteditable paste below stays as a fallback for surfaces that do not
  // register the action.
  const hasControl = await evalIn(app, `Boolean(window.__openworkControl?.listActions?.()
    .find((entry) => entry.id === "composer.set_text" && entry.disabled === false))`).catch(() => false);
  if (hasControl === true) {
    await control(app, "composer.set_text", { text }, { timeoutMs: 120_000 });
    await waitFor(app, `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
        ?? document.querySelector('[contenteditable="true"]');
      return Boolean(editor && (editor.innerText ?? "").includes(${JSON.stringify(text)}));
    })()`, { timeoutMs: 30_000, label: "composer draft text via control" });
    return;
  }

  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
    ?? document.querySelector('[contenteditable="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer contenteditable",
  });
  const pasted = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(text)});
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    return true;
  })()`);
  if (pasted !== true) throw new Error("Could not paste text into the composer contenteditable.");
  await waitFor(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('[contenteditable="true"]');
    return Boolean(editor && (editor.innerText ?? "").includes(${JSON.stringify(text)}));
  })()`, { timeoutMs: 30_000, label: "composer draft text" });
}

export async function sendComposerMessage(app: Surface, text: string): Promise<ComposerState> {
  const before = await readComposerState(app);
  await writeComposerText(app, text);
  await waitFor(app, `Boolean([...document.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === "Run task" && !button.disabled))`, {
    timeoutMs: 30_000,
    label: "enabled Run task button",
  });
  const clicked = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Run task" && !entry.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked !== true) throw new Error("Could not click the enabled Run task button.");
  await waitFor(app, `document.querySelectorAll('[data-message-role="user"]').length > ${before.userMessageCount}`, {
    timeoutMs: 60_000,
    label: "sent user message",
  });
  return readComposerState(app);
}

export async function waitForAssistantReply(
  app: Surface,
  { timeoutMs }: { timeoutMs: number },
): Promise<AssistantReplyFacts> {
  await waitFor(app, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    return messages.some((message) => (message.innerText ?? "").trim().length > 0);
  })()`, { timeoutMs, label: "assistant reply" });
  const value = await evalIn(app, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const latest = messages[messages.length - 1];
    return { text: latest?.innerText?.trim() ?? "", assistantMessageCount: messages.length };
  })()`);
  if (!isRecord(value)) throw new Error("Assistant reply facts were not an object.");
  return {
    text: stringField(value.text),
    assistantMessageCount: numberField(value.assistantMessageCount),
  };
}
