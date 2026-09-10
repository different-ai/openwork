import { readdir, readFile } from 'node:fs/promises';

// One home for CI grouping, readable names, and execution requirements.
// Unlisted specs are discovered automatically as full-regression journeys.
const definitions = {
  // Fixes a fault proxy in front of den-api before Den boots; only the local lane can do that.
  'mcp-oauth-start-unreadable-response.e2e.test.ts': { name: 'Read why a connection sign-in could not start', placement: 'local' },
  'app-smoke.e2e.test.ts': { name: 'Open a working desktop', critical: true },
  // Boots the packaged cloud and enterprise artifacts; only packaged-smoke provides those binaries.
  'packaged-first-launch.e2e.test.ts': { name: 'Open a fresh cloud or enterprise install', placement: 'local' },
  // Boots the packaged enterprise artifact twice (fresh and pre-activated); only packaged-smoke provides that binary.
  'packaged-preactivation-updater.e2e.test.ts': { name: 'Keep an unactivated enterprise install from updating itself', placement: 'local' },
  'packaged-activated-launch.e2e.test.ts': { name: 'Open an already-activated enterprise install', placement: 'local' },
  // Boots a RELEASED enterprise binary (and optionally an older baseline) already activated against a real Den; skips without OPENWORK_EVAL_ELECTRON_BINARY.
  'released-enterprise-activated.e2e.test.ts': { name: 'Open and update an activated enterprise install against its Den', placement: 'local' },
  'org-team-lifecycle-critical-path.e2e.test.ts': { name: 'Set up a working two-person team', critical: true, model: 'live' },
  'desktop-policy-restricted-mode.e2e.test.ts': {
    // The rollback case severs local child IPC and faults its loopback transport.
    name: 'Apply organization and team permissions', critical: true, placement: 'local',
    cases: [{ id: 'POLICY-ROLLBACK', engines: ['v1', 'v2'], surfaces: ['web'], defaultSurface: 'web', optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v1', surface: 'web' } }],
  },
  'cross-server-handoff-atomic-commit.e2e.test.ts': { name: 'Switch servers and recover enrollment', critical: true, placement: 'local' },
  'workspace-new-task-hit-target.e2e.test.ts': { name: 'Keep new tasks and sends instantly responsive', placement: 'local' },
  // Serves the model mock from the spec process's 127.0.0.1; only the local lane can reach it.
  'v2-sessionless-first-send.e2e.test.ts': { name: 'Send the first prompt from the New task route', placement: 'local' },
  'streamed-markdown-answer.e2e.test.ts': {
    cases: [{ id: 'CONT-01', engines: ['v1', 'v2'], surfaces: ['web', 'electron'], defaultSurface: 'web', optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--local', engine: 'v2', surface: 'web' } }],
  },
  'live-tool-visible-after-session-switch.e2e.test.ts': {
    cases: [{ id: 'SWITCH-10', engines: ['v1', 'v2'], surfaces: ['web'], defaultSurface: 'web', optIns: ['OPENWORK_EVAL_E2E_TESTS'], example: { placement: '--daytona', engine: 'v1', surface: 'web' } }],
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

export function selectJourneys(entries, { critical = false, only = '', changed = [] } = {}) {
  return entries.filter(entry => (!critical || entry.critical || changed.includes(entry.spec)) && entry.spec.includes(only));
}
