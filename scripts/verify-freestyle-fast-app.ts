import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { client, launchPreview } from "../packages/freestyle/src/index.ts";

const sha = process.argv[2];
if (!sha) throw new Error("Usage: node scripts/verify-freestyle-fast-app.ts <full-pushed-sha>");
const api = client();
const start = performance.now();
const preview = await launchPreview({ gitSha: sha, world: "app-web", lifetimeMinutes: 10 }, api);
const launchMs = Math.round(performance.now() - start);
try {
  const token = new URL(preview.url).searchParams.get("token");
  assert.ok(token);
  const pageStart = performance.now();
  const page = await fetch(new URL("/", preview.url), {
    headers: { cookie: `__Host-openwork-preview=${token}` }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OpenWork/);
  const appHtmlMs = Math.round(performance.now() - pageStart);
  const health = await api.vms.ref(preview.id).exec({ command: "node /opt/openwork-preview/health.mjs", linuxUser: "root", timeoutMs: 60_000 });
  assert.equal(health.statusCode, 0, "Restored engine and OpenCode workspace must respond");
  const proof = {
    gitSha: sha, world: "app-web", measuredAt: new Date().toISOString(), launchMs, appHtmlMs,
    scope: "Controller launch through private gateway authorization; app HTML and engine health are checked separately after the link is returned. Excludes reviewer HTTP overhead and browser rendering.",
    appAndEngineReady: true,
  };
  await writeFile("freestyle-app-launch-proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `\n## Live OpenWork web snapshot verification\n\nCommit: \`${sha}\`\n\nLink ready: ${(launchMs / 1000).toFixed(2)} s · app HTML after link: ${(appHtmlMs / 1000).toFixed(2)} s.\n\n${proof.scope}\n\nVerified: private app HTML, restored engine, and OpenCode workspace. Test VM deleted.\n`);
} finally {
  await api.vms.delete(preview.id);
}
