import { describe, expect, test } from "bun:test";
import { captureArchivedSendSelection, confirmArchivedComposerRestore as restoreBoundary, isConfirmedUnarchivedSession, sameArchivedSendIdentity } from "../src/react-app/domains/session/surface/archived-composer-send";
import { holdSessionWork, sessionWorkHeld } from "../src/app/lib/opencode-interruption";
import { claimQueuedSend, dispatchQueuedDrain, getQueuedDrainState } from "../src/react-app/domains/session/surface/queued-drain-machine";

import { getSessionAgentSelection, useSessionAgentStore } from "../src/react-app/domains/session/surface/session-mode-memory";

const baseUrl = "http://archive-boundary.invalid";
let sequence = 0;
function confirmArchivedComposerRestore(input: Omit<Parameters<typeof restoreBoundary>[0], "lease">) {
  const sessionId = `archive-boundary-${++sequence}`;
  claimQueuedSend(sessionId, "captured", true);
  return restoreBoundary({ ...input, lease: { baseUrl, sessionId, itemId: "captured" } })
    .finally(() => { dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "captured" }); });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("archived composer restore boundary", () => {
  test("the human-send identity snapshot cannot adopt mutations to the settings object", () => {
    const settings = { authToken: "member-a", activeOrgId: "org-a", baseUrl: "https://den.invalid" };
    const captured = captureArchivedSendSelection(settings, null);
    settings.authToken = "member-b";
    expect(captured.identity.authToken).toBe("member-a");
    expect(sameArchivedSendIdentity(captured.identity, settings)).toBe(false);
  });

  for (const agent of [null, "review"]) {
    test(`the captured ${agent ?? "Default"} agent survives a selection change during restore`, async () => {
      const sessionId = `agent-${++sequence}`;
      useSessionAgentStore.getState().setAgent(sessionId, agent);
      const captured = captureArchivedSendSelection({ baseUrl }, getSessionAgentSelection(sessionId, "fallback"));
      const restore = deferred<boolean>();
      const sentAgents: (string | null)[] = [];
      const pending = confirmArchivedComposerRestore({
        restore: () => restore.promise,
        verify: async () => true,
        isCurrent: () => true,
      }).then((confirmed) => { if (confirmed) sentAgents.push(captured.agent); });
      useSessionAgentStore.getState().setAgent(sessionId, "different");
      restore.resolve(true);
      await pending;
      expect(getSessionAgentSelection(sessionId)).toBe("different");
      expect(sentAgents).toEqual([agent]);
    });
  }
  test("confirmed restore releases the hold but transfers its exact claim to the ordinary send", async () => {
    const sessionId = `confirmed-${++sequence}`;
    expect(claimQueuedSend(sessionId, "captured", true)).toBe(true);
    expect(await restoreBoundary({
      lease: { baseUrl, sessionId, itemId: "captured" },
      restore: async () => true,
      verify: async () => true,
      isCurrent: () => true,
    })).toBe(true);
    expect(sessionWorkHeld(baseUrl, sessionId)).toBe(false);
    expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "sending", itemId: "captured" });
    dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "captured" });
  });

  for (const stage of ["restore", "verify"]) {
    for (const cancellation of ["deadline", "abort"]) {
      test(`${cancellation} during never-settling ${stage} releases its real hold/claim, never a newer claim`, async () => {
        const sessionId = `lease-${++sequence}`;
        const itemId = "captured";
        const late = deferred<boolean>();
        const controller = new AbortController();
        let operationSignal: AbortSignal | undefined;
        let sends = 0;
        let verifyCalls = 0;
        const releaseOtherHold = holdSessionWork(baseUrl, sessionId);
        expect(claimQueuedSend(sessionId, itemId, true)).toBe(true);
        const pending = restoreBoundary({
          lease: { baseUrl, sessionId, itemId },
          signal: controller.signal,
          timeoutMs: 25,
          isCurrent: () => true,
          restore: (signal) => {
            operationSignal = signal;
            return stage === "restore" ? late.promise : Promise.resolve(true);
          },
          verify: (signal) => { operationSignal = signal; verifyCalls++; return late.promise; },
        }).then((confirmed) => { if (confirmed) sends++; return confirmed; });
        await Promise.resolve();
        expect(sessionWorkHeld(baseUrl, sessionId)).toBe(true);
        expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "sending", itemId });
        if (cancellation === "abort") {
          controller.abort();
          expect(await pending).toBe(false);
        } else {
          await expect(pending).rejects.toThrow("timed out");
        }
        expect(operationSignal?.aborted).toBe(true);
        expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "halted", itemId });
        // The boundary released exactly one hold, not an unrelated operation's.
        expect(sessionWorkHeld(baseUrl, sessionId)).toBe(true);
        releaseOtherHold();
        expect(sessionWorkHeld(baseUrl, sessionId)).toBe(false);
        expect(claimQueuedSend(sessionId, "newer", true)).toBe(true);
        late.resolve(true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(sends).toBe(0);
        expect(verifyCalls).toBe(stage === "verify" ? 1 : 0);
        expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "sending", itemId: "newer" });
        dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "newer" });
      });
    }
  }

  test("context/Stop invalidation cancels an ignored request without waiting for its receipt", async () => {
    let current = true;
    let signal: AbortSignal | undefined;
    const pending = confirmArchivedComposerRestore({
      restore: (nextSignal) => { signal = nextSignal; return new Promise<boolean>(() => {}); },
      verify: async () => true,
      isCurrent: () => current,
      timeoutMs: 1_000,
    });
    current = false;
    expect(await pending).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  for (const changed of ["token", "organization", "base URL"]) {
    test(`a changed Den ${changed} cancels the captured identity during restore`, async () => {
      const captured = { authToken: "member-a", activeOrgId: "org-a", baseUrl: "https://den.invalid" };
      let current = { ...captured };
      const pending = confirmArchivedComposerRestore({
        restore: () => new Promise<boolean>(() => {}),
        verify: async () => true,
        isCurrent: () => sameArchivedSendIdentity(captured, current),
        timeoutMs: 1_000,
      });
      if (changed === "token") current = { ...current, authToken: "member-b" };
      if (changed === "organization") current = { ...current, activeOrgId: "org-b" };
      if (changed === "base URL") current = { ...current, baseUrl: "https://other.invalid" };
      expect(await pending).toBe(false);
      expect(sameArchivedSendIdentity(captured, current)).toBe(false);
    });
  }
  test("requires the same server-confirmed session in its owned cache", () => {
    expect(isConfirmedUnarchivedSession("original", undefined)).toBe(false);
    expect(isConfirmedUnarchivedSession("original", { id: "different", time: {} })).toBe(false);
    expect(isConfirmedUnarchivedSession("original", { id: "original", time: { archived: 123 } })).toBe(false);
    expect(isConfirmedUnarchivedSession("original", { id: "original", time: { archived: 0 } })).toBe(true);
    expect(isConfirmedUnarchivedSession("original", { id: "original", time: {} })).toBe(true);
  });
  test("does not authorize the ordinary send before restore AND cache verification finish", async () => {
    const restore = deferred<boolean>();
    const verify = deferred<boolean>();
    const events: string[] = [];
    const pending = confirmArchivedComposerRestore({
      restore: () => { events.push("restore"); return restore.promise; },
      verify: () => { events.push("verify"); return verify.promise; },
      isCurrent: () => true,
    }).then((allowed) => { if (allowed) events.push("send"); });
    expect(events).toEqual(["restore"]);
    restore.resolve(true);
    await Promise.resolve();
    expect(events).toEqual(["restore", "verify"]);
    verify.resolve(true);
    await pending;
    expect(events).toEqual(["restore", "verify", "send"]);
  });

  test("a cancelled/failed restore does not verify or authorize a send", async () => {
    let verified = false;
    await expect(confirmArchivedComposerRestore({
      restore: async () => false,
      verify: async () => { verified = true; return true; },
      isCurrent: () => true,
    })).rejects.toThrow("Your draft is saved");
    expect(verified).toBe(false);
  });

  test("an archived or missing cache result cannot authorize a send", async () => {
    await expect(confirmArchivedComposerRestore({
      restore: async () => true, verify: async () => false, isCurrent: () => true,
    })).rejects.toThrow("Couldn't verify");
  });

  test("an invalid owner/feature/model context never invokes restore", async () => {
    let restored = false;
    expect(await confirmArchivedComposerRestore({
      restore: async () => { restored = true; return true; },
      verify: async () => true, isCurrent: () => false,
    })).toBe(false);
    expect(restored).toBe(false);
  });

  for (const boundary of ["restore", "verify"]) {
    test(`route/kill/Stop invalidation during ${boundary} never authorizes continuation`, async () => {
      const wait = deferred<boolean>();
      let current = true;
      let verified = false;
      const pending = confirmArchivedComposerRestore({
        restore: () => boundary === "restore" ? wait.promise : Promise.resolve(true),
        verify: () => { verified = true; return wait.promise; },
        isCurrent: () => current,
      });
      await Promise.resolve();
      current = false;
      wait.resolve(true);
      expect(await pending).toBe(false);
      expect(verified).toBe(boundary === "verify");
    });
  }

  test("transport errors cannot become a success receipt", async () => {
    await expect(confirmArchivedComposerRestore({
      restore: async () => { throw new Error("offline"); },
      verify: async () => true, isCurrent: () => true,
    })).rejects.toThrow("offline");
  });
});
