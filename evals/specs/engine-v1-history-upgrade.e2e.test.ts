import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineV1HistoryUpgrade } from "../worlds/engine-v1-history.ts";

// OPENWORK_EVAL_V1_HISTORY_LIMIT=all (local only) migrates a whole real history, which can take hours.
const whole = Boolean(process.env.OPENWORK_EVAL_V1_HISTORY_SOURCE?.trim()) && process.env.OPENWORK_EVAL_V1_HISTORY_LIMIT?.trim() === "all";
const MIGRATION_WITHIN_MS = whole ? 6 * 3_600_000 : 300_000;

const test = spec.world(engineV1HistoryUpgrade, {
  timeout: whole ? 7 * 3_600_000 : 900_000,
  resources: {
    surfaces: ["desktop"], services: ["den"],
    nativeReason: "The upgrade copies chats from the v1 database file the desktop's engine owns into its v2 sidecar, and only the desktop offers it.",
  },
});

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
    backupPath: typeof migration.backupPath === "string" ? migration.backupPath : null,
  };
}

test("a member still on OpenCode v1 upgrades in one click: chats are copied with a backup and OpenWork switches to v2", async ({ world, user, probe, step, evidence }) => {
  const workspaceId = world.workspace.workspaceId;
  const status = async () => {
    const response = await probe.desktopApi("/experimental/engine-v2-preview/status");
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
  const fixtureIds = world.chats.map(chat => chat.id).sort();

  await step("before: on OpenCode v1 with four v1 chats, the member is asked to upgrade", async () => {
    const before = await probe.eventually(status, {
      within: 60_000, label: "v1 engine with v1 history",
      until: value => value.chatRouting !== true && value.v1HistoryAvailable === true,
    });
    await user.see({ testId: "engine-upgrade-notice" }, { timeoutMs: 60_000 });
    await user.see({ text: "OpenWork needs to upgrade its chat engine. Your chats are copied over and backed up first." });
    if (world.fixture) await user.see({ text: world.chats[0]!.title }, { timeoutMs: 60_000 });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "the upgrade is offered to a member still on v1",
      `engine v1 (chatRouting ${String(before.chatRouting)}), v1 history ${String(before.v1HistoryAvailable)}, ${world.before.sessions} v1 chats seeded`,
      before.chatRouting !== true && world.before.sessions === world.expectedChats,
    );
  });

  await step("the upgrade says what changes before anything is copied", async () => {
    await user.click({ role: "button", text: /^Upgrade$/ });
    await user.see({ text: "Upgrade to OpenCode v2?" });
    await user.see({ text: /keeps a backup, then switches OpenWork to v2/ });
    await user.click({ text: "What changes in migrated chats" });
    await user.see({ text: /Chat permissions and undo history reset/ });
    await user.screenshot();
    const migration = migrationOf(await status());
    evidence.recordAssertionEvidence("nothing is copied until the member confirms", `migration ${String(migration.state)}`, migration.state === "idle");
    expect(migration.state).toBe("idle");
  });

  // Every phase change with its time and counts: the recorded process.
  const timeline: { at: string; elapsedS: number; state: unknown; phase: unknown; imported: number; skipped: number; total: number; chatRouting: unknown }[] = [];
  const startedAt = Date.now();
  const track = (value: Record<string, unknown>) => {
    const migration = migrationOf(value);
    const phase = isRecord(value.migration) ? value.migration.phase : undefined;
    const last = timeline.at(-1);
    const copiedStep = Math.max(1, Math.floor(migration.total / 20));
    if (!last || last.state !== migration.state || last.phase !== phase || last.chatRouting !== value.chatRouting
      || Math.floor((migration.imported + migration.skipped) / copiedStep) !== Math.floor((last.imported + last.skipped) / copiedStep)) {
      timeline.push({
        at: new Date().toISOString(), elapsedS: Math.round((Date.now() - startedAt) / 1000),
        state: migration.state, phase, imported: migration.imported, skipped: migration.skipped, total: migration.total,
        chatRouting: value.chatRouting,
      });
    }
    return value;
  };

  await step("while it runs: progress stays on screen and the member can keep working", async () => {
    await user.click({ role: "button", text: /^Upgrade$/ });
    await probe.eventually(async () => track(await status()), {
      within: 120_000, intervalMs: 1_000, label: "migration started",
      until: value => migrationOf(value).state !== "idle",
    });
    await user.see({ testId: "engine-migration-progress" }, { timeoutMs: 30_000 });
    await user.screenshot();
    const first = timeline.at(-1);
    evidence.recordAssertionEvidence("the migration started", `state ${String(first?.state)}, phase ${String(first?.phase)}`, first?.state !== "idle");
  });

  await step("after: the chats are copied with a backup and OpenWork switches to v2 by itself", async () => {
    // The toast is short-lived: watch for it while the status is polled.
    const toast = user.see({ text: "Upgraded to OpenCode v2" }, { timeoutMs: MIGRATION_WITHIN_MS }).then(() => true, () => false);
    // Poll by hand so a long run is recorded: a screenshot at every phase change, and every 5 minutes.
    const deadline = Date.now() + MIGRATION_WITHIN_MS;
    let lastShotAt = Date.now();
    let seenEntries = timeline.length;
    let after: Record<string, unknown>;
    while (true) {
      after = track(await status());
      const state = migrationOf(after).state;
      if (state === "error" || (state === "completed" && after.chatRouting === true && after.running === true)) break;
      const phaseChanged = timeline.length > seenEntries && timeline.at(-1)?.phase !== timeline[seenEntries - 1]?.phase;
      seenEntries = timeline.length;
      if (whole && (phaseChanged || Date.now() - lastShotAt > 5 * 60_000)) {
        await user.screenshot();
        lastShotAt = Date.now();
      }
      if (Date.now() > deadline) throw new Error(`Migration did not finish within ${MIGRATION_WITHIN_MS / 60_000} minutes; last ${JSON.stringify(timeline.at(-1))}`);
      await new Promise(resolve => setTimeout(resolve, whole ? 5_000 : 1_000));
    }
    const migration = migrationOf(after);
    evidence.recordJsonArtifact("Migration timeline", { chats: world.expectedChats, whole: world.whole, timeline });
    const phaseStart = (phase: string) => timeline.find(entry => entry.phase === phase)?.elapsedS;
    evidence.recordAssertionEvidence(
      "how long each phase took",
      `snapshot+count ${phaseStart("converting") ?? "?"}s, conversion until ${phaseStart("copying") ?? "?"}s, done at ${timeline.at(-1)?.elapsedS ?? "?"}s; ${migration.state}${isRecord(after.migration) && typeof after.migration.error === "string" ? `: ${after.migration.error}` : ""}`,
      migration.state === "completed",
    );
    expect(migration.state).toBe("completed");
    expect(await toast).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "every v1 chat is copied once, after a backup of v2",
      `imported ${migration.imported} of ${migration.total}, skipped ${migration.skipped}; backup ${migration.backupPath ? migration.backupPath.split("/").slice(-2).join("/") : "missing"}`,
      migration.imported === world.expectedChats && migration.skipped === 0 && migration.backupPath !== null,
    );
    expect(migration).toMatchObject({ imported: world.expectedChats, skipped: 0, total: world.expectedChats });
    expect(migration.backupPath).toMatch(/opencode-v2\/backups\/opencode-v2-.+\.db$/);
  });

  await step("after: the migrated chats open on OpenCode v2 and the notice is gone", async () => {
    await user.notSee({ testId: "engine-upgrade-notice" });
    if (world.fixture) {
      const ids = await probe.eventually(v2SessionIds, {
        within: 60_000, label: "fixture chats listed by v2",
        until: value => fixtureIds.every(id => value.includes(id)),
      });
      const first = world.chats[0]!;
      await user.click({ testId: `sidebar-session-${first.id}` });
      await user.see({ text: first.reply }, { timeoutMs: 60_000 });
      await user.screenshot();
      evidence.recordAssertionEvidence(
        "the chats, sub-chat included, are on v2 with their messages",
        `v2 lists ${fixtureIds.filter(id => ids.includes(id)).length} of ${fixtureIds.length} chats; "${first.title}" shows its reply`,
        fixtureIds.every(id => ids.includes(id)),
      );
    } else {
      const ids = await v2SessionIds();
      await user.screenshot();
      evidence.recordAssertionEvidence("copied history is on v2", `${ids.length} chats in this workspace on v2 (others keep their own folders)`, true);
    }
  });

  await step("then every v1 chat with messages has its messages on v2, not just its title", async () => {
    await user.notSee({ testId: "engine-upgrade-notice" });
    const coverage = await world.readCoverage();
    evidence.recordAssertionEvidence(
      "no chat arrives empty",
      `${coverage.withMessages} v1 chats with messages; ${coverage.emptyInV2} of them have no messages on v2; ${coverage.v2Messages} v2 messages`,
      coverage.emptyInV2 === 0,
    );
    expect(coverage.emptyInV2).toBe(0);
  });

  await step("then the v1 history itself was not changed", async () => {
    const now = world.readV1History();
    evidence.recordAssertionEvidence(
      "v1 chats are only read",
      `${now.sessions} chats, ${now.messages} messages, ${now.parts} parts; sha256 ${now.sha256.slice(0, 12)} before and ${world.before.sha256.slice(0, 12)} after`,
      now.sha256 === world.before.sha256,
    );
    expect(now).toEqual(world.before);
  });

  await step("after: migrating again copies nothing twice", async () => {
    if (world.whole) {
      // A second full pass repeats hours of snapshot and conversion; the fixture and slice runs prove reruns skip.
      evidence.recordAssertionEvidence("a rerun skips chats already on v2", "not repeated for a whole history; covered by the fixture run", true);
      await world.stopFilm();
      return;
    }
    const idsBefore = world.fixture ? await v2SessionIds() : [];
    // The command palette is one of the two homes of "Migrate chats" (Advanced settings is the other).
    await user.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.type({ role: "combobox" }, "Migrate chats");
    await user.click({ text: "Migrate chats to OpenCode v2" });
    await user.click({ role: "button", text: /^Migrate chats$/ });
    const again = await probe.eventually(status, {
      within: 300_000, label: "second migration completed",
      until: value => {
        const migration = migrationOf(value);
        return migration.state === "completed" && migration.skipped === world.expectedChats;
      },
    });
    const migration = migrationOf(again);
    await user.see({ text: `Migrated 0 chats; ${world.expectedChats} already in v2.` }, { timeoutMs: 30_000 });
    await user.screenshot();
    const idsAfter = world.fixture ? await v2SessionIds() : [];
    evidence.recordAssertionEvidence(
      "a rerun skips chats already on v2",
      `imported ${migration.imported}, skipped ${migration.skipped} of ${migration.total}; v2 chats ${idsBefore.length} → ${idsAfter.length}`,
      migration.imported === 0 && migration.skipped === world.expectedChats && idsAfter.length === idsBefore.length,
    );
    expect(migration).toMatchObject({ imported: 0, skipped: world.expectedChats });
    expect(idsAfter).toEqual(idsBefore);
  });
});
