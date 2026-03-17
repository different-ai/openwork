import { expect, test, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const momTestSkill = readFileSync(path.join(fixtureDir, "fixtures", "mom-test-skill.md"), "utf8");
const iphone13 = devices["iPhone 13"];

function definePreviewWrapTests(mode: "desktop" | "mobile") {
  test(`keeps the preview wrapped without mutating pasted text on ${mode}`, async ({ page }) => {
    await page.goto("/");

    const editor = page.locator(".preview-editor");
    await expect(editor).toBeVisible();

    await editor.fill(momTestSkill);
    await expect(editor).toHaveValue(momTestSkill);

    const metrics = await page.locator(".preview-editor-wrap").evaluate((wrap) => {
      const highlight = wrap.querySelector<HTMLElement>(".preview-highlight");
      const editorEl = wrap.querySelector<HTMLElement>(".preview-editor");

      const getOverflow = (node: HTMLElement | null) => ({
        clientWidth: node?.clientWidth ?? 0,
        scrollWidth: node?.scrollWidth ?? 0,
      });

      const locateText = (root: HTMLElement | null, search: string) => {
        if (!root) return null;
        const fullText = root.textContent ?? "";
        const start = fullText.indexOf(search);
        if (start === -1) return null;
        const end = start + search.length;
        const range = document.createRange();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startSet = false;

        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const value = node.nodeValue ?? "";
          const nextOffset = offset + value.length;

          if (!startSet && start >= offset && start <= nextOffset) {
            range.setStart(node, start - offset);
            startSet = true;
          }

          if (startSet && end >= offset && end <= nextOffset) {
            range.setEnd(node, end - offset);
            break;
          }

          offset = nextOffset;
        }

        const rects = Array.from(range.getClientRects());
        if (!rects.length) return null;
        return {
          top: rects[0].top,
          bottom: rects[rects.length - 1].bottom,
        };
      };

      const introRect = locateText(highlight, "Extract actionable insights following the mom-test methodology.");
      const headingRect = locateText(highlight, "Customer Discovery Interview Quote Extraction");

      return {
        wrap: getOverflow(wrap as HTMLElement),
        highlight: getOverflow(highlight),
        editor: getOverflow(editorEl),
        previewText: highlight?.textContent ?? "",
        newlineGap: introRect && headingRect ? headingRect.top - introRect.bottom : null,
      };
    });

    expect(metrics.wrap.scrollWidth - metrics.wrap.clientWidth).toBeLessThanOrEqual(1);
    expect(metrics.highlight.scrollWidth - metrics.highlight.clientWidth).toBeLessThanOrEqual(1);
    expect(metrics.editor.scrollWidth - metrics.editor.clientWidth).toBeLessThanOrEqual(1);
    expect(metrics.previewText).toContain(
      "Extract actionable insights following the mom-test methodology. \n\n# Customer Discovery Interview Quote Extraction",
    );
    expect(metrics.newlineGap).not.toBeNull();
    expect(metrics.newlineGap ?? 0).toBeGreaterThan(6);
  });

  test(`keeps the preview type dot stable while editing on ${mode}`, async ({ page }) => {
    let packageRequests = 0;

    await page.route("**/v1/package", async (route) => {
      packageRequests += 1;
      if (packageRequests === 2) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.continue();
    });

    await page.goto("/");

    const editor = page.locator(".preview-editor");
    const previewDot = page.locator(".preview-filename-dot");
    await expect(editor).toBeVisible();

    await editor.fill(momTestSkill);
    await expect(previewDot).toHaveClass(/dot-skill/);

    await editor.fill(`${momTestSkill}\n\nFollow-up note`);
    await page.waitForTimeout(50);
    expect(await previewDot.evaluate((node) => node.className)).toContain("dot-skill");

    await page.waitForTimeout(450);
    await expect(previewDot).toHaveClass(/dot-skill/);
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 1600 } });
  definePreviewWrapTests("desktop");
});

test.describe("mobile", () => {
  test.use({
    viewport: iphone13.viewport,
    userAgent: iphone13.userAgent,
    deviceScaleFactor: iphone13.deviceScaleFactor,
    isMobile: iphone13.isMobile,
    hasTouch: iphone13.hasTouch,
  });
  definePreviewWrapTests("mobile");
});
