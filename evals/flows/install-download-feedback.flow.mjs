import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denFetch } from "./desktop-brand-icon.flow.mjs";

const vo = await loadVoiceoverParagraphs("install-download-feedback");
const ORG_NAME = "Different AI";
const state = { installPageUrl: null };

async function openInstallPage(ctx) {
  const org = await denFetch(ctx, "/v1/org");
  const orgId = org.body?.organization?.id;
  ctx.assert(typeof orgId === "string", `Organization response was missing id: ${JSON.stringify(org.body).slice(0, 500)}`);
  await denFetch(ctx, "/v1/org", {
    method: "PATCH",
    body: JSON.stringify({ name: ORG_NAME }),
  });
  const minted = await denFetch(ctx, `/v1/orgs/${orgId}/install-links`, {
    method: "POST",
    body: JSON.stringify({ rotate: false }),
  });
  state.installPageUrl = minted.body?.installPageUrl ?? null;
  ctx.assert(typeof state.installPageUrl === "string", "Install-link response was missing installPageUrl.");
  await ctx.eval(`location.replace(${JSON.stringify(state.installPageUrl)})`).catch(() => undefined);
  await ctx.waitFor(`document.body.innerText.includes('Download OpenWork for ${ORG_NAME}')`, {
    timeoutMs: 45_000,
    label: "organization install page",
  });
}

export default {
  id: "install-download-feedback",
  title: "Installer downloads stay clear while the bundle is prepared",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await openInstallPage(ctx);
      },
    },
    {
      name: "Centered install card",
      run: async (ctx) => {
        await ctx.prove("The organization install page presents a centered, focused download card", {
          voiceover: vo[0],
          action: async () => {},
          assert: async () => {
            const geometry = await ctx.eval(`(() => {
              const card = document.querySelector('[data-testid="install-card"]')?.getBoundingClientRect();
              if (!card) return null;
              return { cardCenter: card.left + card.width / 2, viewportCenter: innerWidth / 2 };
            })()`);
            ctx.assert(geometry && Math.abs(geometry.cardCenter - geometry.viewportCenter) < 4, `Install card was not centered: ${JSON.stringify(geometry)}`);
          },
          screenshot: { name: "frame-1-centered-install-card", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: [`Download OpenWork for ${ORG_NAME}`] },
        });
      },
    },
    {
      name: "Focused installer choices",
      run: async (ctx) => {
        await ctx.prove("Redundant team and server metadata are absent from the install page", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`Array.from(document.querySelectorAll('a')).find((link) => link.textContent?.trim() === 'Windows')?.focus()`);
          },
          assert: async () => {
            const text = await ctx.eval("document.body.innerText");
            ctx.assert(!text.includes(`Team · ${ORG_NAME}`), "The redundant team footer is still visible.");
            const metaRows = await ctx.eval("document.querySelectorAll('.den-meta-row').length");
            ctx.assert(metaRows === 0, `Found ${metaRows} metadata rows.`);
          },
          screenshot: { name: "frame-2-focused-installer-choices", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: ["Mac (Apple silicon)", "Windows"], rejectText: [`Team · ${ORG_NAME}`] },
        });
      },
    },
    {
      name: "Preparing feedback",
      run: async (ctx) => {
        await ctx.prove("Choosing a platform immediately explains that the download is being prepared", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              const cancelDownload = (event) => event.preventDefault();
              document.addEventListener('click', cancelDownload, { capture: true, once: true });
              document.querySelector('[data-testid="install-download-primary"]')?.click();
            })()`);
            await ctx.waitFor("document.body.innerText.includes('Preparing your')", { timeoutMs: 1_000, label: "preparing download feedback" });
          },
          assert: async () => {
            const text = await ctx.eval("document.querySelector('[data-testid=install-download-status]')?.textContent ?? ''");
            ctx.assert(text.includes("The first download may take up to a minute"), `Preparation guidance was missing: ${text}`);
          },
          screenshot: { name: "frame-3-preparing-download", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: ["Preparing your", "The first download may take up to a minute"] },
        });
      },
    },
    {
      name: "Download started feedback",
      run: async (ctx) => {
        await ctx.prove("The page confirms the browser download request and offers a retry", {
          voiceover: vo[3],
          action: async () => {
            await ctx.waitFor("document.body.innerText.includes('Download started')", { timeoutMs: 5_000, label: "download started feedback" });
          },
          assert: async () => {
            const text = await ctx.eval("document.querySelector('[data-testid=install-download-status]')?.textContent ?? ''");
            ctx.assert(text.includes("Try again"), `Retry action was missing: ${text}`);
          },
          screenshot: { name: "frame-4-download-started", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: ["Download started", "Try again"] },
        });
      },
    },
  ],
};
