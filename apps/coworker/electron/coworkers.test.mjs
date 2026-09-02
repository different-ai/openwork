import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createCoworker,
  defaultCoworkersDir,
  deleteRetiredCoworker,
  getCoworker,
  listCoworkers,
  listMemoryFiles,
  listRetiredCoworkers,
  parseFrontmatter,
  readCoworkerFile,
  resolveCoworkerFile,
  restoreCoworker,
  retireCoworker,
  serializeFrontmatter,
  slugifyCoworkerName,
  updateCoworker,
  writeCoworkerFile,
} from "./coworkers.mjs";

const roots = [];
async function tempCoworkersDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "coworker-store-"));
  roots.push(dir);
  return path.join(dir, "coworkers");
}

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("defaultCoworkersDir lives inside the OpenWork config home", () => {
  const dir = defaultCoworkersDir({ env: { HOME: "/tmp/home" }, platform: "darwin", homeDir: "/tmp/home" });
  assert.equal(dir, "/tmp/home/.config/openwork/coworkers");
});

test("slugifyCoworkerName produces stable directory names", () => {
  assert.equal(slugifyCoworkerName("Research Bot"), "research-bot");
  assert.equal(slugifyCoworkerName("  Émile's  QA — bot!  "), "miles-qa-bot");
  assert.equal(slugifyCoworkerName("!!!"), "coworker");
});

test("frontmatter codec round-trips strings and arrays", () => {
  const body = "# Body\n";
  const written = serializeFrontmatter(
    { name: "Ops: night shift", automations: ["atm_1", "atm_2"], workspaceId: "ws_9" },
    body,
  );
  const { data, body: parsedBody } = parseFrontmatter(written);
  assert.equal(data.name, "Ops: night shift");
  assert.deepEqual(data.automations, ["atm_1", "atm_2"]);
  assert.equal(data.workspaceId, "ws_9");
  assert.equal(parsedBody, body);
});

test("createCoworker writes the minimal coworker filesystem representation", async () => {
  const coworkersDir = await tempCoworkersDir();
  const coworker = await createCoworker(coworkersDir, {
    name: "Research Bot",
    role: "Research",
    mission: "Track competitors",
    avatarColor: "violet",
    avatarGlasses: "square",
  });
  assert.equal(coworker.slug, "research-bot");
  assert.equal(coworker.name, "Research Bot");
  assert.equal(coworker.workspaceId, "");
  assert.equal(coworker.conversationThreadId, "");
  assert.equal(coworker.modelVariant, "");
  assert.equal(coworker.avatarColor, "violet");
  assert.equal(coworker.avatarGlasses, "square");
  assert.equal(coworker.personality, "neutral", "personality defaults to neutral");
  assert.deepEqual(coworker.automations, []);

  const soul = await readFile(path.join(coworker.path, "soul.md"), "utf8");
  assert.match(soul, /Track competitors/);
  const agents = await readFile(path.join(coworker.path, "AGENTS.md"), "utf8");
  assert.match(agents, /memory\/working\.md/);
  assert.match(agents, /Open Coworker/);
  const opencodeConfig = JSON.parse(await readFile(path.join(coworker.path, "opencode.json"), "utf8"));
  assert.deepEqual(opencodeConfig.instructions, ["soul.md", "memory/working.md", "memory/index.md"]);
  const working = await readFile(path.join(coworker.path, "memory", "working.md"), "utf8");
  assert.match(working, /Working memory/);

  const listed = await listCoworkers(coworkersDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, "research-bot");
});

test("createCoworker rejects duplicate slugs", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Twin" });
  await assert.rejects(() => createCoworker(coworkersDir, { name: "Twin" }), /already exists/);
});

test("updateCoworker patches profile and platform references", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, { name: "Ops" });
  assert.equal(created.model, "");
  const updated = await updateCoworker(coworkersDir, "ops", {
    workspaceId: "ws_local_1",
    conversationThreadId: "ses_discussion_1",
    automations: ["atm_a", "atm_a", " atm_b "],
    model: "anthropic/claude-haiku-4-5",
    modelVariant: "high",
    avatarColor: "mint",
    avatarGlasses: "none",
  });
  assert.equal(updated.workspaceId, "ws_local_1");
  assert.equal(updated.conversationThreadId, "ses_discussion_1");
  assert.deepEqual(updated.automations, ["atm_a", "atm_b"]);
  assert.equal(updated.model, "anthropic/claude-haiku-4-5");
  assert.equal(updated.modelVariant, "high");
  assert.equal(updated.avatarColor, "mint");
  assert.equal(updated.avatarGlasses, "none");
  const reread = await getCoworker(coworkersDir, "ops");
  assert.equal(reread.workspaceId, "ws_local_1");
  assert.equal(reread.conversationThreadId, "ses_discussion_1");
  assert.equal(reread.model, "anthropic/claude-haiku-4-5");
  assert.equal(reread.modelVariant, "high");
  const cleared = await updateCoworker(coworkersDir, "ops", { model: "", modelVariant: "" });
  assert.equal(cleared.model, "");
  assert.equal(cleared.modelVariant, "");
});

test("avatar settings fall back when stored or patched values are unknown", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, {
    name: "Classic",
    avatarColor: "chartreuse",
    avatarGlasses: "monocle",
  });
  assert.equal(created.avatarColor, "blue");
  assert.equal(created.avatarGlasses, "round");
  const updated = await updateCoworker(coworkersDir, "classic", {
    avatarColor: "unknown",
    avatarGlasses: "unknown",
    personality: "sarcastic-pirate",
  });
  assert.equal(updated.avatarColor, "blue");
  assert.equal(updated.avatarGlasses, "round");
  assert.equal(updated.personality, "neutral", "unknown personalities fall back to neutral");
  const voiced = await updateCoworker(coworkersDir, "classic", { personality: "chef" });
  assert.equal(voiced.personality, "chef");
  assert.equal((await getCoworker(coworkersDir, "classic")).personality, "chef", "personality persists in coworker.md");
  const silent = await createCoworker(coworkersDir, { name: "Quiet", personality: "none" });
  assert.equal(silent.personality, "none");
});

test("memory files are listed and editable through the store", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Memo" });
  await writeCoworkerFile(coworkersDir, "memo", "memory/long-term/user-preferences.md", "# Prefs\n");
  const files = await listMemoryFiles(coworkersDir, "memo");
  const ids = files.map((file) => file.id);
  assert.ok(ids.includes("soul"));
  assert.ok(ids.includes("working"));
  assert.ok(ids.includes("index"));
  assert.ok(ids.includes("long-term/user-preferences.md"));
  const prefs = await readCoworkerFile(coworkersDir, "memo", "memory/long-term/user-preferences.md");
  assert.equal(prefs, "# Prefs\n");
  const working = files.find((file) => file.id === "working");
  assert.ok(working.updatedAt > 0, "memory files report when they were last modified");
  assert.ok(Math.abs(Date.now() - working.updatedAt) < 60_000);
});

test("coworker file access is contained to the coworker directory", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Safe" });
  assert.throws(() => resolveCoworkerFile(coworkersDir, "safe", "../other/soul.md"), /escapes/);
  assert.throws(() => resolveCoworkerFile(coworkersDir, "safe", "/etc/passwd"), /escapes/);
  assert.throws(() => resolveCoworkerFile(coworkersDir, "../safe", "soul.md"), /Invalid coworker slug/);
});

test("retirement archives the whole home and restore brings it back intact", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, { name: "Archivist", role: "Records" });
  await updateCoworker(coworkersDir, "archivist", { workspaceId: "ws_archive", model: "anthropic/claude-haiku-4-5" });
  await writeCoworkerFile(coworkersDir, "archivist", "workspace/report.md", "# Report\n");
  await writeCoworkerFile(coworkersDir, "archivist", "memory/long-term/people.md", "# People\n");

  const retired = await retireCoworker(coworkersDir, "archivist", { now: Date.UTC(2026, 8, 1, 20, 15, 30) });
  assert.equal(retired.archiveId, "archivist-20260901201530");
  assert.equal((await listCoworkers(coworkersDir)).length, 0, "retired coworkers leave the active roster");
  assert.equal(await readFile(path.join(retired.path, "workspace", "report.md"), "utf8"), "# Report\n");

  const listed = await listRetiredCoworkers(coworkersDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, "archivist");
  assert.equal(listed[0].name, "Archivist");
  assert.equal(listed[0].role, "Records");
  assert.equal(listed[0].retiredAt, "2026-09-01T20:15:30.000Z");
  assert.equal(listed[0].canRestore, true);
  assert.ok(listed[0].fileCount >= 8, `expected the full home to be counted, got ${listed[0].fileCount}`);

  const restored = await restoreCoworker(coworkersDir, retired.archiveId);
  assert.equal(restored.slug, created.slug);
  assert.equal(restored.workspaceId, "ws_archive");
  assert.equal(restored.model, "anthropic/claude-haiku-4-5");
  assert.equal(await readCoworkerFile(coworkersDir, "archivist", "workspace/report.md"), "# Report\n");
  const config = await readFile(path.join(restored.path, "coworker.md"), "utf8");
  assert.doesNotMatch(config, /retiredSlug|retiredAt/, "restore removes the archive markers");
  assert.deepEqual(await listRetiredCoworkers(coworkersDir), []);
});

test("restore refuses to overwrite a live coworker and permanent delete is explicit", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Twin" });
  const retired = await retireCoworker(coworkersDir, "twin", { now: Date.UTC(2026, 8, 1, 9, 0, 0) });
  await createCoworker(coworkersDir, { name: "Twin" });
  const [entry] = await listRetiredCoworkers(coworkersDir);
  assert.equal(entry.canRestore, false);
  await assert.rejects(() => restoreCoworker(coworkersDir, retired.archiveId), /already exists/);
  await assert.rejects(() => restoreCoworker(coworkersDir, "../twin"), /Invalid retired coworker id/);
  await deleteRetiredCoworker(coworkersDir, retired.archiveId);
  assert.deepEqual(await listRetiredCoworkers(coworkersDir), []);
  assert.equal((await listCoworkers(coworkersDir)).length, 1, "the live twin is untouched");
});
