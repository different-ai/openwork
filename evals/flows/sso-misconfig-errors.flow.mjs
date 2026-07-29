import { defineFlow } from "../runner/flow.ts";
import { normalizeMockIdpConfig } from "../runner/labs/idp.mjs";
import { expectSsoConfigError } from "../runner/journeys/sso.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "sso-misconfig-errors";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const idp = normalizeMockIdpConfig({ domain: "acme.test" });

export default defineFlow({
  id: FLOW_ID,
  title: "SSO misconfigurations produce named, actionable lab errors",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Trailing-newline certificate is named",
      run: async (ctx) => {
        await ctx.prove("A pasted SAML certificate with a trailing newline is reported as sso_cert_trailing_newline", {
          voiceover: vo[0],
          action: async () => {
            const match = await expectSsoConfigError(ctx, {
              idp,
              override: { certTrailingNewline: true },
              expect: { code: "sso_cert_trailing_newline", includes: ["trailing newline", "certificate"] },
            });
            ctx.output("trailing-newline verdict", JSON.stringify(match, null, 2));
          },
        });
      },
    },
    {
      name: "Wrong IdP email domain is named",
      run: async (ctx) => {
        await ctx.prove("An IdP subject from the wrong domain is reported as sso_domain_mismatch", {
          voiceover: vo[1],
          action: async () => {
            const match = await expectSsoConfigError(ctx, {
              idp,
              override: { wrongDomain: true },
              expect: { code: "sso_domain_mismatch", includes: ["wrong-acme.test", "acme.test"] },
            });
            ctx.output("wrong-domain verdict", JSON.stringify(match, null, 2));
          },
        });
      },
    },
  ],
});
