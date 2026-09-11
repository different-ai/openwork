import { readdir, readFile } from 'node:fs/promises';

// One home for CI grouping, readable names, and execution requirements.
// Unlisted specs are discovered automatically as full-regression journeys.
// `needs` names what a journey requires beyond its placement (an env var the
// lane must provide, or a platform), in the TestNeeds vocabulary the specs use.
// It means a WHOLE-FILE blocker: every case in the spec needs it. A prerequisite
// only some cases need stays in that case's own `needs` and skips with its own
// reason; declaring it here would silently drop the runnable cases. The planner
// reports a journey whose needs the lane cannot meet as "skipped: lane cannot
// satisfy prerequisites" instead of scheduling a guaranteed skip.
// journey-ci.test.mjs checks these against what each spec and world guards.
const PACKAGED_BINARY = { env: ['OPENWORK_EVAL_ELECTRON_BINARY'] };
const definitions = {
  'composer-model-picker-no-subscribe-promo.e2e.test.ts': {
    cases: [{ id: 'MODEL-01', engines: ['v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v2' } }],
  },
  // Its registered OAuth callback and synthetic client exchange run on owned loopback services.
  'mcp-connection-consent.e2e.test.ts': { name: 'Authorize a connected client once', placement: 'local' },
  'task-activity-shimmer.e2e.test.ts': {
    cases: [{ id: 'ACT-01', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1' } }],
  },
  // Fixes a fault proxy in front of den-api before Den boots; only the local lane can do that.
  'mcp-oauth-start-unreadable-response.e2e.test.ts': { name: 'Read why a connection sign-in could not start', placement: 'local' },
  'app-smoke.e2e.test.ts': { name: 'Open a working desktop', critical: true },
  // Boots the packaged cloud and enterprise artifacts; only packaged-smoke provides those binaries.
  'packaged-first-launch.e2e.test.ts': { name: 'Open a fresh cloud or enterprise install', placement: 'local', needs: PACKAGED_BINARY },
  // Boots the packaged enterprise artifact twice (fresh and pre-activated); only packaged-smoke provides that binary.
  'packaged-preactivation-updater.e2e.test.ts': { name: 'Keep an unactivated enterprise install from updating itself', placement: 'local', needs: PACKAGED_BINARY },
  // Boots the packaged enterprise artifact twice (fresh and pre-activated) behind a refusing proxy; only packaged-smoke provides that binary.
  'packaged-preactivation-egress.e2e.test.ts': { name: 'Keep an unactivated enterprise install off the network', placement: 'local', needs: PACKAGED_BINARY },
  'packaged-activated-launch.e2e.test.ts': { name: 'Open an already-activated enterprise install', placement: 'local', needs: PACKAGED_BINARY },
  // Boots the packaged enterprise artifact and asks it to quit (SIGTERM and Browser.close); only packaged-smoke provides that binary.
  'desktop-quit-path.e2e.test.ts': { name: 'Quit an enterprise install cleanly', placement: 'local', needs: PACKAGED_BINARY },
  // Boots a RELEASED enterprise binary already activated against a real Den. Only its update case also needs
  // OPENWORK_EVAL_RELEASED_BASELINE_BINARY (spec-level `needs`); that case skips on its own and the lane that runs
  // this journey must provide both binaries for it to pass (#4848).
  'released-enterprise-activated.e2e.test.ts': { name: 'Open and update an activated enterprise install against its Den', placement: 'local', needs: PACKAGED_BINARY },
  // Drives a real AppKit window through the native Computer Use helper; only a local macOS host can run it.
  'computer-use-window-scope.e2e.test.ts': { placement: 'local', needs: { platform: 'darwin' } },
  'org-team-lifecycle-critical-path.e2e.test.ts': { name: 'Set up a working two-person team', critical: true, model: 'live' },
  'desktop-policy-restricted-mode.e2e.test.ts': {
    // The rollback case severs local child IPC and faults its loopback transport.
    name: 'Apply organization and team permissions', critical: true, placement: 'local',
    cases: [{ id: 'POLICY-ROLLBACK', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1' } }],
  },
  'cross-server-handoff-atomic-commit.e2e.test.ts': { name: 'Switch servers and recover enrollment', critical: true, placement: 'local' },
  // Flips sso_connection directly in the testkit database; Daytona Den exposes no database.
  'scim-okta-lifecycle.e2e.test.ts': { name: 'Provision members from an Okta-shaped SCIM client', placement: 'local' },
  'workspace-new-task-hit-target.e2e.test.ts': { name: 'Keep new tasks and sends instantly responsive', placement: 'local' },
  // Serves the model mock from the spec process's 127.0.0.1; only the local lane can reach it.
  'v2-sessionless-first-send.e2e.test.ts': { name: 'Send the first prompt from the New task route', placement: 'local' },
  'streamed-markdown-answer.e2e.test.ts': {
    cases: [{ id: 'CONT-01', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v2' } }],
  },
  'live-tool-visible-after-session-switch.e2e.test.ts': {
    cases: [{ id: 'SWITCH-10', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--daytona', engine: 'v1' } }],
  },
  'unfinished-tool-lifecycle.e2e.test.ts': {
    cases: [{ id: 'STOP-01', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1' } }],
  },
  'saved-app-creation.e2e.test.ts': {
    cases: [{ id: 'APP-ISOLATION', engines: ['v1', 'v2'], optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1' } }],
  },
};

export const registeredCases = Object.freeze(Object.entries(definitions).flatMap(([spec, definition]) =>
  (definition.cases ?? []).map(value => Object.freeze({ spec, ...value }))
));

export async function catalog(root = new URL('../specs/', import.meta.url)) {
  const files = (await readdir(root)).filter(file => file.endsWith('.e2e.test.ts')).sort();
  for (const file of Object.keys(definitions)) {
    if (!files.includes(file)) throw new Error(`Registered journey missing: ${file}`);
  }
  return Promise.all(files.map(async spec => {
    const source = await readFile(new URL(spec, root), 'utf8');
    const rawDesktop = /import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source);
    return {
      spec,
      name: spec.replace('.e2e.test.ts', '').replaceAll('-', ' '),
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
// Keep in step with the e2e and local-journey jobs in .github/workflows/daytona-e2e.yml.
export const ciLane = Object.freeze({ platform: 'linux', env: Object.freeze([]) });

// Needs the lane cannot meet, phrased as the action that would meet them; empty when the journey is applicable.
export function unmetLaneNeeds(entry, lane = ciLane) {
  const missing = (entry.needs?.env ?? []).filter(name => !lane.env.includes(name)).map(name => `set ${name}`);
  if (entry.needs?.platform && entry.needs.platform !== lane.platform) missing.push(`run on ${entry.needs.platform}`);
  return missing;
}
