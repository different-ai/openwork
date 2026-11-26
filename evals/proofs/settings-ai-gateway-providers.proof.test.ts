import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import type { Seed } from "@openwork/env";
import { gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { denForAppWeb, signedInAppWeb } from "../worlds/signed-in-app-web.ts";

async function acmeMember(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const { den, webPort } = await denForAppWeb(seed, {
      web: false, env, org: { name: "Acme", members: { member: { name: "Acme Member" } } },
    });
    stack.use(den);
    if (!den.database) throw new Error("This proof needs a disposable Den database.");
    await startAcmeGateway(stack, den.database.url, { ...gateway, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const hostToken = crypto.randomUUID();
    const { app, workspace } = await signedInAppWeb(seed, {
      den, webPort, as: "member", engine: "v2", name: "settings-ai-gateway-providers",
      workspacePath: seed.tmpPath("Acme workspace"),
      env: { OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken },
    });
    return {
      app, provider,
      settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

const test = spec.world(acmeMember, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

const organization = 'section[aria-labelledby="ai-providers-organization"]';
const providerRows = `${organization} [data-provider-scope="organization"]`;
const anthropicMark = `${providerRows} svg[role="img"] path[d^="M17.304 3.541"]`;

test("an Acme member can see which AI Gateway models are ready in Settings", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("when the member opens AI Providers in Settings", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ text: "From Acme" }, { timeoutMs: 30_000 });
    const sections = (await probe.dom(`${organization} h2`)).elements;
    const opened = sections.some(section => section.text.trim() === "From Acme");
    evidence.recordAssertionEvidence("Acme's provider section opens", `Organization heading: ${sections[0]?.text ?? "not visible"}.`, opened);
    expect(opened).toBe(true);
  });

  const providerRow = async () => (await probe.dom(providerRows)).elements.find(row => row.text.includes("Acme AI Gateway"));
  await step("after: Acme's AI Gateway provider shows its brand and one ready model", async () => {
    await user.see({ text: "Acme AI Gateway" }, { timeoutMs: 30_000 });
    const row = await providerRow();
    const text = row?.text.replace(/\s+/g, " ").trim() ?? "Provider row not found";
    const branded = (await probe.dom(anthropicMark)).elements.length === 1;
    const ready = ["Ready to use", world.provider.modelName, "1 model"].every(label => text.includes(label));
    const noRawId = !/\bipr_/i.test(text);
    evidence.recordAssertionEvidence("The provider shows a readable name, one ready model and the Anthropic mark", `Model: ${world.provider.modelName}; ready with 1 model: ${ready}; Anthropic mark: ${branded}; no raw provider ID: ${noRawId}.`, ready && branded && noRawId);
    await user.screenshot();
    expect(text).toContain(world.provider.modelName);
    expect(ready && branded && noRawId).toBe(true);
  });

  await step("after: Sync now keeps the provider verified and ready", async () => {
    await user.click({ role: "button", label: "Sync now" });
    await user.see({ role: "button", label: "Sync now" }, { timeoutMs: 30_000 });
    await user.see({ text: "Synced with Den" }, { timeoutMs: 30_000 });
    const row = await providerRow();
    const ready = Boolean(row?.text.includes("Ready to use") && row.text.includes("1 model"));
    evidence.recordAssertionEvidence("The provider is ready after refresh", `Synced with Den; Acme AI Gateway still shows Ready to use and 1 model: ${ready}.`, ready);
    await user.screenshot();
    expect(ready).toBe(true);
  });
});
