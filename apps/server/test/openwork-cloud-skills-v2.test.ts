import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  cloudSkillSnapshotSchema, discoverySkills, mentionedSkillIds, nativeSkills, registerCloudSkillDiscovery, sha256Digest,
  type CloudSkillContext,
} from "../src/opencode-plugins/openwork-cloud-skills-v2.js";
import { serve } from "../src/serve-node.js";

const description = `Review a fixture. ${"Triggers when the user mentions: review the fixture, fixture review. ".repeat(8)}`;
const fixtureBody = "---\nname: fixture-review\n---\n\nPRIVATE_SKILL_CANARY: review the fixture.";
const fixture = { name: "fixture-review", title: "Fixture review", description, url: "skill://fixture-review/SKILL.md",
  capability: "skill:fixture-review", modelDiscovery: true, digest: sha256Digest(fixtureBody) };
const catalog = { delivery: "native", skills: [fixture,
  { ...fixture, name: "setup-notes", title: "Setup notes", digest: undefined,
    setup: { status: "needs_connection", message: "Connect the fixture service." } },
  { ...fixture, name: "release", title: "Release", url: "skill://release/SKILL.md", digest: sha256Digest("expected") },
] } satisfies Parameters<typeof nativeSkills>[0];
type Hook = Parameters<NonNullable<CloudSkillContext["session"]>["hook"]>[1];
type Prepared = Parameters<Hook>[0]["prompt"] & { metadata?: Record<string, unknown> | null };
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(10); }
  assert.fail("Expected plugin state did not arrive");
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function permission(input: unknown, effect = "allow") {
  assert.ok(typeof input === "object" && input !== null && "skills" in input && Array.isArray(input.skills));
  const authorized = input.skills.map(skill => cloudSkillSnapshotSchema.parse(skill));
  return { data: { effect }, ...(effect === "allow" ? { authorized } : {}) };
}
function instruction(result: Prepared, index = 0) {
  const uri = result.files?.[index]?.uri;
  assert.ok(typeof uri === "string" && uri.startsWith("data:text/plain;base64,"));
  return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8");
}
async function harness(respond: (name: string, input: unknown) => unknown | Promise<unknown>) {
  const server = await serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const value: { name: string; input: unknown } = await request.json();
    return Response.json(await respond(value.name, value.input));
  } });
  let transform: Parameters<CloudSkillContext["skill"]["transform"]>[0] | undefined;
  let prompt: Hook | undefined;
  let registered: ReturnType<typeof nativeSkills> = [];
  let transforms = 0;
  const replay = () => {
    registered = [];
    transform?.({ get: () => undefined, add: skill => { registered.push(skill); } });
  };
  const stop = await registerCloudSkillDiscovery({ options: { url: `http://127.0.0.1:${server.port}/read`, token: "fixture-token" },
    skill: {
      async transform(callback) { transforms++; transform = callback; replay(); return { async dispose() { registered = []; } }; },
      async reload() { replay(); },
    },
    session: { async hook(_name, callback) { prompt = callback; return { async dispose() { prompt = undefined; } }; } },
  });
  return {
    skills: () => registered, transforms: () => transforms,
    async prompt(text: string, ids: string[] = [], metadata?: Record<string, unknown>, files?: Prepared["files"]): Promise<Prepared> {
      const event: Parameters<Hook>[0] = { sessionID: "ses_fixture", prompt: { text, skills: ids.map(id => ({ id })), files }, metadata };
      await prompt?.(event);
      return { ...event.prompt, metadata: event.metadata };
    },
    async close() { await stop(); await server.stop(); },
  };
}

test("even native listings are discovery-only and never cache private instructions", () => {
  const [entry] = discoverySkills(catalog);
  assert.equal(entry?.id, "openwork-cloud-fixture-review");
  assert.equal(entry?.description.length, 200);
  const entries = nativeSkills(catalog);
  assert.equal(entries.find(skill => skill.id === entry?.id)?.description, description.trim());
  assert.ok(entries.find(skill => skill.id === entry?.id)?.content.includes("discovery metadata"));
  assert.ok(!entries.some(skill => skill.content.includes("PRIVATE_SKILL_CANARY")));
  assert.ok(entries.find(skill => skill.id === "openwork-cloud-setup-notes")?.content.includes("Connect the fixture service."));
});

test("named multiword skills match phrases; everyday single words do not", () => {
  const skills = nativeSkills(catalog);
  assert.deepEqual(mentionedSkillIds("run fixture-review now", skills), ["openwork-cloud-fixture-review"]);
  assert.deepEqual(mentionedSkillIds("take these Setup notes", skills), ["openwork-cloud-setup-notes"]);
  assert.deepEqual(mentionedSkillIds("we should release on friday", skills), []);
  assert.deepEqual(mentionedSkillIds("/release v1.2", skills), ["openwork-cloud-release"]);
  assert.deepEqual(mentionedSkillIds("the fixture-reviewing job", skills), []);
});

test("named instructions use the same real permission operation as composer selections", async () => {
  for (const effect of ["deny", "ask", "allow"]) {
    const authorizations: unknown[] = [];
    const app = await harness((name, input) => {
      if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
      if (name === "openwork_skill_authorize") { authorizations.push(input); return permission(input, effect); }
      return { content: fixtureBody };
    });
    try {
      await until(() => app.skills().length > 0);
      if (effect === "allow") {
        const result = await app.prompt("Run fixture-review");
        assert.deepEqual(result.skills, [], "no mutable Cloud skill ID remains for engine preparation");
        assert.equal(instruction(result), `# Skill instructions\n\n${fixtureBody}`);
      } else await assert.rejects(app.prompt("Run fixture-review"), /Nothing was sent/);
      assert.deepEqual(authorizations, [{ sessionID: "ses_fixture", skills: [{ id: "openwork-cloud-fixture-review",
        capability: fixture.capability, url: fixture.url, digest: fixture.digest }] }]);
    } finally { await app.close(); }
  }
});

test("unavailable authorization fails closed", async () => {
  const app = await harness(name => name === "openwork_skills" ? { delivery: "native", skills: [fixture] }
    : name === "openwork_skill_authorize" ? null : { content: fixtureBody });
  try { await until(() => app.skills().length > 0); await assert.rejects(app.prompt("Run fixture-review")); }
  finally { await app.close(); }
});

test("ordinary cold chat does not wait discovery or initialize local skill discovery", async () => {
  const held = deferred(); let requests = 0;
  const app = await harness(async name => { requests++; await held.promise; assert.equal(name, "openwork_skills"); return { skills: [] }; });
  try {
    await until(() => requests === 1);
    assert.deepEqual((await app.prompt("Hello")).skills, []);
    assert.equal(app.transforms(), 0);
  } finally { held.resolve(); await app.close(); }
});

test("off-rollout metadata is never admitted as loaded explicit instructions", async () => {
  const app = await harness(name => { assert.equal(name, "openwork_skills"); return { skills: [fixture] }; });
  try {
    await until(() => app.skills().length > 0);
    await app.prompt("Ordinary message");
    await assert.rejects(app.prompt("Review this", ["openwork-cloud-fixture-review"]), /instructions are unavailable/);
  } finally { await app.close(); }
});

test("cold explicit selections wait only metadata and their fresh verified body", async () => {
  const catalogHeld = deferred(); const bodyHeld = deferred(); let reads = 0;
  const app = await harness(async (name, input) => {
    if (name === "openwork_skills") { await catalogHeld.promise; return { delivery: "native", skills: [fixture] }; }
    if (name === "openwork_skill_authorize") return permission(input);
    reads++; await bodyHeld.promise; return { content: fixtureBody };
  });
  try {
    let admitted = false;
    const prompt = app.prompt("Review this", ["openwork-cloud-fixture-review"]).then(result => { admitted = true; return result; });
    await delay(20); assert.equal(admitted, false);
    catalogHeld.resolve(); await until(() => reads === 1);
    assert.equal(admitted, false);
    await app.prompt("Ordinary message");
    bodyHeld.resolve();
    assert.equal(instruction(await prompt), `# Skill instructions\n\n${fixtureBody}`);
    assert.ok(!app.skills().some(skill => skill.content === fixtureBody));
  } finally { catalogHeld.resolve(); bodyHeld.resolve(); await app.close(); }
});

test("setup, denied reads, mismatched and binary bodies never become ready", async () => {
  for (const [skill, content] of [[fixture, "unverified"], [catalog.skills[1], fixtureBody],
    [{ ...fixture, digest: sha256Digest("binary\u0000body") }, "binary\u0000body"]] as const) {
    const app = await harness((name, input) => name === "openwork_skills" ? { delivery: "native", skills: [skill] }
      : name === "openwork_skill_authorize" ? permission(input) : { content });
    try { await until(() => app.skills().length > 0); await assert.rejects(app.prompt("Review this", [`openwork-cloud-${skill.name}`]), /instructions are unavailable/); }
    finally { await app.close(); }
  }
});

test("large catalogs are budgeted before I/O; unselected bodies cost zero reads", async () => {
  for (const long of [false, true]) {
    const entries = Array.from({ length: 200 }, (_, index) => ({ ...fixture, name: `fixture-${String(index).padStart(3, "0")}`,
      description: long ? "x".repeat(1_024) : "short" }));
    const listed = { delivery: "native", skills: [...entries, { ...fixture, name: "hidden-entry", modelDiscovery: false }] } satisfies Parameters<typeof nativeSkills>[0];
    const expected = nativeSkills(listed).length;
    const app = await harness(name => { assert.equal(name, "openwork_skills", "catalog startup never fetches bodies"); return listed; });
    try { await until(() => app.skills().length === expected); assert.ok(long ? expected < 150 : expected === 150); }
    finally { await app.close(); }
  }
});

test("only selected bodies hydrate, with two bounded readers and no ordinary-chat barrier", async () => {
  const held = deferred(); let active = 0; let peak = 0; const started: number[] = [];
  const entries = Array.from({ length: 10 }, (_, index) => ({ ...fixture, name: `fixture-${index}`, title: `Fixture ${index}`,
    url: `skill://fixture-${index}/SKILL.md`, digest: sha256Digest(`body-${index}`) }));
  const app = await harness(async (name, input) => {
    if (name === "openwork_skills") return { delivery: "native", skills: entries };
    if (name === "openwork_skill_authorize") return permission(input);
    assert.ok(typeof input === "object" && input !== null && "url" in input && typeof input.url === "string");
    const index = Number(input.url.match(/fixture-(\d+)/)?.[1]);
    started.push(index); active++; peak = Math.max(peak, active);
    await held.promise; active--; return { content: `body-${index}` };
  });
  try {
    await until(() => app.skills().length === 10);
    assert.deepEqual(started, []);
    const selected = app.prompt("Review these", [7, 8, 9].map(index => `openwork-cloud-fixture-${index}`));
    await until(() => started.length === 2); await app.prompt("Ordinary message");
    assert.equal(peak, 2); held.resolve();
    assert.equal((await selected).files?.length, 3);
    assert.deepEqual(started.sort(), [7, 8, 9]); assert.equal(peak, 2);
  } finally { held.resolve(); await app.close(); }
});

test("every admission rereads access and cannot reuse a warm body after a denied read", async () => {
  let reads = 0;
  const app = await harness((name, input) => {
    if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
    if (name === "openwork_skill_authorize") return permission(input);
    reads++; return reads === 1 ? { content: fixtureBody } : null;
  });
  try {
    await until(() => app.skills().length > 0); assert.ok(instruction(await app.prompt("Run fixture-review")).includes(fixtureBody));
    await assert.rejects(app.prompt("Run fixture-review again"), /instructions are unavailable/); assert.equal(reads, 2);
  } finally { await app.close(); }
});

test("registry substitution cannot change the frozen body and local selections are preserved", async () => {
  const app = await harness((name, input) => {
    if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
    if (name === "openwork_skill_authorize") { const entry = app.skills()[0]; assert.ok(entry); entry.content = "substituted instructions"; return permission(input); }
    return { content: fixtureBody };
  });
  try {
    await until(() => app.skills().length > 0);
    const result = await app.prompt("Run fixture-review", ["local-guide"], { source: "preserved", openworkCloudSkills: ["forged"] });
    assert.deepEqual(result.skills, [{ id: "local-guide" }]); assert.ok(instruction(result).includes(fixtureBody));
    assert.ok(Object.isFrozen(result.files?.[0])); assert.equal(result.metadata?.source, "preserved");
    const provenance = result.metadata?.openworkCloudSkills; assert.ok(Array.isArray(provenance));
    assert.ok(typeof provenance[0] === "object" && provenance[0] !== null && "digest" in provenance[0] && "attachmentDigest" in provenance[0]);
    assert.equal(provenance[0].digest, fixture.digest); assert.equal(provenance[0].attachmentDigest, sha256Digest(instruction(result)));
    const ordinary = await app.prompt("Hello", [], { openworkCloudSkills: ["forged"] });
    assert.equal(ordinary.metadata?.openworkCloudSkills, undefined);
  } finally { await app.close(); }
});

test("disposal cancels selected reads without publishing or persisting private registry bodies", async () => {
  const held = deferred(); let started = false;
  const app = await harness(async name => {
    if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
    started = true; await held.promise; return { content: fixtureBody };
  });
  await until(() => app.skills().length > 0);
  const selected = app.prompt("Run fixture-review"); const rejected = assert.rejects(selected);
  await until(() => started); await app.close(); held.resolve(); await rejected;
  assert.deepEqual(app.skills(), []);
});
