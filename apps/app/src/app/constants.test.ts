declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  OPENWORK_EXTENSION_CATALOG,
  filterOpenWorkExtensionCatalogForPlatform,
  resolveOpenWorkExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterOpenWorkExtensionCatalogForPlatform(OPENWORK_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("OpenWork extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveOpenWorkExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveOpenWorkExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveOpenWorkExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveOpenWorkExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["openwork-voice", "ollama"]);
  });

  test("keeps OpenWork Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["openwork-browser", "computer-use", "openwork-voice", "ollama"]);
    expect(filteredIds("linux")).toEqual(["openwork-browser", "openwork-voice", "ollama"]);
  });
});
