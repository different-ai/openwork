import { expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { UiControlMailbox } from "../../apps/server/src/ui-control.ts";

// No renderer, engine, private profile, or installed app is used here. This
// proves the server's registration contract, not the historical outage cause.
test("mailbox registration expires after a poll gap, independently of pin or engine work; a fresh poll restores it", async ({ evidence }) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const mailbox = new UiControlMailbox();
  const signal = new AbortController().signal;
  try {
    await mailbox.pending({ wait: false, signal });
    expect(mailbox.connected()).toBe(true);
    const inFlight = mailbox.request("command", { id: "session.archive", args: { sessionId: "fixture-idle" } });
    const delivered = await mailbox.pending({ wait: false, signal });
    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await inFlight).toMatchObject({ ok: false, error: expect.stringContaining("within 5 seconds") });
    expect(mailbox.reply(delivered[0].id, { ok: true })).toBe(false);
    // Processing an already-delivered command can stop the serial renderer
    // mailbox loop from polling; receipt timeout does not renew registration.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mailbox.connected()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mailbox.connected()).toBe(false);
    const rejected = await mailbox.request("query", { id: "session.read", args: { sessionId: "fixture-idle" } });
    expect(rejected).toEqual({ ok: false, error: "No OpenWork window is connected to this server. Open the OpenWork app or its web tab and try again." });
    // Rejected work was never enqueued and cannot mutate later.
    expect(await mailbox.pending({ wait: false, signal })).toEqual([]);
    expect(mailbox.connected()).toBe(true);
    const recovered = mailbox.request("query", { id: "session.read" });
    const next = await mailbox.pending({ wait: false, signal });
    expect(next).toHaveLength(1);
    expect(mailbox.reply(next[0].id, { ok: true, fixture: true })).toBe(true);
    expect(await recovered).toEqual({ ok: true, fixture: true });
    evidence.recordAssertionEvidence("Registration is recent-poll liveness, not OS window existence", "5s receipt timeout; late reply rejected; connected through 20,000ms, false at 20,001ms; session.read rejected before enqueue; fresh pending poll restores successful request/reply without engine or pin state.", true);
  } finally { vi.useRealTimers(); }
});
