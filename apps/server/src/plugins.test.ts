import { describe, expect, test } from "bun:test";

import { normalizePluginSpec } from "./plugins.js";

describe("normalizePluginSpec", () => {
  test("Windows absolute path with @ in directory is returned unchanged", () => {
    expect(normalizePluginSpec("C:\\Users\\me@work\\my-plugin")).toBe("C:\\Users\\me@work\\my-plugin");
  });

  test("POSIX absolute path is returned unchanged", () => {
    expect(normalizePluginSpec("/abs/path/plugin")).toBe("/abs/path/plugin");
  });

  test("normal package spec with version is truncated to package name", () => {
    expect(normalizePluginSpec("some-plugin@1.2.0")).toBe("some-plugin");
  });

  test("scoped package spec keeps scope, strips version", () => {
    expect(normalizePluginSpec("@my-org/plugin@2.0.0")).toBe("@my-org/plugin");
  });

  test("file: url is returned unchanged", () => {
    expect(normalizePluginSpec("file:///some/plugin")).toBe("file:///some/plugin");
  });

  test("https: url is returned unchanged", () => {
    expect(normalizePluginSpec("https://example.com/plugin")).toBe("https://example.com/plugin");
  });
});
