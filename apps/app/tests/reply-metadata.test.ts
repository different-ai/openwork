import { expect, test } from "bun:test";
import { projectedMessageMetadata } from "../src/lib/session-run";

test("resolved reply identity survives the shared projection with timing and terminal outcome", () => {
  const replyModel = { modelID: "served-model", providerID: "provider", name: "Served model", resolved: true };
  const metadata = projectedMessageMetadata({ time: { created: 1_000, completed: 8_000 }, parentID: "prompt",
    modelID: "requested-model", providerID: "provider", replyModel, error: { name: "MessageAbortedError" } });
  expect(metadata.opencode).toEqual({ created: 1_000, completed: 8_000, parentID: "prompt",
    model: { modelID: "requested-model", providerID: "provider" }, replyModel, outcome: "stopped" });
  expect(projectedMessageMetadata({ time: { created: 1_000 } }).opencode).not.toHaveProperty("replyModel");
});
