import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { attachmentUpload } from "../worlds/chat.ts";

const attachmentName = "big-photo.png";
const test = spec.world(attachmentUpload, {
  needs: { commands: ["bun"] },
  timeout: 300_000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("attaching an image shows its chip instantly and sends with a visible uploading state", async ({ world, user, seed, probe, step }) => {
  await step("manual approval exempts only chat-attachment inbox uploads", async () => {
    expect(world.uploadStatus).toBe(200);
    expect(world.uploadElapsedMs).toBeLessThan(world.approvalTimeoutMs);
    expect(world.writeStatus).toBe(403);
    expect(world.writeElapsedMs).toBeGreaterThanOrEqual(world.approvalTimeoutMs - 100);
  });

  await user.type("composer", "Describe the attached image.");
  // TODO(primitive): attach an in-memory file through the composer's file chooser.
  const attached = await seed.evalIn(world.app, `async (attachmentName) => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400;
      canvas.height = 2400;
      const context = canvas.getContext("2d");
      if (!context) return { error: "no canvas context" };
      const image = context.createImageData(2400, 2400);
      for (let offset = 0; offset < image.data.length; offset += 65536) {
        crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65536, image.data.length)));
      }
      context.putImageData(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!(blob instanceof Blob)) return { error: "no blob" };
      const file = new File([blob], attachmentName, { type: "image/png" });
      const input = [...document.querySelectorAll('input[type="file"][multiple]')].at(-1);
      if (!(input instanceof HTMLInputElement)) return { error: "no composer file input" };
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      const startedAt = performance.now();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline && !document.querySelector("[data-attachment-id]")) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const chip = document.querySelector("[data-attachment-id]");
      return {
        fileBytes: file.size,
        elapsedMs: Math.round(performance.now() - startedAt),
        chipTitle: chip?.getAttribute("title") ?? "",
        chipStatus: chip?.getAttribute("data-attachment-status") ?? "",
      };
  }`, { args: [attachmentName], awaitPromise: true, timeoutMs: 60_000 });
  if (!isRecord(attached)) throw new Error(`Attachment result was invalid: ${JSON.stringify(attached)}`);
  expect(attached.fileBytes).toEqual(expect.any(Number));
  expect(attached.elapsedMs).toEqual(expect.any(Number));
  expect(typeof attached.fileBytes === "number" ? attached.fileBytes : 0).toBeGreaterThan(1_500_000);
  expect(typeof attached.elapsedMs === "number" ? attached.elapsedMs : Number.POSITIVE_INFINITY).toBeLessThan(2_000);
  expect(attached.chipTitle).toBe(attachmentName);
  expect(attached.chipStatus).toBe("ready");
  await user.screenshot();

  await step("paste a video alongside the image", async () => {
    expect(await seed.evalIn(world.app, `(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!(editor instanceof HTMLElement)) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "pasted-recording.mp4", { type: "video/mp4" }));
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      return true;
    })()`)).toBe(true);
    await user.see({ text: "pasted-recording.mp4" });
  });

  // TODO(primitive): observe a transient attachment status during a user send.
  await seed.evalIn(world.app, `(() => {
    globalThis.__attachmentUploadingSeen = false;
    const record = () => {
      if (document.querySelector('[data-attachment-status="uploading"]')) globalThis.__attachmentUploadingSeen = true;
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-attachment-status"], childList: true });
    record();
    return true;
  })()`);
  await user.click("Run task");

  // TODO(primitive): await a transient attachment-status witness.
  expect(await probe.eventually(() => probe.eval(`globalThis.__attachmentUploadingSeen === true`), {
    within: 30_000,
    intervalMs: 50,
    label: "attachment uploading state observed",
    until: (value) => value === true,
  })).toBe(true);
  await user.notSee({ text: /1 queued/ });
  expect((await probe.hash()).includes("/session/ses_")).toBe(true);
  // TODO(primitive): inspect attachment cleanup and error-toast state after send.
  expect(await probe.eval(`!document.querySelector("[data-attachment-id]")
    && !document.querySelector('[data-sonner-toast][data-type="error"]')`)).toBe(true);
  await step("sent video remains visible without a binary model error", async () => {
    await user.see({ text: "pasted-recording.mp4" });
    await user.see({ text: "attachment upload loading proof" });
    await user.notSee({ text: /Cannot read binary file|UnsupportedFunctionalityError/ });
  });
  await user.reload();
  await user.see({ text: "pasted-recording.mp4" });
  expect(await probe.eval(`document.querySelectorAll('button[title="Open pasted-recording.mp4 in Artifacts"]').length`)).toBe(1);
  await user.screenshot();
});
