/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
};

import { renderToStaticMarkup } from "react-dom/server";

import { ProviderIcon } from "./provider-icon";
import { providerLogoCandidates } from "./provider-logo-src";

describe("provider logo candidates", () => {
  test("prefers Simple Icons for providers it actually publishes", () => {
    expect(providerLogoCandidates({ providerId: "anthropic" })[0]).toBe(
      "https://cdn.simpleicons.org/anthropic",
    );
    expect(providerLogoCandidates({ providerId: "google" })[0]).toBe(
      "https://cdn.simpleicons.org/googlegemini",
    );
  });

  test("skips Simple Icons for the providers it 404s on and uses the brand favicon", () => {
    expect(providerLogoCandidates({ providerId: "groq" })).toEqual([
      "https://www.google.com/s2/favicons?sz=64&domain=groq.com",
    ]);
    expect(providerLogoCandidates({ providerId: "bedrock" })).toEqual([
      "https://www.google.com/s2/favicons?sz=64&domain=aws.amazon.com",
    ]);
  });

  test("resolves a real logo for long-tail providers whose id is a domain", () => {
    expect(providerLogoCandidates({ providerId: "302.ai" })).toEqual([
      "https://www.google.com/s2/favicons?sz=64&domain=302.ai",
    ]);
  });

  test("falls back to the configured base URL for custom providers", () => {
    const candidates = providerLogoCandidates({
      providerId: "my-gateway",
      baseUrl: "https://api.together.xyz/v1",
    });
    expect(candidates).toContain("https://www.google.com/s2/favicons?sz=64&domain=together.xyz");
  });

  test("unslugs long-tail catalog ids back into their own domain", () => {
    expect(providerLogoCandidates({ providerId: "abliteration-ai" })).toContain(
      "https://www.google.com/s2/favicons?sz=64&domain=abliteration.ai",
    );
    expect(providerLogoCandidates({ providerId: "302ai" })).toContain(
      "https://www.google.com/s2/favicons?sz=64&domain=302.ai",
    );
  });

  test("leaves nothing to load when there is no logo source at all", () => {
    expect(providerLogoCandidates({ providerId: "" })).toEqual([]);
  });
});

describe("ProviderIcon", () => {
  test("renders the bundled brand mark for Anthropic without a network request", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="anthropic" size={20} />);
    expect(markup).toContain("<svg");
    expect(markup).toContain('role="img"');
  });

  test("renders a real logo image for a long-tail provider instead of a monogram", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="302.ai" size={20} />);
    expect(markup).toContain("<img");
    expect(markup).toContain("s2/favicons");
    expect(markup).toContain("302.ai");
  });

  test("keeps the monogram only for providers with no resolvable logo", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="" size={20} />);
    expect(markup).toContain("AI");
    expect(markup).toContain("<div");
  });
});
