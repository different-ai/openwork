import { browserScript } from "@openwork/testkit";
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

for (const entryPoint of ["existing chat", "new task"]) {
test(`sending an image in ${entryPoint} immediately moves it into the thread while upload is pending`, async ({ world, user, seed, probe, step }) => {
  await step("manual approval exempts only chat-attachment inbox uploads", async () => {
    expect(world.uploadStatus).toBe(200);
    expect(world.uploadElapsedMs).toBeLessThan(world.approvalTimeoutMs);
    expect(world.writeStatus).toBe(403);
    expect(world.writeElapsedMs).toBeGreaterThanOrEqual(world.approvalTimeoutMs - 100);
  });

  if (entryPoint === "new task") await user.click({ role: "button", label: "New session" });
  await user.type("composer", "Describe the attached image.");
  // TODO(primitive): attach an in-memory file through the composer's file chooser.
  const attached = await seed.evalIn(world.app, browserScript(async (attachmentName: string) => {
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
      const input = [...document.querySelectorAll<HTMLInputElement>('input[type="file"][multiple]')].at(-1);
      if (!(input instanceof HTMLInputElement)) return { error: "no composer file input" };
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      const startedAt = performance.now();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline && !document.querySelector<HTMLElement>("[data-attachment-id]")) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const chip = document.querySelector<HTMLElement>("[data-attachment-id]");
      return {
        fileBytes: file.size,
        elapsedMs: Math.round(performance.now() - startedAt),
        chipTitle: chip?.getAttribute("title") ?? "",
        chipStatus: chip?.getAttribute("data-attachment-status") ?? "",
      };
  }, [attachmentName]), { awaitPromise: true, timeoutMs: 60_000 });
  if (!isRecord(attached)) throw new Error(`Attachment result was invalid: ${JSON.stringify(attached)}`);
  expect(attached.fileBytes).toEqual(expect.any(Number));
  expect(attached.elapsedMs).toEqual(expect.any(Number));
  expect(typeof attached.fileBytes === "number" ? attached.fileBytes : 0).toBeGreaterThan(1_500_000);
  expect(typeof attached.elapsedMs === "number" ? attached.elapsedMs : Number.POSITIVE_INFINITY).toBeLessThan(2_000);
  expect(attached.chipTitle).toBe(attachmentName);
  expect(attached.chipStatus).toBe("ready");
  await user.screenshot();

  await step("clicking the draft image thumbnail opens it full-size and Escape returns to the draft", async () => {
    const thumbnail = (await probe.dom("[data-attachment-id] img")).elements[0];
    if (!thumbnail) throw new Error("draft image thumbnail missing");
    await user.click({ role: "button", label: `Expand ${attachmentName}` });
    const lightbox = await probe.eventually(() => probe.dom("[data-image-lightbox] img"), {
      within: 10_000,
      label: "draft image lightbox",
      until: (dom) => dom.elements.length === 1,
    });
    const preview = lightbox.elements[0];
    if (!preview) throw new Error("lightbox image missing");
    expect(preview.rect.width).toBeGreaterThan(thumbnail.rect.width * 4);
    expect(await probe.eval(() => {
      const chip = document.querySelector<HTMLImageElement>("[data-attachment-id] img");
      const large = document.querySelector<HTMLImageElement>("[data-image-lightbox] img");
      return Boolean(chip && large && chip.src === large.src);
    })).toBe(true);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom("[data-image-lightbox]"), {
      within: 10_000,
      label: "draft image lightbox closed",
      until: (dom) => dom.elements.length === 0,
    });
    expect((await probe.dom("[data-attachment-id]")).elements).toHaveLength(1);
    await user.see("composer", { text: /Describe the attached image\./ });
  });

  await step("paste a video alongside the image", async () => {
    expect(await seed.evalIn(world.app, () => {
      const editor = document.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!(editor instanceof HTMLElement)) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "pasted-recording.mp4", { type: "video/mp4" }));
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      return true;
    })).toBe(true);
    await user.see({ text: "pasted-recording.mp4" });
  });

  // TODO(primitive): observe a transient attachment status during a user send.
  await seed.evalIn(world.app, () => {
    globalThis.__attachmentUploadingSeen = false;
    const record = () => {
      if (document.querySelector<HTMLElement>('[data-attachment-status="uploading"]')) globalThis.__attachmentUploadingSeen = true;
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-attachment-status"], childList: true });
    record();
    return true;
  });
  await world.holdUploads();
  await user.click("Run task");

  // TODO(primitive): await a transient attachment-status witness.
  expect(await probe.eventually(() => probe.eval(() => {
    const rows = document.querySelectorAll('[data-message-role="user"]');
    const image = rows[0]?.querySelector<HTMLImageElement>("img");
    return globalThis.__attachmentUploadingSeen === true && window.__openworkSubmissionFault?.attempts === 1
      && rows.length === 1 && Boolean(image?.complete && image.naturalWidth > 0)
      && !document.querySelector("[data-attachment-id]")
      && document.querySelector('[contenteditable="true"]')?.textContent === "";
  }), {
    within: 30_000,
    intervalMs: 50,
    label: "one decoded thread preview and cleared composer while upload is held",
    until: (value) => value === true,
  })).toBe(true);
  await step("Send moves the attachments immediately and preserves the next draft", async () => {
    await user.see("composer", { text: "" });
    expect((await probe.dom('[data-message-role="user"]')).elements).toHaveLength(1);
    expect((await probe.dom('[data-message-role="user"] img')).elements).toHaveLength(1);
    await user.see({ text: "pasted-recording.mp4" });
    await user.type("composer", "Continue after upload.");
    await user.press("Enter");
    await user.press("Meta+Enter");
    await user.see("composer", { text: "Continue after upload." });
    expect((await probe.dom('[data-message-role="user"]')).elements).toHaveLength(1);
    await user.notSee({ text: /1 queued/ });
  });
  await world.releaseUploads();
  await user.see({ text: "attachment upload loading proof" });
  await user.see("composer", { text: "Continue after upload." });
  expect((await probe.dom('[data-message-role="user"]')).elements).toHaveLength(1);
  await user.notSee({ text: /1 queued/ });
  expect((await probe.hash()).includes("/session/ses_")).toBe(true);
  // TODO(primitive): inspect attachment cleanup and error-toast state after send.
  expect(await probe.eval(() => (!document.querySelector<HTMLElement>("[data-attachment-id]")
    && !document.querySelector<HTMLElement>('[data-sonner-toast][data-type="error"]')))).toBe(true);
  await step("sent video remains visible without a binary model error", async () => {
    await user.see({ text: "pasted-recording.mp4" });
    await user.see({ text: "attachment upload loading proof" });
    await user.notSee({ text: /Cannot read binary file|UnsupportedFunctionalityError/ });
  });
  await user.reload();
  await user.see({ text: "pasted-recording.mp4" });
  expect(await probe.eval(() => (document.querySelectorAll<HTMLButtonElement>('button[title="Open pasted-recording.mp4 in Artifacts"]').length))).toBe(1);
  await user.screenshot();
});
}
