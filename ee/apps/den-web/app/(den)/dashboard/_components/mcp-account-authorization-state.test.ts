import assert from "node:assert/strict";
import { test } from "node:test";
import { pollMcpAuthorization } from "./mcp-account-authorization-state";

const timing = { startedAt: 0, timeoutMs: 90_000, now: () => 5_000 };

test("a tab that closes while the status fetch is in flight keeps polling", async () => {
  const tab = { closed: false };
  // The fetch started before the callback saved the account, then the callback closed the tab.
  const outcome = await pollMcpAuthorization({
    ...timing,
    authorizationWindow: tab,
    readConnected: async () => {
      tab.closed = true;
      return false;
    },
  });
  assert.equal(outcome, "pending");
});

test("a tab that was already closed when the fetch started fails the sign-in", async () => {
  const outcome = await pollMcpAuthorization({
    ...timing,
    authorizationWindow: { closed: true },
    readConnected: async () => false,
  });
  assert.equal(outcome, "window_closed");
});

test("a saved account connects even after the tab closed", async () => {
  const outcome = await pollMcpAuthorization({
    ...timing,
    authorizationWindow: { closed: true },
    readConnected: async () => true,
  });
  assert.equal(outcome, "connected");
});

test("an open tab past the time limit times out", async () => {
  const outcome = await pollMcpAuthorization({
    ...timing,
    now: () => 90_000,
    authorizationWindow: { closed: false },
    readConnected: async () => false,
  });
  assert.equal(outcome, "timeout");
});
