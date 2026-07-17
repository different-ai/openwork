import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getBrandFavicon } from "../app/(den)/_lib/brand-favicon";
import { getBrandFaviconForRequest } from "../app/_lib/request-brand-favicon";

const rootLayoutSource = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8",
);
const requestFaviconSource = readFileSync(
  new URL("../app/_lib/request-brand-favicon.ts", import.meta.url),
  "utf8",
);
const orgProviderSource = readFileSync(
  new URL("../app/(den)/dashboard/_providers/org-dashboard-provider.tsx", import.meta.url),
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
  });

  test("falls back promptly when the branding lookup exceeds its deadline", async () => {
    const favicon = await getBrandFaviconForRequest(
      new Headers({ cookie: "openwork-session=test" }),
      {
        apiBase: "https://den.example.test",
        timeoutMs: 5,
        fetchImpl: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("Expected the branding lookup to have a deadline."));
              return;
            }

            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    );

    expect(favicon).toEqual({
      href: "/openwork-mark.svg",
      type: undefined,
    });
  }, 1_000);

  test("renders the request-scoped favicon before hydration and refreshes it after settings change", () => {
    expect(rootLayoutSource).toContain("const favicon = await getRequestBrandFavicon()");
    expect(rootLayoutSource).toContain('<link key={favicon.href} rel="icon" href={favicon.href} type={favicon.type} />');
    expect(rootLayoutSource).not.toContain('icon: "/openwork-mark.svg"');
    expect(requestFaviconSource).toContain('(`${apiBase}/v1/org`');
    expect(requestFaviconSource).toContain('cache: "no-store"');
    expect(requestFaviconSource).toContain("signal: AbortSignal.timeout(dependencies.timeoutMs ?? BRAND_FAVICON_LOOKUP_TIMEOUT_MS)");
    expect(orgProviderSource).toContain('await runMutation("update-organization-settings"');
    expect(orgProviderSource).toContain("router.refresh()");
    expect(requestFaviconSource).not.toContain("useEffect");
  });
});
