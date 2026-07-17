import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/pasted-text-threshold.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("pasted-text-threshold");

const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"]';
const EXPAND_BUTTON_SELECTOR = 'button[data-pasted-expand-label]';
const LONG_PASTE = "This pasted message is longer than fifty characters and should collapse into a chip.";
const SHORT_PASTE = "1234567890".repeat(5);
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

function styledTextExpression(text) {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!editor) return false;
    return Array.from(editor.querySelectorAll("span")).some((element) => {
      if (!(element.textContent || "").includes(${JSON.stringify(text)})) return false;
      const background = getComputedStyle(element).backgroundColor;
      return Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
    });
  })()`;
}

async function composerInfo(ctx, text = "") {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!editor) return { ok: false, reason: "composer not found" };
      const button = editor.querySelector("button[data-pasted-expand-label]");
      const styledMatches = Array.from(editor.querySelectorAll("span")).filter((element) => {
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
        hasStyledTarget: styledMatches.length > 0,
        styledMatches,
      };
    })()`,
  );
}

export default {
  id: "pasted-text-threshold",
  title: "Pasted text collapses only above 50 characters and expanded pastes stay visibly distinct",
  kind: "user-facing",
  precondition: async (ctx) => {
    const state = await waitForReadySession(ctx);
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); pasted-text threshold flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Long paste collapses into a chip",
      run: async (ctx) => {
        await ctx.prove("Text longer than 50 characters is collapsed into one inline pasted-text chip", {
          voiceover: vo[0],
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
          voiceover: vo[1],
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
      name: "Expanded chip text is gray and editable",
      run: async (ctx) => {
        await ctx.prove("Expanding the chip restores the pasted text inline with gray pasted-content styling", {
          voiceover: vo[2],
          action: async () => {
            await ctx.trustedClick(EXPAND_BUTTON_SELECTOR);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(LONG_PASTE)}) && !editor.querySelector("button[data-pasted-expand-label]"));
              })()`,
              { label: "expanded pasted text without chip" },
            );
            await ctx.waitFor(styledTextExpression(LONG_PASTE), { label: "gray styling on expanded paste" });
          },
          assert: async () => {
            const info = await composerInfo(ctx, LONG_PASTE);
            ctx.assert(info.chipCount === 0, `Expanded paste still had ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(LONG_PASTE), "Expanded pasted text was not visible in the composer.");
            ctx.assert(info.hasStyledTarget === true, `Expanded paste did not have gray styling: ${JSON.stringify(info.styledMatches)}.`);
          },
          screenshot: { name: "expanded-chip-gray", requireText: [LONG_PASTE] },
        });
      },
    },
    {
      name: "Fifty characters stays expanded and gray",
      run: async (ctx) => {
        await ctx.prove("Text of exactly 50 characters stays expanded while showing pasted-content styling", {
          voiceover: vo[3],
          action: async () => {
            await createFreshTask(ctx);
            await pasteComposer(ctx, SHORT_PASTE);
            await ctx.waitFor(
              `(() => {
                const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
                return Boolean(editor && editor.innerText.includes(${JSON.stringify(SHORT_PASTE)}) && !editor.querySelector("button[data-pasted-expand-label]"));
              })()`,
              { label: "50-character paste expanded" },
            );
            await ctx.waitFor(styledTextExpression(SHORT_PASTE), { label: "gray styling on 50-character paste" });
          },
          assert: async () => {
            const info = await composerInfo(ctx, SHORT_PASTE);
            ctx.assert(info.chipCount === 0, `50-character paste incorrectly created ${info.chipCount} chip(s).`);
            ctx.assert(info.text.includes(SHORT_PASTE), "50-character pasted text was not visible.");
            ctx.assert(info.hasStyledTarget === true, `50-character paste did not have gray styling: ${JSON.stringify(info.styledMatches)}.`);
          },
          screenshot: { name: "short-paste-gray", requireText: [SHORT_PASTE] },
        });
      },
    },
    {
      name: "Standalone URL never chips",
      run: async (ctx) => {
        await ctx.prove("A standalone HTTP URL with no whitespace remains an expanded link-like paste instead of a chip", {
          voiceover: vo[4],
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
