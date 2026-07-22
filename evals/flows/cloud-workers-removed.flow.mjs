/**
 * User-facing flow demo (spec: evals/voiceovers/cloud-workers-removed.md):
 * the "Cloud Workers" settings tab is removed. The Cloud settings group only
 * offers Account, the Account tab copy no longer mentions Cloud workers, and
 * the legacy /settings/cloud-workers deep link redirects to cloud-account.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("cloud-workers-removed");

export default {
  id: "cloud-workers-removed",
  title: "Cloud Workers tab removed: sidebar, Account copy, legacy redirect",
  kind: "user-facing",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          timeoutMs: 30_000,
          label: "rendered body text",
        });
      },
    },
    {
      name: "Cloud settings group offers only Account",
      run: async (ctx) => {
        await ctx.prove("The Cloud settings group lists Account and nothing else", {
          claim: "Settings shows a Cloud group whose only entry is Account; the Cloud Workers tab is gone.",
          voiceover: vo[0],
          action: async () => {
            await ctx.navigateHash("/settings/general");
            await ctx.waitForText("Cloud", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/general");
            await ctx.expectText("Account");
            await ctx.expectNoText("Cloud Workers");
          },
          screenshot: {
            name: "settings-cloud-group",
            requireText: ["Cloud", "Account"],
            rejectText: ["Cloud Workers", "Cloud workers"],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "Account tab copy no longer mentions Cloud workers",
      run: async (ctx) => {
        await ctx.prove("Cloud Account renders without any Cloud workers copy", {
          claim: "The Cloud Account tab renders its normal signed-in/out surface and no text on the page mentions Cloud workers.",
          voiceover: vo[1],
          action: async () => {
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitForText("OpenWork Cloud", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/cloud-account");
            const mentions = await ctx.eval(
              "document.body.innerText.toLowerCase().includes('cloud worker')",
            );
            ctx.assert(!mentions, "Page text still mentions 'cloud worker'.");
          },
          screenshot: {
            name: "cloud-account-copy",
            requireText: ["OpenWork Cloud"],
            rejectText: ["Cloud Workers", "Cloud workers"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Legacy cloud-workers link redirects to Account",
      run: async (ctx) => {
        await ctx.prove("Old /settings/cloud-workers links land on the Account tab", {
          claim: "Navigating to the retired #/settings/cloud-workers path redirects to #/settings/cloud-account and renders the Account tab.",
          voiceover: vo[2],
          action: async () => {
            // Leave the Account tab first so the redirect is observable.
            await ctx.navigateHash("/settings/general");
            await ctx.waitFor("location.hash.includes('/settings/general')", {
              label: "back on settings general",
            });
            await ctx.navigateHash("/settings/cloud-workers");
            await ctx.waitFor("location.hash.includes('/settings/cloud-account')", {
              timeoutMs: 30_000,
              label: "redirect to /settings/cloud-account",
            });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/cloud-account");
            await ctx.expectText("OpenWork Cloud");
            const mentions = await ctx.eval(
              "document.body.innerText.toLowerCase().includes('cloud worker')",
            );
            ctx.assert(!mentions, "Redirected page still mentions 'cloud worker'.");
          },
        });
      },
    },
  ],
};
