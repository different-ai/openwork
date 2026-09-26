import { expect, test } from "bun:test";
import { createV2ReadAdapter, readV2SessionActivity } from "./opencode-v2-read-adapter.js";

test("native reads preserve the home and chronological visible text across pages", async () => {
  const read = createV2ReadAdapter(async path => {
    if (path.endsWith("/session/ses_a")) return { data: { id: "ses_a", location: { directory: "/worktree" }, openworkHomeDirectory: "/home" } };
    if (path.includes("cursor=next")) return { data: [{ id: "old", type: "user", time: { created: 1 }, text: "first" }], cursor: { next: null } };
    return { data: [{ id: "new", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "last" }, { type: "reasoning", text: "private" }] }], cursor: { next: "next" } };
  });
  expect(await read("/workspace/ws/opencode/session/ses_a")).toMatchObject({ directory: "/home" });
  const messages = await read("/workspace/ws/opencode/session/ses_a/message");
  expect(messages).toEqual([
    { info: { id: "old", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "first" }] },
    { info: { id: "new", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "last" }] },
  ]);
});

test("idle parents report busy and waiting descendants without unrelated permissions", async () => {
  const paths: string[] = [];
  const activity = await readV2SessionActivity(async path => {
    paths.push(path);
    if (path.includes("/session?")) return { data: [
      { id: "parent" }, { id: "child", parentID: "parent" }, { id: "grandchild", parentID: "child" }, { id: "other" },
    ] };
    if (path.endsWith("/active")) return { data: { child: { type: "running" }, grandchild: { type: "running" } } };
    if (path.endsWith("/grandchild/form")) return { data: [{ id: "ask" }] };
    return { data: [] };
  }, "ws", "parent");
  expect(activity).toMatchObject({ status: "waiting", working: true, inventoryComplete: true, descendantActivity: { busy: 1, waiting: 1, unknown: 0 } });
  expect(paths.some(path => path.includes("/other/"))).toBe(false);
});

test("failed pending-request reads remain unknown rather than claiming idle", async () => {
  const activity = await readV2SessionActivity(async path => {
    if (path.includes("/session?")) return { data: [{ id: "parent" }] };
    if (path.endsWith("/active")) return { data: {} };
    throw new Error("offline");
  }, "ws", "parent");
  expect(activity).toMatchObject({ status: "unknown", inventoryComplete: false });
});
