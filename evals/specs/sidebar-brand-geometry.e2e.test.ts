import { waitFor } from "@openwork/behaviors";
import { currentTestEvidence, screenshot } from "@openwork/test-evidence";
import { browserScript, evalIn, needs, test } from "@openwork/testkit";
import { expect } from "vitest";
import { setSidebarBrandTheme, sidebarBrandApp } from "../worlds/sidebar-brand.ts";

test("sidebar brand painted bounds align with the action rail without changing custom branding", async ({ place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: place.kind === "daytona" ? ["daytona"] : ["pnpm", "bun"] });
  await using app = await sidebarBrandApp(place);
  await waitFor(app, () => Boolean(document.querySelector('[data-sidebar-brand] img')), { timeoutMs: 30_000 });

  for (const fontSize of [16, 20]) {
    for (const dark of [false, true]) {
      await setSidebarBrandTheme(app, dark);
      await evalIn(app, browserScript(fontSize => {
        document.documentElement.style.fontSize = `${fontSize}px`;
      }, [fontSize]));
      // Menu padding transitions when rem changes; sample only settled geometry.
      await waitFor(app, browserScript(fontSize => {
        const action = document.querySelector('[data-sidebar-new-chat]');
        return action !== null && getComputedStyle(action).paddingLeft === `${fontSize * 0.625}px`;
      }, [fontSize]), { timeoutMs: 5_000 });
      const geometry = await evalIn(app, async () => {
        await document.fonts.ready;
        const header = document.querySelector<HTMLElement>('[data-sidebar-brand]');
        const image = header?.querySelector('img');
        const label = header?.querySelector('span');
        const action = document.querySelector<HTMLElement>('[data-sidebar-new-chat]');
        const icon = action?.querySelector('svg');
        const actionLabel = action?.querySelector('span');
        if (!header || !image || !label || !action || !icon || !actionLabel) throw new Error("Missing sidebar geometry targets");
        await image.decode();
        const response = await fetch(image.src, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Mark asset HTTP ${response.status}`);
        const source = await response.text();
        const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
        const marketingResponse = await fetch(new URL("openwork-mark.svg", image.src), { signal: AbortSignal.timeout(10_000) });
        if (!marketingResponse.ok) throw new Error(`Marketing asset HTTP ${marketingResponse.status}`);
        const marketing = new DOMParser().parseFromString(await marketingResponse.text(), "image/svg+xml");
        const svg = document.importNode(parsed.documentElement, true);
        if (!(svg instanceof SVGSVGElement)) throw new Error("Mark asset is not SVG");
        // Measure the actual shipped paths, not the padded img element. Keep the
        // measurement SVG out of layout; it never replaces the product's mark.
        svg.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden";
        document.body.append(svg);
        try {
          const box = svg.getBBox();
          const view = svg.viewBox.baseVal;
          const slot = image.getBoundingClientRect();
          const row = header.getBoundingClientRect();
          const text = label.getBoundingClientRect();
          const actionIcon = icon.getBoundingClientRect();
          const actionText = actionLabel.getBoundingClientRect();
          const scale = Math.min(slot.width / view.width, slot.height / view.height);
          const left = slot.left + (slot.width - view.width * scale) / 2 + (box.x - view.x) * scale;
          const top = slot.top + (slot.height - view.height * scale) / 2 + (box.y - view.y) * scale;
          const width = box.width * scale;
          const height = box.height * scale;
          return {
            theme: getComputedStyle(document.documentElement).colorScheme,
            label: label.textContent, labelX: text.left, actionLabelX: actionText.left,
            iconCenterX: actionIcon.left + actionIcon.width / 2,
            slotWidth: slot.width, slotHeight: slot.height,
            slotCenterX: slot.left + slot.width / 2, slotCenterY: slot.top + slot.height / 2,
            painted: { left, top, width, height, centerX: left + width / 2, centerY: top + height / 2 },
            rowHeight: row.height, rowCenterY: row.top + row.height / 2, labelCenterY: text.top + text.height / 2,
            clipped: box.x < view.x || box.y < view.y || box.x + box.width > view.x + view.width || box.y + box.height > view.y + view.height,
            labelClipped: label.scrollWidth > label.clientWidth,
            contained: left >= slot.left && top >= slot.top && left + width <= slot.right && top + height <= slot.bottom,
            filter: getComputedStyle(image).filter, fit: getComputedStyle(image).objectFit,
            objectPosition: getComputedStyle(image).objectPosition,
            transform: getComputedStyle(image).transform, aspect: svg.getAttribute("preserveAspectRatio"),
            bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
            pathsUnchanged: JSON.stringify([...svg.querySelectorAll('path')].map(path => [path.getAttribute("d"), path.getAttribute("fill")])) === JSON.stringify([...marketing.querySelectorAll('path')].map(path => [path.getAttribute("d"), path.getAttribute("fill")])),
            marketingViewBox: marketing.documentElement.getAttribute("viewBox"),
          };
        } finally {
          svg.remove();
        }
      }, { awaitPromise: true, timeoutMs: 20_000 });
      const factor = fontSize / 16;
      const close = (left: number, right: number) => Math.abs(left - right) <= 0.1;
      const aligned = close(geometry.labelX, geometry.actionLabelX)
        && close(geometry.painted.centerX, geometry.iconCenterX)
        && close(geometry.painted.centerY, geometry.rowCenterY)
        && close(geometry.painted.centerY, geometry.labelCenterY);
      const sized = close(geometry.painted.width, 16 * factor) && close(geometry.painted.height, 20 * factor);
      const mode = `${dark ? "dark" : "light"}, ${fontSize}px root`;
      console.log(mode, JSON.stringify(geometry));
      currentTestEvidence()?.recordAssertionEvidence(`Stock mark geometry (${mode})`, JSON.stringify(geometry), aligned && sized && !geometry.clipped && geometry.contained && geometry.objectPosition === "50% 50%");
      await screenshot(app);
      expect.soft(aligned, `painted mark and labels share their rails (${mode})`).toBe(true);
      expect.soft(sized, `visible mark is 16x20 at 16px root (${mode})`).toBe(true);
      expect.soft(geometry.clipped).toBe(false);
      expect.soft(geometry.contained).toBe(true);
      expect.soft(geometry.labelClipped).toBe(false);
      expect.soft(geometry.slotWidth).toBe(20 * factor);
      expect.soft(geometry.slotHeight).toBe(20 * factor);
      expect.soft(geometry.rowHeight).toBe(44 * factor);
      expect.soft(geometry.label).toBe("OpenWork");
      expect.soft(geometry.fit).toBe("contain");
      expect.soft(geometry.objectPosition).toBe("50% 50%");
      expect.soft(geometry.transform).toBe("none");
      expect.soft(geometry.aspect).not.toBe("none");
      expect.soft(geometry.filter).toBe(dark ? "invert(1)" : "none");
      expect.soft(geometry.theme).toBe(dark ? "dark" : "light");
      expect.soft(geometry.pathsUnchanged).toBe(true);
      expect.soft(geometry.marketingViewBox).toBe("0 0 834 649");
    }
  }

  const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" fill="#25262b"/><text x="12" y="22" fill="white">Studio</text></svg>');
  await evalIn(app, browserScript(logo => {
    document.documentElement.style.fontSize = "16px";
    const config = { brandAppName: "Studio", brandLogoUrl: logo };
    window.__openworkApplyDesktopConfig(config);
    window.__openworkSetDesktopConfigRefreshResult(config);
  }, [logo]));
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="brand-logo"] img')), { timeoutMs: 10_000 });
  for (const dark of [false, true]) {
    await setSidebarBrandTheme(app, dark);
    const custom = await evalIn(app, async () => {
      const header = document.querySelector<HTMLElement>('[data-testid="brand-logo"]');
      const image = header?.querySelector('img');
      if (!header || !image) throw new Error("Custom branding disappeared");
      await image.decode();
      const box = image.getBoundingClientRect();
      const row = header.getBoundingClientRect();
      return {
        theme: getComputedStyle(document.documentElement).colorScheme,
        stockVisible: Boolean(document.querySelector('[data-sidebar-brand]')),
        src: image.src, alt: image.alt, width: box.width, height: box.height, rowHeight: row.height,
        inset: box.left - row.left, filter: getComputedStyle(image).filter,
        contained: box.left >= row.left && box.right <= row.right && box.top >= row.top && box.bottom <= row.bottom,
      };
    }, { awaitPromise: true });
    console.log("custom", dark, JSON.stringify(custom));
    currentTestEvidence()?.recordAssertionEvidence(`Custom wordmark source (${dark ? "dark" : "light"})`, JSON.stringify({ expectedSrc: logo, actualSrc: custom.src }), custom.src === logo);
    expect(custom).toEqual({ theme: dark ? "dark" : "light", stockVisible: false, src: logo, alt: "Organization logo", width: 120, height: 32, rowHeight: 56, inset: 12, filter: "none", contained: true });
    currentTestEvidence()?.recordAssertionEvidence(`Custom wordmark unchanged (${dark ? "dark" : "light"})`, JSON.stringify(custom), true);
    await screenshot(app);
  }
});
