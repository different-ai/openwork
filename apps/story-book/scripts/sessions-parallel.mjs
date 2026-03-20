import assert from "node:assert/strict";

import {
  findFreePort,
  makeClient,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();
const count = parseInt(args.get("count") ?? "5", 10);

const port = await findFreePort();
const server = await spawnOpencodeServe({
  directory,
  port,
});

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  console.log(`Creating ${count} sessions in parallel...`);

  const results = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const start = Date.now();
      const label = `session-${i + 1}`;
      console.log(`[${label}] starting...`);
      
      try {
        const session = await client.session.create({ title: `Parallel session ${i + 1}` });
        const elapsed = Date.now() - start;
        console.log(`[${label}] created in ${elapsed}ms - ${session.id}`);
        return { label, ok: true, elapsed, id: session.id };
      } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`[${label}] FAILED in ${elapsed}ms - ${err.message}`);
        return { label, ok: false, elapsed, error: err.message };
      }
    })
  );

  const successful = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const times = successful.map((r) => r.elapsed);
  const avg = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(0) : "N/A";
  const max = times.length ? Math.max(...times) : "N/A";
  const min = times.length ? Math.min(...times) : "N/A";

  console.log("\n--- Summary ---");
  console.log(`Total: ${count}, Success: ${successful.length}, Failed: ${failed.length}`);
  console.log(`Times (ms): min=${min}, avg=${avg}, max=${max}`);

  // Now test sequential creates after the parallel burst
  console.log("\nNow creating 3 more sessions sequentially...");
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const session = await client.session.create({ title: `Sequential session ${i + 1}` });
    const elapsed = Date.now() - start;
    console.log(`[sequential-${i + 1}] created in ${elapsed}ms - ${session.id}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      parallelResults: results,
      stats: { count, successful: successful.length, failed: failed.length, min, avg, max },
    }),
  );
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
