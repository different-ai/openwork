import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createCoworker,
  defaultCoworkersDir,
  getCoworker,
  listCoworkers,
  listMemoryFiles,
  parseFrontmatter,
  readCoworkerFile,
  resolveCoworkerFile,
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
  });
  assert.equal(coworker.slug, "research-bot");
  assert.equal(coworker.name, "Research Bot");
  assert.equal(coworker.workspaceId, "");
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

test("updateCoworker patches platform references and deduplicates automations", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, { name: "Ops" });
  assert.equal(created.model, "");
  const updated = await updateCoworker(coworkersDir, "ops", {
    workspaceId: "ws_local_1",
    automations: ["atm_a", "atm_a", " atm_b "],
    model: "anthropic/claude-haiku-4-5",
  });
  assert.equal(updated.workspaceId, "ws_local_1");
  assert.deepEqual(updated.automations, ["atm_a", "atm_b"]);
  assert.equal(updated.model, "anthropic/claude-haiku-4-5");
  const reread = await getCoworker(coworkersDir, "ops");
  assert.equal(reread.workspaceId, "ws_local_1");
  assert.equal(reread.model, "anthropic/claude-haiku-4-5");
  const cleared = await updateCoworker(coworkersDir, "ops", { model: "" });
  assert.equal(cleared.model, "");
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
});

test("coworker file access is contained to the coworker directory", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Safe" });
  assert.throws(() => resolveCoworkerFile(coworkersDir, "safe", "../other/soul.md"), /escapes/);
  assert.throws(() => resolveCoworkerFile(coworkersDir, "safe", "/etc/passwd"), /escapes/);
  assert.throws(() => resolveCoworkerFile(coworkersDir, "../safe", "soul.md"), /Invalid coworker slug/);
});
