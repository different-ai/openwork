import { expect } from "vitest";
import { z } from "zod";
import { spec, type Probe } from "@openwork/testkit";
import { archivedSessionCompose, archivedSessionComposeOff } from "../worlds/archived-session-compose.ts";

const options = {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
} satisfies Parameters<typeof spec.world>[1];
const test = spec.world(archivedSessionCompose, options);
const testOff = spec.world(archivedSessionComposeOff, options);
const archivedBanner = { testId: "archived-session" };
const hint = "Sending a message will unarchive this conversation.";
const messageSchema = z.object({
  id: z.string(), type: z.string(), text: z.string().optional(), finish: z.string().optional(),
}).passthrough();
const sessionSchema = z.object({ id: z.string(), time: z.object({ archived: z.number().optional() }) });

function dataOf(body: unknown): unknown {
  return typeof body === "object" && body !== null && "data" in body ? body.data : body;
}

function messagesOf(body: unknown) {
  const data = dataOf(body);
  const items = typeof data === "object" && data !== null && "items" in data ? data.items : data;
  // Sort by immutable native id so newest-first pagination cannot hide a repeat.
  return z.array(messageSchema).parse(items).sort((a, b) => a.id.localeCompare(b.id));
}

function archivedOf(body: unknown) {
  return (sessionSchema.parse(dataOf(body)).time.archived ?? 0) > 0;
}

function sessionIdsOf(body: unknown) {
  return z.array(z.object({ id: z.string() })).parse(dataOf(body)).map(session => session.id).sort();
}

async function read(probe: Probe, path: string) {
  const result = await probe.desktopApi(path);
  expect(result.status, `GET ${path}`).toBe(200);
  return result.body;
}

// These are separate isolated organizations: the default-off rollout boundary
// and the enabled behavior are both real server decisions, never renderer overrides.
testOff("a member outside the rollout still restores an archived conversation before writing", async ({ world, user, probe, step, evidence }) => {
  const baseline = messagesOf(world.initial.messages);
  await step("before: an archived conversation is read-only outside the rollout", async () => {
    await user.navigate(world.route);
    await user.see(archivedBanner, { timeoutMs: 60_000 });
    await user.see({ text: "This conversation is read-only. Restore it to continue; previous work will not restart." });
    await user.notSee("composer");
    const org = await probe.api(world.den.admin, "/v1/org");
    expect(org.response.status).toBe(200);
    const features = z.object({ features: z.object({ archivedSessionCompose: z.boolean().optional() }) }).parse(org.body).features;
    const archived = archivedOf(await read(probe, world.sessionPath));
    evidence.recordAssertionEvidence("The rollout is off and the conversation remains archived", `feature=${features.archivedSessionCompose ?? false}; archived=${archived}; composer absent`, features.archivedSessionCompose !== true && archived);
    expect(features.archivedSessionCompose).not.toBe(true);
    expect(archived).toBe(true);
    await user.screenshot();
  });

  await step("the read-only archive survives a reload", async () => {
    await user.reload();
    await user.see(archivedBanner, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Restore" });
    await user.notSee("composer");
    const messages = messagesOf(await read(probe, `${world.sessionPath}/message?limit=100`));
    evidence.recordAssertionEvidence("Reload neither sends a message nor restarts earlier work", `messages before=${baseline.length}; after=${messages.length}; read-only archive still visible`, JSON.stringify(messages) === JSON.stringify(baseline));
    expect(messages).toEqual(baseline);
    await user.screenshot();
  });

  await step("after: explicit Restore opens the old composer without sending anything", async () => {
    await user.click({ role: "button", label: "Restore" });
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.notSee(archivedBanner);
    const archived = archivedOf(await read(probe, world.sessionPath));
    const messages = messagesOf(await read(probe, `${world.sessionPath}/message?limit=100`));
    const unchanged = JSON.stringify(messages) === JSON.stringify(baseline);
    evidence.recordAssertionEvidence("The existing restore-only behavior is unchanged outside the rollout", `archived=${archived}; messages before=${baseline.length}; after=${messages.length}; no new user message`, !archived && unchanged);
    expect(archived).toBe(false);
    expect(messages).toEqual(baseline);
    await user.screenshot();
  });
});

test("a member in the rollout drafts in an archive and explicitly sends one follow-up in the same conversation", async ({ world, user, probe, step, evidence }) => {
  const baseline = messagesOf(world.initial.messages);
  const originalCalls = world.initial.requests.filter(request => request.promptMarker === world.original.prompt).length;
  const newCalls = (requests: Awaited<ReturnType<typeof world.requests>>) => requests.filter(request => request.promptMarker === world.followup.prompt && request.kind === "final");

  const unchangedNeighbors = async () => {
    const [active, activeMessages, otherArchived, otherArchivedMessages, groups, sessions] = await Promise.all([
      read(probe, `${world.sessionsPath}/${world.active.sessionId}`),
      read(probe, `${world.sessionsPath}/${world.active.sessionId}/message?limit=100`),
      read(probe, `${world.sessionsPath}/${world.otherArchived.sessionId}`),
      read(probe, `${world.sessionsPath}/${world.otherArchived.sessionId}/message?limit=100`),
      read(probe, world.groupsPath),
      read(probe, `${world.sessionsPath}?limit=200`),
    ]);
    expect(active).toEqual(world.initial.active);
    expect(messagesOf(activeMessages)).toEqual(messagesOf(world.initial.activeMessages));
    expect(otherArchived).toEqual(world.initial.otherArchived);
    expect(messagesOf(otherArchivedMessages)).toEqual(messagesOf(world.initial.otherArchivedMessages));
    expect(groups).toEqual(world.initial.groups);
    expect(sessionIdsOf(sessions)).toEqual(sessionIdsOf(world.initial.sessions));
    return !archivedOf(active) && archivedOf(otherArchived);
  };

  await step("after: the enabled archived conversation offers a composer without restoring first", async () => {
    await user.navigate(world.route);
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.see({ text: hint });
    await user.see({ text: world.original.reply });
    const org = await probe.api(world.den.admin, "/v1/org");
    expect(org.response.status).toBe(200);
    const features = z.object({ features: z.object({ archivedSessionCompose: z.boolean() }) }).parse(org.body).features;
    const archived = archivedOf(await read(probe, world.sessionPath));
    evidence.recordAssertionEvidence("The enabled composer belongs to a genuinely archived conversation", `feature=${features.archivedSessionCompose}; archived=${archived}; earlier completed reply visible`, features.archivedSessionCompose && archived);
    expect(features.archivedSessionCompose).toBe(true);
    expect(archived).toBe(true);
    expect(baseline.filter(message => message.type === "user")).toHaveLength(1);
    expect(originalCalls).toBeGreaterThan(0);
    await user.screenshot();
  });

  await step("writing a draft leaves the conversation archived and earlier work stopped", async () => {
    await user.type("composer", world.followup.prompt, { replace: true });
    await user.see("composer", { text: world.followup.prompt });
    await user.see({ role: "button", label: "Send & unarchive" });
    await user.see({ text: hint });
    const archived = archivedOf(await read(probe, world.sessionPath));
    const messages = messagesOf(await read(probe, `${world.sessionPath}/message?limit=100`));
    const requests = await world.requests();
    const previousCalls = requests.filter(request => request.promptMarker === world.original.prompt).length;
    const neighbors = await unchangedNeighbors();
    evidence.recordAssertionEvidence("Drafting sends nothing and changes neither archive state nor other conversations", `archived=${archived}; messages=${messages.length}/${baseline.length}; earlier model calls=${previousCalls}/${originalCalls}; follow-up calls=${newCalls(requests).length}; group and two neighbors unchanged`, archived && JSON.stringify(messages) === JSON.stringify(baseline) && previousCalls === originalCalls && newCalls(requests).length === 0 && neighbors);
    expect(archived).toBe(true);
    expect(messages).toEqual(baseline);
    expect(previousCalls).toBe(originalCalls);
    expect(newCalls(requests)).toHaveLength(0);
    expect(await probe.hash()).toContain(world.session.sessionId);
    await user.screenshot();
  });

  await step("the member chooses Send & unarchive and receives exactly one new reply in the same conversation", async () => {
    await user.click({ role: "button", label: "Send & unarchive" });
    await user.see({ text: world.followup.reply }, { timeoutMs: 90_000 });
    await user.notSee({ text: hint });
    await user.see("composer", { editable: true });
    const session = sessionSchema.parse(dataOf(await read(probe, world.sessionPath)));
    const messages = messagesOf(await read(probe, `${world.sessionPath}/message?limit=100`));
    const users = messages.filter(message => message.type === "user");
    const requests = await world.requests();
    const archived = (session.time.archived ?? 0) > 0;
    const neighbors = await unchangedNeighbors();
    evidence.recordAssertionEvidence("One human send restores only its own conversation and adds one follow-up", `same conversation=${session.id === world.session.sessionId}; archived=${archived}; user messages=${users.length}; new follow-up model replies=${newCalls(requests).length}; two neighbors and Review queue unchanged`, session.id === world.session.sessionId && !archived && users.length === 2 && newCalls(requests).length === 1 && neighbors);
    expect(session.id).toBe(world.session.sessionId);
    expect(archived).toBe(false);
    expect(users.map(message => message.text).sort()).toEqual([world.original.prompt, world.followup.prompt].sort());
    for (const message of baseline) expect(messages.find(candidate => candidate.id === message.id)).toEqual(message);
    expect(newCalls(requests)).toHaveLength(1);
    expect(requests.filter(request => request.promptMarker === world.original.prompt)).toHaveLength(originalCalls);
    expect(await probe.hash()).toContain(world.session.sessionId);
    await user.screenshot();
  });

  await step("after: reload preserves the restored conversation, its follow-up and its original group", async () => {
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.see({ text: world.original.reply });
    await user.see({ text: world.followup.reply });
    await user.notSee({ text: hint });
    const archived = archivedOf(await read(probe, world.sessionPath));
    const messages = messagesOf(await read(probe, `${world.sessionPath}/message?limit=100`));
    const users = messages.filter(message => message.type === "user");
    const requests = await world.requests();
    const neighbors = await unchangedNeighbors();
    evidence.recordAssertionEvidence("Reload retains the exact follow-up without replay or collateral changes", `same route=${(await probe.hash()).includes(world.session.sessionId)}; archived=${archived}; user messages=${users.length}; new model replies=${newCalls(requests).length}; saved group and two neighbors unchanged`, !archived && users.length === 2 && newCalls(requests).length === 1 && neighbors);
    expect(archived).toBe(false);
    expect(users.map(message => message.text).sort()).toEqual([world.original.prompt, world.followup.prompt].sort());
    for (const message of baseline) expect(messages.find(candidate => candidate.id === message.id)).toEqual(message);
    expect(newCalls(requests)).toHaveLength(1);
    expect(requests.filter(request => request.promptMarker === world.original.prompt)).toHaveLength(originalCalls);
    expect(await probe.hash()).toContain(world.session.sessionId);
    await user.screenshot();
  });
});
