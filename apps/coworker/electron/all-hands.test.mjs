import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAllHands, updateAllHands, prepareAllHands, dueAllHands, claimAllHands } from "./all-hands.mjs";

test("All Hands is opt-in, serializes creation, preserves identity across disabling, and rejects invalid preferences", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "all-hands-"));
  try {
    assert.equal((await readAllHands(dir)).enabled, false);
    assert.equal(await prepareAllHands(dir, [{ slug: "scout" }, { slug: "editor" }]), null);
    assert.equal(await claimAllHands(dir), null);
    await updateAllHands(dir, { enabled: true, frequency: "manual" });
    assert.equal(await prepareAllHands(dir, [{ slug: "scout" }]), null);
    const groups = await Promise.all([prepareAllHands(dir, [{ slug: "scout" }, { slug: "editor" }]), prepareAllHands(dir, [{ slug: "scout" }, { slug: "editor" }])]);
    assert.equal(groups[0].id, groups[1].id);
    await Promise.all([updateAllHands(dir, { focus: "Customer blockers" }), updateAllHands(dir, { morning: "10:30" })]);
    const saved = await readAllHands(dir);
    assert.equal(saved.focus, "Customer blockers");
    assert.equal(saved.morning, "10:30");
    await assert.rejects(updateAllHands(dir, { morning: "25:00" }));
    await assert.rejects(updateAllHands(dir, { frequency: "twice", afternoon: "08:00" }));
    await assert.rejects(updateAllHands(dir, { groupId: "grp_invalid" }));
    await updateAllHands(dir, { enabled: false });
    assert.equal(await claimAllHands(dir), null);
    await updateAllHands(dir, { enabled: true });
    assert.equal((await prepareAllHands(dir, [{ slug: "scout" }, { slug: "editor" }])).id, saved.groupId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local daily slots catch up once, skip old days, and never run before opt-in", () => {
  const settings = { enabled: true, groupId: "grp_example", frequency: "twice", morning: "09:00", afternoon: "16:00", enabledAt: new Date(2026, 8, 4, 8).getTime(), lastOccurrence: "" };
  assert.equal(dueAllHands(settings, new Date(2026, 8, 4, 8, 59)), null);
  const morning = dueAllHands(settings, new Date(2026, 8, 4, 11));
  assert.equal(morning.id, "all-hands:2026-9-4-09:00");
  assert.equal(dueAllHands({ ...settings, lastOccurrence: morning.occurrence }, new Date(2026, 8, 4, 12)), null);
  const afternoon = dueAllHands(settings, new Date(2026, 8, 4, 19));
  assert.equal(afternoon.id, "all-hands:2026-9-4-16:00");
  assert.equal(dueAllHands({ ...settings, lastOccurrence: afternoon.occurrence }, new Date(2026, 8, 4, 20)), null);
  assert.equal(dueAllHands(settings, new Date(2026, 8, 5, 8)), null);
  assert.equal(dueAllHands({ ...settings, enabledAt: new Date(2026, 8, 4, 17).getTime() }, new Date(2026, 8, 4, 19)), null);
  assert.equal(dueAllHands({ ...settings, frequency: "manual" }, new Date(2026, 8, 4, 19)), null);
});
