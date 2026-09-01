import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createBot,
  defaultBotsDir,
  getBot,
  listBots,
  listMemoryFiles,
  parseFrontmatter,
  readBotFile,
  resolveBotFile,
  serializeFrontmatter,
  slugifyBotName,
  updateBot,
  writeBotFile,
} from "./bots.mjs";

const roots = [];
async function tempBotsDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "workbot-store-"));
  roots.push(dir);
  return path.join(dir, "bots");
}

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("defaultBotsDir lives inside the OpenWork config home", () => {
  const dir = defaultBotsDir({ env: { HOME: "/tmp/home" }, platform: "darwin", homeDir: "/tmp/home" });
  assert.equal(dir, "/tmp/home/.config/openwork/bots");
});

test("slugifyBotName produces stable directory names", () => {
  assert.equal(slugifyBotName("Research Bot"), "research-bot");
  assert.equal(slugifyBotName("  Émile's  QA — bot!  "), "miles-qa-bot");
  assert.equal(slugifyBotName("!!!"), "bot");
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

test("createBot writes the minimal bot filesystem representation", async () => {
  const botsDir = await tempBotsDir();
  const bot = await createBot(botsDir, {
    name: "Research Bot",
    role: "Research",
    mission: "Track competitors",
  });
  assert.equal(bot.slug, "research-bot");
  assert.equal(bot.name, "Research Bot");
  assert.equal(bot.workspaceId, "");
  assert.deepEqual(bot.automations, []);

  const soul = await readFile(path.join(bot.path, "soul.md"), "utf8");
  assert.match(soul, /Track competitors/);
  const agents = await readFile(path.join(bot.path, "AGENTS.md"), "utf8");
  assert.match(agents, /memory\/working\.md/);
  const opencodeConfig = JSON.parse(await readFile(path.join(bot.path, "opencode.json"), "utf8"));
  assert.deepEqual(opencodeConfig.instructions, ["soul.md", "memory/working.md", "memory/index.md"]);
  const working = await readFile(path.join(bot.path, "memory", "working.md"), "utf8");
  assert.match(working, /Working memory/);

  const listed = await listBots(botsDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, "research-bot");
});

test("createBot rejects duplicate slugs", async () => {
  const botsDir = await tempBotsDir();
  await createBot(botsDir, { name: "Twin" });
  await assert.rejects(() => createBot(botsDir, { name: "Twin" }), /already exists/);
});

test("updateBot patches platform references and deduplicates automations", async () => {
  const botsDir = await tempBotsDir();
  await createBot(botsDir, { name: "Ops" });
  const updated = await updateBot(botsDir, "ops", {
    workspaceId: "ws_local_1",
    automations: ["atm_a", "atm_a", " atm_b "],
  });
  assert.equal(updated.workspaceId, "ws_local_1");
  assert.deepEqual(updated.automations, ["atm_a", "atm_b"]);
  const reread = await getBot(botsDir, "ops");
  assert.equal(reread.workspaceId, "ws_local_1");
});

test("memory files are listed and editable through the store", async () => {
  const botsDir = await tempBotsDir();
  await createBot(botsDir, { name: "Memo" });
  await writeBotFile(botsDir, "memo", "memory/long-term/user-preferences.md", "# Prefs\n");
  const files = await listMemoryFiles(botsDir, "memo");
  const ids = files.map((file) => file.id);
  assert.ok(ids.includes("soul"));
  assert.ok(ids.includes("working"));
  assert.ok(ids.includes("index"));
  assert.ok(ids.includes("long-term/user-preferences.md"));
  const prefs = await readBotFile(botsDir, "memo", "memory/long-term/user-preferences.md");
  assert.equal(prefs, "# Prefs\n");
});

test("bot file access is contained to the bot directory", async () => {
  const botsDir = await tempBotsDir();
  await createBot(botsDir, { name: "Safe" });
  assert.throws(() => resolveBotFile(botsDir, "safe", "../other-bot/soul.md"), /escapes/);
  assert.throws(() => resolveBotFile(botsDir, "safe", "/etc/passwd"), /escapes/);
  assert.throws(() => resolveBotFile(botsDir, "../safe", "soul.md"), /Invalid bot slug/);
});
