import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorQuickAddGrid } from "../app/(den)/dashboard/_components/connector-quick-add-grid";

Object.defineProperty(globalThis, "React", { value: React, configurable: true });

describe("GitHub CLI Demo quick add", () => {
  it("offers the reviewed hosted version check", () => {
    const html = renderToStaticMarkup(
      <ConnectorQuickAddGrid
        connections={[]}
        presets={[]}
        telegramConnected={false}
        onSelect={() => undefined}
      />,
    );

    assert.match(html, /data-testid="quick-add-github-cli-demo"/);
    assert.match(html, /GitHub CLI Demo/);
    assert.match(html, /Runs a hosted GitHub CLI version check/);
    assert.match(html, />Enable</);
  });

  it("renders an enabled connector as ready and non-interactive", () => {
    const html = renderToStaticMarkup(
      <ConnectorQuickAddGrid
        connections={[]}
        presets={[]}
        telegramConnected={false}
        cliDemoEnabled
        onSelect={() => undefined}
      />,
    );

    assert.match(html, /data-testid="quick-add-github-cli-demo"[^>]*disabled=""/);
    assert.match(html, />Ready</);
  });
});
