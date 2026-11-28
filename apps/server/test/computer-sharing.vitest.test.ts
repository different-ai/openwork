import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { computerSharingStateSchema, DEFAULT_COMPUTER_SHARING_SETTINGS } from "@openwork/types/computer-sharing";
import { createComputerSharing } from "../src/computers/sharing.js";
import { readComputerSharingSettings, validateComputerSharingSettings } from "../src/computers/sharing-settings.js";
import { getRunnerCredential } from "../src/computers/runner-credential.js";
import { registerComputerSharingRoutes } from "../src/routes/computer-sharing.js";
import type { Route } from "../src/routes/registry.js";
import { SandboxPreparationError } from "../src/sandbox-preparation.js";
import { startServer } from "../src/server.js";
import { TokenService } from "../src/tokens.js";
import { computersFixture } from "./fixtures/computers.js";

const credential = { baseUrl: "http://127.0.0.1:1", token: "test-computer-runner" };
const body = (...paths: string[]) => ({ enabled: true, folders: paths.map(path => ({ path, access: "read" })), sources: [{ kind: "workbot" }] });
const noRunner = async () => { throw new Error("Not connected"); };

test("validates existing canonical directories, rejects aliases of protected paths and overlapping shares, and persists canonical settings only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "computer-sharing-")));
  const config = computersFixture(root);
  const path = join(root, "shared");
  const child = join(path, "child");
  const alias = join(root, "alias");
  const issues = createComputerSharing(config, { fetch: noRunner });
  try {
    await mkdir(child, { recursive: true });
    await mkdir(join(root, "runtime", "nested"), { recursive: true });
    await symlink(path, alias);
    await writeFile(join(root, "file"), "fixture");
    expect(await readComputerSharingSettings(config)).toEqual(DEFAULT_COMPUTER_SHARING_SETTINGS);
    await expect(validateComputerSharingSettings(config, body("/"))).rejects.toThrow();
    await expect(validateComputerSharingSettings(config, body(homedir()))).rejects.toThrow("not the home folder itself");
    await expect(validateComputerSharingSettings(config, body(join(root, "file")))).rejects.toThrow("Choose a folder that exists");
    await expect(validateComputerSharingSettings(config, body(join(root, "missing")))).rejects.toThrow("Choose a folder that exists");
    for (const protectedPath of [root, join(root, "runtime", "nested")]) {
      await expect(validateComputerSharingSettings(config, body(protectedPath))).rejects.toThrow("overlap OpenWork's own storage");
    }
    await expect(validateComputerSharingSettings(config, body(path, child))).rejects.toThrow("can't overlap");
    await expect(validateComputerSharingSettings(config, body(alias, path))).rejects.toThrow("can't overlap");
    expect((await issues.updateSettings(body(alias))).settings).toEqual(body(path));
    expect(await readComputerSharingSettings({ ...config })).toEqual(body(path));
  } finally { await issues.close(); await rm(root, { recursive: true, force: true }); }
});

test("reports exact grants and exposes policy, Den access, capability-required, and feature-off states", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "computer-sharing-den-")));
  const folder = join(root, "notes");
  await mkdir(folder);
  let allowed = true;
  let den: "capability" | "on" | "off" = "capability";
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const posts: unknown[] = [];
  const revokedAt = new Date(now).toISOString();
  const service = createComputerSharing(computersFixture(root), {
    platform: async () => {}, signedIn: () => true, allowed: async () => allowed,
    async fetch(input, init) {
      if (den === "capability") return Response.json({ error: "runner_capability_required" }, { status: 403 });
      if (den === "off") return Response.json({ error: "feature_disabled" }, { status: 404 });
      if (input.includes("/commands")) return Response.json({ items: [] });
      if (init?.method === "PUT" && typeof init.body === "string") { posts.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
      return Response.json({ organizationAllows: true, choice: "off", grants: [{ source: { kind: "workbot" }, folders: [], writableFolders: [], revokedAt }] });
    },
  });
  try {
    expect((await service.state()).availability).toMatchObject({ reason: "signed_out" });
    service.updateCredential(credential);
    expect(await service.state()).toMatchObject({ availability: { state: "available" }, sync: "pending", organizationAllows: null });
    den = "on";
    await vi.waitFor(() => expect(posts).toContainEqual({ choice: "off", grants: [] }), { timeout: 2500 });
    const settings = { ...body(folder), folders: [{ path: folder, access: "edit" }] };
    await service.updateSettings(settings);
    await vi.waitFor(async () => expect(await service.state()).toMatchObject({ sync: "synced", organizationAllows: true, revokedSources: [{ source: { kind: "workbot" }, revokedAt }] }));
    expect(posts).toContainEqual({ choice: "allow", grants: [{ source: { kind: "workbot" }, folders: [folder], writableFolders: [folder] }] });
    allowed = false;
    expect((await service.state()).availability).toMatchObject({ reason: "organization_policy" });
    allowed = true;
    den = "off";
    now += 15_001;
    expect(await service.state()).toMatchObject({ availability: { reason: "feature_off" }, organizationAllows: null });
  } finally { clock.mockRestore(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test.each(["unsupported_platform", "virtualization_unavailable"])("exposes %s before advertising sandbox capability", async code => {
  const root = await mkdtemp(join(tmpdir(), "computer-sharing-platform-"));
  const service = createComputerSharing(computersFixture(root), { platform: async () => {
    if (code === "unsupported_platform" || code === "virtualization_unavailable") throw new SandboxPreparationError({ code, message: "Fixture", action: null, retryable: false });
  } });
  try { expect((await service.state()).availability).toMatchObject({ state: "unavailable", reason: code }); }
  finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("sharing and runner routes require owner or host auth; runner credential never appears in their responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "computer-sharing-routes-"));
  const config = computersFixture(root);
  const tokens = new TokenService(config);
  const collaborator = await tokens.create("collaborator");
  const ownerToken = await tokens.create("owner");
  const registered: Route[] = [];
  registerComputerSharingRoutes(registered, config);
  expect(registered.map(route => route.auth)).toEqual(["host", "host", "host", "host"]);
  const server = await startServer(config, { deferManagedEngineStartup: true });
  const request = (method: string, path: string, headers: Record<string, string>, value?: unknown) => fetch(`http://127.0.0.1:${server.port}/computers/${path}`, {
    method, headers: { ...headers, "content-type": "application/json" }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const owner = { Authorization: `Bearer ${ownerToken.token}` };
  const host = { "x-openwork-host-token": config.hostToken };
  try {
    for (const [method, path] of [["GET", "sharing"], ["PUT", "sharing"], ["PUT", "runner"], ["DELETE", "runner"]]) {
      expect((await request(method, path, { Authorization: `Bearer ${collaborator.token}` })).status).toBe(403);
    }
    const response = await request("GET", "sharing", owner);
    expect(response.status).toBe(200);
    expect(computerSharingStateSchema.parse(await response.json()).settings).toEqual(DEFAULT_COMPUTER_SHARING_SETTINGS);
    expect((await request("PUT", "sharing", owner, DEFAULT_COMPUTER_SHARING_SETTINGS)).status).toBe(200);
    const put = await request("PUT", "runner", host, credential);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    expect(getRunnerCredential(config)).toEqual(credential);
    expect((await request("GET", "sharing", owner)).status).toBe(200);
    expect((await request("DELETE", "runner", host)).status).toBe(200);
    expect(getRunnerCredential(config)).toBeNull();
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
