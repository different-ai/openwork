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

test("video keeps the draft on incompatible models, sends intact with the image on Google, and plays after reload", async ({ world, user, seed, probe, step }) => {
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

  await step("paste a real video alongside the image", async () => {
    await world.pasteVideo();
    await user.see({ text: world.videoName });
    expect(await world.draftAttachments()).toEqual([
      { id: expect.any(String), name: attachmentName, status: "ready" },
      { id: expect.any(String), name: world.videoName, status: "ready" },
    ]);
  });

  const draft = await probe.composer();
  const attachments = await world.draftAttachments();
  const rejection = "This model connection does not support video input.";
  for (const modelName of [world.imageModelName, world.modelName]) {
    await step(`${modelName} rejects video without losing the draft or calling the model`, async () => {
      await user.click({ role: "button", label: "Change model" });
      await user.click({ role: "button", label: /^Model\s/ });
      await user.type({ placeholder: "Search models..." }, modelName, { replace: true });
      await user.screenshot();
      await user.click({ role: "option", label: new RegExp(modelName) });
      await user.see({ role: "button", label: "Change model" }, { text: new RegExp(modelName) });
      expect(await world.modelRequests()).toEqual([]);
      await user.click("Run task");
      await user.see({ text: rejection });
      await user.see("composer", { editable: true, text: /Describe the attached image\./ });
      expect(await probe.composer()).toMatchObject({
        draftText: draft.draftText,
        userMessageCount: draft.userMessageCount,
        assistantMessageCount: draft.assistantMessageCount,
      });
      expect(await world.draftAttachments()).toEqual(attachments);
      expect(await world.modelRequests()).toEqual([]);
      await user.notSee({ text: /1 queued/ });
      await user.click({ role: "button", label: "Dismiss error" });
      await user.notSee({ text: rejection });
      expect(await probe.eventually(() => probe.composer(), {
        within: 5_000,
        label: "retained draft can be sent after dismissing the error",
        until: (state) => state.runTaskEnabled,
      })).toMatchObject({ runTaskEnabled: true, draftText: draft.draftText });
    });
  }

  await step("select a supported Google model without changing the retained draft", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s/ });
    await user.type({ placeholder: "Search models..." }, world.videoModelName, { replace: true });
    await user.click({ role: "option", label: new RegExp(world.videoModelName) });
    await user.see({ role: "button", label: "Change model" }, { text: new RegExp(world.videoModelName) });
    await user.see("composer", { editable: true, text: /Describe the attached image\./ });
    expect((await probe.composer()).draftText).toBe(draft.draftText);
    expect(await world.draftAttachments()).toEqual(attachments);
    expect(await world.modelRequests()).toEqual([]);
  });

  // TODO(primitive): observe a transient attachment status during a user send.
  await seed.evalIn(world.app, `(attachmentName) => {
    globalThis.__attachmentUploadingSeen = false;
    const record = () => {
      if (Array.from(document.querySelectorAll('[data-attachment-status="uploading"]'))
        .some(chip => chip.getAttribute("title") === attachmentName)) globalThis.__attachmentUploadingSeen = true;
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-attachment-status"], childList: true });
    record();
    return true;
  }`, { args: [attachmentName] });
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
  expect(await probe.eventually(() => probe.eval(`!document.querySelector("[data-attachment-id]")
    && !document.querySelector('[data-sonner-toast][data-type="error"]')`), {
    within: 30_000,
    label: "attachment cleanup after send",
    until: (value) => value === true,
  })).toBe(true);
  await step("Google receives the exact video MIME and bytes alongside the image", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    const requests = await probe.eventually(() => world.agentRequests(), {
      within: 30_000,
      label: "native Google completion with attachments",
      until: (requests) => requests.some(request => request.model === world.videoModelId && request.kind === "final"),
    });
    expect(requests.some(request => request.kind === "error")).toBe(false);
    // Judge the content of every video-bearing request, not the engine's
    // number of main/auxiliary inference requests for a single user turn.
    const completed = requests.filter(request => request.model === world.videoModelId && request.kind === "final"
      && request.inlineMedia?.some(media => media.mimeType.startsWith("video/")));
    expect(completed.length).toBeGreaterThan(0);
    for (const request of completed) {
      expect(request.inlineMedia?.filter(media => media.mimeType.startsWith("video/"))).toEqual([world.expectedVideo]);
      expect(request.inlineMedia?.some(media => media.mimeType.startsWith("image/"))).toBe(true);
    }
    expect((await probe.composer()).userMessageCount).toBe(1);
    await user.notSee({ text: /Cannot read binary file|UnsupportedFunctionalityError/ });
  });

  for (const reload of [false, true]) {
    await step(`${reload ? "reloaded" : "sent"} video has one player with controls and plays only when requested`, async () => {
      if (reload) {
        await user.reload();
        await user.see({ text: world.reply }, { timeoutMs: 60_000 });
      }
      await user.see({ text: world.videoName });
      for (const reference of [false, true]) {
        const idle = await probe.eventually(() => world.videoState(false, reference), {
          within: 30_000,
          label: `${reference ? "workspace reference" : "attachment"} decoded without autoplay`,
          until: (state) => state?.ready === true,
        });
        expect(idle).toMatchObject({
          count: 1, totalPlayers: 2, controls: true, autoplay: false, paused: true, time: 0, error: null,
        });
        if (reference) expect(idle?.blobSource).toBe(true);
        await world.videoState(true, reference);
        const playing = await probe.eventually(() => world.videoState(false, reference), {
          within: 5_000,
          label: "video playback advances",
          until: (state) => state !== null && state.time > 0,
        });
        expect(playing).toMatchObject({ count: 1, totalPlayers: 2, controls: true, autoplay: false, error: null });
        expect(playing?.time).toBeGreaterThan(0);
      }
      await user.screenshot();
    });
  }
});
