import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pinnedSessions } from "../worlds/session-shell.ts";

const test = spec.world(pinnedSessions);

type ListedSession = {
  sessionId: string;
  pinned: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseListedSessions(value: unknown): ListedSession[] {
  if (!Array.isArray(value)) throw new Error(`Invalid session listing: ${JSON.stringify(value)}`);
  return value.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.sessionId !== "string" || typeof candidate.pinned !== "boolean") {
      throw new Error(`Invalid listed session: ${JSON.stringify(candidate)}`);
    }
    return { sessionId: candidate.sessionId, pinned: candidate.pinned };
  });
}

function parsePinResult(value: unknown): { ok: true; sessionId: string; pinned: boolean } {
  if (!isRecord(value) || value.ok !== true || typeof value.sessionId !== "string" || typeof value.pinned !== "boolean") {
    throw new Error(`Invalid session.pin result: ${JSON.stringify(value)}`);
  }
  return { ok: true, sessionId: value.sessionId, pinned: value.pinned };
}

test("pinned sessions are exposed to agents through list_sessions, the context snapshot, and the sidebar", async ({ world, user, agent, probe, step }) => {
  const candidateId = world.candidate.sessionId;
  const neighborId = world.neighbor.sessionId;
  const workspaceId = world.workspace.workspaceId;
  const resourceRef = `session:${workspaceId}:${candidateId}`;

  await step("both sessions start unpinned with no global pinned section", async () => {
    await agent.run("session.open", { sessionId: candidateId });
    await probe.eventually(() => probe.hash(), {
      within: 60_000,
      label: "pinned candidate route opens",
      until: (hash) => hash.includes(`/session/${candidateId}`),
    });

    const listing = parseListedSessions(await agent.run("session.list_sessions"));
    expect(listing.find((session) => session.sessionId === candidateId)?.pinned).toBe(false);
    expect(listing.find((session) => session.sessionId === neighborId)?.pinned).toBe(false);
    expect((await world.context()).pinnedSessionIds).toEqual([]);
    expect(await world.pinnedSidebarRows()).toBeNull();
    await user.notSee({ text: "Pinned" });
  });

  await step("pinning the candidate exposes it through agent context and the sidebar", async () => {
    expect(parsePinResult(await agent.run("session.pin", { sessionId: candidateId }))).toEqual({
      ok: true,
      sessionId: candidateId,
      pinned: true,
    });
    const pinnedContext = await probe.eventually(() => world.context(), {
      within: 30_000,
      label: "pinned candidate exposed in OpenWork context",
      until: (snapshot) => snapshot.pinnedSessionIds.includes(candidateId),
    });

    const listing = parseListedSessions(await agent.run("session.list_sessions"));
    expect(listing[0]).toEqual({ sessionId: candidateId, pinned: true });
    expect(listing.find((session) => session.sessionId === neighborId)?.pinned).toBe(false);
    expect(pinnedContext.pinnedSessionIds).toEqual([candidateId]);
    expect(pinnedContext.pinnedResourceRefs).toEqual([resourceRef]);
    const pinnedRows = await probe.eventually(() => world.pinnedSidebarRows(), {
      within: 30_000,
      label: "global pinned section shows the candidate",
      until: (rows) => rows?.includes(candidateId) === true,
    });
    expect(pinnedRows).toContain(candidateId);
    expect(pinnedRows).not.toContain(neighborId);
    await user.see({ text: "Pinned" }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("unpinning the candidate removes all exposed pin state", async () => {
    expect(parsePinResult(await agent.run("session.pin", { sessionId: candidateId }))).toEqual({
      ok: true,
      sessionId: candidateId,
      pinned: false,
    });
    const unpinnedContext = await probe.eventually(() => world.context(), {
      within: 30_000,
      label: "unpinned candidate removed from OpenWork context",
      until: (snapshot) => snapshot.pinnedSessionIds.length === 0,
    });

    const listing = parseListedSessions(await agent.run("session.list_sessions"));
    expect(listing.find((session) => session.sessionId === candidateId)?.pinned).toBe(false);
    expect(unpinnedContext.pinnedSessionIds).toEqual([]);
    expect(unpinnedContext.pinnedResourceRefs).toEqual([]);
    const pinnedRows = await probe.eventually(() => world.pinnedSidebarRows(), {
      within: 30_000,
      label: "global pinned section disappears",
      until: (rows) => rows === null,
    });
    expect(pinnedRows).toBeNull();
    await user.notSee({ text: "Pinned" }, { timeoutMs: 30_000 });
  });
});
