(() => {
  const query = new URLSearchParams(location.search);
  const witness = window.crashRecovery = { fetches: [], errors: [], rejections: [], copies: [], clipboardAttempts: 0, ready: false, throws: 0, initCalled: false, executed: false, boot: crypto.randomUUID(), trustedClicks: [] };
  window.residual = witness;
  // Installed before the product module graph. Never forwards to native fetch.
  window.fetch = (url, options = {}) => {
    witness.fetches.push({ url: String(url), method: options.method, body: options.body, keepalive: options.keepalive, callStack: new Error('synthetic fetch witness').stack });
    if (query.get('transport') === 'throw') throw new Error('FAKE_TRANSPORT_THROW');
    if (query.get('transport') === 'reject') return Promise.reject(new Error('FAKE_TRANSPORT_REJECT'));
    return Promise.resolve(new Response('', { status: 200 }));
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: query.get('clipboard') === 'absent' ? undefined : { writeText(text) {
    witness.clipboardAttempts++;
    if (query.get('clipboard') === 'denied') return Promise.reject(new Error('FAKE_CLIPBOARD_DENIAL_SECRET'));
    witness.copies.push(text);
    return Promise.resolve();
  } } });
  window.addEventListener('error', event => witness.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => witness.rejections.push(typeof event.reason?.message === 'string' ? event.reason.message : 'non-string rejection'));
  window.addEventListener('click', event => witness.trustedClicks.push(event.isTrusted), true);
  localStorage.setItem('openwork.preferences', JSON.stringify({ analyticsEnabled: query.get('analytics') !== 'off' }));
  if (query.get('electron') === 'yes') window.__OPENWORK_ELECTRON__ = {};
})();
