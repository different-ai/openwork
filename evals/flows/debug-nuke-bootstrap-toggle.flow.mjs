import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "debug-nuke-bootstrap-toggle";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

if (vo.length !== 2) {
  throw new Error(`Expected 2 voiceover frames for ${FLOW_ID}, found ${vo.length}.`);
}

const CHECKBOX_SELECTOR = '[role="checkbox"][aria-label="Also delete bootstrap / organization server"]';

async function prepareDebugSettings(ctx) {
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await ctx.waitFor("document.body.innerText.trim().length > 40", {
    timeoutMs: 60_000,
    label: "rendered desktop app",
  });
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.developerMode', '1');
    localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: true }));
    localStorage.setItem('openwork.react.settings.theme-mode', 'light');
    return true;
  })()`);
  await ctx.navigateHash("/settings/debug");
  await ctx.waitForText("Danger zone", { timeoutMs: 60_000 });
}

async function openNukeDialog(ctx) {
  const alreadyOpen = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(CHECKBOX_SELECTOR)}))`);
  if (!alreadyOpen) {
    await ctx.clickText("Nuke & fresh start");
  }
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(CHECKBOX_SELECTOR)}))`, {
    timeoutMs: 30_000,
    label: "delete-bootstrap checkbox",
  });
}

async function nukePreviewState(ctx) {
  return ctx.eval(`(() => {
    const checkboxEl = document.querySelector(${JSON.stringify(CHECKBOX_SELECTOR)});
    const cardText = (heading) => {
      const label = [...document.querySelectorAll('div')]
        .find((element) => element.textContent.trim().toUpperCase() === heading);
      return label?.parentElement?.innerText ?? '';
    };
    return {
      checked: checkboxEl?.getAttribute('aria-checked'),
      deleteText: cardText('WILL DELETE'),
      surviveText: cardText('WILL SURVIVE'),
    };
  })()`);
}

function recordStateAssertions(ctx, state, deleteBootstrap) {
  const suffix = "desktop-bootstrap.json";
  ctx.assert(state.checked === String(deleteBootstrap), `Delete-bootstrap checkbox state was ${state.checked}.`);
  ctx.assert(
    state.surviveText.includes(suffix) === !deleteBootstrap,
    `Will survive bootstrap visibility did not match delete=${deleteBootstrap}.`,
  );
  ctx.assert(
    state.deleteText.includes(suffix) === deleteBootstrap,
    `Will delete bootstrap visibility did not match delete=${deleteBootstrap}.`,
  );
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: deleteBootstrap
      ? "desktop-bootstrap.json is listed under Will delete and omitted from Will survive"
      : "desktop-bootstrap.json is listed under Will survive and omitted from Will delete",
    actual: state,
  });
}

export default {
  id: FLOW_ID,
  title: "Nuke dialog opts in to deleting bootstrap",
  kind: "user-facing",
  steps: [
    {
      name: "The unchecked default keeps organization bootstrap",
      run: async (ctx) => {
        await prepareDebugSettings(ctx);
        await ctx.prove("The nuke dialog leaves desktop-bootstrap.json out of the delete plan by default", {
          voiceover: vo[0],
          action: async () => {
            await openNukeDialog(ctx);
          },
          assert: async () => {
            recordStateAssertions(ctx, await nukePreviewState(ctx), false);
            await ctx.expectText("Also delete bootstrap / organization server");
            await ctx.expectText("Type NUKE to confirm");
          },
          screenshot: {
            name: "bootstrap-preserved-by-default",
            requireText: [
              "Nuke local state and start fresh?",
              "WILL SURVIVE",
              "Also delete bootstrap / organization server",
              "desktop-bootstrap.json",
              "Type NUKE to confirm",
            ],
          },
        });
      },
    },
    {
      name: "Checking the box moves bootstrap into the delete plan",
      run: async (ctx) => {
        await ctx.prove("The user can opt desktop-bootstrap.json into the local-state wipe", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const checkboxEl = document.querySelector(${JSON.stringify(CHECKBOX_SELECTOR)});
              if (!checkboxEl) throw new Error('delete-bootstrap checkbox not found');
              checkboxEl.click();
              return true;
            })()`);
            await ctx.waitFor(
              `document.querySelector(${JSON.stringify(CHECKBOX_SELECTOR)})?.getAttribute('aria-checked') === 'true'`,
              { timeoutMs: 30_000, label: "delete-bootstrap checkbox to turn on" },
            );
          },
          assert: async () => {
            recordStateAssertions(ctx, await nukePreviewState(ctx), true);
            await ctx.expectText("Type NUKE to confirm");
          },
          screenshot: {
            name: "bootstrap-included-in-delete-plan",
            requireText: [
              "WILL DELETE",
              "WILL SURVIVE",
              "Also delete bootstrap / organization server",
              "desktop-bootstrap.json",
              "Type NUKE to confirm",
            ],
          },
        });
      },
    },
  ],
};
