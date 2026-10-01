import type { Seed } from "@openwork/env";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Two descriptions are far wider than the composer, so a row has to end in an
// ellipsis instead of pushing the whole list sideways.
const skills = [
  {
    name: "customize-workspace",
    description: "Use only when the person is editing or creating this workspace's own agent configuration: its providers, permissions, agents, commands and connected tools, never for ordinary project files or documents.",
  },
  {
    name: "become-the-greatest-in-the-world",
    description: "Engineering marketplace skill that reviews a plan end to end, names the riskiest assumption, proposes the smallest experiment that would disprove it, and writes the follow-up checklist for the team.",
  },
  { name: "customer-briefing", description: "Prepare a short account briefing." },
  { name: "deal-summary", description: "Summarize open deals." },
  { name: "standup-digest", description: "Digest standup threads." },
  { name: "release-notes", description: "Draft release notes from merged work." },
  { name: "meeting-prep", description: "Collect context before a meeting." },
  { name: "inbox-triage", description: "Sort the inbox by what needs a reply." },
] as const;

/**
 * The real app (headless Chrome) on a workspace with eight skills, enough to
 * fill the `/` command list. The spec opens a new chat, where the composer sits
 * mid-screen under the greeting and the list has the least room above it.
 */
export async function slashMenuWeb(seed: Seed) {
  const workspacePath = seed.tmpPath("composer-slash-menu");
  for (const skill of skills) {
    const directory = join(workspacePath, ".opencode", "skills", skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nFollow the ${skill.name} steps.\n`);
  }
  const app = await seed.appWeb({ name: "composer-slash-menu", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Earlier conversation" });
  return { app, workspace, session, skills };
}
