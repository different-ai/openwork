import { mkdir, realpath } from "node:fs/promises";
import { spec } from "@openwork/testkit";
import type { Seed } from "@openwork/env";

// A person who brings their own provider key cannot pick up a model released
// after the engine cached its catalog: the engine reads that cache on every
// spawn without revalidating it. The only recourse used to be editing
// opencode.jsonc by hand. This journey is the refresh that replaces that.
async function modelCatalogRefresh(seed: Seed) {
  const temporaryPath = seed.tmpPath("model-catalog-refresh");
  await mkdir(temporaryPath, { recursive: true });
  const workspacePath = await realpath(temporaryPath);
  const app = await seed.appWeb({ name: "model-catalog-refresh", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Model catalog refresh" });
  return { app, workspace, session };
}

const test = spec.world(modelCatalogRefresh, {
  // The journey needs no Den and no provider stand-in: the refresh is a local
  // action against the workspace's own engine.
  resources: { surfaces: ["appWeb"], services: [] },
});

test("a person refreshes the model catalog from AI Providers without editing a config file", async ({
  world,
  user,
  probe,
  step,
  evidence,
}) => {
  // The app in a browser routes by path; the desktop shell's hash routes do
  // not apply here.
  const settingsUrl = new URL(
    `/workspace/${world.workspace.workspaceId}/settings/ai`,
    world.app.webUrl,
  ).toString();

  await step("before: AI Providers offers the refresh and has not claimed a catalog update", async () => {
    await user.navigate(settingsUrl);
    await user.see({ text: "Providers" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Refresh models" });
    // The surface reports what is true rather than showing a standing label:
    // nothing has been refreshed in this session yet.
    await user.notSee({ text: "Catalog updated" });
    await user.screenshot();
  });

  const beforeText = await probe.text();
  evidence.recordAssertionEvidence(
    "The refresh lives on the AI Providers surface and claims nothing yet",
    `"Refresh models" present=${beforeText.includes("Refresh models")}; `
      + `"Catalog updated" present=${beforeText.includes("Catalog updated")}`,
    beforeText.includes("Refresh models") && !beforeText.includes("Catalog updated"),
  );

  await step("the person refreshes the model catalog with one action", async () => {
    await user.click({ role: "button", label: "Refresh models" });
    await user.screenshot();
  });

  await step("after: the surface reports that the catalog was updated", async () => {
    // The engine is dropped and replaced behind this, so allow a rollover.
    await user.see({ text: "Catalog updated" }, { timeoutMs: 120_000 });
    await user.see({ role: "button", label: "Refresh models" });
    await user.screenshot();
  });

  await user.looks([
    "An AI Providers settings page listing connected providers",
    "A 'Refresh models' control in the providers section header",
    "A short status next to it reporting that the catalog was updated",
  ]);
});
