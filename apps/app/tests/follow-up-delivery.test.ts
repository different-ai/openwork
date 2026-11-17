import { describe, expect, test } from "bun:test";

import { FOLLOW_UP_SETTLED_EVENT, FOLLOW_UP_WAITING_EVENT } from "../src/app/lib/follow-up-delivery";
import { createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import type { OpencodeEvent } from "../src/app/types";
import {
  addWaitingFollowUp,
  clearWaitingFollowUps,
  emptyFollowUpDeliveryBook,
  isFollowUpWaiting,
  settleWaitingFollowUp,
} from "../src/react-app/domains/session/status/follow-up-delivery-store";

const SESSION = "ses_follow_up";
const location = { directory: "/tmp/follow-up" };

function translateAll(events: unknown[]): OpencodeEvent[] {
  const state = createV2EventTranslationState();
  return events.flatMap((event) => translateV2Event(event, state) ?? []);
}

function inboxEvent(type: string, inboxID: string, item?: Record<string, unknown>) {
  return { type, created: 10, location, data: { sessionID: SESSION, inboxID, ...(item ? { item } : {}) } };
}

const sent = inboxEvent("session.inbox.enqueued", "msg_sent", { type: "user", payload: { text: "Use the staging database" } });

describe("translating engine inbox events", () => {
  test("a sent message appears in the chat and waits for the agent to read it", () => {
    const events = translateAll([sent]);
    expect(events.map((event) => event.type)).toEqual(["message.updated", "message.part.updated", FOLLOW_UP_WAITING_EVENT]);
    expect(events.at(-1)?.properties).toEqual({ sessionID: SESSION, messageID: "msg_sent" });
  });

  test("delivery ends the wait without touching the message", () => {
    expect(translateAll([inboxEvent("session.inbox.delivered", "msg_sent")])).toEqual([
      { type: FOLLOW_UP_SETTLED_EVENT, properties: { sessionID: SESSION, messageID: "msg_sent" } },
    ]);
  });

  test("a cancelled message is removed and stops waiting", () => {
    expect(translateAll([inboxEvent("session.inbox.cancelled", "msg_sent")])).toEqual([
      { type: "message.removed", properties: { sessionID: SESSION, messageID: "msg_sent" } },
      { type: FOLLOW_UP_SETTLED_EVENT, properties: { sessionID: SESSION, messageID: "msg_sent" } },
    ]);
  });
});

describe("messages waiting for the agent", () => {
  test("a message waits until it is settled", () => {
    const waiting = addWaitingFollowUp(emptyFollowUpDeliveryBook, SESSION, "msg_sent");
    expect(isFollowUpWaiting(waiting, SESSION, "msg_sent")).toBe(true);
    expect(isFollowUpWaiting(waiting, "ses_other", "msg_sent")).toBe(false);

    const settled = settleWaitingFollowUp(waiting, SESSION, "msg_sent");
    expect(isFollowUpWaiting(settled, SESSION, "msg_sent")).toBe(false);
    expect(settled).toEqual({});
  });

  test("settling one message leaves the others waiting", () => {
    const waiting = addWaitingFollowUp(addWaitingFollowUp(emptyFollowUpDeliveryBook, SESSION, "msg_first"), SESSION, "msg_second");
    const settled = settleWaitingFollowUp(waiting, SESSION, "msg_first");
    expect(isFollowUpWaiting(settled, SESSION, "msg_first")).toBe(false);
    expect(isFollowUpWaiting(settled, SESSION, "msg_second")).toBe(true);
  });

  test("a conversation that stops running has nothing waiting", () => {
    const waiting = addWaitingFollowUp(addWaitingFollowUp(emptyFollowUpDeliveryBook, SESSION, "msg_sent"), "ses_other", "msg_kept");
    const cleared = clearWaitingFollowUps(waiting, SESSION);
    expect(isFollowUpWaiting(cleared, SESSION, "msg_sent")).toBe(false);
    expect(isFollowUpWaiting(cleared, "ses_other", "msg_kept")).toBe(true);
  });

  test("changes that change nothing keep the same book", () => {
    const waiting = addWaitingFollowUp(emptyFollowUpDeliveryBook, SESSION, "msg_sent");
    expect(addWaitingFollowUp(waiting, SESSION, "msg_sent")).toBe(waiting);
    expect(settleWaitingFollowUp(waiting, SESSION, "msg_unknown")).toBe(waiting);
    expect(clearWaitingFollowUps(waiting, "ses_other")).toBe(waiting);
  });
});
