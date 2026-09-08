import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createTemplateInstaller, exportCoworkerTemplate, parseCoworkerTemplateFile, templateScope } from "./templates.mjs";
import {
  AGENTS_CONTRACT_VERSION,
  agentsContractVersion,
  agentsTemplate,
  createCoworker,
  createLongTermMemory,
  deleteLongTermMemory,
  deleteRetiredCoworker,
  getCoworker,
  indexLongTermMemory,
  listCoworkers,
  listLongTermMemories,
  listRetiredCoworkers,
  readCoworkerFile,
  repairCoworkerContract,
  resolveCoworkerFile,
  restoreCoworker,
  retireCoworker,
  updateCoworker,
  writeCoworkerFile,
} from "./coworkers.mjs";

const roots = [];
async function tempCoworkersDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "coworker-store-"));
  roots.push(dir);
  return path.join(dir, "coworkers");
}

test("template import gives a recoverable message for invalid JSON and private fields", () => {
  for (const contents of ["not json", JSON.stringify({ kind: "coworker", schemaVersion: 1, name: "Invalid", memory: "private" })]) {
    assert.throws(() => parseCoworkerTemplateFile(contents), { message: "Choose a valid coworker template. Memory, credentials, and working files are not accepted." });
  }
});

test("assigned templates create once, preserve working copies across updates, and respect retirement", async () => {
  const dir = await tempCoworkersDir();
  const create = (input) => createCoworker(dir, input);
  const install = createTemplateInstaller(dir, create);
  const template = { kind: "coworker", schemaVersion: 1, name: "Campaign partner", description: "Campaign planning", role: "Marketing", mission: "Plan campaigns", instructions: "Ask for the audience before drafting.", provisioning: "automatic" };
  const items = [{ id: "assigned", versionId: "one", template, assigned: true }, { id: "catalog-only", versionId: "one", template: { ...template, name: "Catalog only" }, assigned: false }];
  const input = { scope: "first-account", items, automatic: true };
  const runs = await Promise.all([install(input), install(input)]);
  assert.equal(runs.flatMap((run) => run.created).length, 1);
  const coworker = (await listCoworkers(dir))[0];
  assert.equal(coworker.name, template.name);
  assert.match(await readCoworkerFile(dir, coworker.slug, "soul.md"), /Ask for the audience/);
  await writeCoworkerFile(dir, coworker.slug, "soul.md", "My evolving private instructions");
  await writeCoworkerFile(dir, coworker.slug, "memory/working.md", "My private work in progress");
  const updated = { ...input, items: [{ ...items[0], versionId: "two", template: { ...template, instructions: "New starting instructions" } }] };
  const refreshed = await install(updated);
  assert.equal(refreshed.created.length, 0);
  assert.equal(refreshed.items[0].updateAvailable, true);
  assert.equal(await readCoworkerFile(dir, coworker.slug, "soul.md"), "My evolving private instructions");
  const exported = await exportCoworkerTemplate(dir, coworker.slug);
  assert.equal(exported.instructions, template.instructions);
  assert.equal(exported.provisioning, "optional");
  assert.doesNotMatch(JSON.stringify(exported), /private|workspaceId|model|automations|templateOrigin/);
  await retireCoworker(dir, coworker.slug);
  assert.equal((await createTemplateInstaller(dir, create)(updated)).created.length, 0);
  assert.equal((await listCoworkers(dir)).length, 0);
  // An explicitly requested optional template is still available to add.
  const optional = { ...items[1], template: { ...template, name: "Optional", provisioning: "optional" } };
  assert.equal((await install({ scope: "first-account", items: [optional], automatic: true })).created.length, 0);
  assert.equal((await install({ scope: "first-account", items: [optional], installIds: [optional.id] })).created.length, 1);
  const longName = "Campaign ".repeat(8).trim();
  const duplicates = ["long-one", "long-two"].map((id) => ({ ...items[0], id, template: { ...template, name: longName } }));
  const longCopies = await install({ scope: "first-account", items: duplicates, automatic: true });
  assert.equal(new Set(longCopies.created.map((item) => item.slug)).size, 2);
});

test("template imports reject extra private fields and separate account and server scopes", async () => {
  const dir = await tempCoworkersDir();
  const install = createTemplateInstaller(dir, (input) => createCoworker(dir, input));
  const template = { kind: "coworker", schemaVersion: 1, name: "Unsafe", description: "Test", role: "Test", mission: "Test", memory: "private" };
  await assert.rejects(install({ scope: "test", items: [{ id: "one", versionId: "one", assigned: true, template }], automatic: true }));
  assert.deepEqual(await listCoworkers(dir), []);
  const session = { baseUrl: "https://connect.example.test/first", orgId: "org-one" };
  assert.equal(templateScope(session, "Member@example.test"), templateScope(session, "member@example.test"));
  assert.notEqual(templateScope(session, "member@example.test"), templateScope({ ...session, orgId: "org-two" }, "member@example.test"));
  assert.notEqual(templateScope(session, "member@example.test"), templateScope({ ...session, baseUrl: "https://connect.example.test/second" }, "member@example.test"));
  assert.notEqual(templateScope(session, "member@example.test"), templateScope(session, "colleague@example.test"));
});

test("avatar choices survive creation, template export and import, and reload", async () => {
  const dir = await tempCoworkersDir();
  const importedDir = await tempCoworkersDir();
  const install = createTemplateInstaller(importedDir, (input) => createCoworker(importedDir, input));
  const appearance = { avatarColor: "sage", avatarGlasses: "monocle" };
  const created = await createCoworker(dir, { name: "Classic", ...appearance });
  const template = parseCoworkerTemplateFile(JSON.stringify(await exportCoworkerTemplate(dir, created.slug)));
  const imported = await install({ scope: "file", items: [{ id: created.slug, versionId: "one", template }], installIds: [created.slug] });
  assert.equal(imported.created.length, 1);
  const reloaded = await getCoworker(importedDir, imported.created[0].slug);
  assert.equal(reloaded.avatarColor, appearance.avatarColor);
  assert.equal(reloaded.avatarGlasses, appearance.avatarGlasses);
  for (const patch of [{ avatarColor: "unknown" }, { avatarGlasses: "unknown" }]) {
    assert.throws(() => parseCoworkerTemplateFile(JSON.stringify({ ...template, ...patch })), /Choose a valid coworker template/);
  }
});

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("every coworker reads a description of its team that follows the team through create, retire, and restore", async () => {
  const coworkersDir = await tempCoworkersDir();
  const nova = await createCoworker(coworkersDir, {
    name: "Nova",
    role: "Research and synthesis",
    mission: "I dig into questions.",
    roleId: "research",
    firstNote: "Joined the team on Sep 3 to help with research and writing.",
  });
  assert.equal(nova.roleId, "research");
  assert.match(await readFile(path.join(nova.path, "memory", "working.md"), "utf8"), /- Joined the team on Sep 3 to help with research and writing\./);

  const care = await createCoworker(coworkersDir, {
    name: "Care",
    role: "Customer support",
    mission: "I watch the inbox.",
    roleId: "support",
    suggestedBy: { slug: "nova", why: "the support inbox comes up every morning" },
    firstNote: "Joined the team on Sep 3; Nova suggested me because the support inbox comes up every morning.",
  });
  assert.deepEqual(care.suggestedBy, { slug: "nova", why: "the support inbox comes up every morning" });
  const reread = await getCoworker(coworkersDir, "care");
  assert.deepEqual(reread.suggestedBy, care.suggestedBy, "who suggested a coworker survives a reread");

  // Both descriptions name the other; neither carries the other's memory.
  const novaRoster = await readFile(path.join(nova.path, "team", "roster.md"), "utf8");
  assert.match(novaRoster, /- Care \(`care`\) — Customer support — I watch the inbox\./);
  assert.doesNotMatch(novaRoster, /Nova \(`nova`\)/, "a coworker is not its own teammate");
  assert.doesNotMatch(novaRoster, /Joined the team/, "another coworker's memory never enters the description");
  assert.match(await readFile(path.join(care.path, "team", "roster.md"), "utf8"), /- Nova \(`nova`\) — Research and synthesis — I dig into questions\./);

  // A mission change reaches teammates; a model change is not theirs to know.
  await updateCoworker(coworkersDir, "care", { mission: "I watch the inbox and the chat." });
  assert.match(await readFile(path.join(nova.path, "team", "roster.md"), "utf8"), /I watch the inbox and the chat\./);

  const retired = await retireCoworker(coworkersDir, "care");
  assert.match(await readFile(path.join(nova.path, "team", "roster.md"), "utf8"), /No teammates yet/);
  await restoreCoworker(coworkersDir, retired.archiveId);
  assert.match(await readFile(path.join(nova.path, "team", "roster.md"), "utf8"), /- Care \(`care`\)/);

  // Unknown catalog ids and malformed proposers are dropped, never stored.
  const loose = await createCoworker(coworkersDir, { name: "Loose", roleId: "wizard", suggestedBy: { slug: "../x", why: "no" } });
  assert.equal(loose.roleId, "");
  assert.equal(loose.suggestedBy, null);
});

test("repairing an older coworker regenerates only the app-owned contract files", async () => {
  const coworkersDir = await tempCoworkersDir();
  const coworker = await createCoworker(coworkersDir, { name: "Legacy" });
  // Make it look like a coworker created before documents existed.
  await writeFile(path.join(coworker.path, "AGENTS.md"), "# Legacy — coworker contract\n\nOld words.\n", "utf8");
  await writeFile(path.join(coworker.path, "opencode.json"), `${JSON.stringify({ $schema: "x", instructions: ["soul.md", "memory/working.md", "memory/index.md"], mcp: { keep: { type: "remote", url: "http://x" } } }, null, 2)}\n`, "utf8");
  await rm(path.join(coworker.path, "documents"), { recursive: true, force: true });
  await writeFile(path.join(coworker.path, "soul.md"), "# Soul — Legacy\n\nMy own words.\n", "utf8");
  await writeFile(path.join(coworker.path, "memory", "working.md"), "# Working memory\n\n- remembered\n", "utf8");

  await rm(path.join(coworker.path, "team"), { recursive: true, force: true });

  const repaired = await repairCoworkerContract(coworkersDir, "legacy");
  assert.deepEqual(repaired.changed, ["AGENTS.md", "opencode.json", "documents/index.md", "team/roster.md"]);
  const agents = await readFile(path.join(coworker.path, "AGENTS.md"), "utf8");
  assert.match(agents, /## How I talk/);
  assert.match(agents, /## My team/);
  assert.match(agents, /# Legacy — coworker contract/);
  const config = JSON.parse(await readFile(path.join(coworker.path, "opencode.json"), "utf8"));
  assert.deepEqual(config.instructions, ["soul.md", "memory/working.md", "memory/index.md", "documents/index.md", "team/roster.md"]);
  assert.deepEqual(config.mcp, { keep: { type: "remote", url: "http://x" } }, "other config keys survive the repair");
  assert.match(await readFile(path.join(coworker.path, "documents", "index.md"), "utf8"), /\(none yet\)/);
  assert.match(await readFile(path.join(coworker.path, "team", "roster.md"), "utf8"), /^# My team/);
  // Soul and memory are the coworker's; the repair never touches them.
  assert.equal(await readFile(path.join(coworker.path, "soul.md"), "utf8"), "# Soul — Legacy\n\nMy own words.\n");
  assert.equal(await readFile(path.join(coworker.path, "memory", "working.md"), "utf8"), "# Working memory\n\n- remembered\n");

  // Already current: nothing to do, nothing rewritten.
  const again = await repairCoworkerContract(coworkersDir, "legacy");
  assert.deepEqual(again.changed, []);
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
  const soul = await readCoworkerFile(coworkersDir, "ops", "soul.md");
  const patch = { avatarColor: "sage", avatarGlasses: "monocle" };
  await updateCoworker(coworkersDir, "ops", patch);
  assert.deepEqual(await getCoworker(coworkersDir, "ops"), { ...reread, ...patch });
  assert.equal(await readCoworkerFile(coworkersDir, "ops", "soul.md"), soul, "appearance leaves instructions untouched");
  const cleared = await updateCoworker(coworkersDir, "ops", { model: "", modelVariant: "" });
  assert.equal(cleared.model, "");
  assert.equal(cleared.modelVariant, "");
});

test("the record says who chose the model: the app's pick may be swapped once, the person's never, and a record that never said is the person's", async () => {
  const coworkersDir = await tempCoworkersDir();
  const coworker = await createCoworker(coworkersDir, { name: "Pilot" });
  assert.equal(coworker.modelChosenBy, "", "a new coworker has no model and no chooser yet");
  const picked = await updateCoworker(coworkersDir, "pilot", { model: "openwork/claude", modelVariant: "", modelChosenBy: "app" });
  assert.equal(picked.modelChosenBy, "app");
  assert.equal((await getCoworker(coworkersDir, "pilot")).modelChosenBy, "app", "the answer survives a re-read (a relaunch)");
  const effort = await updateCoworker(coworkersDir, "pilot", { modelVariant: "high" });
  assert.equal(effort.modelChosenBy, "app", "an effort alone does not change who chose the model; the renderer says so when the person did");
  const chosen = await updateCoworker(coworkersDir, "pilot", { model: "openwork/claude", modelVariant: "high", modelChosenBy: "person" });
  assert.equal(chosen.modelChosenBy, "person");
  const unsaid = await updateCoworker(coworkersDir, "pilot", { model: "openwork/other", modelVariant: "" });
  assert.equal(unsaid.modelChosenBy, "", "a model change that does not say who chose it is the person's: the app never inherits a claim");
  assert.equal((await updateCoworker(coworkersDir, "pilot", { modelChosenBy: "nobody" })).modelChosenBy, "", "unknown values read as the person's");
  // A record written before the field existed reads as the person's.
  const legacy = await createCoworker(coworkersDir, { name: "Legacy" });
  const configPath = path.join(legacy.path, "coworker.md");
  await writeFile(configPath, (await readFile(configPath, "utf8")).replace(/^modelChosenBy: .*\n/m, "").replace(/^model: .*$/m, 'model: "openwork/claude"'), "utf8");
  assert.equal((await getCoworker(coworkersDir, "legacy")).model, "openwork/claude");
  assert.equal((await getCoworker(coworkersDir, "legacy")).modelChosenBy, "");
});

test("a coworker's model mode: one model every time until the picker chooses Automatic, and records from before the field mean the same", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, { name: "Ops" });
  assert.equal(created.modelMode, "fixed", "Automatic is chosen, not assumed: on the free provider a lane pick must be proven to stay among the free models first");
  assert.match(await readFile(path.join(created.path, "coworker.md"), "utf8"), /^modelMode: fixed$/m);
  assert.equal((await updateCoworker(coworkersDir, "ops", { model: "openai/gpt-5", modelMode: "auto" })).modelMode, "auto");
  // The app persisting the standard model it picked leaves the mode alone; the person fixing a model turns Automatic off.
  assert.equal((await updateCoworker(coworkersDir, "ops", { model: "openai/gpt-5" })).modelMode, "auto");
  const fixed = await updateCoworker(coworkersDir, "ops", { model: "openai/gpt-5", modelMode: "fixed" });
  assert.equal(fixed.modelMode, "fixed");
  assert.equal((await getCoworker(coworkersDir, "ops")).modelMode, "fixed");
  assert.equal((await updateCoworker(coworkersDir, "ops", { modelMode: "nonsense" })).modelMode, "fixed", "an unknown mode changes nothing");
  assert.equal((await updateCoworker(coworkersDir, "ops", { modelMode: "auto" })).modelMode, "auto");
  // A coworker.md from before the field means one model every time, whether or not a model is saved.
  const configPath = path.join(created.path, "coworker.md");
  const withoutField = (await readFile(configPath, "utf8")).replace(/^modelMode: .*\n/m, "");
  await writeFile(configPath, withoutField, "utf8");
  assert.equal((await getCoworker(coworkersDir, "ops")).modelMode, "fixed");
  await writeFile(configPath, withoutField.replace(/^model: .*$/m, 'model: ""'), "utf8");
  assert.equal((await getCoworker(coworkersDir, "ops")).modelMode, "fixed");
});

test("avatar settings fall back when stored or patched values are unknown", async () => {
  const coworkersDir = await tempCoworkersDir();
  const created = await createCoworker(coworkersDir, {
    name: "Classic",
    avatarColor: "chartreuse",
    avatarGlasses: "unknown",
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
  const voiced = await updateCoworker(coworkersDir, "classic", { personality: "playful" });
  assert.equal(voiced.personality, "playful");
  assert.equal((await getCoworker(coworkersDir, "classic")).personality, "playful", "personality persists in coworker.md");
  const silent = await createCoworker(coworkersDir, { name: "Quiet", personality: "none" });
  assert.equal(silent.personality, "none");
});

test("long-term memories join the index with the files on disk", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Memo" });
  assert.deepEqual(await listLongTermMemories(coworkersDir, "memo"), [], "a new coworker has no long-term memories");

  // The coworker promotes two memories and lists them; a third file is written without an index line;
  // a fourth index line points at a file that no longer exists.
  await writeCoworkerFile(coworkersDir, "memo", "memory/long-term/cleaning-day.md", "# Street cleaning\n\n- Move the car every **Friday**.\n");
  await writeCoworkerFile(coworkersDir, "memo", "memory/long-term/people.md", "# People\n");
  await writeCoworkerFile(coworkersDir, "memo", "memory/long-term/stray-notes.md", "Some notes without a heading\n");
  await writeCoworkerFile(
    coworkersDir,
    "memo",
    "memory/index.md",
    "# Long-term memory index\n\nOne line per durable memory.\n\n- `long-term/people.md` — Who is who\n- `long-term/cleaning-day.md` — Street cleaning: move car every Friday\n- `long-term/gone.md` — Promoted then lost\n",
  );
  const memories = await listLongTermMemories(coworkersDir, "memo");
  assert.deepEqual(
    memories.map(({ file, title, summary, indexed, exists }) => ({ file, title, summary, indexed, exists })),
    [
      { file: "people.md", title: "People", summary: "Who is who", indexed: true, exists: true },
      { file: "cleaning-day.md", title: "Street cleaning", summary: "Street cleaning: move car every Friday", indexed: true, exists: true },
      { file: "gone.md", title: "Gone", summary: "Promoted then lost", indexed: true, exists: false },
      { file: "stray-notes.md", title: "Stray notes", summary: "", indexed: false, exists: true },
    ],
    "index order first, then unindexed files; missing files stay visible",
  );
  assert.equal(memories[0].id, "long-term/people.md");
  assert.equal(memories[0].path, path.join("memory", "long-term", "people.md"));
  assert.ok(memories[0].updatedAt > 0);
  assert.equal(memories[2].updatedAt, 0);

  // Adding the stray file to the index uses its title when no summary is given.
  await indexLongTermMemory(coworkersDir, "memo", "stray-notes.md");
  const indexAfterAdd = await readCoworkerFile(coworkersDir, "memo", "memory/index.md");
  assert.ok(indexAfterAdd.includes("- `long-term/stray-notes.md` — Stray notes"));

  // Deleting a memory removes the file and its index line together; a missing file is just its line.
  await deleteLongTermMemory(coworkersDir, "memo", "cleaning-day.md");
  await deleteLongTermMemory(coworkersDir, "memo", "gone.md");
  const indexAfterDelete = await readCoworkerFile(coworkersDir, "memo", "memory/index.md");
  assert.ok(!indexAfterDelete.includes("cleaning-day.md"));
  assert.ok(!indexAfterDelete.includes("gone.md"));
  assert.ok(indexAfterDelete.includes("- `long-term/people.md` — Who is who"), "other lines and prose are untouched");
  assert.ok(indexAfterDelete.startsWith("# Long-term memory index\n\nOne line per durable memory.\n"));
  await assert.rejects(readCoworkerFile(coworkersDir, "memo", "memory/long-term/cleaning-day.md"));
  assert.deepEqual((await listLongTermMemories(coworkersDir, "memo")).map((memory) => memory.file), ["people.md", "stray-notes.md"]);

  // File names are never paths.
  await assert.rejects(deleteLongTermMemory(coworkersDir, "memo", "../soul.md"), /Not a memory file name/);
  await assert.rejects(deleteLongTermMemory(coworkersDir, "memo", "long-term/people.md"), /Not a memory file name/);
  assert.equal(await readCoworkerFile(coworkersDir, "memo", "soul.md").then(() => true), true);
});

test("a memory created by hand gets a titled file, a unique name, and an index line", async () => {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Memo" });
  const first = await createLongTermMemory(coworkersDir, "memo", { title: "Street cleaning", summary: "Move the car every Friday" });
  assert.equal(first.file, "street-cleaning.md");
  assert.equal(first.title, "Street cleaning");
  assert.equal(first.summary, "Move the car every Friday");
  assert.equal(first.indexed, true);
  assert.equal(await readCoworkerFile(coworkersDir, "memo", "memory/long-term/street-cleaning.md"), "# Street cleaning\n\n");
  const index = await readCoworkerFile(coworkersDir, "memo", "memory/index.md");
  assert.ok(!index.includes("(none yet)"), "the template placeholder gives way to the first entry");
  assert.ok(index.includes("- `long-term/street-cleaning.md` — Move the car every Friday"));

  const second = await createLongTermMemory(coworkersDir, "memo", { title: "Street cleaning" });
  assert.equal(second.file, "street-cleaning-2.md", "an existing memory is never overwritten");
  assert.equal(second.summary, "Street cleaning", "the title stands in for a missing summary");
  await assert.rejects(createLongTermMemory(coworkersDir, "memo", { title: "  " }), /needs a title/);
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

test("the refreshed contract keeps the soul and memory untouched and carries the scheduling and self sections", async () => {
  const coworkersDir = await tempCoworkersDir();
  const coworker = await createCoworker(coworkersDir, { name: "Pilot", role: "Ops" });
  const soulPath = path.join(coworker.path, "soul.md");
  const workingPath = path.join(coworker.path, "memory", "working.md");
  await writeFile(soulPath, "# Soul — Pilot\n\n## Role\n\nOps lead, edited by hand.\n", "utf8");
  await writeFile(workingPath, "# Working memory — Pilot\n\n## Now\n\n- Halfway through the audit.\n", "utf8");
  // An older contract without the tool sections, and a config a person extended by hand.
  await writeFile(path.join(coworker.path, "AGENTS.md"), "<!-- open-coworker-contract: 3 -->\n# Pilot — coworker contract\n\nOld words.\n", "utf8");
  await writeFile(path.join(coworker.path, "opencode.json"), JSON.stringify({ instructions: ["soul.md"], mcp: { notes: { type: "remote", url: "http://127.0.0.1:1/mcp" } } }), "utf8");

  const { changed } = await repairCoworkerContract(coworkersDir, "pilot");
  assert.ok(changed.includes("AGENTS.md") && changed.includes("opencode.json"), JSON.stringify(changed));
  const agents = await readFile(path.join(coworker.path, "AGENTS.md"), "utf8");
  assert.equal(agents, agentsTemplate({ name: "Pilot" }));
  assert.equal(agentsContractVersion(agents), AGENTS_CONTRACT_VERSION);
  assert.match(agents, /## Scheduling/);
  assert.match(agents, /## Keeping memory and soul current/);
  assert.doesNotMatch(agents, /## Working memory duty/);
  const config = JSON.parse(await readFile(path.join(coworker.path, "opencode.json"), "utf8"));
  assert.deepEqual(config.instructions, ["soul.md", "memory/working.md", "memory/index.md", "documents/index.md", "team/roster.md"]);
  assert.deepEqual(config.mcp, { notes: { type: "remote", url: "http://127.0.0.1:1/mcp" } });
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.equal(await readFile(soulPath, "utf8"), "# Soul — Pilot\n\n## Role\n\nOps lead, edited by hand.\n");
  assert.equal(await readFile(workingPath, "utf8"), "# Working memory — Pilot\n\n## Now\n\n- Halfway through the audit.\n");
  // Already current: nothing is rewritten.
  assert.deepEqual((await repairCoworkerContract(coworkersDir, "pilot")).changed, []);
});
