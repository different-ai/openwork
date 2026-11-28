import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { shellQuote } from "@openwork/sandbox";
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing";
import type { ComputerToolCall } from "@openwork/types/den/computers";
import { createIncomingSandbox } from "../src/computers/incoming-sandbox.js";
import { loadSandboxImageSdk, sandboxImagePin } from "../src/packaged-sandbox-assets.js";
import { computersFixture } from "./fixtures/computers.js";
import { fakeIncomingDen, incomingAssignment, incomingCredential } from "./fixtures/incoming-computers.js";

test.skipIf(process.env.MICROSANDBOX_LIVE !== "1")("incoming work stays within the real microVM's read-only and editable mounts", async () => {
  const { reference, manifestDigest } = sandboxImagePin();
  const image = await (await loadSandboxImageSdk()).Image.get(reference).catch(() => null);
  expect(image?.manifestDigest, "Live test requires the pinned image to already be cached; it does not download it").toBe(manifestDigest);
  const root = await realpath(await mkdtemp(join(tmpdir(), "incoming-sandbox-live-")));
  const ro = join(root, "reference");
  const rw = join(root, "drafts");
  const privateFolder = join(root, "private");
  const sandbox = createIncomingSandbox(computersFixture(root), { admit: async () => true });
  try {
    await Promise.all([ro, rw, privateFolder].map(dir => mkdir(dir)));
    await writeFile(join(ro, "notes.txt"), "shared reference\n");
    await writeFile(join(privateFolder, "notes.txt"), "unshared text\n");
    await symlink(privateFolder, join(rw, "outside"));
    const settings: ComputerSharingSettings = { enabled: true, folders: [{ path: ro, access: "read" }, { path: rw, access: "edit" }], sources: [{ kind: "computer", id: "source-computer" }] };
    const calls: ComputerToolCall[] = [
      { tool: "read", input: { path: join(ro, "notes.txt") } },
      { tool: "shell", input: { command: "ls && cat notes.txt", cwd: ro } },
      { tool: "write", input: { path: join(rw, "draft.txt"), content: "editable draft" } },
      { tool: "write", input: { path: join(ro, "notes.txt"), content: "must not change" } },
      { tool: "shell", input: { command: "printf changed > notes.txt", cwd: ro } },
      { tool: "shell", input: { command: `cat ${shellQuote(join(privateFolder, "notes.txt"))}`, cwd: rw } },
      { tool: "shell", input: { command: "cat outside/notes.txt", cwd: rw } },
    ];
    const commands = calls.map((call, index) => incomingAssignment(call, settings, `command-${index}`));
    const f = fakeIncomingDen(commands, () => settings, sandbox);
    f.runner.update(incomingCredential);
    try {
      await vi.waitFor(() => expect(f.results.size).toBe(calls.length), { timeout: 60_000 });
      expect(f.results.get("command-0")).toMatchObject({ status: "done", exitCode: 0, output: expect.stringContaining("shared reference") });
      expect(f.results.get("command-1")).toMatchObject({ status: "done", exitCode: 0, output: expect.stringContaining("notes.txt\nshared reference") });
      expect(f.results.get("command-2")).toMatchObject({ status: "done", exitCode: 0 });
      expect(await readFile(join(rw, "draft.txt"), "utf8")).toBe("editable draft");
      expect(f.results.get("command-3")).toEqual({ status: "refused", layer: "source", code: "folder_read_only" });
      expect(f.results.get("command-4")).toMatchObject({ status: "done", exitCode: expect.not.stringMatching(/^0$/), output: expect.stringMatching(/read-only file system/i) });
      expect(await readFile(join(ro, "notes.txt"), "utf8")).toBe("shared reference\n");
      for (const id of ["command-5", "command-6"]) {
        expect(f.results.get(id)).toMatchObject({ status: "done", output: expect.stringContaining("No such file") });
        expect(f.results.get(id)).not.toMatchObject({ exitCode: 0 });
      }
    } finally { f.runner.close(); }
  } finally { await sandbox.close(); await rm(root, { recursive: true, force: true }); }
}, 75_000);
