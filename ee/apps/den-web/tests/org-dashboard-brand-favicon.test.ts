import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getBrandFavicon } from "../app/(den)/dashboard/_components/brand-favicon";

const faviconSource = readFileSync(
  new URL("../app/(den)/dashboard/_components/brand-favicon.tsx", import.meta.url),
  "utf8",
);
const shellSource = readFileSync(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
  "utf8",
);

describe("Den dashboard brand favicon", () => {
  test("uses the active organization's managed icon and restores the OpenWork icon", () => {
    const branded = getBrandFavicon(JSON.stringify({
      brandIconAsset: {
        kind: "icon",
        version: "favicon-version",
        extension: "png",
        contentType: "image/png",
        url: "https://den.example.test/favicon.png",
        width: 128,
        height: 128,
        byteLength: 512,
        originalName: "favicon.png",
        uploadedAt: "2026-07-16T00:00:00.000Z",
      },
    }));

    expect(branded).toEqual({
      href: "https://den.example.test/favicon.png",
      type: "image/png",
    });
    expect(getBrandFavicon(null)).toEqual({
      href: "/openwork-mark.svg",
      type: undefined,
    });
    expect(faviconSource).toContain('return () => favicon.remove()');
  });

  test("follows refreshed organization metadata in the dashboard shell", () => {
    expect(shellSource).toContain('<BrandFavicon metadata={orgContext?.organization.metadata} />');
  });
});
