import { expect } from 'vitest';
import { spec, createBriefRun, claim } from '@openwork/testkit';
import type { User } from '@openwork/testkit';
import { crashRecoveryWorld } from '../worlds/crash-recovery';
import type { CrashRecoveryWorld } from '../worlds/crash-recovery';
import type { RecoverySnapshot } from '../fixtures/crash-recovery/state';

const test = spec.world(crashRecoveryWorld, { timeout: 90000, needs: { commands: ['git', ...(process.env.OPENWORK_EVAL_DAYTONA === '1' ? ['daytona'] : [])] } });
const heading = 'OpenWork hit an unexpected error';
const safeMessage = 'synthetic ordinary failure';
const safeStack = `Error: ${safeMessage}\n    at SyntheticChild (file:///synthetic/source.tsx:12:34)`;
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 350));
const click = (user: User, text: string) => user.click({ role: 'button', text: text === 'Technical details' ? /Technical details$/ : text });

async function observe(world: CrashRecoveryWorld, label: string) {
  const state = await world.observe(label);
  createBriefRun({ behavior: 'Inspect synthetic source-browser observations', claims: { observation: claim('the observation is available for assertion audit') } }).prove.observation(true, JSON.stringify({ label, state, requests: world.requests, interceptionErrors: world.interceptionErrors }));
  return state;
}
function noDelivery(world: CrashRecoveryWorld) {
  expect(world.requests.length).toBeGreaterThan(0);
  expect(world.requests.filter(request => request.method !== 'GET' || new URL(request.url).origin !== world.origin)).toEqual([]);
  expect(world.interceptionErrors).toEqual([]);
}
function recovered(state: RecoverySnapshot) {
  expect(state.heading).toBe(heading);
  expect(state.buttons).toContain('Reload');
  expect(state.text).not.toContain('Healthy synthetic child');
  expect(state.witness.throws).toBeGreaterThan(0);
  expect(state.witness.errors).toEqual([]);
  expect(state.witness.rejections).toEqual([]);
  expect(state.witness.trustedClicks.length).toBeGreaterThan(0);
  expect(state.witness.trustedClicks.every(Boolean)).toBe(true);
}
async function crash(world: CrashRecoveryWorld, user: User, route = 'web/') {
  await user.navigate(world.url(route));
  await user.see({ text: 'Healthy synthetic child' });
  const initial = await observe(world, 'healthy');
  expect(initial.heading).toBe(''); expect(initial.witness.fetches).toEqual([]);
  await click(user, 'Crash'); await settle();
  return observe(world, 'after-render-throw');
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function envelope(state: RecoverySnapshot, world: CrashRecoveryWorld) {
  expect(state.witness.fetches).toHaveLength(1);
  const request = state.witness.fetches[0];
  expect(request.url).toBe('https://telemetry.invalid/api/123/envelope/?sentry_key=fakepublickey&sentry_version=7');
  expect(request.method).toBe('POST'); expect(request.keepalive).toBe(true);
  expect(request.callStack).toContain('componentDidCatch');
  expect(request.callStack).toContain('reportCaughtWebError'); expect(request.callStack).toContain('deliver');
  const lines = request.body.split('\n'); expect(lines).toHaveLength(3);
  const header: unknown = JSON.parse(lines[0]); const event: unknown = JSON.parse(lines[2]);
  if (!record(header) || !record(event) || !record(event.exception) || !record(event.request)) throw new Error('Invalid envelope structure');
  expect(JSON.parse(lines[1])).toEqual({ type: 'event' });
  expect(header.event_id).toBe(event.event_id); expect(event.event_id).toMatch(/^[a-f0-9]{32}$/);
  expect(event.tags).toEqual({ boot_phase: 'runtime' }); expect(event.release).toBe(world.release);
  expect(event.request.url).toBe(`${world.origin}/web/`); expect(request.body).not.toContain('FAKE_PAGE_');
  return { values: event.exception.values, stack: record(event.extra) ? event.extra.stack : undefined, body: request.body };
}

test('crash recovery ordinary Error recovers, copies exact diagnostics, and reports through real callback', async ({ world, user }) => {
  const state = await crash(world, user); noDelivery(world); recovered(state);
  expect(state.expanded).toBe('false'); expect(state.text).not.toContain(safeMessage); expect(state.stack).toBe('');
  expect(state.buttons).not.toContain('Copy details');
  expect(state.witness.active).toBe(true); expect(state.witness.initCalled).toBe(true); expect(state.witness.analytics).toBe(true);
  const event = envelope(state, world); expect(event.values).toEqual([{ type: 'Error', value: safeMessage }]); expect(event.stack).toBe(safeStack);
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const copied = await observe(world, 'ordinary-copy');
  expect(copied.stack).toBe(safeStack); expect(copied.witness.copies).toHaveLength(1);
  expect(copied.witness.copies[0].split('\n\n')[0]).toMatch(new RegExp(`^OpenWork ${world.version.replaceAll('.', '\\.')} \\(web, [^)]+\\)$`));
  expect(copied.witness.copies[0].split('\n\n').slice(1)).toEqual([safeMessage, safeStack]);
  expect(copied.buttons).toContain('Copied'); recovered(copied); noDelivery(world);
});

for (const mode of ['object', 'toString', 'getter-name', 'getter-message', 'getter-stack']) {
  test(`crash recovery survives ${mode} without a secondary crash`, async ({ world, user }) => {
    const state = await crash(world, user, `web/?case=${mode}`); noDelivery(world); recovered(state);
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const copied = await observe(world, 'hostile-value-copy'); recovered(copied);
    expect(copied.witness.copies).toHaveLength(1); expect(copied.buttons).toContain('Copied');
    expect(copied.text).not.toContain('FAKE_GETTER_FAILURE'); expect(copied.witness.copies[0]).not.toContain('FAKE_GETTER_FAILURE');
    expect(copied.text.length).toBeGreaterThan(heading.length); envelope(copied, world); noDelivery(world);
  });
}

const secrets = ['FAKE_USER', 'FAKE_PASSWORD', 'FAKE_QUERY', 'FAKE_FRAGMENT', 'FAKE_BEARER', 'FAKE_API', 'FAKE_STACK_USER', 'FAKE_STACK_PASSWORD', 'FAKE_STACK_API', 'FAKE_STACK_FRAGMENT'];
for (const surface of ['visible', 'copied', 'report']) {
  test(`crash recovery removes mixed URL api_key and Bearer secrets from ${surface}`, async ({ world, user }) => {
    const state = await crash(world, user, 'web/?case=mixed'); noDelivery(world); recovered(state);
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const observed = await observe(world, `mixed-${surface}`); const event = envelope(observed, world);
    expect(observed.witness.copies).toHaveLength(1);
    const fields = surface === 'visible' ? [observed.text, observed.stack] : surface === 'copied' ? [observed.witness.copies[0]] : [event.body];
    expect(fields.flatMap((field, index) => secrets.filter(secret => field.includes(secret)).map(secret => ({ index, secret })))).toEqual([]);
    expect(fields.join('\n')).toContain('https://asset.invalid/view'); recovered(observed); noDelivery(world);
  });
}

test('crash recovery preserves redacted URL frame line column and closing parenthesis on all surfaces', async ({ world, user }) => {
  recovered(await crash(world, user, 'web/?case=mixed'));
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const state = await observe(world, 'diagnostic-positions'); const event = envelope(state, world); noDelivery(world);
  const suffix = 'at SyntheticChild (https://asset.invalid/chunk.js:12:34)';
  expect([state.stack, state.witness.copies[0], event.stack].map(text => typeof text === 'string' && text.includes(suffix))).toEqual([true, true, true]);
});

test('crash recovery renders benign HTML literally without injected elements or execution', async ({ world, user }) => {
  recovered(await crash(world, user, 'web/?case=html'));
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const state = await observe(world, 'literal-html');
  const html = '<img src=x onerror="window.residual.executed=true"><script>window.residual.executed=true</script>';
  expect(state.text).toContain(html); expect(state.witness.copies[0]).toContain(html);
  expect(state.injected).toBe(0); expect(state.witness.executed).toBe(false); recovered(state); noDelivery(world);
});

for (const mode of ['denied', 'absent']) {
  test(`crash recovery ${mode} clipboard shows generic failure without false success or escaped rejection`, async ({ world, user }) => {
    recovered(await crash(world, user, `web/?clipboard=${mode}`));
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const state = await observe(world, 'clipboard-failure'); noDelivery(world);
    expect(state.witness.copies).toEqual([]); expect(state.buttons).not.toContain('Copied'); expect(state.buttons).toContain('Copy details');
    expect(state.text).not.toContain('FAKE_CLIPBOARD_DENIAL_SECRET');
    const issues = { errors: state.witness.errors, rejections: state.witness.rejections, genericFailureVisible: /(?:could not|couldn't|unable|failed|unavailable|not available).{0,50}cop|cop.{0,50}(?:failed|unavailable|not available)/i.test(state.text), reports: state.witness.fetches.length };
    expect(issues).toEqual({ errors: [], rejections: [], genericFailureVisible: true, reports: 1 });
    expect(state.stack).toBe(safeStack); expect(state.heading).toBe(heading);
    expect(state.witness.trustedClicks.every(Boolean)).toBe(true);
  });
}

test('crash recovery healthy child transitions to recovery and Reload boots healthy again', async ({ world, user, probe }) => {
  const crashed = await crash(world, user); recovered(crashed);
  await click(user, 'Reload'); await user.see({ text: 'Healthy synthetic child' });
  const state = await probe.eventually(() => world.observe('reload-poll'), { until: state => state.witness.boot !== crashed.witness.boot, within: 5000 });
  await observe(world, 'after-reload');
  expect(state.heading).toBe(''); expect(state.buttons).not.toContain('Reload'); expect(state.witness.throws).toBe(0);
  expect(state.witness.fetches).toEqual([]); expect(state.witness.errors).toEqual([]); expect(state.witness.rejections).toEqual([]); noDelivery(world);
});

const gates: [string, string, boolean, boolean, boolean][] = [
  ['desktop', 'desktop/', false, true, true], ['Electron', 'web/?electron=yes', false, true, true],
  ['missing DSN', 'missing/', false, true, true], ['disabled analytics', 'web/?analytics=off', true, true, false],
  ['not initialized', 'web/?init=no', false, false, true],
];
for (const [name, route, active, initialized, analytics] of gates) {
  test(`crash recovery ${name} gate prevents caught and direct reporting`, async ({ world, user }) => {
    recovered(await crash(world, user, route)); await click(user, 'Unique report'); await click(user, 'Burst'); await settle();
    const state = await observe(world, 'gated-reporting');
    expect(state.witness.active).toBe(active); expect(state.witness.initCalled).toBe(initialized); expect(state.witness.analytics).toBe(analytics);
    expect(state.witness.fetches).toEqual([]); recovered(state); noDelivery(world);
  });
}

test('crash recovery consent is dynamic, caught errors dedupe, and session cap is exactly ten', async ({ world, user }) => {
  recovered(await crash(world, user, 'web/?analytics=off'));
  expect((await observe(world, 'initial-off')).witness.fetches).toHaveLength(0);
  await click(user, 'Analytics on'); await click(user, 'Crash'); await settle();
  expect((await observe(world, 'enabled-same-error')).witness.fetches).toHaveLength(1);
  await click(user, 'Crash'); await settle(); expect((await observe(world, 'dedupe')).witness.fetches).toHaveLength(1);
  await click(user, 'Analytics off'); await click(user, 'Unique report');
  const off = await observe(world, 'disabled-again'); expect(off.witness.analytics).toBe(false); expect(off.witness.fetches).toHaveLength(1);
  await click(user, 'Analytics on'); await click(user, 'Unique report'); expect((await observe(world, 'enabled-again')).witness.fetches).toHaveLength(2);
  await click(user, 'Burst'); expect((await observe(world, 'at-cap')).witness.fetches).toHaveLength(10);
  await click(user, 'Unique report'); await click(user, 'Burst'); const capped = await observe(world, 'over-cap');
  expect(capped.witness.fetches).toHaveLength(10);
  const ids = capped.witness.fetches.map(request => { const value: unknown = JSON.parse(request.body.split('\n')[2]); if (!record(value)) throw new Error('Invalid event'); return value.event_id; });
  expect(new Set(ids).size).toBe(10); recovered(capped); noDelivery(world);
});

for (const transport of ['reject', 'throw']) {
  test(`crash recovery ${transport} transport never escapes or defeats recovery`, async ({ world, user }) => {
    const state = await crash(world, user, `web/?transport=${transport}`); expect(state.witness.fetches).toHaveLength(1); envelope(state, world);
    await click(user, 'Unique report'); await settle(); const settled = await observe(world, 'transport-settled');
    expect(settled.witness.fetches).toHaveLength(2); recovered(settled); noDelivery(world);
  });
}
