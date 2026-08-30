import { describe, expect, test } from "bun:test";

import { brandIconCandidates, safeBrandImageUrl } from "../app/(den)/_lib/brand-icon";

describe("brand image URLs", () => {
  test("allows bundled paths and credential-free HTTPS image origins", () => {
    expect(safeBrandImageUrl("/integrations/google.svg")).toBe("/integrations/google.svg");
    expect(safeBrandImageUrl("https://assets.example.com/icon.png")).toBe("https://assets.example.com/icon.png");
  });

  test("rejects executable, cross-origin-relative, insecure, and credential-bearing URLs", () => {
    for (const unsafeUrl of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg></svg>",
      "//assets.example.com/icon.png",
      "/\\assets.example.com/icon.png",
      "\\\\assets.example.com/icon.png",
      "https:\\\\assets.example.com\\icon.png",
      "\thttps://assets.example.com/icon.png",
      "https://assets.example.com/icon.png\r",
      "https://assets.example.com/icon.png\n",
      "/integrations/\u0000google.svg",
      "https://assets.example.com/\u001ficon.png",
      "https://assets.example.com/\u007ficon.png",
      "https://assets.example.com/\u0085icon.png",
      "http://assets.example.com/icon.png",
      "https://user:secret@assets.example.com/icon.png",
    ]) {
      expect(safeBrandImageUrl(unsafeUrl)).toBeUndefined();
    }
  });

  test("keeps generated brand images on known HTTPS origins", () => {
    expect(brandIconCandidates({ simpleIconSlug: "openai" })).toEqual([
      "https://cdn.simpleicons.org/openai",
    ]);
    expect(brandIconCandidates({ simpleIconSlug: '"><svg/onload=alert(1)>' })).toEqual([]);
    expect(brandIconCandidates({ serviceUrl: "https://docs.example.com/start" })).toEqual([
      "https://www.google.com/s2/favicons?sz=64&domain=example.com",
    ]);
  });
});
