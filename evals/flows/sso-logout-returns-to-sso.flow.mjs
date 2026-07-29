import { defineScenario } from "../runner/scenario.mjs";
import { startMockIdpLab } from "../runner/labs/idp.mjs";
import { clearOrgSso, configureOrgSso, expectSsoScreenAfterLogout, signInViaSso } from "../runner/journeys/sso.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "sso-logout-returns-to-sso";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_TOKEN"];

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function subjectEmail(ctx) {
  const suffix = `${ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || Date.now()}-${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "run";
  return `sso.logout.${suffix}@acme.test`;
}

export default defineScenario({
  id: FLOW_ID,
  title: "Logging out of SSO returns to the SSO screen",
  kind: "user-facing",
  requiresApp: false,
  stage: { den: { orgMode: "single_org" } },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Logout goes back to SSO",
      run: async (ctx) => {
        let idp;
        try {
          idp = await startMockIdpLab({ domain: "acme.test" });
          const surface = await ctx.surfaces.chrome("sso-logout", { profile: "fresh" });
          const subject = { email: subjectEmail(ctx), name: "SSO Logout User" };
          await configureOrgSso(ctx, { idp });

          await ctx.on(surface, async () => {
            await ctx.prove("A mock OIDC SSO user reaches the Den dashboard", {
              voiceover: vo[0],
              action: async () => {
                await signInViaSso(ctx, { subject });
              },
              assert: async () => {
                await ctx.expectRoute("/dashboard", { timeoutMs: 60_000 });
              },
              screenshot: { name: "sso-user-dashboard", requireText: ["OpenWork"] },
            });
          });

          await ctx.on(surface, async () => {
            await ctx.prove("After logout, the next screen is the SSO screen rather than the legacy password page", {
              voiceover: vo[1],
              action: async () => {
                await expectSsoScreenAfterLogout(ctx, {});
              },
              assert: async () => {
                await ctx.expectText("Continue with SSO", { timeoutMs: 60_000 });
                await ctx.expectNoText("Forgot password?");
              },
              screenshot: { name: "logout-returns-to-sso", requireText: ["Continue with SSO"], rejectText: ["Forgot password?"] },
            });
          });
        } finally {
          await clearOrgSso(ctx).catch((error) => ctx.log(`SSO cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
          if (idp) await idp.stop();
        }
      },
    },
  ],
});
