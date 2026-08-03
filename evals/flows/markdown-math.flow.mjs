import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/markdown-math.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("markdown-math");

const MATH_SEED_ACTION = "eval.markdown_math.seed_chat";

let activeSessionId = "";
let assistantMessageId = "";

function messageSelector(messageId) {
  return `[data-message-id=${JSON.stringify(messageId)}]`;
}

const UNSAFE_JS_CHAR_MAP = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeUnsafeChars(str) {
  return str.replace(/[<>\/\\\b\f\n\r\t\0\u2028\u2029]/g, (ch) => UNSAFE_JS_CHAR_MAP[ch]);
}

async function waitForControl(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
}

async function closeTransientUi(ctx) {
  await ctx.eval(`(() => {
    const closeFind = document.querySelector('button[aria-label="Close find"]');
    if (closeFind instanceof HTMLButtonElement && !closeFind.disabled) {
      closeFind.click();
    }

    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    return true;
  })()`);
}

/**
 * Always starts a brand new task so the flow is idempotent: a previous run
 * leaves its seeded math message behind, which would make the opening frame
 * identical to the seeded ones.
 */
async function ensureSession(ctx) {
  await waitForControl(ctx);
  await closeTransientUi(ctx);

  await ctx.control("session.create_task");
  activeSessionId = await ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      const match = route.match(/ses_[A-Za-z0-9]+/);
      return match ? match[0] : null;
    })()`,
    { timeoutMs: 30_000, label: "created session route" },
  );
  await ctx.waitFor(
    `document.querySelectorAll(".katex").length === 0`,
    { timeoutMs: 30_000, label: "empty transcript with no leftover math" },
  );
  return activeSessionId;
}

/** Seeds progressively more of the math message so each frame shows new content. */
async function seedMathMessage(ctx, stage, expectedFormulas) {
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((action) => action.id === ${escapeUnsafeChars(JSON.stringify(MATH_SEED_ACTION))} && !action.disabled)`,
    { timeoutMs: 30_000, label: `${MATH_SEED_ACTION} enabled` },
  );

  const seeded = await ctx.control(MATH_SEED_ACTION, { stage });
  assistantMessageId = seeded.assistantMessageId || "";
  ctx.assert(Boolean(assistantMessageId), `Seed action did not return an assistant message id: ${JSON.stringify(seeded)}`);

  await ctx.control("session.scroll_bottom").catch(() => undefined);
  // Wait for the concrete artifact under assertion, not for a spinner.
  await ctx.waitFor(
    `document.querySelectorAll(${JSON.stringify(`${messageSelector(assistantMessageId)} .katex`)}).length >= ${expectedFormulas}`,
    { timeoutMs: 30_000, label: `${expectedFormulas} rendered KaTeX formulas` },
  );
}

/** Reads the rendered math state out of the seeded assistant message. */
async function readMathState(ctx) {
  const selector = messageSelector(assistantMessageId);

  return ctx.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root) return { ok: false, reason: "seeded math message not found" };

    const katex = Array.from(root.querySelectorAll(".katex"));
    const display = Array.from(root.querySelectorAll(".katex-display"));
    const annotations = Array.from(root.querySelectorAll('annotation[encoding="application/x-tex"]'))
      .map((node) => (node.textContent || "").trim());
    const mathml = Array.from(root.querySelectorAll("math"));
    const errors = Array.from(root.querySelectorAll("[data-openwork-math-error]"))
      .map((node) => (node.textContent || "").trim());

    // The visible sentence text, with the aria-hidden KaTeX HTML branch and the
    // MathML branch removed, is what a reader actually sees as prose.
    const clone = root.cloneNode(true);
    for (const node of Array.from(clone.querySelectorAll(".katex"))) {
      node.remove();
    }

    return {
      ok: true,
      katexCount: katex.length,
      displayCount: display.length,
      annotations,
      mathmlCount: mathml.length,
      errors,
      proseText: (clone.innerText || "").replace(/\\s+/g, " ").trim(),
      fullText: (root.innerText || "").replace(/\\s+/g, " ").trim(),
    };
  })()`);
}

export default {
  id: "markdown-math",
  title: "LaTeX math renders as typeset math in chat responses",
  kind: "user-facing",
  precondition: async (ctx) => {
    await waitForControl(ctx);
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = String(control.snapshot().route || "");
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        if (route.includes("/session/")) return "ready";
        const create = control.listActions().find((action) => action.id === "session.create_task");
        return create && !create.disabled ? "ready" : null;
      })()`,
      { timeoutMs: 30_000, label: "session route or create_task enabled" },
    );

    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); math rendering proof requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Conversation opens normally",
      run: async (ctx) => {
        await ctx.prove("OpenWork displays a normal session before the math proof starts", {
          voiceover: vo[0],
          action: async () => {
            await ensureSession(ctx);
            await ctx.waitFor("document.body.innerText.trim().length > 40", {
              label: "rendered app text",
            });
          },
          assert: async () => {
            ctx.assert(Boolean(activeSessionId), "No active session id was available.");
            await ctx.expectHashIncludes("/session/");
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "conversation-open",
            hashIncludes: "/session/",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Inline math renders instead of raw LaTeX",
      run: async (ctx) => {
        await ctx.prove("Inline $...$ and \\(...\\) math render as typeset formulas, not raw LaTeX source", {
          voiceover: vo[1],
          action: async () => {
            await seedMathMessage(ctx, 1, 2);
          },
          assert: async () => {
            const state = await readMathState(ctx);
            ctx.assert(state.ok, state.reason || "Math message did not render.");
            ctx.assert(state.katexCount >= 2, `Expected the 2 inline formulas to render, saw ${state.katexCount}.`);

            // The regression being fixed: LaTeX delimiters shown as literal prose.
            ctx.assert(
              !state.proseText.includes("$E\\psi"),
              `Dollar-delimited LaTeX is still visible as raw source: ${state.proseText}`,
            );
            // Only markers unique to the well-formed formulas: the seed also
            // contains a deliberately malformed "$\frac{1}{$", whose visible
            // source is the graceful fallback proved in the last step.
            const leaked = ["\\hbar", "\\hat{H}", "\\partial", "\\Psi"]
              .filter((marker) => state.proseText.includes(marker));
            ctx.assert(
              leaked.length === 0,
              `Backslash LaTeX commands leaked into the visible prose (${leaked.join(", ")}): ${state.proseText}`,
            );

            // The formulas really are the ones from the message.
            ctx.assert(
              state.annotations.some((tex) => tex.includes("E\\psi = \\hat{H}\\psi")),
              `Inline $...$ formula missing. Annotations: ${JSON.stringify(state.annotations)}`,
            );
            ctx.assert(
              state.annotations.some((tex) => tex.includes("\\partial")),
              `Inline \\(...\\) formula missing. Annotations: ${JSON.stringify(state.annotations)}`,
            );
            ctx.log(`rendered formulas: ${JSON.stringify(state.annotations)}`);
          },
          screenshot: {
            name: "inline-math-rendered",
            requireText: ["Schrodinger proof heading"],
            rejectText: ["$E\\psi", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Display math renders centred",
      run: async (ctx) => {
        await ctx.prove("$$...$$ and \\[...\\] both render as centred display equations", {
          voiceover: vo[2],
          action: async () => {
            await seedMathMessage(ctx, 2, 4);
          },
          assert: async () => {
            const state = await readMathState(ctx);
            ctx.assert(
              state.displayCount >= 2,
              `Expected at least 2 display equations, saw ${state.displayCount}.`,
            );
            ctx.assert(
              state.annotations.some((tex) => tex.includes("\\nabla^2")),
              `$$...$$ Hamiltonian display equation missing. Annotations: ${JSON.stringify(state.annotations)}`,
            );
            ctx.assert(
              state.annotations.some((tex) => tex.includes("\\sqrt{b^2 - 4ac}")),
              `\\[...\\] quadratic display equation missing. Annotations: ${JSON.stringify(state.annotations)}`,
            );
            ctx.log(`display equations: ${state.displayCount}`);
          },
          screenshot: {
            name: "display-math-rendered",
            requireText: ["display math too"],
            rejectText: ["\\nabla", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Math stays accessible",
      run: async (ctx) => {
        await ctx.prove("Each formula keeps a MathML branch so screen readers announce the equation", {
          voiceover: vo[3],
          action: async () => {
            await seedMathMessage(ctx, 2, 4);
          },
          assert: async () => {
            const state = await readMathState(ctx);
            // DOMPurify strips <semantics>/<annotation> unless explicitly allowed,
            // which would silently drop the accessible half of every formula.
            ctx.assert(
              state.mathmlCount >= state.katexCount,
              `Expected one <math> element per formula, saw ${state.mathmlCount} for ${state.katexCount} formulas.`,
            );
            ctx.assert(
              state.annotations.length >= state.katexCount,
              `TeX annotations were stripped by sanitization: ${state.annotations.length} of ${state.katexCount}.`,
            );
            // No new pixels here — the evidence is the MathML a screen reader
            // consumes, so the frame carries that text instead of a screenshot.
            await ctx.output(
              "math-accessible-mathml",
              [
                `formulas: ${state.katexCount}`,
                `<math> elements: ${state.mathmlCount}`,
                "TeX announced to assistive tech:",
                ...state.annotations.map((tex) => `  - ${tex}`),
              ].join("\n"),
            );
          },
        });
      },
    },
    {
      name: "Malformed LaTeX degrades gracefully",
      run: async (ctx) => {
        await ctx.prove("Malformed LaTeX and plain currency never break the surrounding message", {
          voiceover: vo[4],
          action: async () => {
            await seedMathMessage(ctx, 3, 4);
          },
          assert: async () => {
            const state = await readMathState(ctx);

            // The paragraph either side of the bad formula still reads correctly.
            ctx.assert(
              state.fullText.includes("must not break this paragraph"),
              `Prose after the malformed formula was lost: ${state.fullText}`,
            );
            // Currency is prose, not math.
            ctx.assert(
              state.fullText.includes("$5") && state.fullText.includes("$10"),
              `Currency amounts were swallowed by the math renderer: ${state.fullText}`,
            );
            ctx.assert(
              !state.annotations.some((tex) => tex.includes("5 and ")),
              `Currency was mis-parsed as a formula: ${JSON.stringify(state.annotations)}`,
            );
            await ctx.expectNoText("Something went wrong");
            ctx.log(`graceful fallbacks: ${JSON.stringify(state.errors)}`);
          },
          screenshot: {
            name: "malformed-latex-graceful",
            requireText: ["must not break this paragraph", "$5", "$10"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
