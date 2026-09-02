import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCUSSION_REGISTRY_FILE,
  configureDiscussionStore,
  discussionIds,
  discussionIdsForWorkspace,
  discussionLabel,
  discussionTitleFromPrompt,
  loadDiscussionRegistry,
  parseDiscussionRegistry,
  registerDiscussion,
  serializeDiscussionRegistry,
  splitDiscussionThreads,
} from "./discussions.ts";

test("parseDiscussionRegistry tolerates missing, malformed, and legacy shapes", () => {
  assert.deepEqual(parseDiscussionRegistry(null), []);
  assert.deepEqual(parseDiscussionRegistry("   "), []);
  assert.deepEqual(parseDiscussionRegistry("{not json"), []);
  assert.deepEqual(parseDiscussionRegistry('["ses_a", "ses_a", 3, " ses_b "]'), ["ses_a", "ses_b"]);
  assert.deepEqual(parseDiscussionRegistry(serializeDiscussionRegistry(["ses_a", "ses_b", "ses_a"])), ["ses_a", "ses_b"]);
  assert.equal(JSON.parse(serializeDiscussionRegistry(["ses_a"])).schemaVersion, 1);
});

test("discussionIds keeps the open discussion even when an older record never registered it", () => {
  assert.deepEqual(discussionIds(["ses_a"], "ses_b"), ["ses_a", "ses_b"]);
  assert.deepEqual(discussionIds(["ses_a", "ses_b"], "ses_b"), ["ses_a", "ses_b"]);
  assert.deepEqual(discussionIds([], ""), []);
});

test("splitDiscussionThreads never lets a discussion count as an assignment", () => {
  const threads = [
    { id: "ses_1", title: "Discussion with Scout" },
    { id: "ses_2", title: "Launch brief" },
    { id: "ses_3", title: "Street cleaning reminder" },
  ];
  const { discussions, assignments } = splitDiscussionThreads(threads, ["ses_1", "ses_3"]);
  assert.deepEqual(discussions.map((thread) => thread.id), ["ses_1", "ses_3"]);
  assert.deepEqual(assignments.map((thread) => thread.id), ["ses_2"]);
});

test("discussionLabel and discussionTitleFromPrompt read well in a list", () => {
  assert.equal(discussionLabel("Discussion with Scout", "Discussion with Scout"), "New discussion");
  assert.equal(discussionLabel("", "Discussion with Scout"), "New discussion");
  assert.equal(discussionLabel("Move the car on Fridays", "Discussion with Scout"), "Move the car on Fridays");
  assert.equal(discussionTitleFromPrompt("\n\n  can you   remember this\nsecond line"), "can you remember this");
  assert.equal(discussionTitleFromPrompt(""), "");
  const long = discussionTitleFromPrompt("x".repeat(100));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("the registry is written beside the coworker record and answers workspace lookups from cache", async () => {
  const files = new Map<string, string>();
  const reads: string[] = [];
  let listings = 0;
  configureDiscussionStore({
    readFile: async (slug, path) => {
      reads.push(`${slug}/${path}`);
      const content = files.get(`${slug}/${path}`);
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${slug}/${path}'`);
      return content;
    },
    writeFile: async (slug, path, content) => {
      files.set(`${slug}/${path}`, content);
    },
    listCoworkers: async () => {
      listings += 1;
      return [{ slug: "scout", workspaceId: "ws_1" }];
    },
  });
  try {
    assert.deepEqual(await loadDiscussionRegistry("scout"), []);
    assert.deepEqual(await registerDiscussion("scout", "ses_a"), ["ses_a"]);
    assert.deepEqual(await registerDiscussion("scout", "ses_b"), ["ses_a", "ses_b"]);
    assert.deepEqual(await registerDiscussion("scout", "ses_a"), ["ses_a", "ses_b"]);
    assert.deepEqual(parseDiscussionRegistry(files.get(`scout/${DISCUSSION_REGISTRY_FILE}`)), ["ses_a", "ses_b"]);
    assert.deepEqual(await discussionIdsForWorkspace("ws_1", "ses_c"), ["ses_a", "ses_b", "ses_c"]);
    assert.deepEqual(await discussionIdsForWorkspace("ws_1"), ["ses_a", "ses_b"]);
    assert.deepEqual(await discussionIdsForWorkspace("ws_unknown", "ses_z"), ["ses_z"]);
    // One read for the missing file, one coworker listing for the first lookup, another for the unknown workspace.
    assert.deepEqual(reads, [`scout/${DISCUSSION_REGISTRY_FILE}`]);
    assert.equal(listings, 2);
  } finally {
    configureDiscussionStore(null);
  }
});

test("without a configured store the registry reads as empty and refuses to write", async () => {
  assert.deepEqual(await loadDiscussionRegistry("nobody"), []);
  assert.deepEqual(await discussionIdsForWorkspace("ws_none", "ses_open"), ["ses_open"]);
  await assert.rejects(registerDiscussion("nobody", "ses_x"), /not available/);
});
