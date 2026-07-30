import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import { denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "desktop-policies-dashboard-section";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

async function setViewport(ctx: FlowContext, width: number): Promise<void> {
  ctx.assert(Boolean(ctx.client), "A browser CDP client is required.");
  await ctx.client?.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });
}

async function navigate(ctx: FlowContext, path: string): Promise<void> {
  const url = new URL(path, denWebUrl()).toString();
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: path });
}

const POLICIES_SECTION = `(() => {
  const heading = [...document.querySelectorAll("h1,h2,h3")]
    .find((entry) => /desktop policies/i.test(entry.textContent || ""));
  const section = heading?.closest("section");
  if (!section) return false;
  return Boolean(
    section.querySelector("table") ||
    /loading desktop policies|no desktop policies/i.test(section.textContent || "")
  );
})()`;

export default defineFlow({
  id: FLOW_ID,
  title: "Desktop Policies render as one independent responsive dashboard section",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Desktop Policies keep an independent responsive boundary",
      run: async (ctx) => {
        await ctx.prove("Desktop Policies remain clearly bounded across loaded, empty, and narrow layouts", {
          voiceover: vo[0],
          action: async () => {
            await setViewport(ctx, 1440);
            await signInViaBrowser(ctx, EMAIL, PASSWORD);
            await navigate(ctx, "/dashboard/desktop-policies");
            await ctx.expectText("Desktop policies", { timeoutMs: 30_000 });
            await ctx.waitFor(POLICIES_SECTION, { timeoutMs: 20_000, label: "dedicated Desktop Policies section" });
            await setViewport(ctx, 390);
            await ctx.waitFor(POLICIES_SECTION, { timeoutMs: 10_000, label: "Desktop Policies section at narrow width" });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll("h1,h2,h3")]
                .find((entry) => /desktop policies/i.test(entry.textContent || ""));
              const section = heading?.closest("section");
              if (!section) return null;
              const rect = section.getBoundingClientRect();
              const table = section.querySelector("table");
              const scroller = table?.closest(".overflow-x-auto");
              return {
                width: rect.width,
                headingCount: [...section.querySelectorAll("h1,h2,h3")]
                  .filter((entry) => /desktop policies/i.test(entry.textContent || "")).length,
                hasState: Boolean(table) || /loading desktop policies|no desktop policies/i.test(section.textContent || ""),
                tableContained: !table || Boolean(scroller),
              };
            })()`);
            ctx.assert(Boolean(state), "Expected a measurable Desktop Policies section.");
            const measured = state as { width: number; headingCount: number; hasState: boolean; tableContained: boolean };
            ctx.assert(measured.width > 0, "Desktop Policies section must remain visible.");
            ctx.assert(measured.headingCount === 1, `Expected one Desktop Policies heading, found ${measured.headingCount}.`);
            ctx.assert(measured.hasState, "Expected the policy table, loading state, or empty state inside the section.");
            ctx.assert(measured.tableContained, "The policy table must keep its narrow-width overflow container.");
          },
          screenshot: {
            name: "desktop-policies-section-narrow",
            requireText: ["Desktop policies"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
