import { expect, test } from "bun:test";
import { browserAddressDestination } from "../src/react-app/domains/session/panel/browser-address-input";

test("searches submitted terms and encodes their punctuation", () => {
  for (const query of ["calendar", "  tea & coffee  ", "how to use C++", "weather?"]) {
    const result = new URL(browserAddressDestination(query));
    expect(result.origin + result.pathname).toBe("https://www.google.com/search");
    expect(result.searchParams.get("q")).toBe(query.trim());
  }
});

test("opens addresses directly, including local servers and intranet paths", () => {
  for (const [input, expected] of [
    ["https://example.com/a?b=c#here", "https://example.com/a?b=c#here"],
    ["docs.example.org/a report", "https://docs.example.org/a%20report"],
    ["localhost:3000/tools", "http://localhost:3000/tools"],
    ["[::1]:8080", "http://[::1]:8080/"],
    ["127.0.0.1", "http://127.0.0.1/"],
    ["intranet/wiki", "https://intranet/wiki"],
    ["café.fr", "https://xn--caf-dma.fr/"],
    ["about:blank", "about:blank"],
  ]) expect(browserAddressDestination(input)).toBe(expected);
});

test("invalid addresses and unsupported schemes never become search queries", () => {
  for (const value of ["https://", "file:///tmp/report", "mailto:user@example.org", "/tmp/private report", "~/Documents/notes", "C:\\Documents\\notes", "http://[bad", "example.org:99999", "   "]) {
    expect(() => browserAddressDestination(value)).toThrow();
  }
});
