import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openworkPluginPath } from "./openwork-extensions-plugin-path.js";

function withPluginDir(value: string | undefined, fn: () => void) {
  const previous = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  if (value === undefined) {
    delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  } else {
    process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
    } else {
      process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = previous;
    }
  }
}

function restoreResourcesPath(previous: string | undefined) {
  if (previous === undefined) {
    delete process.resourcesPath;
  } else {
    process.resourcesPath = previous;
  }
}

describe("openworkPluginPath", () => {
  test("prefers OPENWORK_EXTENSIONS_PLUGIN_DIR", () => {
    withPluginDir("/opt/openwork/opencode-plugins", () => {
      const resourcesPath = join("/Applications", "OpenWork.app", "Contents", "Resources");
      const previousResourcesPath = process.resourcesPath;
      process.resourcesPath = resourcesPath;
      try {
        expect(openworkPluginPath("openwork-extensions-preview", join(resourcesPath, "app.asar", "server", "dist")))
          .toBe(join("/opt/openwork/opencode-plugins", "openwork-extensions-preview.js"));
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses external resources plugin path in packaged Electron when env is unset", () => {
    withPluginDir(undefined, () => {
      const previousResourcesPath = process.resourcesPath;
      const resourcesPath = join("/Applications", "OpenWork.app", "Contents", "Resources");
      process.resourcesPath = resourcesPath;
      try {
        const pluginPath = openworkPluginPath(
          "openwork-extensions-preview",
          join(resourcesPath, "app.asar", "server", "dist"),
        );

        expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "openwork-extensions-preview.js"));
        expect(pluginPath).not.toContain("app.asar");
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses source plugin path in development when env is unset", () => {
    withPluginDir(undefined, () => {
      const here = join("/repo", "apps", "server", "src");
      expect(openworkPluginPath("openwork-extensions-preview", here))
        .toBe(join(here, "opencode-plugins", "openwork-extensions-preview.ts"));
    });
  });
});
