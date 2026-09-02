import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

// The chat image lightbox is rendered from three places. All three must size
// the dialog to the window and explicitly override the base Dialog's desktop
// `lg:max-w-md` cap, otherwise "enlarging" an image yields a 448px preview.
const LIGHTBOX_SOURCES = [
  "apps/app/src/components/ui/image.tsx",
  "apps/app/src/components/chat/image-attachment-badge.tsx",
  "apps/app/src/components/markdown/markdown.tsx",
];
const DIALOG_CLASSES = "max-h-[95vh] w-auto max-w-[95vw] overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 lg:w-max lg:max-w-[95vw]";
const IMAGE_CLASSES = "max-h-[92vh] w-auto max-w-full rounded-xl object-contain";

test("every chat image lightbox sizes its dialog to the window instead of the 448px dialog default", async ({ evidence }) => {
  for (const relativePath of LIGHTBOX_SOURCES) {
    const source = readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
    expect(source, relativePath).toContain(`<DialogContent className="${DIALOG_CLASSES}">`);
    expect(source, relativePath).toContain(`className="${IMAGE_CLASSES}"`);
    expect(source, relativePath).not.toContain("56rem");
    expect(source, relativePath).not.toContain("max-h-[85vh]");
  }

  const dialogSource = readFileSync(
    fileURLToPath(new URL("../../apps/app/src/components/ui/dialog.tsx", import.meta.url)),
    "utf8",
  );
  expect(dialogSource).toContain("lg:max-w-md");
  expect(dialogSource).toContain("lg:w-[calc(100%-2rem)]");

  evidence.recordAssertionEvidence(
    "All three image lightboxes share one window-sized dialog contract that overrides the base Dialog desktop cap",
    `${LIGHTBOX_SOURCES.join(", ")} each render DialogContent with "${DIALOG_CLASSES}" and the image with "${IMAGE_CLASSES}", with no remaining 56rem/85vh cap; the base Dialog still declares lg:max-w-md and lg:w-[calc(100%-2rem)], which is why the lg:max-w-[95vw] and lg:w-max overrides are required.`,
    true,
  );
});
