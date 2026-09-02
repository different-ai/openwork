import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "clicking a chat image opens it near the full window size, not the 448px dialog default"
  : "image lightbox size skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Base `DialogContent` is capped at `lg:max-w-md` (28rem). The lightbox used to
// inherit that cap on every window wider than 1024px, so "enlarging" a
// screenshot rendered it at 448px. The viewport below is wide enough for the
// `lg:` breakpoint and large enough that a 2000px image is still clamped by it.
const VIEWPORT = { width: 1600, height: 1000 };
const LEGACY_DIALOG_CAP_PX = 448;

type LightboxProbe = {
  thumbnailWidth: number;
  dialogWidth: number;
  dialogHeight: number;
  imageWidth: number;
  imageHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  closeButtonInsideImage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  // What the CSS `100vw` / `100vh` units resolve to; the lightbox is sized in vw/vh.
  vwPx: number;
  vhPx: number;
};

function isLightboxProbe(value: unknown): value is LightboxProbe {
  return typeof value === "object" && value !== null && "imageWidth" in value && "dialogWidth" in value;
}

// Every chat thumbnail is a button with an `Expand <alt>` label wrapping an <img>.
const thumbnailScript = (naturalWidth: number, naturalHeight: number) => `(() => {
  const images = [...document.querySelectorAll('button[aria-label^="Expand "] img')];
  return images.find((img) => img.naturalWidth === ${naturalWidth} && img.naturalHeight === ${naturalHeight}) ?? null;
})()`;

async function openLightbox(
  app: Awaited<ReturnType<typeof desktop>>,
  natural: { width: number; height: number },
): Promise<LightboxProbe> {
  await waitFor(app, `${thumbnailScript(natural.width, natural.height)} !== null`, {
    timeoutMs: 15_000,
    label: `${natural.width}x${natural.height} thumbnail loaded`,
  });
  await evalIn(app, `${thumbnailScript(natural.width, natural.height)}.closest('button').click()`);
  await waitFor(app, `(() => {
    const img = document.querySelector('[data-slot="dialog-content"] img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0;
  })()`, { timeoutMs: 10_000, label: "lightbox image rendered" });

  const probe = await evalIn(app, `(() => {
    const thumb = ${thumbnailScript(natural.width, natural.height)};
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const img = dialog?.querySelector('img');
    const close = dialog?.querySelector('[data-slot="dialog-close"]');
    if (!(thumb instanceof HTMLElement) || !(dialog instanceof HTMLElement) || !(img instanceof HTMLImageElement) || !(close instanceof HTMLElement)) return null;
    // Layout sizes (offset*) ignore the dialog's zoom-in open transform, which
    // getBoundingClientRect would fold into the numbers.
    const ruler = document.createElement('div');
    ruler.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none';
    document.body.append(ruler);
    const vwPx = ruler.offsetWidth;
    const vhPx = ruler.offsetHeight;
    ruler.remove();
    // The close button is absolutely positioned inside the dialog; the dialog
    // is its offsetParent, so offsets are relative to the dialog box.
    const closeInsideDialog = close.offsetParent === dialog
      && close.offsetLeft >= 0 && close.offsetTop >= 0
      && close.offsetLeft + close.offsetWidth <= dialog.offsetWidth
      && close.offsetTop + close.offsetHeight <= dialog.offsetHeight;
    return {
      thumbnailWidth: thumb.offsetWidth,
      dialogWidth: dialog.offsetWidth,
      dialogHeight: dialog.offsetHeight,
      imageWidth: img.offsetWidth,
      imageHeight: img.offsetHeight,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      closeButtonInsideImage: closeInsideDialog && dialog.offsetWidth === img.offsetWidth && dialog.offsetHeight === img.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      vwPx,
      vhPx,
    };
  })()`);
  if (!isLightboxProbe(probe)) {
    throw new Error(`Lightbox for ${natural.width}x${natural.height} was not readable: ${JSON.stringify(probe)}`);
  }
  return probe;
}

async function closeLightbox(app: Awaited<ReturnType<typeof desktop>>) {
  await evalIn(app, `document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]').click()`);
  await waitFor(app, `document.querySelector('[data-slot="dialog-content"]') === null`, {
    timeoutMs: 10_000,
    label: "lightbox closed",
  });
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "image-lightbox-size" });
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-image-lightbox-${Date.now()}`,
  });
  await seedSessions(app, ["Image lightbox proof"]);
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.image_lightbox.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "image lightbox seed control ready" },
  );
  await control(app, "eval.image_lightbox.seed");

  // Landscape screenshot sent by the user: previously stuck at the 448px dialog cap.
  const landscape = await openLightbox(app, { width: 2000, height: 1112 });
  expect(landscape.viewportWidth).toBe(VIEWPORT.width);
  // The window is wide enough for the `lg:` breakpoint where the old cap applied.
  expect(landscape.vwPx).toBeGreaterThanOrEqual(1024);
  expect(landscape.thumbnailWidth).toBeLessThan(100);
  expect(landscape.imageWidth).toBeGreaterThan(LEGACY_DIALOG_CAP_PX);
  // Width-bound: the image spans the full 95vw allowance (±1px rounding).
  expect(Math.abs(landscape.imageWidth - landscape.vwPx * 0.95)).toBeLessThanOrEqual(1);
  expect(landscape.imageHeight).toBeLessThanOrEqual(Math.ceil(landscape.vhPx * 0.92));
  expect(landscape.dialogWidth).toBe(landscape.imageWidth);
  expect(landscape.closeButtonInsideImage).toBe(true);
  await screenshot(app);
  evidence.recordAssertionEvidence(
    "A landscape screenshot enlarges to 95% of the window width instead of the 448px dialog default",
    `Thumbnail ${landscape.thumbnailWidth}px → lightbox image ${landscape.imageWidth}x${landscape.imageHeight}px where 100vw=${landscape.vwPx}px and 100vh=${landscape.vhPx}px (natural ${landscape.naturalWidth}x${landscape.naturalHeight}); the dialog hugged the image (${landscape.dialogWidth}px) with the close button inside its corner.`,
    true,
  );
  await closeLightbox(app);

  // Portrait screenshot from the assistant: height-bound, and the dialog must
  // still shrink-wrap the image rather than stretching to the width cap.
  const portrait = await openLightbox(app, { width: 1112, height: 2000 });
  expect(Math.abs(portrait.imageHeight - portrait.vhPx * 0.92)).toBeLessThanOrEqual(1);
  expect(portrait.imageWidth).toBeGreaterThan(LEGACY_DIALOG_CAP_PX);
  expect(portrait.dialogWidth).toBe(portrait.imageWidth);
  expect(portrait.dialogHeight).toBe(portrait.imageHeight);
  expect(portrait.closeButtonInsideImage).toBe(true);
  await screenshot(app);
  evidence.recordAssertionEvidence(
    "A portrait image fills 92% of the window height and the dialog wraps it exactly",
    `Lightbox image ${portrait.imageWidth}x${portrait.imageHeight}px where 100vh=${portrait.vhPx}px; dialog ${portrait.dialogWidth}x${portrait.dialogHeight}px, close button inside the image.`,
    true,
  );
  await closeLightbox(app);

  // A small image must not be upscaled and blurred just to fill the window.
  const icon = await openLightbox(app, { width: 180, height: 180 });
  expect(icon.imageWidth).toBe(180);
  expect(icon.imageHeight).toBe(180);
  expect(icon.dialogWidth).toBe(180);
  await screenshot(app);
  evidence.recordAssertionEvidence(
    "A small image opens at its natural size rather than being stretched",
    `180x180 icon rendered at ${icon.imageWidth}x${icon.imageHeight}px inside a ${icon.dialogWidth}px dialog.`,
    true,
  );
  await closeLightbox(app);
});
