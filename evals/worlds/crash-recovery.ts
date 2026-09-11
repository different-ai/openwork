import { chrome } from '@openwork/hosts';
import { evaluateOnSurface } from '@openwork/cdp';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Place, Seed } from '@openwork/env';
import { recoveryBuild } from '../fixtures/crash-recovery/build.mjs';
import type { RecoverySnapshot } from '../fixtures/crash-recovery/state.ts';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

/** A source-component world: owns a fresh browser and serves only immutable fixture bytes. */
export async function crashRecoveryWorld(_seed: Seed, { place }: { place: Place }) {
  const build = await recoveryBuild();
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const app = await chrome({ name: `crash-recovery-${id}`, host: place.host(), startUrl: 'about:blank', headless: true });
  const origin = 'http://127.0.0.1:8467'; // Virtual origin, not a listening port.
  const requests: { url: string; method: string }[] = [];
  const interceptionErrors: string[] = [];
  const observations: { label: string; state: RecoverySnapshot }[] = [];
  if (!app.client.webSocketDebuggerUrl) { await app.stop(); throw new Error('Browser debugger URL missing'); }
  const socket = new WebSocket(app.client.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function send(method: string, params: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Interception timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function intercept(params: Record<string, unknown>) {
    const request = params.request;
    if (!record(request) || typeof request.url !== 'string' || typeof request.method !== 'string' || typeof params.requestId !== 'string') throw new Error('Invalid paused request');
    const url = new URL(request.url);
    const asset = request.method === 'GET' && url.origin === origin ? build.assets.get(url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname) : undefined;
    // No request is forwarded. Missing local assets receive a local 404; all other traffic is blocked.
    if (request.method !== 'GET' || url.origin !== origin) await send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
    else await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: asset ? 200 : 404, responseHeaders: [{ name: 'Content-Type', value: asset?.contentType ?? 'text/plain' }, { name: 'Cache-Control', value: 'no-store' }], body: asset?.body ?? '' });
  }
  socket.addEventListener('message', event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (message.method === 'Network.requestWillBeSent' && record(message.params) && record(message.params.request)) {
      const request = message.params.request;
      if (typeof request.url === 'string' && typeof request.method === 'string') requests.push({ url: request.url, method: request.method });
    }
    if (message.method === 'Fetch.requestPaused' && record(message.params)) void intercept(message.params).catch(error => interceptionErrors.push(String(error)));
    if (typeof message.id === 'number') {
      const call = pending.get(message.id);
      if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(); }
    }
  });
  async function snapshot(): Promise<RecoverySnapshot> {
    return evaluateOnSurface(app, () => {
      const witness = window.crashRecovery;
      if (!witness) throw new Error('Fixture has not initialized');
      const root = document.getElementById('root');
      return { heading: document.querySelector('h1')?.textContent ?? '', text: root?.innerText ?? '', stack: document.querySelector('pre')?.textContent ?? '', expanded: document.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? null, buttons: [...document.querySelectorAll('#root button')].map(button => button.textContent ?? ''), injected: document.querySelectorAll('#root img,#root script').length, witness, href: location.href };
    });
  }
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Interception socket timeout')), 15000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Interception socket failed')); }, { once: true }); });
    await send('Network.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } catch (error) { socket.close(); await app.stop(); throw error; }
  return {
    app, origin, version: build.version, release: build.release, requests, interceptionErrors,
    url(route = 'web/') { return `${origin}/${route}${route.includes('?') ? '&' : '?'}grant=FAKE_PAGE_QUERY#FAKE_PAGE_FRAGMENT`; },
    async observe(label: string) { const state = await snapshot(); observations.push({ label, state }); return state; },
    async [Symbol.asyncDispose]() {
      try {
        await writeFile(`${build.output}/browser-${id}.json`, JSON.stringify({ id, startedAt, endedAt: new Date().toISOString(), sourceHash: build.manifest.sourceHash, profile: app.handle.profileDir, sandbox: app.handle.sandboxId, observations, requests, interceptionErrors }, null, 2));
      } finally { socket.close(); await app.stop(); }
    },
  };
}
export type CrashRecoveryWorld = Awaited<ReturnType<typeof crashRecoveryWorld>>;
