import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineDriveUpload } from "../worlds/engine-drive-upload.ts";

const test = spec.world(engineDriveUpload, { timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test("V2-DRIVE-UPLOAD: a member approves each workspace file the native model puts in their selected Drive account", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  // A minimal .docx header; the witness compares bytes, not Office structure.
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(randomUUID())]);
  const name = "proposal.docx";
  await world.writeWorkspaceFile(name, bytes);
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "model ready", until: state => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  const driveCopies = async () => ({
    selected: await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 1_000 }),
    other: await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 1_000 }),
  });
  const ask = async (prompt: string, reply: string) => {
    await world.prepareTurn(prompt, reply, [
      { tool: "openwork_drive_upload", arguments: { path: name, connectionId: world.selectedId } },
    ]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see("Allow once", { timeoutMs: 90_000 });
  };

  await step("before: the file is only in the workspace and neither Drive account has it", async () => {
    await user.see("composer", { editable: true });
    const copies = await driveCopies();
    evidence.recordAssertionEvidence("Neither Drive account has the file yet", `selected account: ${copies.selected.length} files; other account: ${copies.other.length} files`, copies.selected.length === 0 && copies.other.length === 0);
    expect(copies).toEqual({ selected: [], other: [] });
    await user.screenshot();
  });

  await step("the member is asked before the file leaves the workspace, and declining sends nothing", async () => {
    const reply = `Kept ${name} in the workspace ${randomUUID()}`;
    await ask(`Put ${name} in my Drive Selected Google Drive ${randomUUID()}`, reply);
    await user.screenshot();
    await user.click("Deny");
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    await user.notSee("Allow once");
    const copies = await driveCopies();
    evidence.recordAssertionEvidence("A declined upload never reaches Drive", `after Deny the approval closed and the turn finished; selected account: ${copies.selected.length} files; other account: ${copies.other.length} files`, copies.selected.length === 0 && copies.other.length === 0);
    expect(copies).toEqual({ selected: [], other: [] });
    await user.screenshot();
  });

  await step("after: allowing the upload puts the exact file in the chosen Drive account only", async () => {
    const prompt = `Put ${name} in my Drive Selected Google Drive ${randomUUID()}`;
    const reply = `Uploaded ${name} to Drive ${randomUUID()}`;
    await ask(prompt, reply);
    await user.click("Allow once");
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    const requests = await world.mock.agentRequests({ promptMarker: prompt });
    expect(requests.some(request => request.kind === "error")).toBe(false);
    const uploads = await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 10_000 });
    const other = await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 1_000 });
    const exact = uploads.length === 1 && uploads[0]?.content.equals(Buffer.from(bytes)) === true;
    evidence.recordAssertionEvidence("The approved file lands byte-for-byte in the selected account only", `selected account: ${uploads.length} file (${uploads[0]?.filename ?? "none"}, ${uploads[0]?.mimeType ?? "no type"}, exact bytes: ${exact}); other account: ${other.length} files`, exact && other.length === 0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ filename: name, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(exact).toBe(true);
    expect(other).toEqual([]);
    await user.screenshot();
  });
});
