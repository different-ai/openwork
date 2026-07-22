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
  title: "Installer downloads hand progress off to the browser clearly",
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
      name: "Browser download feedback",
      run: async (ctx) => {
        await ctx.prove("Choosing a platform immediately confirms the request and points to browser progress", {
          voiceover: vo[0],
          action: async () => {
            await ctx.eval(`(() => {
              const cancelDownload = (event) => event.preventDefault();
              document.addEventListener('click', cancelDownload, { capture: true, once: true });
              document.querySelector('[data-testid="install-download-primary"]')?.click();
            })()`);
            await ctx.waitFor("document.body.innerText.includes('Download requested')", { timeoutMs: 1_000, label: "browser download feedback" });
          },
          assert: async () => {
            const text = await ctx.eval("document.querySelector('[data-testid=install-download-status]')?.textContent ?? ''");
            ctx.assert(text.includes("browser's Downloads menu"), `Browser download guidance was missing: ${text}`);
            ctx.assert(!text.includes("Preparing your"), `Synthetic preparation feedback is still visible: ${text}`);
            ctx.assert(text.includes("Try again"), `Retry action was missing: ${text}`);
            ctx.assert(!text.includes("Download started"), `The page still claims the browser download completed: ${text}`);
            const spinners = await ctx.eval("document.querySelectorAll('[data-testid=install-download-status] .animate-spin').length");
            ctx.assert(spinners === 0, `Found ${spinners} synthetic download spinners.`);
          },
          screenshot: { name: "browser-download-feedback", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: ["Download requested", "Check your browser's Downloads menu", "Try again"], rejectText: ["Download started", "Preparing your"] },
        });
      },
    },
  ],
};
