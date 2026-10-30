import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  englishPrompt,
  englishReplyText,
  mixedPrompt,
  mixedReplyText,
  persianPrompt,
  persianReplyText,
  rtlTextDirection,
} from "../worlds/rtl-text-direction.ts";

const test = spec.world(rtlTextDirection, {
  timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

type Rect = { left: number; width: number };
const centerX = (rect: Rect) => rect.left + rect.width / 2;

test("a message follows its dominant script while English stays left-to-right", async ({ user, probe, step, evidence }) => {
  await step("before: the app opens on an editable composer", async () => {
    await user.see("composer", { editable: true });
    await user.screenshot();
  });

  await step("after: a Persian prompt and its answer align to the right", async () => {
    await user.type("composer", persianPrompt);
    const editor = (await probe.dom("[data-lexical-editor='true'][contenteditable='true']")).elements[0];
    const typed = (await probe.dom("[data-lexical-editor='true'] span")).elements.find((element) => element.text.length > 0);
    expect(editor).toBeDefined();
    expect(typed).toBeDefined();
    if (editor && typed) expect(centerX(typed.rect)).toBeGreaterThan(centerX(editor.rect));

    await user.press("Enter");
    await user.see({ text: persianReplyText }, { timeoutMs: 120_000 });
    const block = await probe.eventually(async () => (await probe.dom(".markdown-content")).elements.find((element) => element.text.includes("پاسخ فارسی")), {
      within: 30_000, label: "the Persian answer renders as markdown",
    });
    const bold = (await probe.dom(".markdown-content strong")).elements.at(-1);
    expect(block).toBeDefined();
    expect(bold).toBeDefined();
    if (block && bold) expect(centerX(bold.rect)).toBeGreaterThan(centerX(block.rect));
    evidence.recordAssertionEvidence(
      "Persian text aligns right in the composer and the answer",
      JSON.stringify({ typed: typed?.rect, editor: editor?.rect, bold: bold?.rect, block: block?.rect }),
      Boolean(editor && typed && block && bold),
    );
    await user.screenshot();
  });

  await step("after: a Persian sentence that opens with an English word is still right-to-left", async () => {
    await user.type("composer", mixedPrompt, { replace: true });
    const editor = (await probe.dom("[data-lexical-editor='true'][contenteditable='true']")).elements[0];
    const typed = (await probe.dom("[data-lexical-editor='true'] span")).elements.find((element) => element.text.length > 0);
    expect(editor).toBeDefined();
    expect(typed).toBeDefined();
    // The draft starts with "OpenWork" but is mostly Persian, so it reads RTL.
    if (editor && typed) expect(centerX(typed.rect)).toBeGreaterThan(centerX(editor.rect));

    await user.press("Enter");
    await user.see({ text: mixedReplyText }, { timeoutMs: 120_000 });
    const block = await probe.eventually(async () => (await probe.dom(".markdown-content")).elements.find((element) => element.text.includes("بیشتر متن این پاسخ")), {
      within: 30_000, label: "the mixed answer renders as markdown",
    });
    const bold = (await probe.dom(".markdown-content strong")).elements.at(-1);
    expect(block).toBeDefined();
    expect(bold).toBeDefined();
    // The answer opens with the English word 'OpenWork'; it starts at the
    // paragraph's RTL start edge, so it sits in the right half of the block.
    if (block && bold) expect(centerX(bold.rect)).toBeGreaterThan(centerX(block.rect));
    evidence.recordAssertionEvidence(
      "An English-leading, Persian-dominant message still aligns right",
      JSON.stringify({ typed: typed?.rect, editor: editor?.rect, bold: bold?.rect, block: block?.rect }),
      Boolean(editor && typed && block && bold),
    );
    await user.screenshot();
  });

  await step("after: an English prompt and its answer stay left-aligned", async () => {
    await user.type("composer", englishPrompt, { replace: true });
    const editor = (await probe.dom("[data-lexical-editor='true'][contenteditable='true']")).elements[0];
    const typed = (await probe.dom("[data-lexical-editor='true'] span")).elements.find((element) => element.text.length > 0);
    expect(editor).toBeDefined();
    expect(typed).toBeDefined();
    if (editor && typed) expect(centerX(typed.rect)).toBeLessThan(centerX(editor.rect));

    await user.press("Enter");
    await user.see({ text: englishReplyText }, { timeoutMs: 120_000 });
    const block = await probe.eventually(async () => (await probe.dom(".markdown-content")).elements.find((element) => element.text.includes("English reply")), {
      within: 30_000, label: "the English answer renders as markdown",
    });
    const bold = (await probe.dom(".markdown-content strong")).elements.at(-1);
    expect(block).toBeDefined();
    expect(bold).toBeDefined();
    if (block && bold) expect(centerX(bold.rect)).toBeLessThan(centerX(block.rect));
    evidence.recordAssertionEvidence(
      "English text stays left-aligned in the composer and the answer",
      JSON.stringify({ typed: typed?.rect, editor: editor?.rect, bold: bold?.rect, block: block?.rect }),
      Boolean(editor && typed && block && bold),
    );
    await user.screenshot();
  });
});
