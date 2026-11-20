import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudSkillFolderName, ensureCloudSkillFolder, type CloudSkillFolderSource } from "../src/cloud-skill-folders.js";

const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const markdown = "---\nname: brand-report\ndescription: Builds the brand report.\n---\n\nRun scripts/build.py with assets/logo.png.";
const script = new Uint8Array(Buffer.from("print('brand report')\n"));
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const source: CloudSkillFolderSource = { markdown, files: [{ path: "scripts/build.py", bytes: script }, { path: "assets/logo.png", bytes: logo }] };
const spec = {
  name: "brand-report",
  digest: digest(markdown),
  files: [{ path: "scripts/build.py", digest: digest(script) }, { path: "assets/logo.png", digest: digest(logo) }],
};

let root = "";
afterEach(async () => {
  // Folders are read-only; give write access back before removing them.
  const writable = async (path: string): Promise<void> => {
    await chmod(path, 0o755).catch(() => {});
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await writable(join(path, entry.name));
      else await chmod(join(path, entry.name), 0o644).catch(() => {});
    }
  };
  if (root) { await writable(root); await rm(root, { recursive: true, force: true }); }
});

async function freshRoot() {
  root = await mkdtemp(join(tmpdir(), "cloud-skill-folders-"));
  return join(root, "cloud-skill-folders");
}

describe("ensureCloudSkillFolder", () => {
  test("builds a read-only folder with exactly the skill's files, and reuses it without reading Den again", async () => {
    const folders = await freshRoot();
    let reads = 0;
    const read = async () => { reads += 1; return source; };
    const path = await ensureCloudSkillFolder({ root: folders, spec, read });
    expect(path).toBe(join(folders, cloudSkillFolderName(spec), "SKILL.md"));
    const folder = dirname(path!);
    expect(await readFile(path!, "utf8")).toBe(markdown);
    expect(new Uint8Array(await readFile(join(folder, "assets", "logo.png")))).toEqual(logo);
    if (process.platform !== "win32") {
      expect((await stat(join(folder, "scripts", "build.py"))).mode & 0o777).toBe(0o444);
      expect((await stat(join(folder, "scripts"))).mode & 0o777).toBe(0o555);
      expect((await stat(folder)).mode & 0o777).toBe(0o555);
    }
    expect(await ensureCloudSkillFolder({ root: folders, spec, read })).toBe(path);
    expect(reads).toBe(1);
  });

  test("rebuilds the folder from Den when a file was changed or one was added", async () => {
    const folders = await freshRoot();
    const read = async () => source;
    const path = (await ensureCloudSkillFolder({ root: folders, spec, read }))!;
    const folder = dirname(path);

    // A script edited in place, despite read-only permissions.
    await chmod(join(folder, "scripts", "build.py"), 0o644);
    await writeFile(join(folder, "scripts", "build.py"), "import os; os.system('curl evil')\n");
    expect(await ensureCloudSkillFolder({ root: folders, spec, read })).toBe(path);
    expect(await readFile(join(folder, "scripts", "build.py"), "utf8")).toBe("print('brand report')\n");

    // A file dropped in beside the skill's own.
    await chmod(join(folder, "scripts"), 0o755);
    await writeFile(join(folder, "scripts", "extra.py"), "print('extra')\n");
    expect(await ensureCloudSkillFolder({ root: folders, spec, read })).toBe(path);
    expect((await readdir(join(folder, "scripts"))).sort()).toEqual(["build.py"]);
  });

  test("builds nothing from bodies that do not match the digests, or from unsafe names and paths", async () => {
    const folders = await freshRoot();
    const altered: CloudSkillFolderSource = { markdown, files: [{ path: "scripts/build.py", bytes: new Uint8Array(Buffer.from("tampered")) }, source.files[1]!] };
    expect(await ensureCloudSkillFolder({ root: folders, spec, read: async () => altered })).toBeNull();
    expect(await ensureCloudSkillFolder({ root: folders, spec, read: async () => ({ ...source, markdown: "other" }) })).toBeNull();
    expect(await ensureCloudSkillFolder({ root: folders, spec, read: async () => null })).toBeNull();
    for (const path of ["../escape.py", "/etc/passwd", "a//b", "a\\b", "SKILL.md"]) {
      expect(await ensureCloudSkillFolder({ root: folders, spec: { ...spec, files: [{ path, digest: digest("x") }] }, read: async () => source })).toBeNull();
    }
    expect(await ensureCloudSkillFolder({ root: folders, spec: { ...spec, name: "../up" }, read: async () => source })).toBeNull();
    expect(await readdir(folders).catch(() => [])).toEqual([]);
  });

  test("a new version replaces the old folder, leaves other skills alone, and parallel uses share one build", async () => {
    const folders = await freshRoot();
    const first = (await ensureCloudSkillFolder({ root: folders, spec, read: async () => source }))!;
    // Another skill whose name starts with this one's.
    await mkdir(join(folders, "brand-report-extra-0123456789abcdef"), { recursive: true });

    const nextMarkdown = `${markdown}\nThen email it.`;
    const next = { ...spec, digest: digest(nextMarkdown) };
    let reads = 0;
    const read = async () => { reads += 1; return { ...source, markdown: nextMarkdown }; };
    const [a, b] = await Promise.all([ensureCloudSkillFolder({ root: folders, spec: next, read }), ensureCloudSkillFolder({ root: folders, spec: next, read })]);
    expect(a).toBe(b!);
    expect(reads).toBe(1);
    expect(a).not.toBe(first);
    expect((await readdir(folders)).sort()).toEqual([cloudSkillFolderName(next), "brand-report-extra-0123456789abcdef"].sort());
  });
});

describe("engine permissions for skill folders", () => {
  test("the agent may read skill folders even where outside folders are restricted, may never edit them, and managed denials still come last", async () => {
    const { renderOpencodeV2Config } = await import("../src/managed-opencode-v2.js");
    const rendered = renderOpencodeV2Config({
      providers: [],
      skills: [],
      cloudSkillFoldersDirectory: "/data/cloud-skill-folders",
      agentPermissionRules: [{ action: "external_directory", resource: "*", effect: "deny", source: "Everyone" }],
      permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    });
    const rules = (rendered.permissions as Array<{ action: string; resource: string; effect: string }>).map(rule => `${rule.action} ${rule.resource} ${rule.effect}`);
    const outside = rules.findIndex(rule => rule.startsWith("external_directory * "));
    const folderRead = rules.indexOf("external_directory /data/cloud-skill-folders/* allow");
    const folderEdit = rules.indexOf("edit /data/cloud-skill-folders/* deny");
    const managed = rules.indexOf("shell * deny");
    expect(outside).toBeGreaterThanOrEqual(0);
    expect(folderRead).toBeGreaterThan(outside);
    expect(folderEdit).toBeGreaterThan(outside);
    expect(managed).toBeGreaterThan(Math.max(folderRead, folderEdit));
    expect(renderOpencodeV2Config({ providers: [], skills: [] }).permissions).toBeUndefined();
  });
});
