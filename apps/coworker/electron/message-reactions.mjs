import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withCoworkerRecordWrite } from "./coworkers.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { GROUPS_DIR, isGroupId, withGroupMetadataWrite } from "./groups.mjs";

const STORE_VERSION = 2;
const MAX_REACTIONS = 2000;
const MAX_RECEIPTS = 512;
const MAX_ADMISSION_RECEIPTS = 32;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EMOJI = /^(?:\p{RGI_Emoji}|[\p{Emoji}--\p{Emoji_Component}])$/v;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const decoder = new TextDecoder("utf-8", { fatal: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identifier = (value, limit = 256) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\s\p{Cc}\p{Cf}<>]/u.test(value);
const slug = (value) => typeof value === "string" && SLUG.test(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left, right) => sameNode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode && left.nlink === right.nlink;
const keysAre = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const actorKey = (actor) => JSON.stringify([actor.slug, actor.createdAt]);
const slotKey = (reaction) => JSON.stringify([reaction.messageId, reaction.actor.slug, reaction.actor.createdAt]);

export function normalizeReactionEmoji(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 64 || !EMOJI.test(value)
    || [...segmenter.segment(value)].length !== 1 || /^\p{Emoji_Component}$/u.test(value)) {
    throw new Error("Use one emoji, or null to remove a reaction.");
  }
  return value;
}

function scopeOf(value) {
  if (keysAre(value, ["kind", "slug", "threadId"]) && value.kind === "private" && slug(value.slug) && identifier(value.threadId)) {
    return { kind: "private", slug: value.slug, threadId: value.threadId };
  }
  if (keysAre(value, ["kind", "groupId"]) && value.kind === "group" && isGroupId(value.groupId)) {
    return { kind: "group", groupId: value.groupId };
  }
  throw new Error("A private discussion or group scope is required.");
}

function admissionOf(value) {
  if (!keysAre(value, ["threadId", "messageId"]) || !identifier(value.threadId) || !identifier(value.messageId)) {
    throw new Error("An exact host native admission with threadId and messageId is required.");
  }
  return { threadId: value.threadId, messageId: value.messageId };
}

function actorOf(value) {
  if (!slug(value?.slug) || !identifier(value.createdAt, 80) || typeof value.name !== "string" || !value.name.trim()
    || value.name.length > 256 || /\p{Cc}/u.test(value.name)) {
    throw new Error("A current coworker creation identity is required.");
  }
  return { slug: value.slug, name: value.name, createdAt: value.createdAt };
}

function validateStore(value, scope, createdAt) {
  const invalid = () => { throw new Error("Invalid reaction store. The file has been kept."); };
  if (!keysAre(value, ["version", "scope", "createdAt", "revision", "reactions", "receipts"]) || ![1, STORE_VERSION].includes(value.version)
    || JSON.stringify(scopeOf(value.scope)) !== JSON.stringify(scope) || value.createdAt !== createdAt || !timestamp(value.revision)
    || !Array.isArray(value.reactions) || value.reactions.length > MAX_REACTIONS
    || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) invalid();
  const slots = new Set();
  for (const reaction of value.reactions) {
    if (!keysAre(reaction, ["messageId", "emoji", "actor", "updatedAt"]) || !identifier(reaction.messageId)
      || !keysAre(reaction.actor, ["slug", "name", "createdAt"]) || reaction.emoji === null || !timestamp(reaction.updatedAt)) invalid();
    actorOf(reaction.actor);
    normalizeReactionEmoji(reaction.emoji);
    const key = slotKey(reaction);
    if (slots.has(key)) invalid();
    slots.add(key);
  }
  const receipts = new Set();
  const lanes = new Map();
  const receiptKeys = value.version === 1 ? ["id", "fingerprint"] : ["id", "fingerprint", "lane", "admission"];
  for (const receipt of value.receipts) {
    if (!keysAre(receipt, receiptKeys) || typeof receipt.id !== "string" || !DIGEST.test(receipt.id)
      || typeof receipt.fingerprint !== "string" || !DIGEST.test(receipt.fingerprint) || receipts.has(receipt.id)) invalid();
    receipts.add(receipt.id);
    if (value.version === 1) continue;
    if (typeof receipt.lane !== "string" || !DIGEST.test(receipt.lane)) invalid();
    const admission = JSON.stringify(admissionOf(receipt.admission));
    const lane = lanes.get(receipt.lane) ?? { admission, count: 0 };
    lane.count++;
    if (lane.admission !== admission || lane.count > MAX_ADMISSION_RECEIPTS) invalid();
    lanes.set(receipt.lane, lane);
  }
  if (value.reactions.length && value.revision === 0) invalid();
  return value;
}

async function fileInfo(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function regularFile(info) {
  if (!info.isFile() || info.nlink !== 1) throw new Error("Reaction storage cannot use symbolic links, hard links, or non-regular files.");
}

async function assertFile(target, expected) {
  const current = await fileInfo(target);
  if (current) regularFile(current);
  if (expected === null && current === null) return;
  if (!expected || !current || !sameFile(current, expected)) throw new Error("Reaction storage changed while saving. Try again.");
}

async function readText(target, limit, optional = false) {
  const info = await fileInfo(target);
  if (info === null && optional) return { text: null, info };
  if (!info) throw new Error("The coworker or group no longer exists.");
  regularFile(info);
  if (info.size > limit) throw new Error("Reaction storage is oversized. The file has been kept.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(await handle.stat(), info)) throw new Error("Reaction storage changed while reading.");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== info.size || !sameFile(await handle.stat(), info)) throw new Error("Reaction storage changed while reading.");
    await assertFile(target, info);
    return { text: decoder.decode(bytes.subarray(0, length)), info };
  } finally {
    await handle.close();
  }
}

async function authorized(authorize) {
  if (await authorize() === false) throw new Error("The reaction was not authorized.");
}

async function persist(snapshot, value, authorize) {
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error("The reaction store has reached its size limit.");
  await snapshot.verify();
  const temporary = `${snapshot.target}.${randomUUID()}.tmp`;
  let handle;
  let info;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    info = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    info = await handle.stat();
    await handle.close();
    handle = undefined;
    await authorized(authorize);
    await snapshot.verify();
    await assertFile(temporary, info);
    await rename(temporary, snapshot.target);
  } finally {
    await handle?.close();
    if (info) {
      const current = await fileInfo(temporary).catch(() => null);
      if (current?.isFile() && sameNode(current, info)) await unlink(temporary).catch(() => undefined);
    }
  }
}

export function createMessageReactions({ directory, onChange = () => {}, now = Date.now }) {
  if (typeof directory !== "string" || !directory.trim() || typeof onChange !== "function" || typeof now !== "function") {
    throw new Error("Reaction storage requires a directory and valid callbacks.");
  }
  const root = path.resolve(directory);

  function serial(scope, actor, run) {
    const slugs = [...new Set([scope.kind === "private" ? scope.slug : null, actor?.slug].filter(Boolean))].sort();
    const enter = (index) => index < slugs.length
      ? withCoworkerRecordWrite(root, slugs[index], () => enter(index + 1))
      : scope.kind === "group" ? withGroupMetadataWrite(root, scope.groupId, run) : run();
    return enter(0);
  }

  async function load(scope, actor) {
    const directories = new Map();
    const files = new Map();
    const records = new Map();
    async function pin(...segments) {
      let target = root;
      for (const segment of [null, ...segments]) {
        if (segment !== null) target = path.join(target, segment);
        if (directories.has(target)) continue;
        const info = await lstat(target);
        if (!info.isDirectory()) throw new Error("Reaction storage cannot follow symbolic links or missing homes.");
        directories.set(target, { info, real: await realpath(target) });
      }
      return target;
    }
    async function verify() {
      for (const [target, before] of directories) {
        const current = await lstat(target);
        if (!current.isDirectory() || !sameNode(current, before.info) || await realpath(target) !== before.real) {
          throw new Error("The reaction home was replaced or retired.");
        }
      }
      for (const [target, before] of files) await assertFile(target, before);
    }
    async function record(slug) {
      if (records.has(slug)) return records.get(slug);
      const home = await pin(slug);
      const target = path.join(home, "coworker.md");
      const source = await readText(target, MAX_METADATA_BYTES);
      files.set(target, source.info);
      const { data } = parseFrontmatter(source.text);
      const identity = actorOf({ slug, name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : slug, createdAt: data.createdAt });
      if (data.retiredAt !== undefined || data.retiredSlug !== undefined) throw new Error("This coworker is retired.");
      const result = { home, identity, workspaceId: typeof data.workspaceId === "string" ? data.workspaceId.trim() : "" };
      records.set(slug, result);
      return result;
    }
    let currentActor;
    if (actor) {
      const current = await record(actor.slug);
      if (current.identity.createdAt !== actor.createdAt || current.workspaceId !== actor.workspaceId) {
        throw new Error("This coworker was replaced or its workspace changed.");
      }
      currentActor = current.identity;
    }
    let home;
    let createdAt;
    if (scope.kind === "private") {
      const owner = await record(scope.slug);
      home = owner.home;
      createdAt = owner.identity.createdAt;
    } else {
      home = await pin(GROUPS_DIR, scope.groupId);
      const target = path.join(home, "group.json");
      const source = await readText(target, MAX_METADATA_BYTES);
      files.set(target, source.info);
      const group = JSON.parse(source.text);
      if (!group || group.schemaVersion !== 1 || group.id !== scope.groupId || !timestamp(group.createdAt)
        || !Array.isArray(group.participantSlugs) || !group.participantSlugs.every(slug)
        || !(group.archivedAt === null || timestamp(group.archivedAt))) throw new Error("Group metadata is unreadable.");
      if (actor && (group.archivedAt !== null || !group.participantSlugs.includes(actor.slug))) {
        throw new Error("Reactions require active group membership.");
      }
      createdAt = group.createdAt;
    }
    const target = path.join(home, scope.kind === "private" ? `.message-reactions-${hash(scope.threadId)}.json` : ".message-reactions.json");
    const source = await readText(target, MAX_STORE_BYTES, true);
    files.set(target, source.info);
    const store = source.text === null
      ? { version: STORE_VERSION, scope, createdAt, revision: 0, reactions: [], receipts: [] }
      : validateStore(JSON.parse(source.text), scope, createdAt);
    await verify();
    return { target, store, actor: currentActor, verify };
  }

  async function read(input) {
    const scope = scopeOf(input);
    return serial(scope, null, async () => {
      const { store } = await load(scope);
      return { revision: store.revision, reactions: store.reactions.map((reaction) => ({ ...reaction, actor: { ...reaction.actor } })) };
    });
  }

  async function set(input, { authorize } = {}) {
    if (!keysAre(input, ["scope", "actor", "messageId", "emoji", "operationId", "admission"]) || typeof authorize !== "function") {
      throw new Error("A reaction command and a trusted authorizer are required.");
    }
    const scope = scopeOf(input.scope);
    const identity = actorOf(input.actor);
    if (typeof input.actor.path !== "string" || !path.isAbsolute(input.actor.path) || path.resolve(input.actor.path) !== path.join(root, identity.slug)
      || typeof input.actor.workspaceId !== "string" || (input.actor.workspaceId !== "" && !identifier(input.actor.workspaceId))) {
      throw new Error("The actor must belong to this coworker directory and workspace.");
    }
    const actor = { ...identity, workspaceId: input.actor.workspaceId };
    const { messageId, operationId } = input;
    if (!identifier(messageId) || !identifier(operationId, 512)) throw new Error("Valid message and host operation identifiers are required.");
    const emoji = normalizeReactionEmoji(input.emoji);
    const admission = admissionOf(input.admission);
    const id = hash(operationId);
    const lane = hash(JSON.stringify([actor.slug, actor.createdAt, admission.threadId]));
    const fingerprint = hash(JSON.stringify([scope, actor.slug, actor.createdAt, messageId, emoji, admission]));
    const result = await serial(scope, actor, async () => {
      const snapshot = await load(scope, actor);
      const { store } = snapshot;
      if (store.version !== STORE_VERSION) throw new Error("These reaction receipts predate native admission tracking. The file is read-only and has been kept.");
      const index = store.reactions.findIndex((reaction) => reaction.messageId === messageId && actorKey(reaction.actor) === actorKey(actor));
      const previous = index === -1 ? null : store.reactions[index];
      const receipt = store.receipts.find((entry) => entry.id === id);
      if (receipt && receipt.fingerprint !== fingerprint) throw new Error("The operation id was already used for different reaction arguments.");
      await authorized(authorize);
      await snapshot.verify();
      if (receipt) return { revision: store.revision, messageId, emoji: previous?.emoji ?? null, actor: snapshot.actor, changed: false, duplicate: true };
      store.receipts = store.receipts.filter((entry) => entry.lane !== lane
        || (entry.admission.threadId === admission.threadId && entry.admission.messageId === admission.messageId));
      if (store.receipts.filter((entry) => entry.lane === lane).length >= MAX_ADMISSION_RECEIPTS) {
        throw new Error("The reaction receipt limit for this native admission was reached.");
      }
      if (store.receipts.length >= MAX_RECEIPTS) throw new Error("The reaction receipt limit across native lanes was reached. Other lanes have been kept.");
      const changed = (previous?.emoji ?? null) !== emoji;
      if (changed) {
        if (store.revision === Number.MAX_SAFE_INTEGER) throw new Error("The reaction revision limit was reached.");
        if (emoji === null) store.reactions.splice(index, 1);
        else {
          const updatedAt = now();
          if (!timestamp(updatedAt)) throw new Error("A valid reaction timestamp is required.");
          const reaction = { messageId, emoji, actor: snapshot.actor, updatedAt: Math.max(updatedAt, previous?.updatedAt ?? 0) };
          if (index === -1) {
            if (store.reactions.length >= MAX_REACTIONS) throw new Error("The conversation reaction limit was reached.");
            store.reactions.push(reaction);
          } else store.reactions[index] = reaction;
        }
        store.revision++;
      }
      store.receipts.push({ id, fingerprint, lane, admission });
      await persist(snapshot, store, authorize);
      return { revision: store.revision, messageId, emoji, actor: snapshot.actor, changed };
    });
    if (result.changed) {
      try { void Promise.resolve(onChange({ ...scope }, result.revision)).catch(() => undefined); }
      catch {}
    }
    return result;
  }

  return { read, set };
}
