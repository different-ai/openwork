import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { evalJourneyFiles } from '../bin/test-files.mjs';

// One home for CI grouping, readable names, and execution requirements.
// Unlisted specs are discovered automatically as full-regression journeys.
// `needs` names what a journey requires beyond its placement (an env var the
// lane must provide, or a platform), in the TestNeeds vocabulary the specs use.
// It means a WHOLE-FILE blocker: every case in the spec needs it. A prerequisite
// only some cases need stays in that case's own `needs` and skips with its own
// reason; declaring it here would silently drop the runnable cases. The planner
// reports a journey whose needs the lane cannot meet as "skipped: lane cannot
// satisfy prerequisites" instead of scheduling a guaranteed skip.
const PACKAGED_BINARY = { env: ['OPENWORK_EVAL_ELECTRON_BINARY'] };
const definitions = {
  'agent-connection-journey.e2e.test.ts': {
    cases: [{ id: 'AGENT-VIS-04', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1' } }],
  },
  'app-smoke.e2e.test.ts': { name: 'Open a working desktop', critical: true },
  // Installs a newer signed build from a loopback feed through Squirrel.Mac; only packaged-smoke-macos provides both builds.
  'packaged-update-install.e2e.test.ts': {
    name: 'Update an activated enterprise install in place', placement: 'local',
    needs: { platform: 'darwin', env: ['OPENWORK_EVAL_ELECTRON_BINARY', 'OPENWORK_EVAL_UPDATE_FEED_DIR'] },
  },
};

export const registeredCases = Object.freeze(Object.entries(definitions).flatMap(([spec, definition]) =>
  (definition.cases ?? []).map(value => Object.freeze({ spec, ...value }))
));

// Journeys in evals/specs, evals/core and evals/proofs, keyed by basename so a
// file can move between those folders without changing its entry here.
export async function catalog(paths = evalJourneyFiles()) {
  const byName = new Map(paths.map(path => [basename(path), path]));
  const files = [...byName.keys()].sort();
  for (const file of Object.keys(definitions)) {
    if (!byName.has(file)) throw new Error(`Registered journey missing: ${file}`);
  }
  return Promise.all(files.map(async spec => {
    const source = await readFile(byName.get(spec), 'utf8');
    const rawDesktop = /import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source);
    return {
      spec,
      name: spec.replace(/\.(?:e2e|proof)\.test\.ts$/, '').replaceAll('-', ' '),
      critical: false,
      model: 'mock',
      placement: rawDesktop ? 'manual' : 'daytona',
      ...definitions[spec],
    };
  }));
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
export const ciLane = Object.freeze({ platform: 'linux', env: Object.freeze([]) });

// Needs the lane cannot meet, phrased as the action that would meet them; empty when the journey is applicable.
export function unmetLaneNeeds(entry, lane = ciLane) {
  const missing = (entry.needs?.env ?? []).filter(name => !lane.env.includes(name)).map(name => `set ${name}`);
  missing.push(...(entry.needs?.optIn ?? []).filter(name => !lane.optIns?.includes(name)).map(name => `set ${name}=1`));
  if (entry.needs?.platform && entry.needs.platform !== lane.platform) missing.push(`run on ${entry.needs.platform}`);
  return missing;
}
