import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  copyDenBrowserHandoffUrl,
  tryOpenDenBrowserHandoff,
} from "../app/(den)/_components/browser-handoff-fallback";
import { McpAuthorizationFallback } from "../app/(den)/dashboard/_components/mcp-authorization-fallback";

describe("Den browser handoff", () => {
  test("reports a blocked popup without throwing", async () => {
    const result = await tryOpenDenBrowserHandoff("https://provider.example/authorize", {
      sanitizeUrl: (url) => url,
      open: () => false,
    });

    expect(result.ok).toBe(false);
  });

  test("uses selection-based copy when Clipboard API access is rejected", async () => {
    let legacyValue = "";
    const result = await copyDenBrowserHandoffUrl("https://provider.example/authorize", {
      writeClipboard: async () => {
        throw new Error("Clipboard permission denied");
      },
      legacyCopy: (url) => {
        legacyValue = url;
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(legacyValue).toBe("https://provider.example/authorize");
  });

  test("reports failure when browser-managed and selection-based copy are both blocked", async () => {
    const result = await copyDenBrowserHandoffUrl("https://provider.example/authorize", {
      writeClipboard: async () => {
        throw new Error("Clipboard permission denied");
      },
      legacyCopy: () => false,
    });

    expect(result).toEqual({ ok: false, error: "Automatic copy was blocked." });
  });
});

describe("McpAuthorizationFallback", () => {
  test("keeps the complete authorization URL visible and selectable", () => {
    const url = "https://provider.example/authorize?state=keep-this-visible";
    const markup = renderToStaticMarkup(
      <McpAuthorizationFallback url={url} connectionName="Example" />,
    );

    expect(markup).toContain('data-testid="mcp-authorization-fallback"');
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain("keep-this-visible");
    expect(markup).toContain("Open again");
    expect(markup).toContain("Copy link");
  });
});
