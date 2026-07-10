import { execFileSync } from "node:child_process";
import baseFlow, { orgAwareDashboardDownloadsHarness as harness } from "./org-aware-dashboard-downloads.flow.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "on-prem-install-links-default";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function withApprovedProof(ctx, index, claim) {
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "prove") {
        return (_baseClaim, options) => target.prove(claim, { ...options, voiceover: vo[index] });
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function clickText(ctx, text) {
  const clicked = await ctx.eval(`(() => {
    const element = [...document.querySelectorAll('button, a')]
      .find((candidate) => candidate.textContent?.trim().startsWith(${JSON.stringify(text)}));
    element?.click();
    return Boolean(element);
  })()`);
  ctx.assert(clicked === true, `Could not click ${text}.`);
}

export default {
  id: FLOW_ID,
  title: "Self-deployed organizations get workspace downloads by default while hosted controls stay explicit",
  kind: "user-facing",
  requiredEnv: baseFlow.requiredEnv,
  steps: [
    {
      name: "Frame 1",
      run: (ctx) => baseFlow.steps[0].run(withApprovedProof(
        ctx,
        0,
        "A fresh single-org deployment shows the organization download without a stored capability opt-in",
      )),
    },
    {
      name: "Frame 2",
      run: (ctx) => baseFlow.steps[1].run(withApprovedProof(
        ctx,
        1,
        "The default download opens the organization's configured install page and still requires sign-in",
      )),
    },
    {
      name: "Frame 3",
      run: (ctx) => baseFlow.steps[2].run(withApprovedProof(
        ctx,
        2,
        "An ordinary member gets the download while privileged link rotation remains forbidden",
      )),
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Hosted multi-org capability controls remain off until explicitly enabled", {
          voiceover: vo[3],
          action: async () => {
            await harness.uiSignIn(ctx, harness.ADMIN_EMAIL, harness.ADMIN_PASSWORD);
            await harness.navigateTo(ctx, `${harness.DEN_WEB_URL}/admin`);
            await ctx.waitForText("User backoffice", { timeoutMs: 30_000 });
            await clickText(ctx, "Organizations");
            await ctx.waitForText("Install links", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const raw = await harness.denApiFetch(
              `/v1/admin/organizations/${harness.state.organizationId}/capabilities`,
              { headers: harness.authHeaders(harness.state.adminToken) },
            );
            ctx.assert(raw.response.ok, `Could not read stored capabilities (${raw.response.status}).`);
            ctx.assert(raw.body?.capabilities?.installLinks === false, "Hosted-facing stored capability unexpectedly defaulted on.");

            const checkbox = await ctx.eval(`(() => {
              const row = [...document.querySelectorAll('[data-testid^="admin-org-row-"]')]
                .find((candidate) => candidate.textContent?.includes(${JSON.stringify(harness.ORGANIZATION_NAME)}));
              return row?.querySelector('[data-testid="admin-capability-installLinks"]')?.checked;
            })()`);
            ctx.assert(checkbox === false, "The platform-admin install-links control was not visibly off.");

            const testOutput = execFileSync("pnpm", [
              "exec",
              "bun",
              "test",
              "ee/apps/den-api/test/organization-capabilities.test.ts",
              "--test-name-pattern",
              "supports an on-prem default without changing the hosted default",
            ], { encoding: "utf8" });
            ctx.output("hosted-capability-regression", testOutput);
            await ctx.expectText("Install links");
          },
          screenshot: {
            name: "hosted-install-links-control-off",
            requireText: ["User backoffice", harness.ORGANIZATION_NAME, "Install links"],
          },
        });
      },
    },
  ],
};
