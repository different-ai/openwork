import { org } from "../seed.ts";
import { denWeb } from "../surfaces.ts";
import { fillForm } from "../steps.ts";
import { shot } from "./shot.ts";

const browser = denWeb({ org, as: "admin" });

export const denPluginDetail = shot("den-plugin-detail", {
  use: browser,
  at: (surface) => `/dashboard/plugins/${surface.organization.pluginIds[0]}`,
  expect: ["Customer Research", "Add skill"],
  out: "packages/docs/images/cloud-plugin-add-skill.png",
});

export const denSkillEditor = shot("den-skill-editor", {
  use: browser,
  at: (surface) => `/dashboard/plugins/${surface.organization.pluginIds[0]}/skills/new`,
  steps: [fillForm({
    'input[placeholder="e.g. customer-research"]': "call-brief",
    'input[placeholder="When should an agent use this skill?"]': "Prepare a one-page brief before a customer call.",
    'textarea[placeholder^="# Instructions"]': "# Instructions\n\n1. Pull the account's recent activity.\n2. Summarize the goal of the call in two sentences.\n3. List the three questions to ask.",
  })],
  expect: ["Name", "Description", "Skill body", "Create skill"],
  viewport: { width: 1440, height: 1160, deviceScaleFactor: 2 },
  out: "packages/docs/images/cloud-skill-editor.png",
});

export const denOpenworkWeb = shot("den-openwork-web", {
  use: browser,
  at: "/dashboard/web",
  expect: ["OpenWork Web", "Open OpenWork Web"],
  out: "packages/docs/images/cloud-openwork-web.png",
});
