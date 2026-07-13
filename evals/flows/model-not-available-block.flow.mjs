import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/model-not-available-block.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("model-not-available-block");

const GUIDANCE = "The model you were using is no longer available, please select a different model for this session.";
const WARNING = "Model no longer available";
const MODEL_DIALOG = '[data-slot="dialog-content"]';
const MODEL_SEARCH_INPUT = 'input[placeholder="Search providers and models..."]';
const CONTINUE_TEXT = "Model recovery can continue.";

let seededRecovery = null;

function quoted(value) {
  return JSON.stringify(value);
}

function requireSeededRecovery(ctx) {
  ctx.assert(seededRecovery?.availableModel?.modelID, "The eval seed action did not return an available model.");
  return seededRecovery;
}

async function waitForControl(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
}

async function ensureSession(ctx) {
  await waitForControl(ctx);
  const inSession = await ctx.eval(`window.__openworkControl.snapshot().route.includes("/session/")`);
  if (inSession) return;

  await ctx.waitFor(
    `(() => {
      const action = window.__openworkControl.listActions().find((item) => item.id === "session.create_task");
      return action && !action.disabled;
    })()`,
    { timeoutMs: 45_000, label: "session.create_task enabled" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor(`window.__openworkControl.snapshot().route.includes("/session/")`, {
    timeoutMs: 45_000,
    label: "created session route",
  });
}

async function seedUnavailableSelectedModel(ctx) {
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((item) => item.id === "eval.model_not_available.seed" && !item.disabled)`,
    { timeoutMs: 45_000, label: "unavailable model eval seed action" },
  );
  seededRecovery = await ctx.control("eval.model_not_available.seed");
  const recovery = requireSeededRecovery(ctx);
  ctx.log(`Seeded unavailable model: ${JSON.stringify(recovery.unavailableModel)}`);
  ctx.log(`Available recovery model: ${JSON.stringify(recovery.availableModel)}`);
  return recovery;
}

async function waitForModelsDialog(ctx) {
  await ctx.waitFor(
    `(() => {
      const dialog = document.querySelector(${quoted(MODEL_DIALOG)});
      return Boolean(dialog && dialog.innerText.includes("Models"));
    })()`,
    { timeoutMs: 30_000, label: "Models dialog" },
  );
}

async function searchPicker(ctx, value) {
  await waitForModelsDialog(ctx);
  await ctx.fill(MODEL_SEARCH_INPUT, value);
}

async function pasteComposer(ctx, text) {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
        || document.querySelector('[contenteditable="true"]');
      if (!editor) return { ok: false, reason: "composer not found" };
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", ${quoted(text)});
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      return { ok: true };
    })()`,
  );
}

export default {
  id: "model-not-available-block",
  title: "Prompt for a replacement when a selected model disappears",
  kind: "user-facing",
  precondition: async (ctx) => {
    await waitForControl(ctx);
    const route = await ctx.eval(`window.__openworkControl.snapshot().route || ""`);
    return route.startsWith("/welcome") || route.startsWith("/signin")
      ? "Profile is not onboarded; this flow requires a workspace with a usable model."
      : null;
  },
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The active session can be put into the unavailable selected-model state", {
          voiceover: vo[0],
          action: async () => {
            await ensureSession(ctx);
            const recovery = await seedUnavailableSelectedModel(ctx);
            await ctx.waitForText(WARNING, { timeoutMs: 30_000 });
            await ctx.waitForText(recovery.unavailableModel.modelID, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const recovery = requireSeededRecovery(ctx);
            await ctx.expectText(WARNING);
            await ctx.expectText(recovery.unavailableModel.modelID);
          },
          screenshot: { name: "unavailable-selected-model", requireText: [WARNING] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The existing Models picker opens automatically for recovery", {
          voiceover: vo[1],
          action: async () => {
            const recovery = requireSeededRecovery(ctx);
            await waitForModelsDialog(ctx);
            await searchPicker(ctx, recovery.availableModel.providerName);
            await ctx.waitForText(recovery.availableModel.providerName, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Models");
            await ctx.expectText("Done");
          },
          screenshot: { name: "models-picker-auto-open", requireText: ["Models", "Done"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The Models picker replaces its subtitle with exact unavailable-model guidance", {
          voiceover: vo[2],
          action: async () => {
            const recovery = requireSeededRecovery(ctx);
            await searchPicker(ctx, recovery.availableModel.modelID);
            await ctx.waitForText(recovery.availableModel.modelID, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(GUIDANCE);
          },
          screenshot: { name: "models-picker-recovery-guidance", requireText: [GUIDANCE] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Selecting the returned available model closes recovery and leaves the composer usable", {
          voiceover: vo[3],
          action: async () => {
            const recovery = requireSeededRecovery(ctx);
            await searchPicker(ctx, recovery.availableModel.modelID);
            await ctx.waitFor(
              `(() => {
                const buttons = Array.from(document.querySelectorAll(${quoted(`${MODEL_DIALOG} button`)}));
                const target = buttons.find((button) => {
                  const text = button.innerText || button.textContent || "";
                  return text.includes(${quoted(recovery.availableModel.modelID)}) && !button.disabled;
                });
                if (!target) return null;
                target.scrollIntoView({ block: "center", inline: "nearest" });
                target.click();
                return target.textContent || true;
              })()`,
              { timeoutMs: 30_000, label: "available model row" },
            );
            await ctx.waitFor(`!document.body.innerText.includes(${quoted(GUIDANCE)})`, {
              timeoutMs: 30_000,
              label: "Models recovery dialog closed",
            });
            const pasted = await pasteComposer(ctx, CONTINUE_TEXT);
            ctx.assert(pasted?.ok, `Composer was not ready: ${pasted?.reason ?? "unknown"}`);
            await ctx.waitForText(CONTINUE_TEXT, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectNoText(GUIDANCE);
            await ctx.expectNoText(WARNING);
            await ctx.expectText(CONTINUE_TEXT);
            const canRun = await ctx.eval(`(() => {
              return Array.from(document.querySelectorAll("button")).some((button) => {
                const text = (button.textContent || "").trim();
                return text.includes("Run task") && !button.disabled;
              });
            })()`);
            ctx.assert(canRun, "The composer Run task button was not enabled after selecting an available model.");
          },
          screenshot: {
            name: "available-model-selected-composer-ready",
            requireText: [CONTINUE_TEXT, "Run task"],
            rejectText: [GUIDANCE, WARNING],
          },
        });
      },
    },
  ],
};
