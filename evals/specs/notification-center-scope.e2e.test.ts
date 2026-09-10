import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { notificationCenter } from "../worlds/notification-center.ts";

const test = spec.world(notificationCenter);

const bell: Target = { role: "button", label: /^Notifications/ };
const emptyTitle: Target = { text: "No notifications yet" };
const emptyHint: Target = { text: /^Background updates show up here: .*Confirmations of your own actions, like archiving a session, appear briefly instead\.$/ };
const staleHint: Target = { text: /Updates from OpenWork Cloud and your workspaces/ };
const archivedToast: Target = { text: "Session archived" };
const undoButton: Target = { role: "button", label: "Undo" };

type ListedNotification = { kind: string; title: string; readAt: number | null; count: number; actionType: string | null };

function listed(value: unknown): ListedNotification[] {
  if (!Array.isArray(value)) throw new Error(`notifications.list did not return a list: ${JSON.stringify(value)}`);
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Malformed notification entry");
    const kind: unknown = Reflect.get(entry, "kind");
    const title: unknown = Reflect.get(entry, "title");
    const readAt: unknown = Reflect.get(entry, "readAt");
    const count: unknown = Reflect.get(entry, "count");
    const actionType: unknown = Reflect.get(entry, "actionType");
    if (typeof kind !== "string" || typeof title !== "string" || typeof count !== "number"
      || (readAt !== null && typeof readAt !== "number") || (actionType !== null && typeof actionType !== "string")) {
      throw new Error(`Malformed notification entry: ${JSON.stringify(entry)}`);
    }
    return { kind, title, readAt, count, actionType };
  });
}

test("notification center keeps background events and leaves action confirmations to toasts", async ({ world, user, agent, probe, step }) => {
  const candidateId = world.candidate.sessionId;
  const center = async () => listed(await agent.run("notifications.list"));

  await step("a fresh desktop has an empty center whose copy states what belongs there", async () => {
    expect(await center()).toEqual([]);
    expect(await world.bell()).toEqual({ label: "Notifications", badge: null });
    await user.click(bell);
    await user.see(emptyTitle);
    await user.see(emptyHint);
    await user.notSee(staleHint);
    await user.screenshot();
    await user.press("Escape");
    await user.notSee(emptyTitle);
  });

  if (world.engine !== "v2") {
    await step("archiving a session confirms with an undoable toast and adds nothing to the center", async () => {
      const archiveButton: Target = { role: "button", label: "Archive session", testId: `session-archive-${candidateId}` };
      await user.hover({ testId: `sidebar-session-${candidateId}` });
      await user.see(archiveButton);
      await user.click(archiveButton);
      await user.see({ text: `Session archived: ${world.candidate.title}` }, { timeoutMs: 30_000 });
      await user.see(undoButton);
      const stamps = await probe.eventually(() => world.archivedAt(), {
        within: 30_000, label: "candidate archived on the server", until: (value) => value[candidateId] > 0,
      });
      expect(stamps[candidateId]).toBeGreaterThan(0);
      expect(await center()).toEqual([]);
      expect(await world.bell()).toEqual({ label: "Notifications", badge: null });
      await user.click(undoButton);
      await user.notSee(archivedToast);
      await probe.eventually(() => world.archivedAt(), {
        within: 30_000, label: "Undo restores the candidate", until: (value) => value[candidateId] === 0,
      });
      expect(await center()).toEqual([]);
      expect(await world.bell()).toEqual({ label: "Notifications", badge: null });
    });
  }

  await step("a provider sync lands in the center as one unread entry and repeats coalesce", async () => {
    expect(await world.providerSync([{ id: "sync-alpha", name: "Alpha", providerId: "alpha" }])).toBe(1);
    const first = await probe.eventually(center, {
      within: 10_000, label: "provider sync reaches the center", until: (value) => value.length > 0,
    });
    expect(first).toEqual([{ kind: "providers", title: "1 new provider available", readAt: null, count: 1, actionType: "open-model-picker" }]);
    expect(await world.bell()).toEqual({ label: "Notifications (1)", badge: "1" });
    await user.notSee({ text: "1 new provider available" });

    expect(await world.providerSync([{ id: "sync-beta", name: "Beta", providerId: "beta" }])).toBe(1);
    const merged = await probe.eventually(center, {
      within: 10_000, label: "second sync merges into the unread entry", until: (value) => value[0]?.title === "2 new providers available",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "providers", readAt: null, actionType: "open-model-picker" });
    expect(await world.bell()).toEqual({ label: "Notifications (1)", badge: "1" });

    expect(await world.providerSync([{ id: "sync-alpha", name: "Alpha", providerId: "alpha" }])).toBe(1);
    await user.notSee({ text: "3 new providers available" });
    expect(await center()).toEqual(merged);
  });

  await step("the entry survives a reload unread, then reading it clears the badge and persists", async () => {
    await user.reload();
    const persisted = await probe.eventually(center, {
      within: 30_000, label: "notification center restores from storage", until: (value) => value.length === 1,
    });
    expect(persisted[0]).toMatchObject({ title: "2 new providers available", readAt: null });
    expect(await world.bell()).toEqual({ label: "Notifications (1)", badge: "1" });

    await user.click(bell);
    await user.see({ text: "2 new providers available" });
    await user.see({ role: "button", label: "Select a model" });
    await user.notSee(emptyTitle);
    await user.screenshot();
    await user.press("Escape");
    const read = await probe.eventually(center, {
      within: 10_000, label: "closing the panel marks the entry read", until: (value) => value[0]?.readAt !== null,
    });
    expect(read).toHaveLength(1);
    expect(await world.bell()).toEqual({ label: "Notifications", badge: null });

    await user.reload();
    const stillRead = await probe.eventually(center, {
      within: 30_000, label: "read state restores from storage", until: (value) => value.length === 1,
    });
    expect(stillRead[0]).toMatchObject({ title: "2 new providers available" });
    expect(typeof stillRead[0]?.readAt).toBe("number");
    expect(await world.bell()).toEqual({ label: "Notifications", badge: null });
  });
});
