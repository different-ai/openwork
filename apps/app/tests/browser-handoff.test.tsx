import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  copyBrowserHandoffUrl,
  openBrowserUrlWithGlobalFallback,
  tryOpenBrowserUrl,
} from "../src/app/lib/browser-handoff";
import { BrowserHandoffFallback } from "../src/components/browser-handoff-fallback";

describe("tryOpenBrowserUrl", () => {
  test("reports a desktop shell failure without throwing", async () => {
    const result = await tryOpenBrowserUrl("https://example.com/oauth?state=secret", {
      desktopRuntime: true,
      openDesktop: async () => {
        throw new Error("No browser is available");
      },
    });

    expect(result).toEqual({ ok: false, error: "No browser is available" });
  });

  test("treats a blocked web popup as a failed handoff", async () => {
    const result = await tryOpenBrowserUrl("https://example.com/oauth", {
      desktopRuntime: false,
      openWindow: () => null,
    });

    expect(result.ok).toBe(false);
  });

  test("announces a durable app-level fallback for generic link failures", async () => {
    let fallbackUrl = "";
    const result = await openBrowserUrlWithGlobalFallback(
      "https://example.com/docs",
      {
        desktopRuntime: false,
        openWindow: () => null,
      },
      (detail) => {
        fallbackUrl = detail.url;
      },
    );

    expect(result.ok).toBe(false);
    expect(fallbackUrl).toBe("https://example.com/docs");
  });
});

describe("copyBrowserHandoffUrl", () => {
  test("uses the legacy copy path when Clipboard API access is rejected", async () => {
    let legacyValue = "";
    const result = await copyBrowserHandoffUrl("https://example.com/oauth", {
      writeClipboard: async () => {
        throw new Error("Clipboard permission denied");
      },
      legacyCopy: (value) => {
        legacyValue = value;
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(legacyValue).toBe("https://example.com/oauth");
  });

  test("reports failure when both copy mechanisms are blocked", async () => {
    const result = await copyBrowserHandoffUrl("https://example.com/oauth", {
      writeClipboard: async () => {
        throw new Error("Clipboard permission denied");
      },
      legacyCopy: () => false,
    });

    expect(result).toEqual({ ok: false, error: "Automatic copy was blocked." });
  });
});

describe("BrowserHandoffFallback", () => {
  test("always renders the complete URL in a selectable readonly field", () => {
    const url = "https://example.com/oauth?state=keep-this-visible";
    const markup = renderToStaticMarkup(<BrowserHandoffFallback url={url} />);

    expect(markup).toContain('data-testid="browser-handoff-url"');
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain("keep-this-visible");
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Open again");
  });
});
