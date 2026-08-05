declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  MICX_EXTENSION_CATALOG,
  filterMicxExtensionCatalogForPlatform,
  resolveMicxExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterMicxExtensionCatalogForPlatform(MICX_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("Micx extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveMicxExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveMicxExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveMicxExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveMicxExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["micx-voice", "ollama"]);
  });

  test("keeps Micx Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["micx-browser", "computer-use", "micx-voice", "ollama"]);
    expect(filteredIds("linux")).toEqual(["micx-browser", "micx-voice", "ollama"]);
  });
});
