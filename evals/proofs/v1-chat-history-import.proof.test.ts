import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v1ChatHistory, type V1FixtureChat } from "../worlds/v1-chat-history.ts";

const IMPORT_WITHIN_MS = 300_000;

const test = spec.world(v1ChatHistory, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "The earlier chats are a v1 database file on this computer that only the desktop's local server reads and copies into its OpenCode v2 engine.",
  },
});

// The offer's wording belongs to the app; match its meaning, not one exact sentence.
const OFFER = /Upgrade your earlier chats to continue/i;
const ACCEPT = /^(Bring (them |chats )?over|Import( chats| earlier chats| them)?|Upgrade)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrationOf(status: Record<string, unknown>) {
  const migration = isRecord(status.migration) ? status.migration : {};
  return {
    state: migration.state,
    imported: typeof migration.imported === "number" ? migration.imported : -1,
    skipped: typeof migration.skipped === "number" ? migration.skipped : -1,
    total: typeof migration.total === "number" ? migration.total : -1,
    error: typeof migration.error === "string" ? migration.error : null,
  };
}

test("a person with chats from OpenCode v1 brings them into OpenWork once and reads them again", async ({ world, user, probe, step, evidence }) => {
  const workspaceId = world.workspace.workspaceId;
  const first = world.chats[0]!;
  const fixtureIds = world.chats.map(chat => chat.id).sort();
  const status = async () => {
    const response = await probe.desktopApi("/engine/status");
    expect(response.status).toBe(200);
    if (!isRecord(response.body)) throw new Error("Engine status missing");
    return response.body;
  };
  const v2SessionIds = async () => {
    const response = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(response.status).toBe(200);
    const items = isRecord(response.body) ? response.body.data : response.body;
    return (Array.isArray(items) ? items : []).filter(isRecord).map(item => String(item.id)).sort();
  };
  const v2ShowsReply = async (chat: V1FixtureChat) => {
    const response = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session/${chat.id}/message`);
    return response.status === 200 && JSON.stringify(response.body).includes(chat.reply);
  };

  await step("before: OpenWork offers to bring over earlier chats that are not listed yet", async () => {
    const before = await probe.eventually(status, {
      within: 60_000, label: "the local server finds the earlier chat history",
      until: value => value.v1HistoryAvailable === true,
    });
    await user.see({ text: OFFER }, { timeoutMs: 60_000 });
    await user.see({ role: "button", text: ACCEPT });
    await user.notSee({ testId: `sidebar-session-${first.id}` });
    await user.press("Escape");
    await user.see({ testId: "chat-import-notice" });
    await user.notSee({ role: "button", text: /later|skip/i });
    const blocked = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(blocked.status).toBe(503);
    expect(blocked.body).toMatchObject({ error: "history_migration_required" });
    const migration = migrationOf(before);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "the offer appears while none of the earlier chats are in OpenWork yet",
      `v1HistoryAvailable ${String(before.v1HistoryAvailable)}; import ${String(migration.state)}; chat API blocked until migration; "${first.title}" not in the sidebar`,
      migration.state === "idle" && blocked.status === 503,
    );
    expect(migration.state).toBe("idle");
  });

  await step("the person accepts the offer and every earlier chat is copied once", async () => {
    await user.click({ role: "button", text: ACCEPT });
    await user.see({ testId: "chat-import-consent" });
    await user.screenshot();
    await user.click({ testId: "chat-import-confirm" });
    const done = await probe.eventually(status, {
      within: IMPORT_WITHIN_MS, intervalMs: 1_000, label: "the import finished",
      until: value => migrationOf(value).state === "completed" || migrationOf(value).state === "error",
    });
    const migration = migrationOf(done);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "each earlier chat, sub-chat included, is imported once",
      `${String(migration.state)}${migration.error ? `: ${migration.error}` : ""}; imported ${migration.imported} of ${migration.total}, skipped ${migration.skipped}`,
      migration.state === "completed" && migration.imported === world.expectedChats && migration.skipped === 0,
    );
    expect(migration).toMatchObject({ state: "completed", imported: world.expectedChats, skipped: 0, total: world.expectedChats });
  });

  await step("after: the earlier chats are listed and open with their messages", async () => {
    await user.click({ role: "button", text: /^(Done|Close)$/i });
    await user.see({ testId: `sidebar-session-${first.id}` }, { timeoutMs: 60_000 });
    await user.click({ testId: `sidebar-session-${first.id}` });
    await user.see({ text: first.reply }, { timeoutMs: 60_000 });
    const ids = await v2SessionIds();
    const readable = await Promise.all(world.chats.map(v2ShowsReply));
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "the chats are on v2 with their messages, not just their titles",
      `v2 lists ${fixtureIds.filter(id => ids.includes(id)).length} of ${fixtureIds.length} earlier chats; ${readable.filter(Boolean).length} of ${readable.length} carry their reply; "${first.title}" opens and shows it`,
      fixtureIds.every(id => ids.includes(id)) && readable.every(Boolean),
    );
    expect(fixtureIds.filter(id => !ids.includes(id))).toEqual([]);
    expect(readable).toEqual(world.chats.map(() => true));
  });

  await step("after: the offer is gone, a reload copies nothing twice, and the v1 history is only read", async () => {
    await user.notSee({ role: "button", text: ACCEPT });
    const idsBefore = await v2SessionIds();
    await user.reload();
    await user.see({ testId: `sidebar-session-${first.id}` }, { timeoutMs: 60_000 });
    await user.notSee({ text: OFFER });
    await user.notSee({ role: "button", text: ACCEPT });
    const migration = migrationOf(await status());
    const idsAfter = await v2SessionIds();
    const history = world.readV1History();
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "the import runs once and leaves the v1 chats untouched",
      `no offer after the import or after reloading OpenWork; import still ${String(migration.state)} with ${migration.imported} imported; v2 chats ${idsBefore.length} → ${idsAfter.length}; v1 ${history.sessions} chats, sha256 ${world.before.sha256.slice(0, 12)} → ${history.sha256.slice(0, 12)}`,
      migration.imported === world.expectedChats && idsAfter.length === idsBefore.length && history.sha256 === world.before.sha256,
    );
    expect(migration).toMatchObject({ state: "completed", imported: world.expectedChats });
    expect(idsAfter).toEqual(idsBefore);
    expect(history).toEqual(world.before);
  });
});
