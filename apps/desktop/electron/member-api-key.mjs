import { createHash, randomBytes } from "node:crypto";

const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const failure = (code) => ({ ok: false, code });
const fingerprint = (state) => createHash("sha256").update(JSON.stringify([
  state.apiBaseUrl, state.token, state.organizationId,
])).digest("hex");

export function memberApiKeyProofEnabled({ development, packaged, optIn }) {
  return development === true && packaged === false && optIn === "1";
}

/**
 * Private main-process service. readState is a fixed host-owned snapshot reader,
 * never a caller-supplied URL/token. Existing renderer sign-in storage remains
 * trusted application state, not a defense against a compromised app renderer.
 * No payloads/errors are logged, persisted, or returned verbatim.
 */
export function createMemberApiKeyService({ readState, fetch: fetchTransport, allowLoopback = false, now = Date.now, observeSaved = (_receipt) => {} }) {
  const active = new Map();
  const sequence = new Map();
  const ttl = 120_000;

  async function state(owner) {
    const current = await readState(owner);
    if (!current || !id(current.organizationId) || typeof current.token !== "string" || !current.token) throw Error();
    const url = new URL(current.apiBaseUrl);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error();
    return { apiBaseUrl: url.href.replace(/\/$/, ""), token: current.token, organizationId: current.organizationId };
  }

  async function request(current, path, signal, options = {}) {
    const response = await fetchTransport(`${current.apiBaseUrl}${path}`, {
      method: options.body === undefined ? "GET" : "PUT", redirect: "error",
      credentials: "omit", cache: "no-store", signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${current.token}`,
        "x-openwork-org-id": current.organizationId, "x-openwork-legacy-org-id": current.organizationId,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    // Bound response memory; errors never leave this module as raw bodies.
    const reader = response.body?.getReader();
    const chunks = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2_000_000) { await reader.cancel(); throw Error(); }
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
    return { status: response.status, body };
  }

  async function identity(current, connectionId, signal) {
    const me = await request(current, "/v1/me", signal);
    if (me.status !== 200 || !id(me.body?.user?.id) || !id(me.body?.session?.id)) throw Error();
    const orgs = await request(current, "/v1/me/orgs", signal);
    const org = orgs.body?.orgs?.find((entry) => entry.id === current.organizationId);
    if (orgs.status !== 200 || !id(org?.membershipId)) throw Error();
    const inventory = await request(current, "/v1/mcp-connections?scope=usable", signal);
    const connection = inventory.body?.connections?.find((entry) => entry.id === connectionId);
    if (inventory.status !== 200 || !connection || connection.authType !== "apikey"
      || connection.credentialMode !== "per_member" || typeof connection.updatedAt !== "string"
      || typeof connection.name !== "string" || connection.reconnectActionOwner === "organization_admin") throw Error();
    return { memberId: org.membershipId, userId: me.body.user.id, sessionId: me.body.session.id,
      revision: connection.updatedAt, connectionName: connection.name };
  }

  function discard(owner) {
    const old = active.get(owner);
    active.delete(owner);
    old?.controller.abort();
    if (old?.timer) clearTimeout(old.timer);
    sequence.set(owner, (sequence.get(owner) ?? 0) + 1);
  }

  async function current(owner, entry) {
    if (active.get(owner) !== entry || now() >= entry.expiresAt) return null;
    const next = await state(owner);
    return active.get(owner) === entry && fingerprint(next) === entry.fingerprint ? next : null;
  }

  return {
    async prepare(owner, connectionId) {
      if (!id(connectionId)) return failure("invalid_input");
      discard(owner);
      const generation = sequence.get(owner);
      try {
        const initial = await state(owner);
        const controller = new AbortController();
        const actor = await identity(initial, connectionId, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (sequence.get(owner) !== generation || fingerprint(await state(owner)) !== fingerprint(initial)) return failure("context_changed");
        const handle = randomBytes(32).toString("hex");
        const entry = { ...actor, handle, connectionId, fingerprint: fingerprint(initial),
          expiresAt: now() + ttl, controller, submitted: false, timer: null };
        entry.timer = setTimeout(() => { if (active.get(owner) === entry) discard(owner); }, ttl);
        entry.timer.unref?.();
        active.set(owner, entry);
        return { ok: true, context: { handle, connectionId, connectionName: actor.connectionName,
          organizationId: initial.organizationId, memberId: actor.memberId } };
      } catch { return failure("unavailable"); }
    },

    async submit(owner, handle, apiKey) {
      const entry = active.get(owner);
      if (!entry || typeof handle !== "string" || handle !== entry.handle) return failure("expired");
      if (entry.submitted) return failure("busy");
      if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)) return failure("invalid_input");
      entry.submitted = true;
      let dispatched = false;
      try {
        const initial = await current(owner, entry);
        if (!initial) return failure("context_changed");
        const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(45_000)]);
        const actor = await identity(initial, entry.connectionId, signal);
        if (actor.memberId !== entry.memberId || actor.userId !== entry.userId || actor.sessionId !== entry.sessionId
          || actor.revision !== entry.revision || !await current(owner, entry)) return failure("context_changed");
        dispatched = true;
        const result = await request(initial, `/v1/mcp-connections/${encodeURIComponent(entry.connectionId)}/my-credential`, signal,
          { body: { apiKey } });
        apiKey = "";
        if (!await current(owner, entry)) return failure("context_changed");
        // Confirm the same server actor/config after the asynchronous write. If
        // this check fails, do not imply rollback or adopt another account's state.
        const after = await identity(initial, entry.connectionId, signal);
        if (after.memberId !== entry.memberId || after.userId !== entry.userId || after.sessionId !== entry.sessionId
          || after.revision !== entry.revision || !await current(owner, entry)) return failure("context_changed");
        if (result.status === 200 && result.body?.ok === true) {
          // Optional test-only response projection, after both actor/config
          // checks. Never pass the request, key, session, handle, or raw body.
          try {
            observeSaved?.({ httpStatus: 200, stored: true,
              organizationId: initial.organizationId, memberId: entry.memberId,
              connectionId: entry.connectionId });
          } catch { /* Observers cannot change storage or the UI result. */ }
          return { ok: true, saved: true };
        }
        if (result.status === 400) return failure("invalid_input");
        if ([401, 403, 404].includes(result.status)) return failure("forbidden");
        if (result.status === 409) return failure("context_changed");
        // A proxy error, timeout or unrecognized success cannot establish
        // whether storage committed. Never automatically repeat the write.
        return failure("uncertain");
      } catch { return failure(dispatched ? "uncertain" : "unavailable"); }
      finally { apiKey = ""; }
    },

    cancel(owner, handle) {
      if (active.get(owner)?.handle === handle) discard(owner);
    },
    dispose: discard,
  };
}

/** Dedicated IPC, deliberately not part of the generic desktop/tool dispatcher. */
export function registerMemberApiKeyIpc({ ipcMain, window, expectedUrl, readBootstrap, fetch, allowLoopback = false, assertActivation, proofObserver = false }) {
  const snapshots = new Map();
  const allowed = (event) => {
    const target = window();
    if (!target || target.isDestroyed() || event.sender !== target.webContents
      || event.senderFrame !== target.webContents.mainFrame) return false;
    try {
      const actual = new URL(event.senderFrame.url);
      const expected = new URL(expectedUrl());
      return actual.protocol === "file:" ? actual.pathname === expected.pathname && expected.protocol === "file:"
        : actual.origin === expected.origin;
    } catch { return false; }
  };
  const originKey = (input) => {
    const url = new URL(input);
    if (["127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) url.hostname = "localhost";
    return url.origin;
  };
  ipcMain.on("openwork:member-key:snapshot-result", (event, nonce, value) => {
    const pending = snapshots.get(nonce);
    if (!pending || !allowed(event) || pending.owner !== event.sender.id) return;
    snapshots.delete(nonce);
    clearTimeout(pending.timer);
    pending.resolve(value);
  });
  ipcMain.on("openwork:member-key:proof-enabled", (event) => {
    event.returnValue = proofObserver && allowed(event);
  });
  const service = createMemberApiKeyService({ fetch, allowLoopback,
    ...(proofObserver ? { observeSaved: (receipt) => {
      const target = window();
      if (target && !target.isDestroyed()) target.webContents.send("openwork:member-key:saved-proof", receipt);
    } } : {}),
    readState: async (owner) => {
      const target = window();
      if (!target || target.isDestroyed() || target.webContents.id !== owner) throw Error();
      assertActivation();
      const bootstrap = await readBootstrap();
      if (!bootstrap?.baseUrl) throw Error();
      const nonce = randomBytes(32).toString("hex");
      const snapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { snapshots.delete(nonce); reject(Error()); }, 1500);
        snapshots.set(nonce, { owner, resolve, timer });
        target.webContents.send("openwork:member-key:snapshot", nonce);
      });
      if (originKey(bootstrap.baseUrl) !== snapshot?.sessionOrigin) throw Error();
      const base = bootstrap.baseUrl.replace(/\/$/, "");
      // Use only durable host configuration. A snapshot cannot retarget a key.
      const apiBaseUrl = bootstrap.apiBaseUrl || (new URL(base).hostname === "app.openworklabs.com"
        ? "https://api.openworklabs.com" : `${base}/api/den`);
      return { apiBaseUrl, token: snapshot.token, organizationId: snapshot.organizationId };
    },
  });
  ipcMain.handle("openwork:member-key:prepare", async (event, ...args) => {
    if (!allowed(event) || args.length !== 1) return failure("unavailable");
    return service.prepare(event.sender.id, args[0]);
  });
  ipcMain.handle("openwork:member-key:submit", async (event, ...args) => {
    if (!allowed(event) || args.length !== 2) return failure("unavailable");
    return service.submit(event.sender.id, args[0], args[1]);
  });
  ipcMain.handle("openwork:member-key:cancel", async (event, ...args) => {
    if (allowed(event) && args.length === 1) service.cancel(event.sender.id, args[0]);
  });
  return service;
}
