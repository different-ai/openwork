import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { availableNote, chatFileLinks, fileLinksPrompt, missingFileReferences } from "../worlds/chat-file-links.ts";

const test = spec.world(chatFileLinks, {
  resources: { surfaces: ["appWeb"], services: ["mock"] }, timeout: 360_000,
});

// Browser-hosted sessions have no local desktop origin. Missing file references
// must remain useful without asking the native desktop to open a foreign path.
test("a member can copy unavailable handoff paths and still preview a workspace file", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("given: the member receives inline paths and file links from another machine", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", fileLinksPrompt);
    await user.click("Run task");
    await user.see({ role: "link", text: "Preview available note" }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    const replies = await world.replies();
    const inline = (await probe.dom('[data-message-role="assistant"] [data-openwork-inline-code-path]')).elements;
    expect(replies).toBeGreaterThan(0);
    expect(inline).toHaveLength(missingFileReferences.length);
    evidence.recordAssertionEvidence("The engine delivered four inline file references and their Markdown links", `model replies=${replies}; inline references=${inline.length}`, replies > 0 && inline.length === missingFileReferences.length);
    await user.screenshot();
  });

  for (const reference of missingFileReferences) {
    for (const presentation of ["inline code", "Markdown link"]) {
      await step(`after: the member can copy ${reference.label.toLowerCase()} from ${presentation} without a disk error`, async () => {
        await user.click(presentation === "inline code"
          ? { role: "button", label: `Open ${reference.path}` }
          : { role: "link", text: reference.label });
        await user.see({ text: "This file is on another machine or is no longer available." });
        await user.see({ role: "button", text: "Copy path" });
        const visibleText = await probe.text();
        expect(visibleText).not.toMatch(/Could not find .* on disk/);
        expect(visibleText).not.toContain("This is not a local file path");
        const toasts = (await probe.dom('[data-sonner-toast]')).elements;
        expect(toasts.some((toast) => toast.text.includes("Copy path"))).toBe(true);
        const info = (await probe.dom('[data-sonner-toast] .lucide-info')).elements;
        expect(info).toHaveLength(1);
        const errors = (await probe.dom('[data-sonner-toast] .lucide-octagon-x')).elements;
        expect(errors).toHaveLength(0);
        await user.screenshot();
        await user.click({ role: "button", text: "Copy path" });
        const copied = await probe.eventually(() => world.readClipboard(), {
          within: 5_000, label: "the original handoff path was copied", until: (value) => value === reference.path,
        });
        expect(copied).toBe(reference.path);
        evidence.recordAssertionEvidence("The unavailable file stays a copyable reference, not a local disk failure", `presentation=${presentation}; path=${reference.path}; clipboard=${copied}; error toasts=${errors.length}`, copied === reference.path && errors.length === 0);
        await probe.eventually(() => probe.dom('[data-sonner-toast]:not([data-removed="true"])'), {
          within: 10_000, label: "the reference toast is dismissed before the next file", until: (value) => value.elements.length === 0,
        });
      });
    }
  }

  await step("a file that is still in the workspace opens its preview instead of the unavailable notice", async () => {
    await user.click({ role: "link", text: "Preview available note" });
    await user.see({ text: availableNote }, { timeoutMs: 30_000 });
    await user.notSee({ text: "This file is on another machine or is no longer available." });
    await user.notSee({ text: /Could not find .* on disk/ });
    const visibleText = await probe.text();
    const previewAvailable = visibleText.includes(availableNote);
    expect(previewAvailable).toBe(true);
    evidence.recordAssertionEvidence("The existing workspace file still opens normally", `notes/available.md preview: ${availableNote}`, previewAvailable);
    await user.screenshot();
  });
});
