import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type CloudSkillFolderSpec = {
  name: string;
  digest: string;
  files: ReadonlyArray<{ path: string; digest: string }>;
};

export type CloudSkillFolderSource = { markdown: string; files: ReadonlyArray<{ path: string; bytes: Uint8Array }> };

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safePath(path: string): boolean {
  if (!path || path.length > 255 || path === "SKILL.md" || path.includes("\\") || path.startsWith("/") || /[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function cloudSkillFolderName(spec: CloudSkillFolderSpec): string {
  const files = [...spec.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.digest]);
  const key = createHash("sha256").update(JSON.stringify([spec.digest, files])).digest("hex").slice(0, 16);
  return `${spec.name}-${key}`;
}

async function listFiles(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else files.push(entry.isFile() ? relative(base, full).split(sep).join("/") : "\u0000");
  }
  return files;
}

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

async function makeReadOnly(folder: string): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) await makeReadOnly(full);
    else await chmod(full, 0o444);
  }
  await chmod(folder, 0o555);
}

const building = new Map<string, Promise<string | null>>();

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
