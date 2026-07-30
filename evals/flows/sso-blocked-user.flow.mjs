import { defineScenario } from "../runner/scenario.mjs";
import { startMockIdpLab } from "../runner/labs/idp.mjs";
import { clearOrgSso, configureOrgSso, expectSsoBlockedUserMessage } from "../runner/journeys/sso.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "sso-blocked-user";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_TOKEN"];
const BLOCKED_EMAIL = "blocked.sso@acme.test";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

export default defineScenario({
  id: FLOW_ID,
  title: "Mock IdP policy blocks show an actionable SSO message",
  kind: "user-facing",
  requiresApp: false,
  stage: { den: { orgMode: "single_org" } },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Blocked user sees IdP policy copy",
      run: async (ctx) => {
        let idp;
        try {
          idp = await startMockIdpLab({ domain: "acme.test", knobs: { blockedUser: BLOCKED_EMAIL } });
          const surface = await ctx.surfaces.chrome("sso-blocked-user", { profile: "fresh" });
          await configureOrgSso(ctx, { idp });
          await ctx.on(surface, async () => {
            await ctx.prove("When the mock IdP blocks an assigned user, the browser stops on a policy message instead of a dead end", {
              voiceover: vo[0],
              action: async () => {
                await expectSsoBlockedUserMessage(ctx, { subject: { email: BLOCKED_EMAIL, name: "Blocked User" } });
              },
              assert: async () => {
                await ctx.expectText("identity provider policy", { timeoutMs: 10_000 });
                await ctx.expectText("administrator has configured the application to block users", { timeoutMs: 10_000 });
              },
              screenshot: {
                name: "idp-policy-block",
                requireText: ["identity provider policy", "administrator has configured the application to block users"],
              },
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
