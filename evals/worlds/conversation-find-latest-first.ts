import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SOURCE_ID = "97a1ac70-0000-4000-8000-000000000390";
const TITLE = "Review the orbital checkpoints";

/** Synthetic Claude Code-format history, imported through the product API; no model call. */
function transcript() {
  const rows: unknown[] = [{ type: "custom-title", customTitle: TITLE, sessionId: SOURCE_ID }];
  const started = Date.parse("2026-11-01T09:00:00Z");
  for (let index = 0; index < 9; index += 1) {
    const label = index === 0 ? "EARLIEST" : index === 8 ? "LATEST" : `MIDDLE ${index + 1}`;
    const userId = `checkpoint-${index}-question`;
    rows.push({ type: "user", uuid: userId, parentUuid: index === 0 ? null : `checkpoint-${index - 1}-answer`, sessionId: SOURCE_ID,
      timestamp: new Date(started + index * 2_000).toISOString(),
      message: { role: "user", content: `Review checkpoint ${index + 1}.` } });
    rows.push({ type: "assistant", uuid: `checkpoint-${index}-answer`, parentUuid: userId, sessionId: SOURCE_ID,
      timestamp: new Date(started + index * 2_000 + 1_000).toISOString(),
      message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text",
        text: `## ${label} checkpoint\n\nThe **orbital** record at checkpoint ${index + 1} is ready for review.\n\n`
          + Array.from({ length: 7 }, (_, note) => `Supporting note ${note + 1}: this synthetic conversation contains only sample review notes, with enough history to require scrolling between checkpoints.`).join("\n\n"),
      }] } });
  }
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

export async function conversationFindLatestFirstWorld(seed: Seed) {
  const folder = seed.tmpPath("find-checkpoints");
  await mkdir(folder, { recursive: true });
  const workspacePath = await realpath(folder);
  const claudeConfig = seed.tmpPath("claude-history");
  const projects = join(claudeConfig, "projects", workspacePath.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, `${SOURCE_ID}.jsonl`), transcript());

  const { den, webPort } = await denForAppWeb(seed, { org: {
    name: "Checkpoint review team", admin: { name: "Review Owner" }, members: { reader: { name: "Review Reader" } },
  }, env: { DEN_AUTOMATIONS_ENABLED: "false", DEN_AUTOMATIONS_RUNTIME_ENABLED: "false" } });
  const reader = den.members.reader;
  if (!reader) throw new Error("The review member was not provisioned.");
  const org = await seed.api(den.admin, "/v1/org");
  if (!org.response.ok || !isRecord(org.body) || !isRecord(org.body.organization)
    || typeof org.body.organization.id !== "string" || !Array.isArray(org.body.members)) throw new Error("Expected the review organization.");
  const organizationId = org.body.organization.id;
  const member = org.body.members.find(value => isRecord(value) && (value.email === reader.email
    || (isRecord(value.user) && value.user.email === reader.email)));
  if (!isRecord(member) || typeof member.id !== "string") throw new Error("Expected the reader membership.");
  const memberId = member.id;
  const baseline = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { conversationFindLatestFirst: false } }),
  });
  if (!baseline.response.ok) throw new Error("Could not establish the organization flag-off baseline.");

  const token = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "reader", name: "conversation-find-latest-first", workspacePath, engine: "v2",
    env: { CLAUDE_CONFIG_DIR: claudeConfig, OPENWORK_TOKEN: token },
  });
  // Arrangement only: call the same import endpoint as Settings, before the
  // first user action. The engine stores and renders the real imported history.
  const imported = await fetch(`${app.openworkUrl}/workspace/${workspace.workspaceId}/claude-import/code`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: [SOURCE_ID] }), signal: AbortSignal.timeout(120_000),
  });
  const result: unknown = await imported.json();
  if (!imported.ok || !isRecord(result) || !Array.isArray(result.results)) throw new Error("Could not import the checkpoint conversation.");
  const conversation = result.results[0];
  if (!isRecord(conversation) || conversation.status !== "imported" || typeof conversation.sessionId !== "string") throw new Error("The real engine did not confirm the imported conversation.");

  const admin = await seed.web({ den, signedInAs: den.admin, startPath: `/admin/organizations/${organizationId}`,
    headless: true, viewport: { width: 1280, height: 900 } });
  const state = async () => {
    const [selected, other] = await Promise.all([reader, den.admin].map(session => denFetch(session, "/v1/org", {
      headers: { authorization: `Bearer ${session.token}` },
    })));
    if (!selected?.response.ok || !other?.response.ok || !isRecord(selected.body) || !isRecord(selected.body.features)
      || !isRecord(other.body) || !isRecord(other.body.features)) throw new Error("Could not read the two members' effective features.");
    return { reader: selected.body.features.conversationFindLatestFirst, otherMember: other.body.features.conversationFindLatestFirst };
  };
  return { app, admin, memberId, state, title: TITLE, query: "orbital",
    conversationUrl: `${app.webUrl}/workspace/${workspace.workspaceId}/session/${conversation.sessionId}` };
}
