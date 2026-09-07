import { readdir, readFile } from 'node:fs/promises';

// One home for CI grouping, readable names, and execution requirements.
// Unlisted specs are discovered automatically as full-regression journeys.
const definitions = {
  'app-smoke.e2e.test.ts': { name: 'Open a working desktop', critical: true },
  'org-team-lifecycle-critical-path.e2e.test.ts': { name: 'Set up a working two-person team', critical: true, model: 'live' },
  'desktop-policy-restricted-mode.e2e.test.ts': { name: 'Apply organization and team permissions', critical: true },
  'cross-server-handoff-atomic-commit.e2e.test.ts': { name: 'Switch servers and recover enrollment', critical: true, placement: 'local' },
};

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
