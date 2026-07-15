import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/pasted-text-threshold.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("pasted-text-threshold");

const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';
const SHORT_TEXT = "Meeting notes\n- Ship the composer fix\n- Keep this text editable";
const LONG_TEXT = [
  "LONG PASTE START",
  ...Array.from(
    { length: 260 },
    (_, index) => `Review line ${index + 1}: this large pasted text remains available for review and editing.`,
  ),
  "LONG PASTE END",
].join("\n");

async function clearComposer(ctx) {
  await ctx.control("composer.set_text", { text: "" });
  await ctx.waitFor(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      return Boolean(editor && editor.innerText.trim().length === 0);
    })()`,
    { label: "empty composer" },
  );
}

async function pasteComposer(ctx, text) {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!editor) return { ok: false, reason: "composer not found" };
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", ${JSON.stringify(text)});
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      editor.dispatchEvent(event);
      return { ok: true, prevented: event.defaultPrevented };
    })()`,
  );
}

async function composerState(ctx) {
  return ctx.eval(`(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const expand = document.querySelector("button[data-pasted-expand-label]");
    const text = editor?.innerText ?? "";
    return {
      text,
      length: text.length,
      expandVisible: Boolean(expand),
      expandText: expand?.textContent?.trim() ?? "",
    };
  })()`);
}

async function waitForPaint(ctx) {
  await ctx.eval(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    { awaitPromise: true },
  );
}

export default {
  id: "pasted-text-threshold",
  title: "Normal pasted text stays editable and large pastes stay manageable",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const route = await ctx.eval("window.__openworkControl.snapshot().route || ''");
    if (route.startsWith("/welcome") || route.startsWith("/signin")) {
      return "Profile is not onboarded; this flow requires an active workspace session.";
    }
    await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, {
      timeoutMs: 30_000,
      label: "session composer",
    });
    return null;
  },
  steps: [
    {
      name: "Short pasted text stays editable",
      run: async (ctx) => {
        await ctx.prove("Short pasted text remains directly editable", {
          voiceover: vo[0],
          action: async () => {
            await clearComposer(ctx);
            const pasted = await pasteComposer(ctx, SHORT_TEXT);
            ctx.assert(pasted?.ok, pasted?.reason ?? "Short paste failed.");
            await ctx.waitFor(
              `document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.innerText.includes("Meeting notes")`,
              { label: "short pasted note in composer" },
            );
            await waitForPaint(ctx);
          },
          assert: async () => {
            const state = await composerState(ctx);
            ctx.assert(state.text === SHORT_TEXT, `Expected editable short paste, got ${JSON.stringify(state.text)}.`);
            ctx.assert(!state.expandVisible, "Short paste unexpectedly rendered as a collapsed chip.");
          },
          screenshot: {
            name: "short-paste-editable",
            requireText: ["Meeting notes", "Keep this text editable"],
            rejectText: ["Show in text field"],
          },
        });
      },
    },
    {
      name: "Large pasted text collapses into one compact chip",
      run: async (ctx) => {
        await ctx.prove("Large pasted text becomes a compact expandable chip", {
          voiceover: vo[1],
          action: async () => {
            await clearComposer(ctx);
            ctx.assert(LONG_TEXT.length > 10_000, "Large paste fixture did not cross the threshold.");
            const pasted = await pasteComposer(ctx, LONG_TEXT);
            ctx.assert(pasted?.ok, pasted?.reason ?? "Large paste failed.");
            ctx.assert(pasted.prevented, "Large paste was not intercepted for collapsing.");
            await ctx.waitFor(
              'Boolean(document.querySelector("button[data-pasted-expand-label]"))',
              { label: "collapsed pasted-text chip" },
            );
            await waitForPaint(ctx);
          },
          assert: async () => {
            const state = await composerState(ctx);
            ctx.assert(state.expandVisible, "Large paste did not render an expand action.");
            ctx.assert(state.expandText === "Show in text field", `Unexpected expand label: ${state.expandText}`);
            ctx.assert(!state.text.includes("LONG PASTE START"), "Large paste remained expanded in the composer.");
          },
          screenshot: {
            name: "large-paste-collapsed",
            requireText: ["Pasted", "Show in text field"],
            rejectText: ["LONG PASTE START"],
          },
        });
      },
    },
    {
      name: "The user restores the full paste to the text field",
      run: async (ctx) => {
        await ctx.prove("Show in text field restores the full editable paste", {
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText("Show in text field");
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes("LONG PASTE START") && editor.innerText.length > 10_000);
              })()`,
              { label: "full pasted text restored" },
            );
            await ctx.eval(`(() => {
              const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
              if (editor) editor.scrollTop = 0;
              return true;
            })()`);
            await waitForPaint(ctx);
          },
          assert: async () => {
            const state = await composerState(ctx);
            ctx.assert(state.length > 10_000, `Restored paste was only ${state.length} characters.`);
            ctx.assert(state.text.includes("LONG PASTE START"), "Restored paste is missing its first marker.");
            ctx.assert(state.text.includes("LONG PASTE END"), "Restored paste is missing its final marker.");
            ctx.assert(!state.expandVisible, "Collapsed chip remained after restoring the text.");
          },
          screenshot: {
            name: "large-paste-restored",
            requireText: ["LONG PASTE START", "Review line 1"],
            rejectText: ["Show in text field"],
          },
        });
      },
    },
  ],
};
