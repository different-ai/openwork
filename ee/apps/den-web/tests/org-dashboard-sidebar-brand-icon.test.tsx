import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DenRuntimeVersionLabel,
  SidebarBrandMark,
  parseDenRuntimeVersion,
} from "../app/(den)/dashboard/_components/org-dashboard-shell";

const managedIconUrl = "https://den.example.test/v1/brand-assets/org_acme/icon/version.png";
const managedIconMetadata = JSON.stringify({
  brandIconAsset: {
    kind: "icon",
    version: "version",
    extension: "png",
    contentType: "image/png",
    url: managedIconUrl,
    width: 256,
    height: 256,
    byteLength: 1024,
    originalName: "acme.png",
    uploadedAt: "2026-07-10T00:00:00.000Z",
  },
});

describe("Den dashboard sidebar brand icon", () => {
  test("holds a neutral square while organization branding loads", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandMark metadata={undefined} organizationName="Acme" />,
    );

    expect(markup).toContain('data-sidebar-brand-icon="loading"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  test("renders the canonical managed square icon without first rendering the OpenWork mark", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandMark metadata={managedIconMetadata} organizationName="Acme" />,
    );

    expect(markup).toContain(`src="${managedIconUrl}"`);
    expect(markup).toContain('alt="Acme icon"');
    expect(markup).toContain('data-sidebar-brand-icon="loading"');
    expect(markup).toContain("opacity-0");
    expect(markup).not.toContain("<svg");
  });

  test("uses the OpenWork mark when no managed square icon exists", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandMark metadata={null} organizationName="Acme" />,
    );

    expect(markup).toContain("<svg");
    expect(markup).toContain('aria-label="OpenWork"');
    expect(markup).toContain('data-sidebar-brand-icon="fallback"');
    expect(markup).not.toContain("<img");
  });
});

describe("Den dashboard runtime version", () => {
  test("reads a non-empty version from the public health payload", () => {
    expect(parseDenRuntimeVersion({ version: " 0.17.31 " })).toBe("0.17.31");
    expect(parseDenRuntimeVersion({ version: " " })).toBeNull();
    expect(parseDenRuntimeVersion(null)).toBeNull();
  });

  test("renders the version as discreet sidebar metadata", () => {
    const markup = renderToStaticMarkup(
      <DenRuntimeVersionLabel version="0.17.31" />,
    );

    expect(markup).toContain("Den 0.17.31");
    expect(markup).toContain('data-den-runtime-version="0.17.31"');
    expect(markup).toContain("text-[10px]");
    expect(markup).toContain("text-gray-400");
  });
});
