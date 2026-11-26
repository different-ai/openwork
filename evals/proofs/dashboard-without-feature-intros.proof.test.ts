import type { Seed } from "@openwork/env";
import { spec } from "@openwork/testkit";
import { expect } from "vitest";

const test = spec.world(async (seed: Seed) => {
  const den = await seed.den({ org: { name: "Connector Setup", admin: { name: "Alex Admin" } } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1440, height: 960 } });
  return { den, web };
}, { timeout: 600_000, needs: { commands: ["pnpm"] }, resources: { surfaces: ["web"], services: ["den"] } });

const addConnector = { role: "link", label: /^Add connector$/ } as const;
const aboutPage = { role: "button", label: /^About this page/ } as const;
const introSummary = "Let your team's AI read and act in the apps you already use.";

test("an organization owner can go straight from an empty Connectors page to connector setup", async ({ world, user, probe, step, evidence }) => {
  await step("after: Connectors opens on the organization's actual empty list", async () => {
    const { response, body } = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connections: [] });
    await user.see({ role: "heading", label: /^Connectors$/ }, { timeoutMs: 90_000 });
    try {
      await user.notSee({ text: introSummary });
      await user.notSee(aboutPage);
      await user.see({ text: /^No connectors yet$/ });
      await user.see(addConnector);
    } catch (error) {
      evidence.recordAssertionEvidence("A new organization sees the actual empty list instead of the intro", `Den returned zero connectors. ${String(error)}`, false);
      await user.screenshot();
      throw error;
    }
    const page = await probe.text();
    const emptyList = page.includes("No connectors yet") && !page.includes(introSummary);
    evidence.recordAssertionEvidence("A new organization sees the actual empty list instead of the intro", "Den returned zero connectors. The page showed No connectors yet and the Add connector link, with neither the introductory copy nor the About this page button.", emptyList);
    expect(emptyList).toBe(true);
    await user.screenshot();
  });

  await step("the owner opens the catalog from Add connector", async () => {
    await user.click(addConnector);
    await user.see({ role: "heading", label: /^Add a connector$/ }, { timeoutMs: 60_000 });
    await user.see({ testId: "connector-catalog" });
    await user.notSee(aboutPage);
    const catalogOpened = new URL(await probe.url()).pathname.endsWith("/dashboard/mcp-connections/new");
    evidence.recordAssertionEvidence("Add connector opens the real catalog", "The Add a connector catalog appeared without an About this page button.", catalogOpened);
    expect(catalogOpened).toBe(true);
    await user.screenshot();
  });

  await step("the owner can open the form for an MCP address", async () => {
    await user.click({ role: "button", label: /^Add another MCP$/ });
    await user.see({ role: "textbox", label: /^Address$/ });
    await user.see({ role: "button", label: /^Continue$/ });
    const customFormOpened = (await probe.dom('[data-testid="connector-picker-custom"] input[aria-label="Address"]')).elements.length === 1;
    evidence.recordAssertionEvidence("The catalog opens the custom connector form", "Add another MCP opened the Address field and Continue button; no connector was submitted.", customFormOpened);
    expect(customFormOpened).toBe(true);
    await user.screenshot();
  });
});
