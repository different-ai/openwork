import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export async function composerSlashAnywhere(seed: Seed) {
  const workspacePath = seed.tmpPath("slash-suggestions");
  const directory = join(workspacePath, ".opencode", "skills", "analytics-dashboard");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: analytics-dashboard\ndescription: Summarize key metrics.\n---\n\nPresent a dashboard of the supplied metrics.\n");
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Analytics workspace", admin: { name: "Workspace owner" } },
  });
  const { app } = await signedInAppWeb(seed, { den, webPort, workspacePath, name: "slash-suggestions", headless: true });
  return {
    app,
    enableSlashSuggestions: () => enableOrganizationCapabilities(seed, den.admin, { composerSlashAnywhere: true }),
  };
}
