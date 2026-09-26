import { describe, expect, test } from "bun:test";
import { describeMcpRedirect, fallbackClientName, isLoopbackHost } from "../app/mcp/client-identity-model";

describe("MCP consent client identity", () => {
  test("names the host the approval is sent to", () => {
    expect(describeMcpRedirect("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", loopbackOnly: false });
  });

  test("flags loopback-only redirects, on any port", () => {
    expect(describeMcpRedirect("http://127.0.0.1:39421/callback")).toEqual({ host: "127.0.0.1:39421", loopbackOnly: true });
    expect(describeMcpRedirect("http://localhost:3000/cb")?.loopbackOnly).toBe(true);
    expect(describeMcpRedirect("http://[::1]:8080/cb")?.loopbackOnly).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });

  test("names native app schemes and ignores garbage", () => {
    expect(describeMcpRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({ host: "cursor://", loopbackOnly: false });
    expect(describeMcpRedirect("not a url")).toBeNull();
    expect(describeMcpRedirect(null)).toBeNull();
  });

  test("falls back to the metadata document host for unnamed CIMD clients", () => {
    expect(fallbackClientName("https://app.example.com/oauth/client.json")).toBe("app.example.com");
    expect(fallbackClientName("abc123")).toBe("An app without a name");
  });
});
