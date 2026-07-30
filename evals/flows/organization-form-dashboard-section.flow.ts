import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import { denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "organization-form-dashboard-section";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ORGANIZATION_NAME = "Acme Robotics";

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

const ORGANIZATION_SECTION = `(() => {
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .filter((entry) => /organization/i.test(entry.textContent || ""));
  return headings.some((heading) => {
    const section = heading.closest("section");
    return Boolean(section && section.querySelector("form") && section.querySelector('input[type="text"]'));
  });
})()`;

export default defineFlow({
  id: FLOW_ID,
  title: "Organization settings render as one dedicated responsive section",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Organization form keeps its section boundary and behavior",
      run: async (ctx) => {
        await ctx.prove("The Organization form is independently headed, responsive, and still saves through its existing workflow", {
          voiceover: vo[0],
          action: async () => {
            await setViewport(ctx, 1440);
            await signInViaBrowser(ctx, EMAIL, PASSWORD, ORGANIZATION_NAME);
            await navigate(ctx, "/dashboard/org-settings");
            await ctx.expectText("Organization", { timeoutMs: 30_000 });
            await ctx.waitFor(ORGANIZATION_SECTION, { timeoutMs: 15_000, label: "dedicated Organization section" });

            const name = await ctx.eval(`(() => {
              const label = [...document.querySelectorAll("label")].find((entry) =>
                (entry.textContent || "").trim().startsWith("Name"));
              const input = label?.querySelector('input[type="text"]');
              return input instanceof HTMLInputElement ? input.value : "";
            })()`);
            ctx.assert(typeof name === "string" && name.length >= 2, "Expected the existing organization name.");
            await ctx.fill('label input[type="text"]', String(name));
            await ctx.clickText("Save settings", { selector: "button" });
            await ctx.expectText("Workspace settings updated.", { timeoutMs: 30_000 });

            await setViewport(ctx, 390);
            await ctx.waitFor(ORGANIZATION_SECTION, { timeoutMs: 10_000, label: "Organization section at narrow width" });
          },
          assert: async () => {
            const metrics = await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll("h1,h2,h3")]
                .find((entry) => /organization/i.test(entry.textContent || "") && entry.closest("section")?.querySelector("form"));
              const section = heading?.closest("section");
              const form = section?.querySelector("form");
              if (!section || !form) return null;
              const sectionRect = section.getBoundingClientRect();
              const formRect = form.getBoundingClientRect();
              return {
                sectionWidth: sectionRect.width,
                formWidth: formRect.width,
                overflow: Math.max(0, formRect.right - sectionRect.right),
                heading: heading?.textContent?.trim(),
              };
            })()`);
            ctx.assert(Boolean(metrics), "Expected measurable Organization section and form.");
            const measured = metrics as { sectionWidth: number; formWidth: number; overflow: number };
            ctx.assert(measured.sectionWidth > 0 && measured.formWidth > 0, "Organization section must remain visible.");
            ctx.assert(measured.overflow <= 1, `Organization form overflowed its narrow section by ${measured.overflow}px.`);
          },
          screenshot: {
            name: "organization-section-narrow",
            requireText: ["Organization", "Save settings"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
