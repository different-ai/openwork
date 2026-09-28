#!/usr/bin/env node
// Scaffold a journey spec that already follows the conventions CI reads (docs/testing.md#add-a-journey):
//   pnpm evals:new <name> [--flow user|agent] [--engine v1,v2] [--critical] [--world <file>.ts:<export>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const evalsDir = fileURLToPath(new URL('..', import.meta.url));
const GUIDE = 'docs/testing.md#add-a-journey';
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WORLD = /^([a-z0-9][a-z0-9-]*\.ts):([A-Za-z_$][\w$]*)$/;

export const usage = `Usage: pnpm evals:new <name> [--flow user|agent] [--engine v1,v2] [--critical] [--world <file>.ts:<export>]

Creates evals/specs/<name>.e2e.test.ts and, unless --world names an existing one, evals/worlds/<name>.ts.
  <name>        kebab-case journey name, e.g. invite-teammate
  --flow        user (default): a person in the real UI; agent: an agent, MCP client or server acts
  --engine      make the test a registered --case on these engines (titled with a unique case ID)
  --critical    tag the journey critical: it then runs on every PR and dev merge
  --world       bind an existing world instead of creating one, e.g. chat.ts:streamedMarkdown
Guide: ${GUIDE}`;

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

function title(name) {
  const words = name.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A case ID no spec uses yet: the name's first word, upper-cased, numbered from 01.
export function freshCaseId(name, specSources) {
  const prefix = name.split('-')[0].toUpperCase().slice(0, 12);
  for (let number = 1; ; number += 1) {
    const id = `${prefix}-${String(number).padStart(2, '0')}`;
    const used = new RegExp(`["'\`]${id}[\\s:]`);
    if (!specSources.some(source => used.test(source))) return id;
  }
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      flow: { type: 'string', default: 'user' },
      engine: { type: 'string' },
      critical: { type: 'boolean', default: false },
      world: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return { help: true };
  const [name, ...extra] = positionals;
  if (!name || extra.length) throw new Error(`Give exactly one journey name.\n\n${usage}`);
  if (!NAME.test(name)) throw new Error(`"${name}" is not a kebab-case name (lowercase words joined by "-", e.g. invite-teammate).`);
  if (values.flow !== 'user' && values.flow !== 'agent') throw new Error(`--flow is user or agent, not "${values.flow}".`);
  const engines = values.engine === undefined ? [] : values.engine.split(',').map(value => value.trim()).filter(Boolean);
  if (values.engine !== undefined && (engines.length === 0 || engines.some(engine => engine !== 'v1' && engine !== 'v2') || new Set(engines).size !== engines.length))
    throw new Error(`--engine is a comma-separated list of v1 and v2, not "${values.engine}".`);
  let world;
  if (values.world !== undefined) {
    const match = values.world.match(WORLD);
    if (!match) throw new Error(`--world is <file>.ts:<export> from evals/worlds, e.g. chat.ts:streamedMarkdown, not "${values.world}".`);
    world = { file: match[1], exportName: match[2] };
  }
  return { help: false, name, flow: values.flow, engines, critical: values.critical, world };
}

function header(options) {
  return [
    '/**',
    ` * ${title(options.name)}`,
    ' *',
    " * TODO: rename the line above to the journey in a person's words; CI and the report show it.",
    ...(options.critical ? [' *', ' * @module-tag critical'] : []),
    ' */',
  ].join('\n');
}

function userBody(testTitle, tags) {
  return `test(${JSON.stringify(testTitle)}, { tags: [${tags.map(tag => JSON.stringify(tag)).join(", ")}] }, async ({ user, step, evidence }) => {
  // Every step is something the person does or sees, and ends with a screenshot of it.
  await step("before: TODO what the member sees or cannot do today", async () => {
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await user.screenshot();
    const seen = false; // TODO: observe the old state, e.g. await user.notSee({ role: "button", label: "Share" })
    evidence.recordAssertionEvidence("TODO: the old state, as a claim", "TODO: what was observed, with the numbers in it", seen);
    expect(seen, "scaffold: replace the TODO check").toBe(true);
  });

  await step("TODO: the member does the thing, as they would", async () => {
    // await user.click({ role: "button", label: "TODO" });
    // await user.type("composer", "TODO");
    await user.screenshot();
  });

  await step("after: TODO what the member now sees", async () => {
    await user.screenshot();
    const seen = false; // TODO: await user.see({ text: "TODO" })
    evidence.recordAssertionEvidence("TODO: the new state, as a claim", "TODO: what was observed", seen);
    expect(seen, "scaffold: replace the TODO check").toBe(true);
  });

  await step("TODO: who is not affected (the negative half), e.g. a member without access", async () => {
    await user.screenshot();
    const unaffected = false; // TODO
    evidence.recordAssertionEvidence("TODO: who still cannot", "TODO: what was observed", unaffected);
    expect(unaffected, "scaffold: replace the TODO check").toBe(true);
  });
});`;
}

function agentBody(testTitle, tags) {
  return `test(${JSON.stringify(testTitle)}, { tags: [${tags.map(tag => JSON.stringify(tag)).join(", ")}] }, async ({ world, probe, step, evidence }) => {
  // Every step records one evidence line: the observed fact, with the numbers in it.
  await step("given TODO: the state the world arranged", async () => {
    evidence.recordAssertionEvidence("TODO: the arranged state", \`Den \${world.den.ref.apiUrl}\`, true);
  });

  let status = 0;
  await step("when TODO: the agent or client makes its request", async () => {
    const response = await probe.api(world.den.admin, "/v1/TODO");
    status = response.response.status;
    evidence.recordAssertionEvidence("TODO: the request", \`GET /v1/TODO → \${status}\`, true);
  });

  await step("then TODO: the risky condition really happened (witness)", async () => {
    const witnessed = false; // TODO: prove the condition occurred; a pass without it proves nothing
    evidence.recordAssertionEvidence("TODO: the witness", "TODO: what the witness saw", witnessed);
    expect(witnessed, "scaffold: replace the TODO witness").toBe(true);
  });

  await step("after: TODO the response the caller now gets", async () => {
    evidence.recordAssertionEvidence("TODO: the outcome", \`status \${status}\`, status === 200);
    expect(status).toBe(200);
  });
});`;
}

function worldStub(options, exportName) {
  const user = options.flow === 'user';
  return `import type { Seed } from "@openwork/env";

/**
 * TODO: one sentence on what this world arranges for ${options.name}.e2e.test.ts.
 * Only \`seed.*\` writes state, all of it here before the spec's first step.
 */
export async function ${exportName}(seed: Seed) {
${user
    ? `  const workspacePath = seed.tmpPath(${JSON.stringify(options.name)});
  // Headless Chrome on the real app; add \`mocks: { agent: seed.mock() }\` (and the "mock" service) for chat.
  const app = await seed.appWeb({ name: ${JSON.stringify(options.name)}, workspacePath });
  // TODO: arrange the before state (seed.workspace, seed.session, seed.den, …).
  return { app };`
    : `  const den = await seed.den();
  // TODO: arrange the before state (seed.api, seed.orgConnection, seed.mock, …).
  return { den };`}
}
`;
}

// The files to create, relative to evals/, with their contents. `specSources` keeps case IDs unique.
export function scaffold(options, specSources = []) {
  const exportName = options.world?.exportName ?? camel(options.name);
  const worldFile = options.world?.file ?? `${options.name}.ts`;
  const caseId = options.engines.length ? freshCaseId(options.name, specSources) : undefined;
  const tags = [options.flow === 'user' ? 'user-flow' : 'agent-flow', ...options.engines.map(engine => `engine-${engine}`)];
  const persona = options.flow === 'user'
    ? 'a member can now TODO (the person and what they can now do)'
    : 'an MCP client can now TODO (the actor and what it can now do)';
  const testTitle = caseId ? `${caseId} ${persona}` : persona;
  const resources = options.world
    ? '{ surfaces: [], services: [] }, // TODO: declare what the world launches: surfaces appWeb|desktop|web, services den|mock'
    : options.flow === 'user' ? '{ surfaces: ["appWeb"], services: [] },' : '{ surfaces: [], services: ["den"] },';
  const spec = `${header(options)}
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ${exportName} } from "../worlds/${worldFile}";

// Proof shape: .opencode/skills/write-a-spec/SKILL.md. Tags and how CI runs this: ${GUIDE}
const test = spec.world(${exportName}, {
  resources: ${resources}
});

${options.flow === 'user' ? userBody(testTitle, tags) : agentBody(testTitle, tags)}
`;
  const files = [{ path: `specs/${options.name}.e2e.test.ts`, content: spec }];
  if (!options.world) files.push({ path: `worlds/${worldFile}`, content: worldStub(options, exportName) });
  return { files, caseId };
}

function specSources(root) {
  const directory = join(root, 'specs');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(file => file.endsWith('.test.ts')).map(file => readFileSync(join(directory, file), 'utf8'));
}

// Writes the scaffold under `root` (evals/ by default); refuses to overwrite anything.
export function writeScaffold(options, root = evalsDir) {
  if (options.world) {
    const worldPath = join(root, 'worlds', options.world.file);
    if (!existsSync(worldPath)) throw new Error(`evals/worlds/${options.world.file} does not exist.`);
    if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${options.world.exportName}\\b`).test(readFileSync(worldPath, 'utf8')))
      throw new Error(`evals/worlds/${options.world.file} does not export ${options.world.exportName}.`);
  }
  const result = scaffold(options, specSources(root));
  const taken = result.files.filter(file => existsSync(join(root, file.path)));
  if (taken.length) throw new Error(`Refusing to overwrite ${taken.map(file => `evals/${file.path}`).join(', ')}; pick another name or extend the existing journey.`);
  for (const file of result.files) writeFileSync(join(root, file.path), file.content, { flag: 'wx' });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      const { files, caseId } = writeScaffold(options);
      console.log(`Created:\n${files.map(file => `  ${relative(process.cwd(), join(evalsDir, file.path))}`).join('\n')}`);
      if (caseId) console.log(`Registered case ${caseId} on ${options.engines.join(', ')}.`);
      if (options.critical) console.log('Tagged critical: it runs on every PR and dev merge.');
      console.log(`Next:
  1. Replace every TODO; the scaffold fails until you do.
  2. pnpm evals:e2e ${options.name} --local${caseId ? ` --case ${caseId} --engine ${options.engines.at(-1)}` : ''}
  3. Read evals/results/test-runs/<latest>/index.html top to bottom.
Guide: ${GUIDE}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
