import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "@openwork/testkit";
import { INTERVAL_MS, TIMEOUT_MS, readNpmVersion, waitForNpmVersion } from "../../.github/scripts/wait-for-npm-version.mjs";

// v0.18.70: npm publish printed "+ openwork-server@0.18.70" at 00:39:18.971Z;
// the registry recorded the version at 00:50:34.885Z.
const PROCESSING_MS = Date.parse("2026-11-19T00:50:34.885Z") - Date.parse("2026-11-19T00:39:18.971Z");
const OLD_INSTALL_BUDGET_MS = 6 * 30_000;

function registryClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
}

test("waits through the 0.18.70 registry processing delay that the old install loop gave up on", async () => {
  const { now, sleep } = registryClock();
  const reads: number[] = [];
  const read = async () => {
    reads.push(now());
    return now() >= PROCESSING_MS ? { version: "0.18.70" } : { version: null, error: "HTTP 200 without 0.18.70" };
  };
  const result = await waitForNpmVersion({ name: "openwork-server", version: "0.18.70", read, sleep, now, log: () => {} });
  assert.ok(PROCESSING_MS > OLD_INSTALL_BUDGET_MS, "the observed delay outlasts six 30s install attempts");
  assert.ok(result.elapsedMs >= PROCESSING_MS && result.elapsedMs < PROCESSING_MS + INTERVAL_MS);
  assert.equal(reads.filter((at) => at < PROCESSING_MS).length, result.attempts - 1, "only the last read saw the version");
  assert.ok(result.elapsedMs < TIMEOUT_MS);
});

test("fails at the deadline when the version never appears, and an older version does not count", async () => {
  const { now, sleep } = registryClock();
  let reads = 0;
  const read = async () => { reads += 1; return { version: "0.18.69" }; };
  await assert.rejects(
    waitForNpmVersion({ name: "openwork-server", version: "0.18.70", read, sleep, now, log: () => {} }),
    /npm did not serve openwork-server@0\.18\.70 within 30 minutes \(\d+ checks, last: version "0\.18\.69"\)/,
  );
  assert.ok(now() <= TIMEOUT_MS, "never sleeps past the deadline");
  assert.equal(reads, TIMEOUT_MS / INTERVAL_MS + 1);
});

test("reads the uncached install metadata npm resolves versions from", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.url !== "/openwork-server") return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
    response.end(JSON.stringify({ name: "openwork-server", versions: { "0.18.69": { version: "0.18.69" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const registry = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await readNpmVersion("openwork-server", "0.18.69", registry), { version: "0.18.69" });
    assert.deepEqual(await readNpmVersion("openwork-server", "0.18.70", registry), { version: null });
    assert.deepEqual(await readNpmVersion("not-published", "0.18.70", registry), { version: null, error: "HTTP 404" });
    assert.ok(seen.every((headers) => headers.accept === "application/vnd.npm.install-v1+json" && headers["cache-control"] === "no-cache"));
  } finally {
    server.close();
  }
});

test("the release publishes, waits for the registry, then installs once from it", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");
  const job = workflow.slice(workflow.indexOf("\n  publish-npm:"), workflow.indexOf("\n  publish-daytona-snapshot:"));
  const publish = job.indexOf("npm publish \"$NPM_TARBALL\"");
  const wait = job.indexOf("node .github/scripts/wait-for-npm-version.mjs openwork-server \"$RELEASE_VERSION\"");
  const install = job.indexOf("npm install -g --prefer-online --prefix \"$prefix\" \"openwork-server@$RELEASE_VERSION\"");
  assert.ok(publish > 0 && wait > publish && install > wait, "publish, then wait, then install");
  assert.match(job, /sparse-checkout: \.github\/scripts\/wait-for-npm-version\.mjs/);
  assert.match(job.slice(install), /\[ "\$actual" = "\$RELEASE_VERSION" \]/, "the installed binary must report the release version");
  assert.doesNotMatch(job, /for attempt in|sleep \d/, "no fixed install retry loop");
});
