import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);

describe("Cloud MCP submission failure banner", () => {
  test("ellipsizes diagnostics with a full hover title and visible recovery actions", () => {
    const source = readFileSync(sessionSurfacePath, "utf8");
    const banner = source.match(
      /<div\s+className="([^"]*max-h-24[^"]*)"\s+data-testid="cloud-mcp-submission-failure"\s*>([\s\S]*?)<ReactSessionComposer/,
    );

    expect(banner?.[1]).toContain("overflow-hidden");
    expect(banner?.[2]).toMatch(
      /<span className="[^"]*truncate[^"]*" title=\{cloudMcpSubmissionFailureText\}>\s*\{cloudMcpSubmissionFailureText\}/,
    );
    expect(banner?.[2]).toMatch(/<button[^>]*className="[^"]*shrink-0[^"]*"[^>]*>\s*Retry/);
    expect(banner?.[2]).toMatch(/<button[^>]*className="[^"]*shrink-0[^"]*"[^>]*>\s*Open Connect/);
  });
});
