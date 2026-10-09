import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineDriveUpload } from "../worlds/engine-drive-upload.ts";

const test = spec.world(engineDriveUpload, { timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test("V2-DRIVE-UPLOAD: the native model puts a workspace file in the selected Drive account", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  // A minimal .docx header; the witness compares bytes, not Office structure.
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(randomUUID())]);
  const name = "proposal.docx";
  await world.writeWorkspaceFile(name, bytes);
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "model ready", until: state => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });

  await step("before: the file is only in the workspace and neither Drive account has it", async () => {
    expect(await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 1_000 })).toEqual([]);
    expect(await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 1_000 })).toEqual([]);
    await user.screenshot();
  });

  await step("after: asking for the upload puts the exact file in the chosen Drive account", async () => {
    const prompt = `Put ${name} in my Drive Selected Google Drive ${randomUUID()}`;
    const reply = `Uploaded ${name} to Drive ${randomUUID()}`;
    await world.prepareTurn(prompt, reply, [
      { tool: "openwork_drive_upload", arguments: { path: name, connectionId: world.selectedId } },
    ]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    const requests = await world.mock.agentRequests({ promptMarker: prompt });
    expect(requests.some(request => request.kind === "error")).toBe(false);
    const uploads = await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 10_000 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ filename: name, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(uploads[0]?.content.equals(Buffer.from(bytes))).toBe(true);
    expect(await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 1_000 })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("v2 uploads a local Office file through the member's Cloud connection",
      "The native openwork_drive_upload tool sent the workspace .docx through the real host and Den to the selected Google account: same name, Word MIME type and byte-identical content. The default account received nothing and no Google sign-in was requested.", true);
  });
});
