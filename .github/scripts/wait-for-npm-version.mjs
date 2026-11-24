// Waits until the npm registry serves an exact package version:
//   node wait-for-npm-version.mjs <package> <version>
// `npm publish` now returns before the registry serves the version ("Your
// package is being processed and may take a few minutes to become
// available."). openwork-server 0.18.69 and 0.18.70 took 12m15s and 11m16s
// between that notice and their registry publish time, so the old 3-minute
// install loop failed both releases. This polls the registry's install metadata,
// bypassing caches, until the exact version appears or the deadline
// passes; the install check that follows stays strict.
import { fileURLToPath } from "node:url";

export const REGISTRY = "https://registry.npmjs.org";
export const TIMEOUT_MS = 30 * 60_000;
export const INTERVAL_MS = 30_000;

// Reads the abbreviated document `npm install` resolves versions from,
// revalidated so neither a CDN nor a local cache answers with an old copy.
export async function readNpmVersion(name, version, registry = REGISTRY) {
  try {
    const response = await fetch(`${registry}/${name}`, {
      headers: { accept: "application/vnd.npm.install-v1+json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { version: null, error: `HTTP ${response.status}` };
    const document = await response.json();
    return { version: document.versions?.[version]?.version ?? null };
  } catch (error) {
    return { version: null, error: error.name };
  }
}

export async function waitForNpmVersion({
  name,
  version,
  read = readNpmVersion,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
  intervalMs = INTERVAL_MS,
  log = console.log,
}) {
  const started = now();
  for (let attempt = 1; ; attempt += 1) {
    const result = await read(name, version);
    const elapsed = now() - started;
    if (result.version === version) {
      log(`npm serves ${name}@${version} after ${Math.round(elapsed / 1000)}s (attempt ${attempt}).`);
      return { attempts: attempt, elapsedMs: elapsed };
    }
    const seen = result.error ?? `version ${JSON.stringify(result.version)}`;
    if (elapsed + intervalMs > timeoutMs) {
      throw new Error(`npm did not serve ${name}@${version} within ${Math.round(timeoutMs / 60_000)} minutes (${attempt} checks, last: ${seen}).`);
    }
    log(`npm does not serve ${name}@${version} yet (${seen}, ${Math.round(elapsed / 1000)}s); checking again in ${intervalMs / 1000}s.`);
    await sleep(intervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, version] = process.argv.slice(2);
  if (!name || !version) {
    console.error("usage: node wait-for-npm-version.mjs <package> <version>");
    process.exit(2);
  }
  await waitForNpmVersion({ name, version }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
