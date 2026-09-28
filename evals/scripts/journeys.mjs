import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every journey is a spec file in evals/specs, and Vitest discovers it: `collect` with
// `staticParse` reads each spec's `@module-tag` lines and each test's `{ tags }` from the source
// without importing it, so no spec, world or fixture code runs. The tag descriptions in
// evals/vitest.config.ts are the documentation (`pnpm --dir evals exec vitest --list-tags`).
//   - Journey tags (critical, local-only, live-model, live-openai, packaged, macos, raw-desktop)
//     are file-level `@module-tag`s; journey-ci.test.mjs keeps them off individual tests.
//   - Registered cases: tests whose title starts with a case ID (`HOME-01 …`) and that carry an
//     `engine-v1`/`engine-v2` tag.
//   - Readable name: the first line of the JSDoc block at the top of the file (else the filename).

const evalsDir = fileURLToPath(new URL('..', import.meta.url));
// Always the config next to this script. The required-verification controller runs this script
// from the trusted default-branch checkout and points `root` at a directory holding a PR's spec
// files, so the PR's own vitest.config.ts is never loaded.
const trustedConfig = fileURLToPath(new URL('../vitest.config.ts', import.meta.url));

// `needs` is what a journey requires beyond its placement (an env var the lane must provide, an
// opt-in, or a platform), in the TestNeeds vocabulary the specs use. It is a WHOLE-FILE blocker:
// a prerequisite only some cases need stays in that case's own `needs` and skips with its own
// reason. The planner reports a journey whose needs the lane cannot meet as "skipped: lane cannot
// satisfy prerequisites" instead of scheduling a guaranteed skip. journey-ci.test.mjs checks the
// tags against what each spec and its worlds actually guard.
const TAG_NEEDS = Object.freeze({
  packaged: { env: ['OPENWORK_EVAL_ELECTRON_BINARY'] },
  'live-openai': { env: ['OPENAI_API_KEY'], optIn: ['OPENWORK_EVAL_LIVE_OPENAI'] },
  macos: { platform: 'darwin' },
});
const ENGINES = ['v1', 'v2'];
const CASE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+(?=[\s:]|$)/;
const SPEC = /^specs\/[^/]+\.e2e\.test\.ts$/;
export const JOURNEY_DOCS = 'docs/testing.md#journey-tags';
const DISCOVERY_HINT = 'A tag must be declared in evals/vitest.config.ts: list the declared tags with '
  + '`pnpm --dir evals exec vitest --list-tags`, or add the new tag there with a description. See ' + JOURNEY_DOCS + '.';

// The one-line summary of a JSDoc block at the very top of the file; Vitest does not read docs.
export function journeyName(source) {
  const block = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1];
  const summary = block?.split('\n').map(line => line.replace(/^\s*\*?\s?/, '').trim()).find(line => line !== '');
  return summary && !summary.startsWith('@') ? summary : undefined;
}

function needsFor(tags) {
  const needs = {};
  for (const tag of tags) {
    for (const [key, value] of Object.entries(TAG_NEEDS[tag] ?? {})) {
      needs[key] = Array.isArray(value) ? [...new Set([...(needs[key] ?? []), ...value])] : value;
    }
  }
  const ordered = Object.fromEntries(['env', 'optIn', 'platform'].filter(key => key in needs).map(key => [key, needs[key]]));
  return Object.keys(ordered).length ? ordered : undefined;
}

// `tests` are Vitest test cases ({ name, tags }); a test's tags include its file's `@module-tag`s.
export function journeyEntry(spec, source, tests) {
  const tags = new Set(tests.flatMap(test => test.tags));
  const placement = tags.has('raw-desktop') ? 'manual' : tags.has('local-only') ? 'local' : 'daytona';
  const entry = {
    spec,
    name: journeyName(source) ?? spec.replace('.e2e.test.ts', '').replaceAll('-', ' '),
    critical: tags.has('critical'),
    model: tags.has('live-model') ? 'live' : 'mock',
    placement,
  };
  const needs = needsFor(tags);
  if (needs) entry.needs = needs;
  // Running a registered case is consent to the e2e opt-in and to the opt-ins its journey tags need.
  const optIns = ['OPENWORK_EVAL_E2E_TESTS', ...(needs?.optIn ?? [])];
  const cases = tests.flatMap(test => {
    const id = test.name.match(CASE_ID)?.[0];
    const engines = ENGINES.filter(engine => test.tags.includes(`engine-${engine}`));
    // Examples run locally (every placement can) on the newest engine the case supports.
    return id && engines.length ? [{ id, engines, optIns, example: { placement: '--local', engine: engines.at(-1) } }] : [];
  });
  if (cases.length) entry.cases = cases;
  return entry;
}

// Vitest's view of `<root>/specs/*.e2e.test.ts`: per spec, its source and its tests with their tags.
// `root` defaults to evals/; any other root is read as data with this checkout's config.
export async function collectSpecs(root = evalsDir) {
  const { createVitest } = await import('vitest/node');
  // Vite copies its env (MODE, DEV, PROD, …) onto process.env; keep callers' environment untouched.
  const environment = { ...process.env };
  const vitest = await createVitest('test', { config: trustedConfig, root, project: 'e2e', watch: false, reporters: [] });
  try {
    const { testModules, unhandledErrors } = await vitest.collect(['specs/'], { staticParse: true });
    const problems = [
      ...unhandledErrors.map(String),
      ...testModules.flatMap(module => module.errors().map(error => `${module.relativeModuleId}: ${error.message}`)),
    ];
    if (problems.length) throw new Error(`Vitest could not read the journey specs:\n${problems.join('\n')}\n${DISCOVERY_HINT}`);
    const specs = testModules.filter(module => SPEC.test(module.relativeModuleId));
    return (await Promise.all(specs.map(async module => ({
      spec: basename(module.moduleId),
      source: await readFile(module.moduleId, 'utf8'),
      tests: [...module.children.allTests()].map(test => ({ name: test.name, tags: [...test.tags] })),
    })))).sort((a, b) => a.spec.localeCompare(b.spec));
  } finally {
    await vitest.close();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
  }
}

export async function discoverJourneys(root = evalsDir) {
  return (await collectSpecs(root)).map(({ spec, source, tests }) => journeyEntry(spec, source, tests));
}

export function registeredCases(journeys) {
  return journeys.flatMap(entry => (entry.cases ?? []).map(value => ({ spec: entry.spec, ...value })));
}

// For callers that read untrusted spec sources (the required-verification controller): a spec that
// already exists on the trusted ref keeps the trusted ref's disposition, so a PR cannot drop its own
// requirement by retagging it, and a PR cannot remove a critical journey. PR-only specs use their own tags.
export function withTrustedMetadata(candidates, trusted) {
  const present = new Set(candidates.map(entry => entry.spec));
  const missing = trusted.filter(entry => entry.critical && !present.has(entry.spec)).map(entry => entry.spec);
  if (missing.length) throw new Error(`Critical journey missing: ${missing.join(', ')}`);
  const known = new Map(trusted.map(entry => [entry.spec, entry]));
  return candidates.map(entry => known.get(entry.spec) ?? entry);
}

// `only` is a comma-separated list of filename substrings; empty matches everything.
// Delimiters alone (", ,") are a typo, not "everything": refuse them instead of running the whole suite.
export function selectJourneys(entries, { critical = false, only = '', changed = [] } = {}) {
  const filters = only.split(',').map(value => value.trim()).filter(Boolean);
  if (filters.length === 0 && only.trim() !== '') throw new Error(`The only filter "${only}" names no journey; give comma-separated filename substrings or leave it empty to select everything.`);
  return entries.filter(entry => (!critical || entry.critical || changed.includes(entry.spec))
    && (filters.length === 0 || filters.some(filter => entry.spec.includes(filter))));
}

// What the CI lane provides to every job: Linux runners and no packaged desktop binary.
// Keep in step with the e2e and local-journey jobs in .github/workflows/daytona-e2e.yml.
export const ciLane = Object.freeze({ platform: 'linux', env: Object.freeze([]) });

// Needs the lane cannot meet, phrased as the action that would meet them; empty when the journey is applicable.
export function unmetLaneNeeds(entry, lane = ciLane) {
  const missing = (entry.needs?.env ?? []).filter(name => !lane.env.includes(name)).map(name => `set ${name}`);
  missing.push(...(entry.needs?.optIn ?? []).filter(name => !lane.optIns?.includes(name)).map(name => `set ${name}=1`));
  if (entry.needs?.platform && entry.needs.platform !== lane.platform) missing.push(`run on ${entry.needs.platform}`);
  return missing;
}
