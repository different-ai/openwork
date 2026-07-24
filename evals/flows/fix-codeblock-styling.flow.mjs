import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/fix-codeblock-styling.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("fix-codeblock-styling");

const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"]';
const CODE_BLOCK_SELECTOR = '[data-message-role="assistant"] [data-openwork-code-block]';
const COPY_BUTTON_SELECTOR = `${CODE_BLOCK_SELECTOR} [data-openwork-code-copy]`;
const SAMPLE_CODE = [
  "function greet(name) {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
  'console.log(greet("OpenWork"));',
].join("\n");
const PROMPT = `Reply with only this fenced JavaScript code block and preserve every space and newline:\n\n\`\`\`js\n${SAMPLE_CODE}\n\`\`\``;

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

async function setTheme(ctx, theme) {
  await ctx.eval(
    `(() => {
      const theme = ${JSON.stringify(theme)};
      localStorage.setItem("openwork.react.settings.theme-mode", theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      return document.documentElement.dataset.theme;
    })()`,
  );
  await ctx.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, {
    timeoutMs: 5_000,
    label: `${theme} mode`,
  });
}

async function waitForComposer(ctx) {
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, {
    timeoutMs: 30_000,
    label: "composer editor",
  });
}

async function createFreshTask(ctx) {
  await ctx.control("session.create_task");
  await waitForComposer(ctx);
}

async function pasteComposer(ctx, text) {
  const result = await ctx.eval(
    `(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!editor) return { ok: false, reason: "composer not found" };
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", ${JSON.stringify(text)});
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      return { ok: true, text: editor.innerText };
    })()`,
  );
  ctx.assert(result?.ok === true, `Could not paste into composer: ${result?.reason ?? "unknown"}`);
}

async function submitComposer(ctx) {
  const ran = await ctx.eval(`(() => {
    const byLabel = Array.from(document.querySelectorAll("button"))
      .find((button) => /run task|send|run/i.test((button.textContent || "").trim()) && !button.disabled);
    if (byLabel) { byLabel.click(); return "clicked"; }
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return "enter";
    }
    return "none";
  })()`);
  ctx.assert(ran !== "none", "Could not submit the composer message.");
}

async function waitForHighlightedCodeBlock(ctx) {
  await ctx.waitFor(
    `(() => Array.from(document.querySelectorAll(${JSON.stringify(CODE_BLOCK_SELECTOR)}))
      .some((block) => block.matches("[data-openwork-shiki]")
        && block.textContent.includes("function greet")
        && block.textContent.includes("OpenWork")
        && block.querySelector('[data-openwork-code-copy][aria-label="Copy code block"] [data-openwork-code-copy-icon]:not([hidden])')
        && block.querySelector("[data-openwork-code-copy] [data-openwork-code-copy-check-icon][hidden]")))()`,
    { timeoutMs: 120_000, label: "highlighted assistant code block with copy button" },
  );
}

function codeBlockInfoExpression() {
  return `(() => {
    const block = Array.from(document.querySelectorAll(${JSON.stringify(CODE_BLOCK_SELECTOR)}))
      .find((candidate) => candidate.textContent.includes("function greet") && candidate.textContent.includes("OpenWork"));
    if (!block) return { ok: false, reason: "code block not found" };
    const button = block.querySelector("[data-openwork-code-copy]");
    const copyIcon = button?.querySelector("[data-openwork-code-copy-icon]");
    const checkIcon = button?.querySelector("[data-openwork-code-copy-check-icon]");
    const copyLabel = button?.querySelector("[data-openwork-code-copy-label]");
    const code = block.querySelector("code");
    const token = block.querySelector(".shiki span");
    const paddedElement = code
      ? Array.from(block.querySelectorAll("div, pre"))
        .find((element) => element.contains(code) && Number.parseFloat(getComputedStyle(element).paddingTop) > 0)
      : null;

    const resolveColor = (cssValue) => {
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.pointerEvents = "none";
      probe.style.background = cssValue;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const paintColor = (cssValue, backdrop) => {
      if (!context || !cssValue) return null;
      context.clearRect(0, 0, 1, 1);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "rgba(1, 2, 3, 0.4)";
      const sentinel = context.fillStyle;
      try {
        context.fillStyle = cssValue;
      } catch {
        return null;
      }
      if (context.fillStyle === sentinel) return null;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      const alpha = pixel[3] / 255;
      return [
        pixel[0] * alpha + backdrop[0] * (1 - alpha),
        pixel[1] * alpha + backdrop[1] * (1 - alpha),
        pixel[2] * alpha + backdrop[2] * (1 - alpha),
      ];
    };
    const luminance = (channels) => {
      if (!channels) return null;
      const [red, green, blue] = channels;
      return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    };

    const blockRect = block.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    const blockBackground = getComputedStyle(block).backgroundColor;
    const pageBackground = resolveColor("var(--background)");
    const tokenColor = token ? getComputedStyle(token).color : "";
    const pageChannels = paintColor(pageBackground, [255, 255, 255]);
    const blockChannels = pageChannels ? paintColor(blockBackground, pageChannels) : null;
    const tokenChannels = tokenColor && blockChannels ? paintColor(tokenColor, blockChannels) : null;
    const blockLuminance = luminance(blockChannels);
    const pageLuminance = luminance(pageChannels);
    const tokenLuminance = luminance(tokenChannels);

    return {
      ok: true,
      theme: document.documentElement.dataset.theme || "",
      text: code?.textContent || "",
      blockBackground,
      pageBackground,
      tokenColor,
      colorMeasurementsOk: Boolean(blockChannels && pageChannels && (!tokenColor || tokenChannels)),
      blockLuminance,
      pageLuminance,
      backgroundDelta: blockLuminance === null || pageLuminance === null ? null : Math.abs(blockLuminance - pageLuminance),
      tokenContrastDelta: tokenLuminance === null || blockLuminance === null ? null : Math.abs(tokenLuminance - blockLuminance),
      buttonAria: button?.getAttribute("aria-label") || "",
      buttonTitle: button?.getAttribute("title") || "",
      hasCopyIcon: Boolean(copyIcon),
      hasCheckIcon: Boolean(checkIcon),
      copyIconAriaHidden: copyIcon?.getAttribute("aria-hidden") || "",
      checkIconAriaHidden: checkIcon?.getAttribute("aria-hidden") || "",
      copyIconHidden: copyIcon ? copyIcon.hasAttribute("hidden") : null,
      checkIconHidden: checkIcon ? checkIcon.hasAttribute("hidden") : null,
      copyLabel: copyLabel?.textContent?.trim() || "",
      copyLabelHidden: copyLabel?.classList.contains("sr-only") || false,
      copyLabelLive: copyLabel?.getAttribute("aria-live") || "",
      buttonTop: buttonRect ? buttonRect.top - blockRect.top : null,
      buttonRight: buttonRect ? blockRect.right - buttonRect.right : null,
      codePaddingTop: paddedElement ? Number.parseFloat(getComputedStyle(paddedElement).paddingTop) : 0,
    };
  })()`;
}

export default {
  id: "fix-codeblock-styling",
  title: "Code blocks stay theme-subtle and copy exact text",
  kind: "user-facing",
  precondition: async (ctx) => {
    const state = await waitForReadySession(ctx);
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); code-block styling flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Light mode code block is subtle",
      run: async (ctx) => {
        await ctx.prove("Light mode renders the assistant code block on a near-background surface", {
          voiceover: vo[0],
          action: async () => {
            await setTheme(ctx, "light");
            await createFreshTask(ctx);
            await pasteComposer(ctx, PROMPT);
            await submitComposer(ctx);
            await waitForHighlightedCodeBlock(ctx);
          },
          assert: async () => {
            const info = await ctx.eval(codeBlockInfoExpression());
            ctx.assert(info.ok === true, info.reason ?? "No code block info returned.");
            ctx.assert(info.theme === "light", `Expected light theme, got ${info.theme}.`);
            ctx.assert(info.colorMeasurementsOk === true, `Could not measure light code block colors: ${JSON.stringify(info)}`);
            ctx.assert(info.blockLuminance > 0.75, `Light code block is too dark: ${JSON.stringify(info)}`);
            ctx.assert(info.backgroundDelta > 0.002 && info.backgroundDelta < 0.12, `Light code block is not one subtle shade from the page: ${JSON.stringify(info)}`);
            ctx.assert(info.tokenContrastDelta > 0.25, `Light syntax colors do not contrast enough: ${JSON.stringify(info)}`);
          },
          screenshot: { name: "light-subtle-code-block", requireText: ["function greet"] },
        });
      },
    },
    {
      name: "Dark mode code block stays dark",
      run: async (ctx) => {
        await ctx.prove("Dark mode keeps the same code block dark and subtly distinct", {
          voiceover: vo[1],
          action: async () => {
            await setTheme(ctx, "dark");
            await waitForHighlightedCodeBlock(ctx);
          },
          assert: async () => {
            const info = await ctx.eval(codeBlockInfoExpression());
            ctx.assert(info.ok === true, info.reason ?? "No code block info returned.");
            ctx.assert(info.theme === "dark", `Expected dark theme, got ${info.theme}.`);
            ctx.assert(info.colorMeasurementsOk === true, `Could not measure dark code block colors: ${JSON.stringify(info)}`);
            ctx.assert(info.blockLuminance < 0.35, `Dark code block turned light: ${JSON.stringify(info)}`);
            ctx.assert(info.backgroundDelta > 0.002 && info.backgroundDelta < 0.15, `Dark code block is not subtly distinct: ${JSON.stringify(info)}`);
            ctx.assert(info.tokenContrastDelta > 0.25, `Dark syntax colors do not contrast enough: ${JSON.stringify(info)}`);
          },
          screenshot: { name: "dark-subtle-code-block", requireText: ["function greet"] },
        });
      },
    },
    {
      name: "Copy button is in the top right",
      run: async (ctx) => {
        await ctx.prove("The code block exposes an accessible Copy button in the top-right corner", {
          voiceover: vo[2],
          action: async () => {
            await waitForHighlightedCodeBlock(ctx);
          },
          assert: async () => {
            const info = await ctx.eval(codeBlockInfoExpression());
            ctx.assert(info.ok === true, info.reason ?? "No code block info returned.");
            ctx.assert(info.buttonAria === "Copy code block", `Unexpected copy aria label: ${info.buttonAria}.`);
            ctx.assert(info.buttonTitle === "Copy code block", `Unexpected copy title: ${info.buttonTitle}.`);
            ctx.assert(info.hasCopyIcon === true, `Copy icon is missing: ${JSON.stringify(info)}`);
            ctx.assert(info.hasCheckIcon === true, `Copied check icon is missing: ${JSON.stringify(info)}`);
            ctx.assert(info.copyIconAriaHidden === "true", `Copy icon should be aria-hidden: ${JSON.stringify(info)}`);
            ctx.assert(info.checkIconAriaHidden === "true", `Copied check icon should be aria-hidden: ${JSON.stringify(info)}`);
            ctx.assert(info.copyIconHidden === false, `Copy icon should be visible before copy: ${JSON.stringify(info)}`);
            ctx.assert(info.checkIconHidden === true, `Check icon should be hidden before copy: ${JSON.stringify(info)}`);
            ctx.assert(info.copyLabel === "Copy code block", `Unexpected copy assistive label: ${info.copyLabel}.`);
            ctx.assert(info.copyLabelHidden === true, `Copy assistive label is not screen-reader-only: ${JSON.stringify(info)}`);
            ctx.assert(info.copyLabelLive === "polite", `Copy assistive feedback should be polite: ${JSON.stringify(info)}`);
            ctx.assert(info.buttonTop >= 0 && info.buttonTop <= 16, `Copy button is not near the top: ${JSON.stringify(info)}`);
            ctx.assert(info.buttonRight >= 0 && info.buttonRight <= 16, `Copy button is not near the right edge: ${JSON.stringify(info)}`);
            ctx.assert(info.codePaddingTop >= 36, `Code is not padded below the button: ${JSON.stringify(info)}`);
          },
          screenshot: { name: "copy-button-top-right", requireText: ["function greet"] },
        });
      },
    },
    {
      name: "Copy preserves formatting",
      run: async (ctx) => {
        await ctx.prove("Selecting Copy writes the exact code block text to the clipboard", {
          voiceover: vo[3],
          action: async () => {
            await ctx.trustedClick(COPY_BUTTON_SELECTOR);
            await ctx.waitFor(
              `(() => {
                const button = document.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)});
                return Boolean(button
                  && button.getAttribute("aria-label") === "Code block copied"
                  && button.querySelector("[data-openwork-code-copy-icon][hidden]")
                  && button.querySelector("[data-openwork-code-copy-check-icon]:not([hidden])"));
              })()`,
              { timeoutMs: 5_000, label: "copied feedback" },
            );
          },
          assert: async () => {
            const info = await ctx.eval(codeBlockInfoExpression());
            ctx.assert(info.buttonAria === "Code block copied", `Copied aria feedback did not occur: ${JSON.stringify(info)}`);
            ctx.assert(info.copyIconHidden === true, `Copy icon was not hidden after copy: ${JSON.stringify(info)}`);
            ctx.assert(info.checkIconHidden === false, `Check icon was not shown after copy: ${JSON.stringify(info)}`);
            ctx.assert(info.copyLabel === "Code block copied", `Copied assistive feedback did not occur: ${JSON.stringify(info)}`);
            const copied = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
            ctx.assert(copied === SAMPLE_CODE, `Clipboard text changed formatting: ${JSON.stringify(copied)}`);
          },
          screenshot: { name: "copy-feedback", requireText: ["function greet"] },
        });
      },
    },
  ],
};
