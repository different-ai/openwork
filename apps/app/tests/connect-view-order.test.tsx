/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CloudSessionProvider } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import {
  ConnectActivePanel,
  ConnectViewLayout,
} from "../src/react-app/domains/settings/pages/connect-view";

describe("Connect page section priority", () => {
  test("renders organization connections before agent access details", () => {
    const html = renderToStaticMarkup(
      <CloudSessionProvider>
        <ConnectActivePanel
          connections={[]}
          marketplaceItems={[]}
          openworkClient={null}
          workspaceId={null}
          currentModel={null}
          loading={false}
          error={null}
          connectingId={null}
          disconnectingId={null}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      </CloudSessionProvider>,
    );

    expect(html.indexOf('data-testid="connect-organization-section"')).toBeGreaterThan(-1);
    expect(html.indexOf("Agent access to connected services")).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="connect-organization-section"'))
      .toBeLessThan(html.indexOf("Agent access to connected services"));
  });

  test("renders primary Connect content before diagnostics", () => {
    const html = renderToStaticMarkup(
      <ConnectViewLayout
        primaryContent={<div data-testid="primary-content" />}
        diagnosticsContent={<div data-testid="diagnostics-content" />}
      />,
    );

    expect(html.indexOf('data-testid="primary-content"'))
      .toBeLessThan(html.indexOf('data-testid="diagnostics-content"'));
  });
});
