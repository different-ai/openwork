const PLAIN_ENDPOINT = 'https://core-api.uk.plain.com/graphql/v1';

/** Scoped to the disposable landing child process via NODE_OPTIONS=--import.
 * No production URL/configuration, bot check, form or route is changed.
 */
export function feedbackFetch({ origin, token, fetch: realFetch }) {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Plain witness must be owned loopback origin');
  if (!token) throw new Error('Synthetic Plain token required');
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === PLAIN_ENDPOINT) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.get('authorization') !== `Bearer ${token}`) throw new Error('Refusing non-synthetic Plain credential');
      if (input instanceof Request) return realFetch(new Request(`${target.origin}/graphql/v1`, input), init);
      return realFetch(`${target.origin}/graphql/v1`, init);
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`Owned landing external egress blocked: ${url.origin}`);
    return realFetch(input, init);
  };
}

if (process.env.OPENWORK_WORKSHOP_PLAIN_ORIGIN) {
  globalThis.fetch = feedbackFetch({ origin: process.env.OPENWORK_WORKSHOP_PLAIN_ORIGIN, token: process.env.OPENWORK_WORKSHOP_PLAIN_TOKEN, fetch: globalThis.fetch.bind(globalThis) });
}
