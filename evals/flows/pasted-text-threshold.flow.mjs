import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/pasted-text-threshold.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("pasted-text-threshold");

const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"]';
const EXPAND_BUTTON_SELECTOR = 'button[data-pasted-expand-label]';
const LONG_PASTE = "This pasted message should fill the composer without being shown in full. ".repeat(100);
const FITTING_PASTE = "This pasted message fits in the composer.";
const URL_PASTE = "https://example.com/pasted-text-threshold/abcdefghijklmnopqrstuvwxyz";

async function waitForReadySession(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  return ctx.waitFor(
    `(() => {
      const control = window.__openworkControl;
      const route = control.snapshot().route;
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      const action = control.listActions().find((item) => item.id === "session.create_task");
      if (action && !action.disabled) return "ready";
      return null;
    })()`,
    { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
  );
}

async function waitForComposer(ctx) {
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, {
    timeoutMs: 30_000,
    label: "composer editor",
  });
}

async function openEmptyComposer(ctx) {
  const target = await ctx.eval(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const match = route.match(/^\\/workspace\\/([^/]+)/);
      if (!match) return { ok: false, reason: "workspace route not found", route };
      const targetRoute = "/workspace/" + match[1] + "/session";
      if (route !== targetRoute) window.location.hash = "#" + targetRoute;
      return { ok: true, targetRoute };
    })()`,
  );
  ctx.assert(target?.ok === true, `Could not open the empty-state composer: ${target?.reason ?? "unknown"}`);
  await ctx.waitFor(
    `window.__openworkControl.snapshot().route === ${JSON.stringify(target.targetRoute)}`,
    { label: "empty workspace session route" },
  );
  await waitForComposer(ctx);
  await ctx.waitFor(
    `document.body.innerText.includes("What do you need done?")`,
    { label: "empty-state composer heading" },
  );
}

async function createFreshTask(ctx) {
  const previousRoute = await ctx.eval("window.__openworkControl.snapshot().route || ''");
  await ctx.control("session.create_task");
  await waitForComposer(ctx);
  await ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      return Boolean(route !== ${JSON.stringify(previousRoute)} && editor && editor.innerText.trim() === "");
    })()`,
    { label: "fresh empty task composer" },
  );
}

async function pasteComposer(ctx, text) {
  const result = await ctx.eval(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!editor) return { ok: false, reason: "composer not found" };
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", ${JSON.stringify(text)});
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      editor.dispatchEvent(event);
      return { ok: true, defaultPrevented: event.defaultPrevented, text: editor.innerText };
    })()`,
  );
  ctx.assert(result?.ok === true, `Could not paste into composer: ${result?.reason ?? "unknown"}`);
  return result;
}

function plainTextExpression(text) {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!editor) return false;
    const hasHighlight = Array.from(editor.querySelectorAll("span")).some((element) => {
      if (!(element.textContent || "").includes(${JSON.stringify(text)})) return false;
      const background = getComputedStyle(element).backgroundColor;
      return Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
    });
    return editor.innerText.includes(${JSON.stringify(text)}) && !hasHighlight;
  })()`;
}

async function composerInfo(ctx, text = "") {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!editor) return { ok: false, reason: "composer not found" };
      const button = editor.querySelector("button[data-pasted-expand-label]");
      const highlightedMatches = Array.from(editor.querySelectorAll("span")).filter((element) => {
        if (${JSON.stringify(text)} && !(element.textContent || "").includes(${JSON.stringify(text)})) return false;
        const background = getComputedStyle(element).backgroundColor;
        return Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
      }).map((element) => ({
        text: element.textContent || "",
        background: getComputedStyle(element).backgroundColor,
      }));
      return {
        ok: true,
        text: editor.innerText,
        chipCount: editor.querySelectorAll("button[data-pasted-expand-label]").length,
        expandTitle: button ? button.title : "",
        expandAriaLabel: button ? button.getAttribute("aria-label") || "" : "",
        hasHighlightedTarget: highlightedMatches.length > 0,
        highlightedMatches,
      };
    })()`,
  );
}

export default {
  id: "pasted-text-threshold",
  title: "Pasted text collapses only when it would make the composer scroll",
  kind: "user-facing",
  precondition: async (ctx) => {
    const state = await waitForReadySession(ctx);
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); pasted-text threshold flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Empty-state composer collapses long paste",
      run: async (ctx) => {
        await ctx.prove("The centered new-task composer collapses text that exceeds its visible capacity", {
          voiceover: vo[0],
          action: async () => {
            await openEmptyComposer(ctx);
            await pasteComposer(ctx, LONG_PASTE);
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EXPAND_BUTTON_SELECTOR)}))`, {
              label: "empty-state pasted-text chip",
            });
          },
          assert: async () => {
            const info = await composerInfo(ctx);
            ctx.assert(info.ok === true, info.reason ?? "Composer was not found.");
            ctx.assert(info.chipCount === 1, `Expected one empty-state pasted-text chip, got ${info.chipCount}.`);
            ctx.assert(info.text.includes("Pasted · 1 line"), `Chip label was not visible: ${JSON.stringify(info.text)}`);
            ctx.assert(!info.text.includes(LONG_PASTE), "Empty-state pasted text was expanded instead of collapsed.");
          },
          screenshot: { name: "empty-state-long-paste-chip", requireText: ["What do you need done?", "Pasted · 1 line", "Expand"] },
        });
      },
    },
    {
      name: "Empty-state chip expands to plain text",
      run: async (ctx) => {
        await ctx.prove("Expanding an empty-state paste chip restores normal editable text without highlighting", {
          voiceover: vo[1],
          action: async () => {
            await ctx.trustedClick(EXPAND_BUTTON_SELECTOR);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(LONG_PASTE)}) && !editor.querySelector("button[data-pasted-expand-label]"));
              })()`,
              { label: "expanded empty-state pasted text" },
            );
            await ctx.waitFor(plainTextExpression(LONG_PASTE), { label: "normal styling on expanded empty-state paste" });
          },
          assert: async () => {
            const info = await composerInfo(ctx, LONG_PASTE);
            ctx.assert(info.chipCount === 0, `Expanded empty-state paste still had ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(LONG_PASTE), "Expanded empty-state pasted text was not visible.");
            ctx.assert(info.hasHighlightedTarget === false, `Expanded empty-state paste was highlighted: ${JSON.stringify(info.highlightedMatches)}.`);
          },
          screenshot: { name: "empty-state-expanded-paste-plain", requireText: ["What do you need done?", LONG_PASTE] },
        });
      },
    },
    {
      name: "Long paste collapses into a chip",
      run: async (ctx) => {
        await ctx.prove("Text that exceeds the composer's visible capacity is collapsed into one inline pasted-text chip", {
          voiceover: vo[2],
          action: async () => {
            await createFreshTask(ctx);
            await pasteComposer(ctx, LONG_PASTE);
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EXPAND_BUTTON_SELECTOR)}))`, {
              label: "pasted-text chip",
            });
          },
          assert: async () => {
            const info = await composerInfo(ctx);
            ctx.assert(info.ok === true, info.reason ?? "Composer was not found.");
            ctx.assert(info.chipCount === 1, `Expected one pasted-text chip, got ${info.chipCount}.`);
            ctx.assert(info.text.includes("Pasted · 1 line"), `Chip label was not visible: ${JSON.stringify(info.text)}`);
            ctx.assert(!info.text.includes(LONG_PASTE), "Long pasted text was expanded instead of collapsed.");
          },
          screenshot: { name: "long-paste-chip", requireText: ["Pasted · 1 line", "Expand"] },
        });
      },
    },
    {
      name: "Chip hover says Expand",
      run: async (ctx) => {
        await ctx.prove("Hovering the pasted-text chip expansion control exposes the exact title Expand", {
          voiceover: vo[3],
          action: async () => {
            const point = await ctx.waitFor(
              `(() => {
                const button = document.querySelector(${JSON.stringify(EXPAND_BUTTON_SELECTOR)});
                if (!button) return null;
                button.scrollIntoView({ block: "center", inline: "center" });
                const rect = button.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              })()`,
              { label: "expand button hover point" },
            );
            await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
          },
          assert: async () => {
            const info = await composerInfo(ctx);
            ctx.assert(info.expandTitle === "Expand", `Expected title "Expand", got ${JSON.stringify(info.expandTitle)}.`);
            ctx.assert(info.expandAriaLabel.includes("Expand pasted text"), `Expansion aria label was unclear: ${JSON.stringify(info.expandAriaLabel)}.`);
          },
          screenshot: { name: "chip-hover-expand-title", requireText: ["Pasted · 1 line", "Expand"] },
        });
      },
    },
    {
      name: "Expanded chip text is plain and editable",
      run: async (ctx) => {
        await ctx.prove("Expanding the chip restores the pasted text as normal editable text without highlighting", {
          voiceover: vo[4],
          action: async () => {
            await ctx.trustedClick(EXPAND_BUTTON_SELECTOR);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(LONG_PASTE)}) && !editor.querySelector("button[data-pasted-expand-label]"));
              })()`,
              { label: "expanded pasted text without chip" },
            );
            await ctx.waitFor(plainTextExpression(LONG_PASTE), { label: "normal styling on expanded paste" });
          },
          assert: async () => {
            const info = await composerInfo(ctx, LONG_PASTE);
            ctx.assert(info.chipCount === 0, `Expanded paste still had ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(LONG_PASTE), "Expanded pasted text was not visible in the composer.");
            ctx.assert(info.hasHighlightedTarget === false, `Expanded paste was still highlighted: ${JSON.stringify(info.highlightedMatches)}.`);
          },
          screenshot: { name: "expanded-chip-plain", requireText: [LONG_PASTE] },
        });
      },
    },
    {
      name: "Fitting paste stays expanded and plain",
      run: async (ctx) => {
        await ctx.prove("Text that fits without scrolling stays expanded and looks like normal typed text", {
          voiceover: vo[5],
          action: async () => {
            await createFreshTask(ctx);
            await pasteComposer(ctx, FITTING_PASTE);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(FITTING_PASTE)}) && !editor.querySelector("button[data-pasted-expand-label]"));
              })()`,
              { label: "fitting paste expanded" },
            );
            await ctx.waitFor(plainTextExpression(FITTING_PASTE), { label: "normal styling on fitting paste" });
          },
          assert: async () => {
            const info = await composerInfo(ctx, FITTING_PASTE);
            ctx.assert(info.chipCount === 0, `Fitting paste incorrectly created ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(FITTING_PASTE), "Fitting pasted text was not visible.");
            ctx.assert(info.hasHighlightedTarget === false, `Fitting paste was highlighted: ${JSON.stringify(info.highlightedMatches)}.`);
          },
          screenshot: { name: "fitting-paste-plain", requireText: [FITTING_PASTE] },
        });
      },
    },
    {
      name: "Standalone URL never chips",
      run: async (ctx) => {
        await ctx.prove("A standalone HTTP URL with no whitespace remains an expanded link-like paste instead of a chip", {
          voiceover: vo[6],
          action: async () => {
            await createFreshTask(ctx);
            await pasteComposer(ctx, URL_PASTE);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(URL_PASTE)}));
              })()`,
              { label: "standalone URL visible" },
            );
          },
          assert: async () => {
            const info = await composerInfo(ctx, URL_PASTE);
            ctx.assert(info.chipCount === 0, `Standalone URL incorrectly created ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(URL_PASTE), "Standalone URL was not visible in the composer.");
          },
          screenshot: { name: "standalone-url-no-chip", requireText: [URL_PASTE] },
        });
      },
    },
  ],
};
