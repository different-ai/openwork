import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootAcmeWeb } from "./acme-web.ts";
import { assertAcmeConnections } from "./lib/acme-runtime.ts";
import { record } from "./lib/acme-gateway.ts";
import { connectDemoServer, startDemoScript } from "./lib/demo-workspace.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { workshopModelProfile, takeWorkshopCredential, seedWorkshopInference, probeWorkshopInference } from "./lib/workshop-inference.ts";
import { allocateFreePort } from "../evals/packages/cdp/src/index.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";

export const summary = "A fictional enterprise workday: real model, Jira, Confluence, Outlook and OneDrive with browser views and mutable demo data.";
export const supportedTargets = ["local/host"];

export interface WorkshopHooks {
  /** Owned fixture additions run after inference seeding, before any engine starts. */
  beforeRuntime?: (den: Den, baseline: { orgId: string; providerId: string; modelId: string }) => Promise<void>;
}

export async function main(argv = process.argv.slice(2), hooks: WorkshopHooks = {}): Promise<void> {
  if (process.env.OPENWORK_WORLD_PLACE && process.env.OPENWORK_WORLD_PLACE !== "local") throw new Error("enterprise-workshop currently supports local only. Paid keys are never baked into remote snapshots.");
  const profile = workshopModelProfile(argv);
  const key = takeWorkshopCredential(profile);
  if (argv.includes("--probe-inference") && profile.name !== "gpt-sol-fast") throw new Error("--probe-inference is supported only for gpt-sol-fast; no Qwen inference is performed during startup.");
  await using stack = new AsyncDisposableStack();
  const uiPort = await allocateFreePort();
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  let paid: { providerId: string; modelId: string; variant?: string } | undefined;
  const world = await bootAcmeWeb(stack, undefined, undefined, {
    atlassian: true, atlassianBrowserUrl: uiOrigin,
    async beforeRuntime(den, baseline) {
      paid = await seedWorkshopInference(den, baseline, profile, key);
      await hooks.beforeRuntime?.(den, baseline);
    },
  });
  if (!paid) throw new Error("Workshop model was not seeded before the runtime started.");
  const inferenceWitness = argv.includes("--probe-inference")
    ? await probeWorkshopInference(world.den, world.model.orgId, world.gatewayUrl, paid, profile)
    : undefined;
  if (!world.atlassian) throw new Error("Workshop Atlassian server was not started.");
  const microsoft = await startDemoScript(stack, world.den, {
    url: new URL("../evals/packages/labs/src/demo-microsoft365.mjs", import.meta.url), label: "demo-microsoft365", daytonaPort: 3988,
  });
  await connectDemoServer(world.den, "microsoft365", "Microsoft 365 (Outlook & OneDrive demo)", `${microsoft.baseUrl}/mcp`);
  await assertAcmeConnections(world.den, [world.demo.baseUrl, world.atlassian.baseUrl, microsoft.baseUrl]);
  const serviceUi = await startDemoScript(stack, world.den, {
    url: new URL("../evals/packages/labs/src/demo-workplace-ui.mjs", import.meta.url), label: "demo-workplace-ui", daytonaPort: 3987, localPort: uiPort,
  }, { ATLASSIAN_BASE_URL: world.atlassian.baseUrl });

  const manifest = world.web.manifest;

  // This is a fixture, not a customer brief. Everything stays in the world's scratch workspace.
  const brief = `# Acme Robotics workday\n\nYou are Alex Chen. This is a fictional workshop; all services are demo data.\n\nUse the connected Atlassian and Microsoft 365 tools to do work, never fabricate their results. Capability discovery finds tool metadata, not document contents. Confluence search returns excerpts: use confluence_get_page with the discovered page IDs for complete source pages. Outlook uses mail_search, mail_read and mail_create_reply_draft; OneDrive uses file_find, file_read and file_write. Discover their exact capability names and schemas before calling them. Never use a literal-return script as evidence of a service read.\n\n- Jira projects: FLEET, DOC and ITSD (IT service desk). Nora Patel owns documentation.\n- Confluence spaces: HB (handbook), PROD (datasheets), SALES (account plans), ENG.\n- Products: Atlas 2 and Atlas Lift. Customers: Northwind Logistics and Blue Harbor Foods.\n- Use Outlook and OneDrive for mail and documents. Emails never leave the demo.\n- Save generated files in this workspace. Open and validate Office files, not just their extensions.\n- Ask before sending mail, assigning tickets or publishing updates unless the user has explicitly requested that action.\n- If a policy cannot be found, say so. Do not invent internal rules.\n\n## Start here\nFind the latest customer request in Outlook, read the relevant Confluence product pages, and draft a customer-ready comparison of Atlas 2 and Atlas Lift. Save it as a document and draft a reply with the link. Do not send yet.\n`;
  const workspace = await fetch(`${manifest.openworkUrl}/workspaces`, { headers: { authorization: `Bearer ${manifest.token}` } }).then((response) => response.json());
  const item = record(workspace) && Array.isArray(workspace.items) ? workspace.items.find(record) : undefined;
  if (!item || typeof item.path !== "string" || typeof item.id !== "string") throw new Error("Workshop workspace missing.");
  await writeFile(join(item.path, "WORKSHOP.md"), brief);
  const defaultModel = await fetch(`${manifest.openworkUrl}/workspace/${item.id}/default-model`, {
    method: "PUT", headers: { authorization: `Bearer ${manifest.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: paid.providerId, modelID: paid.modelId, ...(paid.variant ? { variant: paid.variant } : {}) } }),
  });
  if (!defaultModel.ok) throw new Error(`Workshop default model setup failed: HTTP ${defaultModel.status}`);

  await hold({ name: "enterprise-workshop", outputs: {
    webUrl: output(manifest.webUrl, { group: "Workday" }),
    jira: output(`${serviceUi.baseUrl}/jira`, { group: "Workday" }),
    confluence: output(`${serviceUi.baseUrl}/confluence`, { group: "Workday" }),
    outlook: output(`${microsoft.baseUrl}/outlook`, { group: "Workday" }),
    oneDrive: output(`${microsoft.baseUrl}/onedrive`, { group: "Workday" }),
    denWeb: output(world.den.ref.webUrl, { group: "Accounts" }),
    denApi: output(world.den.ref.apiUrl, { group: "Technical" }),
    model: output(profile.model, { group: "Model", note: "Live paid inference; synthetic service data only" }),
    modelProfile: output(profile.name, { group: "Model" }),
    modelVariant: output(paid.variant ?? "default", { group: "Model", note: "Fast is priority service tier, not reduced reasoning" }),
    inferenceRoute: output(`${profile.upstream}${profile.route}`, { group: "Model", note: "Configured upstream protocol; not per-turn evidence" }),
    ...(inferenceWitness ? { inferenceWitness: output(JSON.stringify(inferenceWitness), { group: "Model", note: "Bounded explicit gateway probe, not narrative/engine proof" }) } : {}),
    modelId: output(paid.modelId, { group: "Model" }),
    providerId: output(paid.providerId, { group: "Model" }),
    workspaceId: output(item.id, { group: "Model" }),
    email: output(world.den.admin.email, { group: "Accounts" }),
    password: secret(world.den.admin.password, { group: "Accounts" }),
    openworkUrl: output(manifest.openworkUrl, { group: "Technical" }),
    openworkToken: secret(manifest.token, { group: "Technical" }),
    atlassianState: output(`${world.atlassian.baseUrl}/state`, { group: "Technical" }),
    microsoftState: output(`${microsoft.baseUrl}/state`, { group: "Technical" }),
    note: output("Fictional workspace. Demo sends and writes never reach real customers. Separate world per attendee for isolated changes.", { group: "Workday" }),
  } });
}
if (import.meta.main) await main();
