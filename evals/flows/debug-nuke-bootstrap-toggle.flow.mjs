import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "debug-nuke-bootstrap-toggle";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

if (vo.length !== 2) {
  throw new Error(`Expected 2 voiceover frames for ${FLOW_ID}, found ${vo.length}.`);
}

const SWITCH_SELECTOR = '[role="switch"][aria-label="Keep bootstrap / organization server"]';

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
  const alreadyOpen = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(SWITCH_SELECTOR)}))`);
  if (!alreadyOpen) {
    await ctx.clickText("Nuke & fresh start");
  }
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(SWITCH_SELECTOR)}))`, {
    timeoutMs: 30_000,
    label: "bootstrap preservation switch",
  });
}

async function nukePreviewState(ctx) {
  return ctx.eval(`(() => {
    const switchEl = document.querySelector(${JSON.stringify(SWITCH_SELECTOR)});
    const cardText = (heading) => {
      const label = [...document.querySelectorAll('div')]
        .find((element) => element.textContent.trim().toUpperCase() === heading);
      return label?.parentElement?.innerText ?? '';
    };
    return {
      checked: switchEl?.getAttribute('aria-checked'),
      deleteText: cardText('WILL DELETE'),
      surviveText: cardText('WILL SURVIVE'),
    };
  })()`);
}

function recordStateAssertions(ctx, state, preserveBootstrap) {
  const suffix = "desktop-bootstrap.json";
  ctx.assert(state.checked === String(preserveBootstrap), `Bootstrap switch state was ${state.checked}.`);
  ctx.assert(
    state.surviveText.includes(suffix) === preserveBootstrap,
    `Will survive bootstrap visibility did not match preserve=${preserveBootstrap}.`,
  );
  ctx.assert(
    state.deleteText.includes(suffix) === !preserveBootstrap,
    `Will delete bootstrap visibility did not match preserve=${preserveBootstrap}.`,
  );
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: preserveBootstrap
      ? "desktop-bootstrap.json is listed under Will survive and omitted from Will delete"
      : "desktop-bootstrap.json is listed under Will delete and omitted from Will survive",
    actual: state,
  });
}

export default {
  id: FLOW_ID,
  title: "Nuke dialog toggles bootstrap preservation",
  kind: "user-facing",
  steps: [
    {
      name: "The safe default keeps organization bootstrap",
      run: async (ctx) => {
        await prepareDebugSettings(ctx);
        await ctx.prove("The nuke dialog preserves desktop-bootstrap.json by default", {
          voiceover: vo[0],
          action: async () => {
            await openNukeDialog(ctx);
          },
          assert: async () => {
            recordStateAssertions(ctx, await nukePreviewState(ctx), true);
            await ctx.expectText("Keep bootstrap / organization server");
            await ctx.expectText("Type NUKE to confirm");
          },
          screenshot: {
            name: "bootstrap-preserved-by-default",
            requireText: [
              "Nuke local state and start fresh?",
              "WILL SURVIVE",
              "Keep bootstrap / organization server",
              "desktop-bootstrap.json",
              "Type NUKE to confirm",
            ],
          },
        });
      },
    },
    {
      name: "Turning the switch off moves bootstrap into the delete plan",
      run: async (ctx) => {
        await ctx.prove("The user can include desktop-bootstrap.json in the local-state wipe", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const switchEl = document.querySelector(${JSON.stringify(SWITCH_SELECTOR)});
              if (!switchEl) throw new Error('bootstrap switch not found');
              switchEl.click();
              return true;
            })()`);
            await ctx.waitFor(
              `document.querySelector(${JSON.stringify(SWITCH_SELECTOR)})?.getAttribute('aria-checked') === 'false'`,
              { timeoutMs: 30_000, label: "bootstrap switch to turn off" },
            );
          },
          assert: async () => {
            recordStateAssertions(ctx, await nukePreviewState(ctx), false);
            await ctx.expectText("Type NUKE to confirm");
          },
          screenshot: {
            name: "bootstrap-included-in-delete-plan",
            requireText: [
              "WILL DELETE",
              "WILL SURVIVE",
              "Keep bootstrap / organization server",
              "desktop-bootstrap.json",
              "Type NUKE to confirm",
            ],
          },
        });
      },
    },
  ],
};
