import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { agentPermissionDenialMessage, decideAgentPermission } from "@openwork/types/den/agent-permissions-runtime";

/** Exact HTTP(S) origin, never a display hostname or native application's name. */
export function browserUploadOrigin(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}
function scopeKey(scope) {
  if (!scope || ![scope.baseUrl, scope.organizationId, scope.memberId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 2048)) return null;
  const url = new URL(scope.baseUrl);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) return null;
  // Physical computer scope is the private userData store, never synced to Den.
  return createHash("sha256").update(JSON.stringify(["local-built-in-browser", url.href.replace(/\/$/, ""), scope.organizationId, scope.memberId])).digest("hex");
}
function within(folder, file) {
  const relative = path.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function canonicalFiles(folder, files) {
  if (!Array.isArray(files) || !files.length || !files.every((file) => typeof file === "string" && path.isAbsolute(file) && within(folder, file))) return false;
  for (const file of files) {
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) return false;
    await access(file, constants.R_OK);
  }
  return await realpath(folder) === folder && (await lstat(folder)).isDirectory();
}

/** Private, atomic, bounded account-partitioned storage. Corruption never becomes a grant. */
export function createBrowserUploadGrantStore({ directory }) {
  let writes = Promise.resolve();
  let revision = 0;
  const fileFor = (scope) => {
    const key = scopeKey(scope);
    if (!key) throw new Error("Sign in before remembering file sharing.");
    return path.join(directory, `${key}.json`);
  };
  async function read(scope) {
    const file = fileFor(scope);
    let handle;
    try {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("The grant store is not a private directory.");
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await handle.stat()).size > 256_000) throw new Error("Remembered file-sharing data is too large.");
      const data = JSON.parse(await handle.readFile("utf8"));
      if (data?.version !== 1 || !Array.isArray(data.grants) || data.grants.length > 100 || !data.grants.every((grant) =>
        typeof grant?.id === "string" && /^[a-f0-9-]{36}$/.test(grant.id) && browserUploadOrigin(grant.origin) === grant.origin
        && typeof grant.folder === "string" && grant.folder.length < 4096 && path.isAbsolute(grant.folder))) {
        throw new Error("Remembered file-sharing data is invalid. No remembered permission was used.");
      }
      return data.grants.map(({ id, origin, folder }) => ({ id, origin, folder }));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    } finally { await handle?.close(); }
  }
  function write(scope, mutate) {
    const operation = writes.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("The grant store is not a private directory.");
      const grants = mutate(await read(scope));
      if (grants.length > 100) throw new Error("Remove an old file-sharing permission first.");
      const file = fileFor(scope);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, grants }), "utf8");
        await handle.sync();
        await handle.close(); handle = null;
        await rename(temporary, file);
        revision++;
      } finally { await handle?.close(); await rm(temporary, { force: true }); }
      return grants;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return {
    get revision() { return revision; },
    async list(scope) { await writes; return read(scope); },
    async covers(scope, origin, files) {
      await writes;
      const grants = await read(scope);
      for (const grant of grants) if (grant.origin === origin && await canonicalFiles(grant.folder, files).catch(() => false)) return true;
      return false;
    },
    async remember(scope, origin, folder, files) {
      if (browserUploadOrigin(origin) !== origin || typeof folder !== "string" || await realpath(folder) !== folder
        || !await canonicalFiles(folder, files)) throw new Error("Choose the real folder containing all the files being shared. Links are not allowed.");
      return write(scope, (grants) => grants.some((grant) => grant.origin === origin && grant.folder === folder)
        ? grants : [...grants, { id: randomUUID(), origin, folder }]);
    },
    async remove(scope, id) { return write(scope, (grants) => grants.filter((grant) => grant.id !== id)); },
  };
}

/**
 * Main-process browser consent. Signed-in account and rules come from the local
 * server's verified Den read, not from the renderer, prompt or Slack event.
 * A remembered folder covers new chats and remote tasks only on this computer.
 */
export function createBrowserUploadPermissions({ readPolicy, store, requestFiles, legacyApprove, chooseFolder }) {
  let revision = 0;
  const stamp = (policy) => JSON.stringify([scopeKey(policy.scope), policy.rules]);
  function decision(policy, url) {
    return decideAgentPermission(policy.rules ?? [], "browser_upload", [url]);
  }
  async function current() {
    const policy = await readPolicy();
    if (!policy || typeof policy.enabled !== "boolean" || !Array.isArray(policy.rules)) throw new Error("File-sharing policy could not be verified.");
    if (policy.enabled && !scopeKey(policy.scope)) throw new Error("The signed-in file-sharing account could not be verified.");
    return policy;
  }
  return {
    async list() {
      const policy = await current();
      if (!policy.enabled) return { enabled: false, grants: [] };
      const grants = await store.list(policy.scope);
      if (stamp(await current()) !== stamp(policy)) throw new Error("The signed-in account changed. Refresh remembered file sharing.");
      return { enabled: true, grants: grants.map((grant) => ({
        ...grant, blocked: decision(policy, grant.origin).effect === "deny",
      })) };
    },
    async remove(id) {
      const policy = await current();
      if (!policy.enabled || typeof id !== "string") return { ok: false };
      // Invalidate an in-flight remembered authorization before touching disk.
      revision++;
      await store.remove(policy.scope, id);
      return { ok: true };
    },
    async approve(sessionId, request, signal) {
      const policy = await current();
      if (!policy.enabled) return legacyApprove(sessionId, request, signal);
      const origin = browserUploadOrigin(request.url);
      if (!origin) return false;
      const answer = decision(policy, request.url);
      if (answer.effect === "deny") return { allowed: false, code: "organization_policy_denied",
        error: answer.rule ? agentPermissionDenialMessage(answer.rule, request.url) : "Your organization blocked file uploads to this website." };
      const askedAt = stamp(policy);
      const askedRevision = revision;
      let approved = answer.effect === "allow";
      let freshlyApproved = false;
      // Explicit administrative Ask always asks; only the ordinary default Ask
      // can be satisfied by a member's remembered folder permission.
      const canRemember = answer.rule == null;
      if (!approved && canRemember) approved = await store.covers(policy.scope, origin, request.files);
      if (!approved) {
        const response = await requestFiles({ sessionId, site: origin, files: request.files, canRemember, accountScope: scopeKey(policy.scope) }, { signal });
        freshlyApproved = response === "allow" || response === "remember";
        signal.throwIfAborted();
        if (response === "remember" && canRemember) {
          const folder = await chooseFolder(origin);
          signal.throwIfAborted();
          if (!folder || stamp(await current()) !== askedAt || revision !== askedRevision) return false;
          await store.remember(policy.scope, origin, folder, request.files);
          approved = true;
        } else approved = response === "allow" || (response === "always" && canRemember);
      }
      if (!approved) return false;
      const authorizedStoreRevision = store.revision;
      const revalidate = async (frameUrl = request.url) => {
        signal.throwIfAborted();
        if (revision !== askedRevision || store.revision !== authorizedStoreRevision) return false;
        const fresh = await current();
        signal.throwIfAborted();
        // Revocation may finish while the fresh policy read is in flight.
        if (revision !== askedRevision || store.revision !== authorizedStoreRevision) return false;
        if (!fresh.enabled || stamp(fresh) !== askedAt || browserUploadOrigin(frameUrl) !== origin) return false;
        const frame = decision(fresh, frameUrl);
        if (frame.effect === "deny" || decision(fresh, request.url).effect === "deny") return false;
        // A frame-specific mandatory Ask cannot be satisfied by a stored grant
        // or administrative Allow on the top-level page.
        if (frame.effect === "ask" && frame.rule && !freshlyApproved) return false;
        return true;
      };
      if (!await revalidate()) return false;
      return { allowed: true, revalidate };
    },
  };
}
