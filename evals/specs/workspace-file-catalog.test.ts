import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  } finally {
    await chmod(workspace, 0o700);
    await chmod(restricted, 0o700);
    await stopChild(booted.child);
    await rm(scratch, { recursive: true, force: true });
  }
});
