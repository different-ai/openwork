import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { McpCredentialInput } from "../app/(den)/dashboard/_components/mcp-credential-input";

const credentialConsumers = [
  "../app/(den)/dashboard/_components/mcp-connections-screen.tsx",
  "../app/(den)/dashboard/_components/marketplace-detail-screen.tsx",
  "../app/(den)/dashboard/_components/microsoft-365-dialog.tsx",
];

describe("MCP credential autofill protection", () => {
  test("marks secrets as machine credentials instead of account passwords", () => {
    const html = renderToStaticMarkup(createElement(McpCredentialInput, {
      kind: "secret",
      name: "mcp-oauth-client-secret",
      value: "",
      readOnly: true,
    }));

    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('data-bwignore="true"');
  });

  test("does not present client and tenant identifiers as usernames", () => {
    const html = renderToStaticMarkup(createElement(McpCredentialInput, {
      kind: "identifier",
      name: "mcp-oauth-client-id",
      value: "",
      readOnly: true,
    }));

    expect(html).toContain('type="text"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('autoCapitalize="none"');
    expect(html).toContain('spellCheck="false"');
  });

  test("routes every MCP password field through the protected input", () => {
    for (const relativePath of credentialConsumers) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
      expect(source).not.toContain('type="password"');
    }
  });
});
