import { expect, test } from "bun:test";
import { ProviderKeyShareService, type ProviderKeyShareDependencies } from "./provider-key-share.js";

const session = { baseUrl: "https://den.example.test/api/den", orgId: "org_fixture", token: "fixture-session" };
const eligibility = { organizationId: session.orgId, memberId: "mem_fixture", organizationName: "Example Team", teams: [{ id: "team_fixture", name: "Engineering" }], eligible: true, reason: null };
const input = { organizationId: session.orgId, memberId: eligibility.memberId, providerId: "anthropic", allMembers: true, teamIds: [], removeLocal: true, confirmed: true };

function fixture() {
  let reads = 0;
  let removals = 0;
  let beforeRead: (() => Promise<void>) | undefined;
  let beforeVerify: (() => Promise<void>) | undefined;
  let fail = false;
  let authorized = true;
  let receiptValid = true;
  let remaining = true;
  const sent: Array<{ requestId: string }> = [];
  const journal = new Map<string, unknown>();
  const dependencies: ProviderKeyShareDependencies = {
    source: {
      describe: async () => ({ name: "Anthropic" }),
      read: async () => { reads++; await beforeRead?.(); if (!remaining) throw new Error("No local credential"); return { key: "LOCAL_PROVIDER_ANTHROPIC_API_KEY", value: "fixture-private-key", updatedAt: 100 }; },
      remove: async (_id, value, isCurrent) => { isCurrent(); expect(value.value).toBe("fixture-private-key"); removals++; remaining = false; return true; },
    },
    readJournal: async (key) => journal.get(key) ?? null,
    writeJournal: async (key, value, isCurrent) => { isCurrent(); journal.set(key, structuredClone(value)); },
    transport: async (url, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.credentials).toBe("omit");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-session");
      if (url.includes("/eligibility?")) { await beforeVerify?.(); return authorized ? Response.json(eligibility) : new Response(null, { status: 403 }); }
      const body = JSON.parse(String(options?.body));
      expect(body.credential).toEqual({ kind: "api_key", secret: "fixture-private-key" });
      sent.push({ requestId: body.requestId });
      if (fail) throw new Error("fixture-private-key must never appear in errors");
      return Response.json({ share: { requestId: body.requestId, organizationId: receiptValid ? session.orgId : "org_other", providerId: input.providerId, inferenceProviderId: "ipr_fixture" } });
    },
  };
  const service = new ProviderKeyShareService(dependencies);
  service.setSession(session);
  return { service, sent, journal, dependencies, reads: () => reads, removals: () => removals, fail: (value: boolean) => { fail = value; }, deny: () => { authorized = false; }, badReceipt: () => { receiptValid = false; }, pauseRead: (value: () => Promise<void>) => { beforeRead = value; }, pauseVerify: (value: () => Promise<void>) => { beforeVerify = value; } };
}

function gate() {
  let release = () => {};
  let enter = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, pause: async () => { enter(); await waiting; } };
}

test("sharing requires verified fresh admin access before any private credential read", async () => {
  const f = fixture(); f.deny();
  await expect(f.service.share(input)).rejects.toMatchObject({ status: 403 });
  expect(f.reads()).toBe(0); expect(f.sent).toHaveLength(0); expect(f.removals()).toBe(0); expect(f.journal.size).toBe(0);
});

test("preview never reads or transfers a key and consent must be explicit", async () => {
  const f = fixture();
  expect(await f.service.eligibility(input.providerId, input.organizationId)).toEqual(eligibility);
  await expect(f.service.share({ ...input, confirmed: false })).rejects.toMatchObject({ status: 400 });
  await expect(f.service.share({ ...input, allMembers: false, teamIds: ["team_other"] })).rejects.toMatchObject({ status: 400 });
  expect(f.reads()).toBe(0); expect(f.sent).toHaveLength(0);
});

test("failed or uncertain transfers keep the key and retry the same durable request", async () => {
  const f = fixture(); f.fail(true);
  await expect(f.service.share(input)).rejects.toMatchObject({ code: "share_unverified" });
  expect(f.removals()).toBe(0);
  f.fail(false);
  const restarted = new ProviderKeyShareService(f.dependencies); restarted.setSession(session);
  const result = await restarted.share(input);
  expect(result.localRemoved).toBe(true); expect(f.removals()).toBe(1);
  expect(f.sent[0].requestId).toBe(f.sent[1].requestId);
  expect(JSON.stringify(result)).not.toContain("fixture-private-key");
  expect(JSON.stringify([...f.journal.values()])).not.toContain("fixture-private-key");
});

test("confirmed success removes only on request and repeated success creates no duplicate", async () => {
  const f = fixture();
  const kept = await f.service.share({ ...input, removeLocal: false });
  expect(kept.localRemoved).toBe(false); expect(f.removals()).toBe(0);
  const removed = await f.service.share(input);
  expect(removed.localRemoved).toBe(true); expect(f.sent).toHaveLength(1);
  expect(await f.service.share(input)).toEqual(removed); expect(f.removals()).toBe(1); expect(f.sent).toHaveLength(1);
});

test("an invalid durable receipt cannot remove the local key", async () => {
  const f = fixture(); f.badReceipt();
  await expect(f.service.share(input)).rejects.toMatchObject({ code: "share_unverified" });
  expect(f.removals()).toBe(0);
});

test.each(["verification", "private read"])("identity change during %s produces no external write or deletion", async (point) => {
  const f = fixture(); const wait = gate();
  if (point === "verification") f.pauseVerify(wait.pause); else f.pauseRead(wait.pause);
  const result = f.service.share(input);
  await wait.entered;
  f.service.setSession({ ...session, orgId: "org_other" }); wait.release();
  await expect(result).rejects.toMatchObject({ code: "share_identity_changed" });
  expect(f.sent).toHaveLength(0); expect(f.removals()).toBe(0); expect(f.journal.size).toBe(0);
});

test("cross-organization input and stale member identity cannot read a key", async () => {
  const f = fixture();
  expect(() => f.service.share({ ...input, organizationId: "org_other" })).toThrow();
  await expect(f.service.share({ ...input, memberId: "mem_other" })).rejects.toMatchObject({ status: 403 });
  expect(f.reads()).toBe(0); expect(f.sent).toHaveLength(0);
});
