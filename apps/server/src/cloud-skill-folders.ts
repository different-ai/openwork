import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Organization skills as real folders on this machine, so an agent can read a
 * skill's references and run its scripts the way it does with a local skill
 * (and the way Claude runs skills from their folder).
 *
 * A folder is built only for a skill a chat uses that has supporting files,
 * from bodies that matched the digests Den listed. It is named after the skill
 * and a key of every file's digest, so a new version gets a new folder, and it
 * is made read-only. Each use checks the folder again, file by file: anything
 * changed, added or removed since (by the person, a tool or a script) rebuilds
 * it from Den, so the agent always runs exactly what the organization
 * published. Older versions of the skill are removed when a new one is built.
 */

export type CloudSkillFolderSpec = {
  name: string;
  /** SKILL.md digest, `sha256:<hex>`. */
  digest: string;
  files: ReadonlyArray<{ path: string; digest: string }>;
};

export type CloudSkillFolderSource = { markdown: string; files: ReadonlyArray<{ path: string; bytes: Uint8Array }> };

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A supporting file path that stays inside the skill folder. */
function safePath(path: string): boolean {
  if (!path || path.length > 255 || path === "SKILL.md" || path.includes("\\") || path.startsWith("/") || /[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The folder a version of a skill lives in: its name and a key of all its digests. */
export function cloudSkillFolderName(spec: CloudSkillFolderSpec): string {
  const files = [...spec.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.digest]);
  const key = createHash("sha256").update(JSON.stringify([spec.digest, files])).digest("hex").slice(0, 16);
  return `${spec.name}-${key}`;
}

/** Every file under `root`, as paths relative to it with `/` separators. */
async function listFiles(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    // Links, sockets and the like are never part of a skill: they fail the check.
    else files.push(entry.isFile() ? relative(base, full).split(sep).join("/") : "\u0000");
  }
  return files;
}

/** True when the folder holds exactly the skill's files with exactly its digests. */
async function folderMatches(folder: string, spec: CloudSkillFolderSpec): Promise<boolean> {
  try {
    const expected = new Map([["SKILL.md", spec.digest], ...spec.files.map((file) => [file.path, file.digest] as const)]);
    const present = await listFiles(folder);
    if (present.length !== expected.size || present.some((path) => !expected.has(path))) return false;
    for (const [path, digest] of expected) {
      if (sha256(new Uint8Array(await readFile(join(folder, ...path.split("/"))))) !== digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Gives the owner write access back throughout `folder`, so it can be removed (Windows refuses to delete read-only files). */
async function makeWritable(folder: string): Promise<void> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  await chmod(folder, 0o755).catch(() => undefined);
  for (const entry of entries) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) await makeWritable(full);
    else await chmod(full, 0o644).catch(() => undefined);
  }
}

async function removeFolder(folder: string): Promise<void> {
  await makeWritable(folder);
  await rm(folder, { recursive: true, force: true });
}

/** Files read-only, then folders read-only from the deepest up. */
async function makeReadOnly(folder: string): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) await makeReadOnly(full);
    else await chmod(full, 0o444);
  }
  await chmod(folder, 0o555);
}

const building = new Map<string, Promise<string | null>>();

/**
 * The SKILL.md path of the skill's folder under `root`, built or rebuilt from
 * `read()` when it is missing or no longer matches. Null when the skill cannot
 * have a folder (an unsafe name or path) or its bodies could not be read and
 * verified; the caller then keeps serving the skill without one.
 */
export async function ensureCloudSkillFolder(input: {
  root: string;
  spec: CloudSkillFolderSpec;
  read: () => Promise<CloudSkillFolderSource | null>;
}): Promise<string | null> {
  const { root, spec } = input;
  if (!SKILL_NAME.test(spec.name) || spec.name.length > 64 || !spec.files.every((file) => safePath(file.path))) return null;
  const folder = join(root, cloudSkillFolderName(spec));
  const pending = building.get(folder);
  if (pending) return pending;
  const run = (async () => {
    if (await folderMatches(folder, spec)) return join(folder, "SKILL.md");
    const source = await input.read();
    if (!source || sha256(source.markdown) !== spec.digest) return null;
    const bodies = new Map(source.files.map((file) => [file.path, file.bytes]));
    if (bodies.size !== spec.files.length || spec.files.some((file) => !bodies.has(file.path) || sha256(bodies.get(file.path)!) !== file.digest)) return null;

    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = join(root, `.building-${randomBytes(6).toString("hex")}`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeFile(join(staging, "SKILL.md"), source.markdown);
      for (const [path, bytes] of bodies) {
        const target = resolve(staging, ...path.split("/"));
        if (!target.startsWith(`${resolve(staging)}${sep}`)) return null;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      await makeReadOnly(staging);
      if (await stat(folder).then(() => true, () => false)) await removeFolder(folder);
      await rename(staging, folder);
    } finally {
      await removeFolder(staging).catch(() => undefined);
    }
    // Older versions of this skill are no longer listed by Den.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== cloudSkillFolderName(spec) && entry.name.startsWith(`${spec.name}-`) && /^[a-f0-9]{16}$/.test(entry.name.slice(spec.name.length + 1))) {
        await removeFolder(join(root, entry.name)).catch(() => undefined);
      }
    }
    return (await folderMatches(folder, spec)) ? join(folder, "SKILL.md") : null;
  })().finally(() => building.delete(folder));
  building.set(folder, run);
  return run;
}
