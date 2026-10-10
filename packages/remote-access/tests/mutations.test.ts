import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
const api = (await import("../src/mutations/ledger.js").catch(
  () => ({}),
)) as any;
const id = "c3f31f0e-2f0a-4a30-a988-caf870e95702";
test("concurrent identical actions forward once, changed body conflicts, prompt is not persisted", async () => {
  expect(api.Ledger).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-ledger-"));
  const store = await Store.open(join(parent, "state"));
  try {
    const ledger = new api.Ledger(store);
    let forwarded = 0;
    const action = async () => {
      forwarded++;
      await new Promise((r) => setTimeout(r, 10));
      return "ses_new";
    };
    const [a, b] = await Promise.all([
      ledger.perform(
        "device",
        id,
        "/messages",
        { text: "Secret prompt" },
        action,
      ),
      ledger.perform(
        "device",
        id,
        "/messages",
        { text: "Secret prompt" },
        action,
      ),
    ]);
    expect(forwarded).toBe(1);
    expect(a.state).toBe("accepted");
    expect(["pending", "accepted"]).toContain(b.state);
    await expect(
      ledger.perform("device", id, "/messages", { text: "Changed" }, action),
    ).rejects.toThrow("REQUEST_CONFLICT");
    expect(JSON.stringify(store.snapshot)).not.toContain("Secret prompt");
    const c = await ledger.perform(
      "device",
      id,
      "/messages",
      { text: "Secret prompt" },
      action,
    );
    expect(c.resourceId).toBe("ses_new");
    expect(forwarded).toBe(1);
  } finally {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
test("uncertain delivery and pending receipts after restart never forward again", async () => {
  expect(api.Ledger).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-unknown-"));
  let store = await Store.open(join(parent, "state"));
  try {
    let attempts = 0;
    const l = new api.Ledger(store),
      r = await l.perform(
        "device",
        id,
        "/messages",
        { text: "Hi" },
        async () => {
          attempts++;
          throw Error("lost response");
        },
      );
    expect(r.state).toBe("outcome_unknown");
    await store.update((s) => {
      Object.values(s.ledger)[0]!.receipt.state = "pending";
    });
    await store.close();
    store = await Store.open(join(parent, "state"));
    const next = await new api.Ledger(store).perform(
      "device",
      id,
      "/messages",
      { text: "Hi" },
      async () => {
        attempts++;
        return null;
      },
    );
    expect(next.state).toBe("outcome_unknown");
    expect(attempts).toBe(1);
  } finally {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
