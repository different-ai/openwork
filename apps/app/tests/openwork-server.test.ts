import { describe, expect, test } from "bun:test";

import { stripOpenworkWorkspaceMount } from "../src/app/lib/openwork-server";

describe("stripOpenworkWorkspaceMount", () => {
  test("strips trailing workspace mounts", () => {
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/ws_123")).toBe("https://worker.example.test/base");
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/w/ws_123")).toBe("https://worker.example.test/base");
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/ws_123/api")).toBe("https://worker.example.test/base");
  });

  test("preserves non-mount path segments named workspace", () => {
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/docs/api")).toBe("https://worker.example.test/base/workspace/docs/api");
  });
});
