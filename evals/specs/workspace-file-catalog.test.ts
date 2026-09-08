import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

// The file-session catalog is a public server journey used by the file browser
// and sync clients. Exercise real OS permissions and HTTP, without mocking fs.
test("workspace catalog preserves readable siblings and reports permission gaps", async ({ evidence }) => {
  const scratch = await mkdtemp(join(tmpdir(), "openwork-catalog-permissions-"));
  const workspace = join(scratch, "workspace");
  const restricted = join(workspace, "a-restricted");
  await mkdir(restricted, { recursive: true });
  await mkdir(join(workspace, "z-readable"));
  await writeFile(join(restricted, "private.txt"), "synthetic restricted fixture");
  await writeFile(join(workspace, "z-readable", "report.txt"), "synthetic readable fixture");
  const home = join(scratch, "home");
  await mkdir(home);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const headers = { authorization: "Bearer catalog-test-token", "content-type": "application/json" };
  const booted = bootServer({ ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), OPENWORK_MANAGE_OPENCODE: "0" }, "catalog-test-token", workspace, () => {});
  try {
    const base = await booted.listening;
    const request = (path: string, body?: unknown) => fetch(`${base}${path}`, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const workspaces: unknown = await (await request("/workspaces")).json();
    if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Missing workspace");
    const workspaceId = workspaces.items[0].id;
    const created: unknown = await (await request(`/workspace/${workspaceId}/files/sessions`, { write: false })).json();
    if (!isRecord(created) || !isRecord(created.session) || typeof created.session.id !== "string") throw new Error("Missing file session");
    const catalogPath = `/files/sessions/${created.session.id}/catalog/snapshot`;
    const catalog = async (query = "") => {
      const response = await request(`${catalogPath}${query}`);
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("Missing catalog");
      return { ...value, paths: value.items.filter(isRecord).map((item) => item.path) };
    };
    await chmod(restricted, 0);
    // Fail loudly under root or on an OS that does not enforce POSIX modes.
    await expect(readdir(restricted)).rejects.toMatchObject({ code: "EACCES" });
    const partial = await catalog();
    expect(partial.paths).toContain("z-readable/report.txt");
    expect(partial.paths).not.toContain("a-restricted/private.txt");
    expect(partial).toMatchObject({ incomplete: true, skippedDirectories: ["a-restricted"], truncated: false });
    const filtered = await catalog("?prefix=z-readable&includeDirs=false&limit=1");
    expect(filtered.paths).toEqual(["z-readable/report.txt"]);
    expect(filtered).toMatchObject({ incomplete: true, truncated: false, total: 1 });
    const content = await request(`/workspace/${workspaceId}/files/content?path=z-readable%2Freport.txt`);
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({ content: "synthetic readable fixture" });
    evidence.recordAssertionEvidence("Denied child folders do not hide readable sibling files", "Real chmod denial was observed; catalog and file read returned HTTP 200 for the readable sibling, excluded restricted contents, and explicitly reported incomplete=true with the relative skipped directory. Prefix and limit filtering retained the permission warning.", true);

    await chmod(restricted, 0o700);
    const complete = await catalog();
    expect(complete.paths).toContain("a-restricted/private.txt");
    expect(complete.paths).toContain("z-readable/report.txt");
    expect(complete).toMatchObject({ incomplete: false, skippedDirectories: [] });
    evidence.recordAssertionEvidence("Refreshing after permission restoration returns a complete catalog", "The same session's next HTTP snapshot included both files and cleared incomplete and skippedDirectories.", true);

    await chmod(workspace, 0);
    await expect(readdir(workspace)).rejects.toMatchObject({ code: "EACCES" });
    const denied = await request(catalogPath);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "workspace_permission_denied" });
    evidence.recordAssertionEvidence("An unreadable workspace root returns a meaningful error", "Real root permission denial returned HTTP 403 workspace_permission_denied, never an empty successful catalog.", true);
    await chmod(workspace, 0o700);
    const moved = join(scratch, "moved-workspace");
    await rename(workspace, moved);
    try {
      const missing = await request(catalogPath);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "workspace_not_found" });
      evidence.recordAssertionEvidence("A missing workspace folder returns a meaningful error", "Moving the workspace root after session creation returned HTTP 404 workspace_not_found instead of a server error or an empty successful catalog.", true);
    } finally {
      await rename(moved, workspace);
    }
  } finally {
    await chmod(workspace, 0o700);
    await chmod(restricted, 0o700);
    await stopChild(booted.child);
    await rm(scratch, { recursive: true, force: true });
  }
});


test("healthy workspace catalog preserves symlink boundaries, pagination, and directory exclusions", async ({ evidence }) => {
  const scratch = await mkdtemp(join(tmpdir(), "openwork-catalog-compatibility-"));
  const workspace = join(scratch, "workspace");
  const outside = join(scratch, "outside");
  const home = join(scratch, "home");
  const pageNames = ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"];
  for (const path of [outside, home, join(workspace, "pages"), join(workspace, ".git"), join(workspace, "node_modules"), join(workspace, "nested", "node_modules")]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(outside, "outside-only.txt"), "synthetic external fixture");
  for (const name of pageNames) await writeFile(join(workspace, "pages", name), name);
  for (const path of [".git/internal.txt", "node_modules/dependency.txt", "nested/node_modules/dependency.txt", "nested/visible.txt"]) {
    await writeFile(join(workspace, path), "synthetic fixture");
  }
  await symlink(outside, join(workspace, "external-link"), "dir");
  await symlink(workspace, join(workspace, "cycle-link"), "dir");
  await symlink(join(outside, "outside-only.txt"), join(workspace, "external-file-link"), "file");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const headers = { authorization: "Bearer catalog-compatibility-token", "content-type": "application/json" };
  const booted = bootServer({ ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), OPENWORK_MANAGE_OPENCODE: "0" }, "catalog-compatibility-token", workspace, () => {});
  try {
    const base = await booted.listening;
    const request = (path: string, body?: unknown) => fetch(`${base}${path}`, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const workspaces: unknown = await (await request("/workspaces")).json();
    if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Missing workspace");
    const created: unknown = await (await request(`/workspace/${workspaces.items[0].id}/files/sessions`, { write: false })).json();
    if (!isRecord(created) || !isRecord(created.session) || typeof created.session.id !== "string") throw new Error("Missing file session");
    const sessionId = created.session.id;
    const catalog = async (query: string) => {
      const response = await request(`/files/sessions/${sessionId}/catalog/snapshot?${query}`);
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("Missing catalog");
      return { ...value, paths: value.items.filter(isRecord).map((item) => item.path), nextAfter: value.nextAfter, truncated: value.truncated, total: value.total };
    };
    const all = await catalog("excludeHeavyDirectories=false");
    expect(all.paths).toContain("pages/001.txt");
    expect(all.paths).not.toContain("external-link");
    expect(all.paths).not.toContain("cycle-link");
    expect(all.paths).not.toContain("external-file-link");
    expect(all.paths.some((path) => typeof path === "string" && /outside-only|external-link\/|cycle-link\//.test(path))).toBe(false);
    evidence.recordAssertionEvidence("Stable external and cyclic symlinks are excluded from the catalog", "The real HTTP snapshot completed within its deadline, included ordinary files, and excluded external-directory, external-file, and cyclic links and their target entries.", true);

    const excluded = await catalog("excludeHeavyDirectories=true");
    for (const path of [".git", ".git/internal.txt", "node_modules", "node_modules/dependency.txt", "nested/node_modules", "nested/node_modules/dependency.txt"]) {
      expect(all.paths).toContain(path);
      expect(excluded.paths).not.toContain(path);
    }
    expect(excluded.paths).toContain("nested/visible.txt");
    expect(excluded).not.toMatchObject({ incomplete: true });
    evidence.recordAssertionEvidence("Heavy directory exclusion is opt-in and applies at nested levels", "Both root and nested dependency directories and .git were present when inclusion was requested, absent when exclusion was requested, and the ordinary sibling remained visible.", true);

    const received: unknown[] = [];
    let after = "";
    for (let page = 0; page < 3; page += 1) {
      const result = await catalog(`prefix=pages&includeDirs=false&limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      expect(result.total).toBe(5 - page * 2);
      expect(result.paths).toEqual(pageNames.slice(page * 2, page * 2 + 2).map((name) => `pages/${name}`));
      expect(result.truncated).toBe(page < 2);
      received.push(...result.paths);
      if (page < 2) {
        expect(result.nextAfter).toBe(result.paths.at(-1));
        if (typeof result.nextAfter !== "string") throw new Error("Missing continuation cursor");
        after = result.nextAfter;
      } else expect(result.nextAfter).toBeUndefined();
    }
    expect(received).toEqual(pageNames.map((name) => `pages/${name}`));
    expect(new Set(received).size).toBe(5);
    const exhausted = await catalog(`prefix=pages&includeDirs=false&limit=2&after=${encodeURIComponent("pages/005.txt")}`);
    expect(exhausted).toMatchObject({ paths: [], total: 0, truncated: false });
    expect(exhausted.nextAfter).toBeUndefined();
    evidence.recordAssertionEvidence("Numbered filenames paginate without omission or duplication", "Five files were returned exactly once across three HTTP pages (2, 2, 1); continuation cursors, remaining totals, terminal truncation, and an exhausted page were asserted.", true);
  } finally {
    await stopChild(booted.child);
    await rm(scratch, { recursive: true, force: true });
  }
});
