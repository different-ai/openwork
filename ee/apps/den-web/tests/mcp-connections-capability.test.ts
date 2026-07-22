import { describe, expect, test } from "bun:test";

import { shouldShowMcpConnectionsStagingBanner } from "../app/(den)/dashboard/_components/mcp-connections-capability";

describe("shouldShowMcpConnectionsStagingBanner", () => {
  test("shows the staging banner when OpenWork Connect is disabled", () => {
    expect(shouldShowMcpConnectionsStagingBanner({ mcpConnections: false })).toBe(true);
  });

  test("hides the staging banner when OpenWork Connect is enabled", () => {
    expect(shouldShowMcpConnectionsStagingBanner({ mcpConnections: true })).toBe(false);
  });
});
