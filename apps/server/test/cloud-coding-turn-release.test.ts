import { test, expect, mock } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createCloudCodingTurnRelease } from "../src/opencode-plugins/cloud-coding-turn-release.js";

const session = "session-root";
const key = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
const state = { api: "https://den.example.test", taskId: "task-one", token: "gateway-test-token", tokenExpiresAt: "2026-11-28T12:00:00Z", extra: 42 };

async function putState(base: string, id: string, name = "task-one") {
  const path = join(base, key(id), name, "state.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), { mode: 0o644 });
  return path;
}

test.each([false, true])("release stays in the root conversation directory and clears state (request fails: %s)", async (fails) => {
  const base = await mkdtemp(join(import.meta.dir, ".cloud-coding-"));
  const fs = { lstat: mock(lstat), readdir: mock(readdir), open: mock(open) };
  const fetch = mock(async (_url: URL | RequestInfo, _options?: RequestInit) => {
    if (fails) throw new Error("offline");
    return new Response(null, { status: 204 });
  });
  try {
    const path = await putState(base, session);
    const otherPath = await putState(base, "other-conversation");
    await symlink(dirname(otherPath), join(dirname(dirname(path)), "linked-task"));
    const linkedFileFolder = join(dirname(dirname(path)), "linked-file");
    await mkdir(linkedFileFolder);
    await symlink(otherPath, join(linkedFileFolder, "state.json"));
    const release = createCloudCodingTurnRelease({ base, fs, fetch });
    await Promise.all([release(session), release(session)]);
    await release(session);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://den.example.test/v1/cloud-coding/gateway/release");
    expect(options).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${state.token}` }, redirect: "error" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...state, token: null });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(otherPath, "utf8"))).toEqual(state);
    for (const [observed] of [...fs.lstat.mock.calls, ...fs.readdir.mock.calls, ...fs.open.mock.calls]) {
      expect(String(observed) === base || String(observed).startsWith(`${base}/${key(session)}`)).toBe(true);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("no folder means no state file access or network call", async () => {
  const base = await mkdtemp(join(import.meta.dir, ".cloud-coding-"));
  const fs = { lstat: mock(lstat), readdir: mock(readdir), open: mock(open) };
  const fetch = mock(async () => new Response(null));
  try {
    await createCloudCodingTurnRelease({ base, fs, fetch })(session);
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Cloud coding app and server sources do not access local Git or account setup", async () => {
  const domain = join(import.meta.dir, "../../app/src/react-app/domains/cloud-coding");
  const files = (await readdir(domain, { recursive: true })).filter(path => /\.tsx?$/.test(path)).map(path => join(domain, path));
  files.push(join(import.meta.dir, "../src/cloud-coding-worker-proof.ts"), join(import.meta.dir, "../src/opencode-plugins/cloud-coding-turn-release.ts"));
  for (const path of files) {
    const source = await readFile(path, "utf8");
    expect(source, basename(path)).not.toMatch(/node:child_process|\bgit config\b|\.gitconfig|credential|\.ssh\b|ssh-agent|\bgh auth\b|hosts\.yml/);
  }
});
