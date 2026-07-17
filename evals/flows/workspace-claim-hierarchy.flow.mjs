import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("workspace-claim-hierarchy");

export default {
  id: "workspace-claim-hierarchy",
  title: "Workspace claim has one clear demo handoff",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Claim success is centered with one primary action",
      run: async (ctx) => {
        await ctx.prove("The local claim success page is centered and makes copying the sign-in code the clear next step", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitForText("DEMO WORKSPACE READY", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const surface = document.querySelector('[data-demo-claim="true"]');
              const card = surface?.querySelector('.den-frame');
              const primary = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Copy sign-in code'));
              const open = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Open OpenWork'));
              const browser = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Continue in browser instead'));
              if (!surface || !card || !primary || !open || !browser) return null;
              const cardRect = card.getBoundingClientRect();
              const primaryRect = primary.getBoundingClientRect();
              const openRect = open.getBoundingClientRect();
              const browserRect = browser.getBoundingClientRect();
              const background = getComputedStyle(surface).backgroundColor;
              return {
                background,
                cardCenterX: cardRect.left + cardRect.width / 2,
                cardCenterY: cardRect.top + cardRect.height / 2,
                viewportCenterX: innerWidth / 2,
                viewportCenterY: innerHeight / 2,
                primaryWidth: primaryRect.width,
                openWidth: openRect.width,
                browserWidth: browserRect.width,
              };
            })()`);
            ctx.assert(state !== null, "The local demo claim controls were not rendered.");
            ctx.assert(Math.abs(state.cardCenterX - state.viewportCenterX) < 3, "The claim card is not horizontally centered.");
            ctx.assert(Math.abs(state.cardCenterY - state.viewportCenterY) < 30, "The claim card is not vertically centered.");
            ctx.assert(state.primaryWidth > state.openWidth * 2, "The primary action is not visually dominant.");
            ctx.assert(state.primaryWidth > state.browserWidth * 2, "The browser fallback competes with the primary action.");
            ctx.assert(state.background === "rgb(237, 246, 255)", `Expected the demo-blue background, got ${state.background}.`);
            await ctx.expectNoText("isolated development app");
          },
          screenshot: {
            name: "workspace-claim-centered-hierarchy",
            requireText: ["DEMO WORKSPACE READY", "Copy sign-in code", "Open OpenWork", "Continue in browser instead"],
            rejectText: ["isolated development app", "Something went wrong"],
          },
        });
      },
    },
  ],
};
