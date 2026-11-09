#!/usr/bin/env node
/**
 * Real React WorkbotScreen / in-memory fixture browser evidence, NOT production integration.
 * Requires a fresh chat-screen-server.ts (remote Stop changes its in-memory state).
 *
 * Start fixture separately, with WORKBOT_FIXTURE_FRAME pointing to an actual page JPEG:
 *   pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3096
 * Run from any directory (requires Playwright; it is not a declared Workbot dependency):
 * Install it separately if needed: npm install --prefix /your/test-tools playwright@1.57.0
 * Then set PLAYWRIGHT_MODULE=/your/test-tools/node_modules/playwright/index.mjs.
 * Without that override the script tries resolving Playwright from evals:
 *   WORKBOT_EVIDENCE_DIR=/path/out node ee/apps/workbot/scripts/round-two-browser.mjs
 * Options: WORKBOT_FIXTURE_URL (default http://localhost:3096),
 * WORKBOT_EVIDENCE_DIR (default ./workbot-evidence),
 * PLAYWRIGHT_MODULE (optional module path), WORKBOT_FIXTURE_FRAME (optional JPEG path).
 * To capture the source JPEG first, use --record-frame with WORKBOT_FIXTURE_FRAME set;
 * WORKBOT_FRAME_URL defaults to https://example.com. This command exits after capture.
 * Uploads are deliberately separate; this script never publishes evidence or contacts a runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const requireEvals = createRequire(path.join(root, 'evals/package.json'));
let playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) {
  try { playwrightPath = requireEvals.resolve('playwright'); }
  catch { throw new Error('Playwright is not installed in evals. Install it in a separate tools directory and set PLAYWRIGHT_MODULE to its absolute index.mjs path. No application dependency changes are required.'); }
}
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)).href);
const output = path.resolve(process.env.WORKBOT_EVIDENCE_DIR || 'workbot-evidence');
const origin = process.env.WORKBOT_FIXTURE_URL || 'http://localhost:3096';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'This destructive fixture test only accepts a loopback fixture URL, never a production host');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
if (process.argv.includes('--record-frame')) {
  assert.ok(process.env.WORKBOT_FIXTURE_FRAME, 'Set WORKBOT_FIXTURE_FRAME to the output JPEG path');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(process.env.WORKBOT_FRAME_URL || 'https://example.com', { waitUntil: 'networkidle' });
  await page.screenshot({ path: process.env.WORKBOT_FIXTURE_FRAME, type: 'jpeg', quality: 90 });
  await browser.close();
  process.exit(0);
}
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'light' });
const page = await context.newPage();
const report = {
  evidence: 'Real React UI + in-memory threads + simulated recorded frame stream; NOT production integration.',
  origin, viewport: { width: 390, height: 844 }, checks: [], screenshots: [], errors: [], requests: [],
};
let intentionalFailure = false;
page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', text: message.text(), intentionalFailure }); });
page.on('pageerror', error => report.errors.push({ kind: 'page', text: String(error), intentionalFailure }));
page.on('response', response => { if (response.status() >= 400) report.errors.push({ kind: 'http', status: response.status(), url: response.url(), intentionalFailure }); });
page.on('request', request => report.requests.push({ method: request.method(), url: request.url() }));
const flags = { browser: '1', working: '1', profile: '1', centered: '1', preview: '1', quick: '1' };
async function go(scenario = 'browsing', overrides = {}) {
  const query = new URLSearchParams({ scenario, ...flags, ...overrides });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-workbot-composer]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}
function record(name, value) { report.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
async function screenshot(name) {
  if (name === 'mobile-browsing' || name === 'mobile-retained-frame') {
    await page.getByText(/A couple of minutes\.$/).waitFor();
  }
  await page.waitForTimeout(250);
  const file = path.join(output, `final-${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}
// Phones show Workbot's plain name and status instead of the avatar badge; both open the same profile.
const NAME = '[data-workbot-profile-badge], [data-workbot-working-name]';
async function openProfile() {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.locator('[data-workbot-profile-badge]').click();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).waitFor();
}
try {
  await go();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-workbot-live-thumbnail] canvas');
    return canvas?.width > 0 && canvas.getContext('2d').getImageData(100, 100, 1, 1).data[3] > 0;
  });
  assert.equal(await page.locator('[data-workbot-live-thumbnail]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Open browser', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-workbot-profile-badge]').count(), 0, 'No avatar badge on a phone');
  const subtitle = await page.locator('[data-workbot-working-name] [data-workbot-status-line]').evaluate(element => ({ text: element.textContent, width: element.clientWidth, scrollWidth: element.scrollWidth }));
  record('finalBadgeSubtitle', subtitle);
  assert.ok(subtitle.text.includes('Searching YouTube'));
  await screenshot('mobile-browsing');
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.waitForURL('**/browser?**');
  // Delay the next connection's recorded frame to distinguish retained pixels from fresh pixels.
  await page.route('**/v1/workbot/computer/viewer*', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const snapshot = document.querySelector('[data-workbot-live-thumbnail] img');
    const canvas = document.querySelector('[data-workbot-live-thumbnail] canvas');
    return snapshot || (canvas?.width > 0 && canvas.getContext('2d').getImageData(100, 100, 1, 1).data[3] > 0);
  }, undefined, { timeout: 2000 });
  const retained = page.getByRole('img', { name: 'Last browser frame', exact: true });
  record('lastFrameRetention', { url: page.url(), snapshotImageCount: await retained.count(), liveCanvasCount: await page.locator('[data-workbot-live-thumbnail] canvas').count(), note: 'Snapshot or shared live canvas remains drawn on return. A retained live connection may make the snapshot transient unobservable.' });
  await screenshot('mobile-retained-frame');
  await page.unroute('**/v1/workbot/computer/viewer*');
  await openProfile();
  await screenshot('mobile-profile-tasks');
  for (const tab of ['Apps', 'Schedules', 'Identity']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    if (tab === 'Apps') await page.getByText('Gmail', { exact: true }).waitFor();
    if (tab === 'Identity') await page.getByText('About me', { exact: true }).waitFor();
    await screenshot(`mobile-profile-${tab.toLowerCase()}`);
  }
  // On a phone the name opens the same profile as the avatar on a wide screen (ENG-1143), never a phone-only sheet.
  await go('browsing', { centered: '0', preview: '0' });
  await page.locator('[data-workbot-working-name]').click();
  await page.locator('[data-workbot-profile]').waitFor();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).waitFor();
  assert.equal(await page.locator('[data-workbot-task-sheet]').count(), 0);
  record('phoneNameOpensProfile', true);
  await screenshot('mobile-name-profile');
  await page.keyboard.press('Escape');
  for (const quick of ['1', '0']) {
    const start = performance.now();
    await go('waiting', { quick });
    const ack = page.getByText("Sure! I'll take a look in my browser and let you know what I find.", { exact: true });
    if (quick === '1') { await ack.waitFor({ timeout: 2000 }); assert.ok(performance.now() - start < 2000); }
    else { await page.waitForTimeout(250); assert.equal(await ack.count(), 0); }
    record(`quickReply${quick}`, { elapsedMs: performance.now() - start, acknowledgementCount: await ack.count() });
    await screenshot(`mobile-waiting-quick-${quick}`);
  }
  await go('remote', { remote: '1', preview: '0', quick: '0' });
  await page.waitForFunction(() => document.querySelector('[data-workbot-profile-badge], [data-workbot-working-name]')?.textContent.includes('Checking the mobile browser flow'));
  record('remoteBadge', await page.locator(NAME).first().innerText());
  await openProfile();
  assert.equal(await page.locator('[data-workbot-remote-job]').count(), 3);
  const panel = page.getByRole('tabpanel');
  const panelText = await panel.innerText();
  for (const text of ['Mac Studio', 'Needs approval', 'Finished', '3D room planner', 'Stopped']) assert.ok(panelText.includes(text), `Expected ${text}`);
  assert.ok(!panelText.includes('Watch the remote session'), 'Pure local watcher must be hidden');
  record('remoteCollapsed', panelText);
  await screenshot('mobile-remote-collapsed');
  const running = page.locator('[data-workbot-remote-job="command:fixture-running"]');
  await running.locator('summary').click();
  await running.getByRole('button', { name: 'Stop task', exact: true }).waitFor();
  assert.ok((await running.innerText()).includes('Latest messages'));
  record('remoteExpanded', await running.innerText());
  await screenshot('mobile-remote-expanded');
  await running.getByRole('button', { name: 'Stop task', exact: true }).click();
  await running.getByText('Stopped.', { exact: true }).waitFor();
  await running.locator('summary').getByText('Finished', { exact: true }).waitFor();
  assert.equal(await running.getByRole('button', { name: 'Stop task', exact: true }).count(), 0);
  assert.ok(!(await running.locator('summary').innerText()).includes('Working'));
  record('remoteStopped', await running.innerText());
  await screenshot('mobile-remote-stopped');
  const beforeOff = report.requests.length;
  await go('remote', { remote: '0', preview: '0', quick: '0' });
  await openProfile();
  await page.waitForTimeout(500);
  const offRequests = report.requests.slice(beforeOff).filter(request => request.url.includes('/v1/workbot/remote-jobs'));
  assert.equal(offRequests.length, 0);
  assert.equal(await page.locator('[data-workbot-remote-job]').count(), 0);
  record('remoteFlagOff', { remoteRequests: offRequests, rows: 0, text: await page.getByRole('tabpanel').innerText() });
  await screenshot('mobile-remote-flag-off');
  intentionalFailure = true;
  await page.route('**/v1/workbot/memory', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_memory_unavailable' }) }));
  await go();
  await openProfile();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor({ timeout: 15000 });
  const errorText = await page.getByRole('tabpanel').innerText();
  assert.equal((errorText.match(/Try again/g) || []).length, 1);
  record('memoryFailure', errorText);
  await screenshot('mobile-memory-error');
  assert.deepEqual(report.errors.filter(error => !error.intentionalFailure), []);
} catch (error) {
  report.failure = String(error);
  await screenshot('failure');
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, 'final-browser-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
