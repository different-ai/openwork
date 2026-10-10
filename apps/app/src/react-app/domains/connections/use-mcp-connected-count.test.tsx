import React from "react";
import { renderToString } from "react-dom/server";
import { useMcpConnectedCount } from "./use-mcp-connected-count";

// Declare Bun test globals so TypeScript doesn't throw module errors
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (actual: any) => { toContain: (expected: string) => void };

function TestComponent({ client, directory }: { client: any; directory: string }) {
  const count = useMcpConnectedCount(client, directory);
  return React.createElement("div", { "data-count": count }, count);
}

describe("useMcpConnectedCount", () => {
  test("returns 0 when client or directory is missing", () => {
    const htmlWithNullClient = renderToString(
      React.createElement(TestComponent, { client: null, directory: "/test/dir" })
    );
    expect(htmlWithNullClient).toContain('data-count="0"');

    const htmlWithEmptyDir = renderToString(
      React.createElement(TestComponent, { client: {} as any, directory: "" })
    );
    expect(htmlWithEmptyDir).toContain('data-count="0"');
  });
});