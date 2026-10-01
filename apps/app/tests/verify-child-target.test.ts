import { expect, test } from "bun:test";
import { verifyChildTarget } from "../src/lib/verify-child-target";

const records = { parent: { childSessionIds: ["child"], runStartedAt: 1_000 }, child: { childSessionIds: ["grandchild"], runStartedAt: 2_000 } };

test("a verified descendant can be targeted without targeting its siblings", async () => {
  const read: string[] = [];
  await verifyChildTarget("parent", "grandchild", [], records, async id => {
    read.push(id);
    return { parentID: id === "grandchild" ? "child" : "parent" };
  });
  expect(read).toEqual(["grandchild", "child"]);
  await expect(verifyChildTarget("parent", "unrelated", [], records, async () => { throw new Error("must not read"); })).rejects.toThrow("no longer associated");
});

test("stale associations and cyclic native ancestry cannot authorize Stop", async () => {
  await expect(verifyChildTarget("parent", "child", [], records, async () => ({ parentID: "other" }))).rejects.toThrow("parent could not be verified");
  const reads: string[] = [];
  await expect(verifyChildTarget("parent", "child", [], records, async id => {
    reads.push(id);
    return { parentID: id === "child" ? "other" : "child" };
  })).rejects.toThrow("parent could not be verified");
  expect(reads).toEqual(["child", "other", "child"]);
});
