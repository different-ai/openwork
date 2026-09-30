import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { computerUseHelper } from "../worlds/computer-use-helper.ts";

test("Computer Use starts after switching macOS distribution architectures", { timeout: 600_000 }, async ({ evidence }) => {
  const helper = computerUseHelper();
  console.log("placement: local (native macOS helper MCP boundary)");
  try {
    for (const [target, arch] of [
      ["aarch64-apple-darwin", "arm64"],
      ["x86_64-apple-darwin", "x86_64"],
      ["aarch64-apple-darwin", "arm64"],
    ]) {
      expect(helper.stage(target)).toEqual({ architectures: [arch], reused: false });
      expect(helper.initialize()).toEqual([
        expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: expect.objectContaining({ name: "openwork-computer-use" }) }) }),
        expect.objectContaining({ id: 2, result: expect.objectContaining({ tools: expect.any(Array) }) }),
      ]);
      expect(helper.stage(target)).toEqual({ architectures: [arch], reused: true });
      evidence.recordAssertionEvidence(
        `${arch} helper starts and answers MCP`,
        `The ${target} helper contains only ${arch}, replaces the previous architecture, answers initialize and tools/list, and is reused only on the next same-target preparation.`,
        true,
      );
    }
  } finally {
    helper.close();
  }
});
