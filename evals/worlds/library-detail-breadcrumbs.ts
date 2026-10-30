import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { isRecord, stringField } from "./library.ts";

export async function libraryDetailBreadcrumbs(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Navigation Studio", admin: { name: "Library Owner" } },
  });
  const workspacePath = seed.tmpPath("library-breadcrumbs");
  const skillPath = join(workspacePath, ".opencode", "skills", "review-notes");
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: review-notes\ndescription: Turn supplied notes into a focused review.\n---\n\n# Review notes\n\nList the decisions and unresolved questions.\n");
  const created = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: "Review toolkit", components: [
      { type: "skill", input: { rawSourceText: "---\nname: plan-a-review\ndescription: Plan a focused review.\n---\n\nList unresolved questions and assign an owner." } },
      { type: "skill", input: { rawSourceText: "---\nname: capture-decisions\ndescription: Keep the outcome of a review.\n---\n\nRecord decisions and due dates." } },
    ] }),
  });
  const pluginId = stringField(isRecord(created.body) ? created.body.item : null, "id");
  if (!created.response.ok || !pluginId) throw new Error(`Could not create fixture plugin: ${created.text}`);
  const { app, workspace } = await signedInAppWeb(seed, {
    name: "library-detail-breadcrumbs", den, webPort, workspacePath,
  });
  return { app, workspace, pluginId };
}
