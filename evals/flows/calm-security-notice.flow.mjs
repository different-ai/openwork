import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  applyDesktopViewport,
  clickExactText,
  clickSelectorWithMouse,
  grantClipboardPermissions,
  navigateTo,
  signInToDenWeb,
  stageStaleSessionAndInstallLinks,
} from "./den-reauth-pending-action.flow.mjs";

// Narration is loaded from the approved script (evals/voiceovers/calm-security-notice.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("calm-security-notice");
const GUIDANCE_MESSAGE = "For security, confirm it's you before changing workspace settings.";
const OLD_REAUTH_TITLE = "Confirm it's you to continue";
const COPY_INSTALL_LINK_SELECTOR = '[data-testid="copy-install-link"]';

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function cancelReauth(ctx) {
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && dialog.textContent.includes(${JSON.stringify(GUIDANCE_MESSAGE)}));
  })()`, { timeoutMs: 30_000, label: "reauth dialog" });
  await clickExactText(ctx, "Cancel", "button");
  await ctx.waitFor(`(() => {
    const notice = document.querySelector('[data-notice-tone="info"]');
    return Boolean(notice && notice.textContent.includes(${JSON.stringify(GUIDANCE_MESSAGE)}));
  })()`, { timeoutMs: 20_000, label: "calm security guidance" });
  await ctx.eval(`(() => {
    document.querySelector('[data-notice-tone="info"]')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  })()`);
  await ctx.waitFor(`(() => {
    const notice = document.querySelector('[data-notice-tone="info"]');
    if (!notice) return false;
    const rect = notice.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })()`, { timeoutMs: 10_000, label: "security guidance in viewport" });
}

async function readGuidanceNotice(ctx) {
  return ctx.eval(`(() => {
    const notice = document.querySelector('[data-notice-tone]');
    return {
      text: notice?.textContent?.trim() ?? '',
      tone: notice?.getAttribute('data-notice-tone') ?? '',
      role: notice?.getAttribute('role') ?? '',
      className: notice?.getAttribute('class') ?? '',
      oldReauthTitleVisible: document.body.innerText.includes(${JSON.stringify(OLD_REAUTH_TITLE)}),
    };
  })()`);
}

export default {
  id: "calm-security-notice",
  title: "Routine security confirmation reads as calm guidance across workspace settings",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MYSQL_CONTAINER"],
  steps: [
    {
      name: "Members shows canceled reauth as calm guidance",
      run: async (ctx) => {
        await ctx.prove("Members presents routine identity confirmation as guidance instead of an error", {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            await signInToDenWeb(ctx);
            await stageStaleSessionAndInstallLinks(ctx);
            await navigateTo(ctx, "/dashboard/members");
            await grantClipboardPermissions(ctx);
            await ctx.waitFor(`(() => {
              const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
              return Boolean(button && !button.disabled && button.textContent.includes('Copy install link'));
            })()`, { timeoutMs: 45_000, label: "copy install link button" });
            await clickSelectorWithMouse(ctx, COPY_INSTALL_LINK_SELECTOR, "copy install link button");
            await cancelReauth(ctx);
          },
          assert: async () => {
            const actual = await readGuidanceNotice(ctx);
            recordAssertion(ctx, "The routine confirmation is an informational status", actual.text === GUIDANCE_MESSAGE && actual.tone === "info" && actual.role === "status", actual);
            recordAssertion(ctx, "The routine confirmation has no aggressive red treatment", !actual.className.includes("red-") && actual.oldReauthTitleVisible === false, actual);
          },
          screenshot: {
            name: "calm-security-members",
            requireText: ["Members", GUIDANCE_MESSAGE],
            rejectText: [OLD_REAUTH_TITLE],
          },
        });
      },
    },
    {
      name: "Org settings uses the same calm notice",
      run: async (ctx) => {
        await ctx.prove("Org settings uses the same reusable informational notice", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, "/dashboard/org-settings");
            await ctx.waitFor("document.body.innerText.includes('Org settings') && document.body.innerText.includes('Save settings')", {
              timeoutMs: 45_000,
              label: "organization settings",
            });
            await clickExactText(ctx, "Save settings", "button");
            await cancelReauth(ctx);
          },
          assert: async () => {
            const actual = await readGuidanceNotice(ctx);
            recordAssertion(ctx, "Org settings renders the same informational security guidance", actual.text === GUIDANCE_MESSAGE && actual.tone === "info" && actual.role === "status", actual);
            recordAssertion(ctx, "The settings notice remains free of red error styling", !actual.className.includes("red-"), actual);
          },
          screenshot: {
            name: "calm-security-org-settings",
            requireText: ["Org settings", GUIDANCE_MESSAGE],
            rejectText: [OLD_REAUTH_TITLE],
          },
        });
      },
    },
    {
      name: "A real authentication failure remains distinct",
      run: async (ctx) => {
        await ctx.prove("An invalid password remains a clearly marked error", {
          voiceover: vo[2],
          action: async () => {
            await clickExactText(ctx, "Save settings", "button");
            await ctx.waitFor("Boolean(document.querySelector('[role=\"dialog\"] input[autocomplete=\"current-password\"]'))", {
              timeoutMs: 30_000,
              label: "password reauth form",
            });
            await ctx.fill('[role="dialog"] input[autocomplete="current-password"]', "definitely-wrong-password");
            await clickExactText(ctx, "Verify password", "button");
            await ctx.waitFor(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              return Boolean(dialog?.querySelector('[data-notice-tone="error"][role="alert"]'));
            })()`, { timeoutMs: 30_000, label: "invalid password error" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const error = document.querySelector('[role="dialog"] [data-notice-tone="error"]');
              return {
                visible: Boolean(error),
                role: error?.getAttribute('role') ?? '',
                className: error?.getAttribute('class') ?? '',
                text: error?.textContent?.trim() ?? '',
              };
            })()`);
            recordAssertion(ctx, "The failed verification is exposed as an alert", actual.visible === true && actual.role === "alert" && actual.text.length > 0, actual);
            recordAssertion(ctx, "The real failure retains explicit red error styling", actual.className.includes("border-red-200") && actual.className.includes("bg-red-50") && actual.className.includes("text-red-700"), actual);
          },
          screenshot: {
            name: "calm-security-real-error",
            requireText: [GUIDANCE_MESSAGE],
          },
        });
      },
    },
  ],
};
