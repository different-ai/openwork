import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const localEmail = (value) => typeof value === 'string' && /^[^@\s]+@acme\.test$/.test(value);

/** Owned synthetic Plain GraphQL boundary, not a replacement /api/app-feedback route.
 * Only the real landing POST may construct mutations. Never preseed feedback here.
 */
export async function startPlainWitness({ directory, token }) {
  if (!directory || !token) throw new Error('Owned storage directory and synthetic token required');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'plain-state.json');
  let state = { customers: [], threads: [], audit: [] };
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = async () => {
    await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  await persist();
  let queue = Promise.resolve();
  const handle = async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Owned operator authorization required' });
    if (request.method === 'GET' && request.url === '/operator/state') return send(200, state);
    if (request.method !== 'POST' || request.url !== '/graphql/v1') return send(404, { error: 'Unknown provider contract' });
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (raw.length > 20000) return send(413, { error: 'Provider payload too large' }); }
    let payload;
    try { payload = JSON.parse(raw); } catch { return send(400, { error: 'Invalid JSON' }); }
    const input = payload?.variables?.input;
    const query = payload?.query;
    if (!object(input) || typeof query !== 'string') return send(400, { error: 'GraphQL query and input required' });
    const at = Date.now();
    let operation, result;
    if (/^\s*mutation LandingUpsertCustomer\(/.test(query) && /upsertCustomer\(input:\s*\$input\)/.test(query)) {
      const email = input.identifier?.emailAddress;
      if (!localEmail(email) || input.onCreate?.email?.email !== email || input.onCreate?.email?.isVerified !== false || typeof input.onCreate?.fullName !== 'string' || !object(input.onUpdate) || Object.keys(input.onUpdate).length) return send(400, { error: 'Synthetic unverified customer contract required' });
      let customer = state.customers.find((value) => value.email === email);
      if (!customer) { customer = { id: `customer_${state.customers.length + 1}`, email, input: structuredClone(input) }; state.customers.push(customer); }
      operation = 'upsertCustomer';
      result = { customer: { id: customer.id }, error: null };
    } else if (/^\s*mutation LandingCreateThread\(/.test(query) && /createThread\(input:\s*\$input\)/.test(query)) {
      if (!state.customers.some((value) => value.id === input.customerIdentifier?.customerId) || input.title !== 'OpenWork app feedback' || !Array.isArray(input.components) || input.components.length !== 1 || typeof input.components[0]?.componentPlainText?.plainText !== 'string' || !input.components[0].componentPlainText.plainText.trim() || !Array.isArray(input.threadFields)) return send(400, { error: 'Existing customer, feedback text and diagnostic fields required' });
      const allowedFields = ['openwork_os_name', 'openwork_app_version', 'openwork_deployment', 'openwork_metadata'];
      if (input.threadFields.some((field) => !allowedFields.includes(field.key) || field.type !== 'STRING' || typeof field.stringValue !== 'string')) return send(400, { error: 'Plain STRING thread-field contract required' });
      const thread = { id: `thread_${state.threads.length + 1}`, createdAt: new Date(at).toISOString(), input: structuredClone(input) };
      state.threads.push(thread);
      operation = 'createThread';
      result = { thread: { id: thread.id }, error: null };
    } else return send(400, { error: 'Unsupported Plain mutation' });
    state.audit.push({ sequence: state.audit.length + 1, at, operation, input: structuredClone(input), result });
    await persist();
    return send(200, { data: { [operation]: result } });
  };
  const server = createServer((request, response) => {
    queue = queue.then(() => handle(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async read() { return JSON.parse(await readFile(path, 'utf8')); },
    async [Symbol.asyncDispose]() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
