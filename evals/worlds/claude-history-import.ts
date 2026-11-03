import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Two Claude Code sessions saved for the workspace folder, shaped like Claude Code's own transcripts. */
const sessions = [
  {
    id: "7b1d2c3e-0000-4000-8000-000000000001",
    title: "Fix the checkout total rounding",
    started: "2026-10-20T09:00:00Z",
    question: "The checkout total is off by a cent. Find out why.",
    answer: "The total was rounded per line instead of once at the end. I changed it to round the sum.",
  },
  {
    id: "7b1d2c3e-0000-4000-8000-000000000002",
    title: "Write release notes for 2.4",
    started: "2026-10-21T15:30:00Z",
    question: "Draft release notes for version 2.4.",
    answer: "Here are the release notes for 2.4.",
  },
] as const;

function transcript(session: (typeof sessions)[number]): string {
  const answered = new Date(Date.parse(session.started) + 4_000).toISOString();
  const rows = [
    { type: "custom-title", customTitle: session.title, sessionId: session.id },
    { type: "user", uuid: `${session.id}-u`, sessionId: session.id, timestamp: session.started, message: { role: "user", content: session.question } },
    { type: "assistant", uuid: `${session.id}-r`, parentUuid: `${session.id}-u`, sessionId: session.id, timestamp: answered, message: {
      role: "assistant", model: "claude-sonnet-4-5",
      content: [
        { type: "tool_use", id: `${session.id}-tool`, name: "Read", input: { file_path: "src/checkout.ts" } },
      ],
    } },
    { type: "user", uuid: `${session.id}-t`, parentUuid: `${session.id}-r`, sessionId: session.id, timestamp: answered, message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: `${session.id}-tool`, content: "export const total = (lines) => lines.map(round).sum()" }],
    } },
    { type: "assistant", uuid: `${session.id}-a`, parentUuid: `${session.id}-t`, sessionId: session.id, timestamp: answered, message: {
      role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: session.answer }],
    } },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/**
 * A signed-in owner whose project folder has Claude Code history. Claude Code
 * keeps sessions under `<CLAUDE_CONFIG_DIR>/projects/<folder name>`; the world
 * points the OpenWork server at a private config folder, so nothing on the
 * test machine is read. Import is available without rollout configuration.
 */
export async function claudeHistoryImportWorld(seed: Seed) {
  const folder = seed.tmpPath("claude-history-project");
  await mkdir(folder, { recursive: true });
  const workspacePath = await realpath(folder);
  const claudeConfig = seed.tmpPath("claude-config");
  const projects = join(claudeConfig, "projects", workspacePath.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projects, { recursive: true });
  for (const session of sessions) await writeFile(join(projects, `${session.id}.jsonl`), transcript(session));

  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Northwind Studio", admin: { name: "Ola Owner" } } });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "claude-history-import", workspacePath, engine: "v2",
    env: { CLAUDE_CONFIG_DIR: claudeConfig },
  });
  return {
    app, den, workspace, sessions,
    settingsUrl: (tab: string) => `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/${tab}`,
  };
}
