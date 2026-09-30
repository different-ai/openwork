import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { conversationResponseLifetime } from "../worlds/conversation-response-lifetime.ts";

const test = spec.world(conversationResponseLifetime, {
  resources: { surfaces: [], services: [] },
  needs: { commands: ["node", "pnpm"] },
  timeout: 240_000,
});

test("a member can reopen a conversation while OpenWork verifies it in the background", async ({ world, step, evidence }) => {
  await step("before: the engine returns the conversation before its ownership check finishes", async () => {
    expect(world.ordering).toEqual({ ownershipDelayMs: 250, message: "immediate" });
    evidence.recordAssertionEvidence(
      "The proof recreates the production response order that exposed the failure",
      "The fake engine returns conversation messages immediately and delays the ownership lookup by 250 ms, leaving the completed response waiting inside OpenWork.",
      true,
    );
  });

  let observed: Awaited<ReturnType<typeof world.reopen>> | null = null;
  await step("the member reopens the conversation while Node collects completed engine responses", async () => {
    observed = await world.reopen();
    expect(observed.gcRuns).toBeGreaterThanOrEqual(5);
    expect(world.engineRequests.filter((path) => path.endsWith("/message"))).toHaveLength(24);
    evidence.recordAssertionEvidence(
      "Garbage collection ran inside the production Node server while conversation reads waited",
      `Node acknowledged ${observed.gcRuns} forced garbage-collection runs after the engine had returned all 24 message responses and before ownership verification finished.`,
      true,
    );
  });

  await step("after: every conversation reaches the member instead of becoming an internal server error", async () => {
    if (!observed) throw new Error("The conversation reads were not performed");
    const statuses = observed.results.map((result) => result.status);
    const internalErrors = observed.results.filter((result) => result.body.includes("internal_error"));
    const conversations = observed.results.filter((result) => result.body.includes("The conversation is ready."));
    if (internalErrors.length > 0) {
      const runtimeCause = observed.output.split("\n").find((line) => line.includes("Response body object should not be disturbed or locked"));
      throw new Error(`OpenWork returned ${internalErrors.length} internal server errors instead of the conversation. Runtime cause: ${runtimeCause ?? "not recorded"}`);
    }
    expect(statuses).toEqual(Array.from({ length: 24 }, () => 200));
    expect(conversations).toHaveLength(24);
    evidence.recordAssertionEvidence(
      "Every conversation read survives the collection window",
      `All 24 reads returned HTTP 200 with “The conversation is ready.”; 0 returned internal_error or “Response body object should not be disturbed or locked”.`,
      true,
    );
  });
});
