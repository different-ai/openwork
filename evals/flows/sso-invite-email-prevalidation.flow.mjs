import { defineScenario } from "../runner/scenario.mjs";
import { startMockIdpLab } from "../runner/labs/idp.mjs";
import { denApiFetch, denWebUrl, extractInviteFromPayload } from "../runner/journeys/den.mjs";
import { clearOrgSso, configureOrgSso, expectInviteEmailPrevalidated } from "../runner/journeys/sso.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "sso-invite-email-prevalidation";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_TOKEN"];

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function runSuffix(ctx) {
  return `${ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || Date.now()}-${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "run";
}

function authHeaders(ctx) {
  const token = ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim();
  if (!token) throw new Error("OPENWORK_EVAL_DEN_TOKEN is required.");
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function createInvite(ctx, email) {
  const created = await denApiFetch(ctx, "/v1/invitations", {
    method: "POST",
    headers: authHeaders(ctx),
    body: JSON.stringify({ email, role: "member" }),
  });
  if (!created.response.ok) {
    throw new Error(`Could not create SSO invite for ${email}: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  return { ...extractInviteFromPayload(created.body, denWebUrl(ctx)), email };
}

async function navigate(ctx, url) {
  const targetUrl = new URL(url).toString();
  await ctx.client.send("Page.navigate", { url: targetUrl });
  await ctx.waitFor(`location.href === ${JSON.stringify(targetUrl)}`, { timeoutMs: 15_000, label: "invite URL committed" });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: "invite page loaded" });
}

export default defineScenario({
  id: FLOW_ID,
  title: "SSO invite acceptance rejects subjects whose email differs from the invite",
  kind: "user-facing",
  requiresApp: false,
  stage: { den: { orgMode: "single_org" } },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Invite email is prevalidated against the SSO subject",
      run: async (ctx) => {
        const suffix = runSuffix(ctx);
        const invitedEmail = `sso.invited.${suffix}@acme.test`;
        const actualEmail = `sso.actual.${suffix}@acme.test`;
        let idp;
        try {
          idp = await startMockIdpLab({ domain: "acme.test", knobs: { emailMismatch: actualEmail } });
          await configureOrgSso(ctx, { idp });
          const invite = await createInvite(ctx, invitedEmail);
          const surface = await ctx.surfaces.chrome("sso-invite-mismatch", { profile: "fresh" });
          await ctx.on(surface, async () => {
            await ctx.prove("The invite screen locks the expected invited email before SSO begins", {
              voiceover: vo[0],
              action: async () => {
                await navigate(ctx, invite.inviteUrl);
              },
              assert: async () => {
                await ctx.expectText("INVITED EMAIL", { timeoutMs: 60_000 });
                await ctx.expectText(invitedEmail, { timeoutMs: 60_000 });
                await ctx.expectText("Join Acme Robotics", { timeoutMs: 60_000 });
              },
              screenshot: { name: "invite-email-locked", requireText: ["INVITED EMAIL", invitedEmail] },
            });
          });

          await ctx.on(surface, async () => {
            await ctx.prove("If the IdP returns a different email, OpenWork rejects the invite coherently and does not loop", {
              voiceover: vo[1],
              action: async () => {
                await expectInviteEmailPrevalidated(ctx, {
                  invite,
                  subject: { email: actualEmail, name: "Actual SSO User" },
                });
              },
              screenshot: {
                name: "invite-email-mismatch-rejected",
                requireText: [invitedEmail],
                rejectText: ["Dashboard"],
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
