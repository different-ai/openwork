import { test } from "@openwork/testkit";
import { expect } from "vitest";
import {
  formatExpiryLabel,
  isClaimReminderDue,
  isTeamNudgeDue,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../../ee/apps/den-api/src/lifecycle-emails/policy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);

test("claim reminder waits most of a day and only fires while there is time to claim", () => {
  // 72-hour workspace created 21 hours ago: due.
  expect(isClaimReminderDue({ createdAt: ago(21 * HOUR), expiresAt: ahead(51 * HOUR), now })).toBe(true);
  // Too soon after setup.
  expect(isClaimReminderDue({ createdAt: ago(2 * HOUR), expiresAt: ahead(70 * HOUR), now })).toBe(false);
  // About to expire: a reminder would arrive too late to act on.
  expect(isClaimReminderDue({ createdAt: ago(70 * HOUR), expiresAt: ahead(2 * HOUR), now })).toBe(false);
});

test("team nudge targets an owner still alone two to fourteen days in, with no invites", () => {
  const base = { now, activeMemberCount: 1, invitationCount: 0 };
  expect(isTeamNudgeDue({ ...base, organizationCreatedAt: ago(3 * DAY) })).toBe(true);
  expect(isTeamNudgeDue({ ...base, organizationCreatedAt: ago(1 * DAY) })).toBe(false);
  expect(isTeamNudgeDue({ ...base, organizationCreatedAt: ago(20 * DAY) })).toBe(false);
  expect(isTeamNudgeDue({ ...base, organizationCreatedAt: ago(3 * DAY), activeMemberCount: 2 })).toBe(false);
  expect(isTeamNudgeDue({ ...base, organizationCreatedAt: ago(3 * DAY), invitationCount: 1 })).toBe(false);
});

test("unsubscribe tokens are bound to the address and the secret", () => {
  const secret = "test-secret-that-is-at-least-thirty-two-chars";
  const token = signUnsubscribeToken("Ada@Example.com ", secret);
  expect(verifyUnsubscribeToken("ada@example.com", token, secret)).toBe(true);
  expect(verifyUnsubscribeToken("eve@example.com", token, secret)).toBe(false);
  expect(verifyUnsubscribeToken("ada@example.com", token, `${secret}-rotated`)).toBe(false);
  expect(verifyUnsubscribeToken("ada@example.com", "not-a-real-token", secret)).toBe(false);
});

test("expiry label is a plain UTC sentence", () => {
  expect(formatExpiryLabel(new Date("2026-10-06T15:00:00Z"))).toBe("Tuesday, October 6 at 3:00 PM UTC");
});
