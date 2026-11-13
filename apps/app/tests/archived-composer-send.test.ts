import { describe, expect, test } from "bun:test";
import { confirmArchivedComposerRestore, isConfirmedUnarchivedSession } from "../src/react-app/domains/session/surface/archived-composer-send";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("archived composer restore boundary", () => {
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
