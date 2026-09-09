import { describe, expect, test } from "bun:test";

import { sendWithRevertRollback } from "../src/react-app/domains/session/surface/safe-edit-resend";
import { PromptAdmissionUnknownError } from "../src/app/lib/opencode";
import { assertQueuedSendCurrent, dispatchQueuedDrain, getQueuedSendGeneration, resetQueuedDrainForTests } from "../src/react-app/domains/session/surface/queued-drain-machine";

describe("safe edit resend", () => {
  test("a late response failure after Stop cannot roll back the successor's history", async () => {
    resetQueuedDrainForTests();
    const sessionId = "ses_late_revert_response";
    const generation = getQueuedSendGeneration(sessionId);
    const response = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    const old = sendWithRevertRollback({
      assertCurrent: () => assertQueuedSendCurrent(sessionId, generation),
      revertMessageId: "msg_original",
      abort: async () => {},
      revert: async () => { calls.push("old-revert"); },
      prompt: async () => { started.resolve(); await response.promise; },
      unrevert: async () => { calls.push("unrevert"); },
    });
    await started.promise;
    dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
    calls.push("successor-revert");
    response.reject(new Error("Late HTTP 502"));
    await expect(old).rejects.toThrow("Send cancelled by Stop.");
    expect(calls).toEqual(["old-revert", "successor-revert"]);
    resetQueuedDrainForTests();
  });

  test("sends a normal draft without history mutation", async () => {
    const calls: string[] = [];
    await sendWithRevertRollback({
      abort: async () => calls.push("abort"),
      revert: async () => calls.push("revert"),
      prompt: async () => { calls.push("prompt"); },
      unrevert: async () => calls.push("unrevert"),
    });

    expect(calls).toEqual(["prompt"]);
  });

  test("orders revert before prompt and unreverts a failed replacement", async () => {
    const calls: string[] = [];
    const promptError = new Error("prompt dispatch failed");
    let thrown: unknown;

    try {
      await sendWithRevertRollback({
        revertMessageId: "message-a",
        abort: async () => calls.push("abort"),
        revert: async (messageId) => calls.push(`revert:${messageId}`),
        prompt: async () => {
          calls.push("prompt");
          throw promptError;
        },
        unrevert: async () => calls.push("unrevert"),
      });
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(["abort", "revert:message-a", "prompt", "unrevert"]);
    expect(thrown).toBe(promptError);
  });

  test("never unreverts or resubmits a replacement whose admission is unknown", async () => {
    const calls: string[] = [];
    const error = new PromptAdmissionUnknownError({ messageID: "msg_replacement" });
    await expect(sendWithRevertRollback({
      revertMessageId: "msg_original",
      abort: async () => calls.push("abort"),
      revert: async () => calls.push("revert"),
      prompt: async () => { calls.push("prompt"); throw error; },
      unrevert: async () => calls.push("unrevert"),
    })).rejects.toBe(error);
    expect(calls).toEqual(["abort", "revert", "prompt"]);
  });

  test.each(["abort", "revert"])("Stop during %s prevents the late replacement POST", async (stopAt) => {
    resetQueuedDrainForTests();
    const sessionId = "ses_edit_stop";
    const generation = getQueuedSendGeneration(sessionId);
    const calls: string[] = [];
    await expect(sendWithRevertRollback({
      assertCurrent: () => assertQueuedSendCurrent(sessionId, generation),
      revertMessageId: "msg_original",
      abort: async () => {
        calls.push("abort");
        if (stopAt === "abort") dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
      },
      revert: async () => {
        calls.push("revert");
        if (stopAt === "revert") dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
      },
      prompt: async () => { calls.push("prompt"); },
      unrevert: async () => calls.push("unrevert"),
    })).rejects.toThrow("Send cancelled by Stop.");
    expect(calls).toEqual(stopAt === "abort" ? ["abort"] : ["abort", "revert", "unrevert"]);
    resetQueuedDrainForTests();
  });
});
